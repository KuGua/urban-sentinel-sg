import React, { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { WebSocketClient } from '../api/websocket';
import './StaffHome.css';

const POI_TYPES = [
  { key: 'police', label: 'Police Station', query: 'Police Station', color: '#2563eb' },
  { key: 'fire', label: 'Fire Station', query: 'Fire Station', color: '#dc2626' },
  { key: 'hospital', label: 'Hospital', query: 'Hospital', color: '#16a34a' }
];

const ONEMAP_TOKEN = process.env.REACT_APP_ONEMAP_API_TOKEN || '';

const ADMIN_THEME_KEYWORDS = [
  ['subzone', 'boundary'],
  ['planning', 'area'],
  ['region'],
  ['constituency']
];

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function themeMatches(theme, keywordGroup) {
  const haystack = [
    theme?.THEMENAME,
    theme?.QUERYNAME,
    theme?.CATEGORY,
    theme?.ICON_NAME
  ]
    .map(normalizeText)
    .join(' ');
  return keywordGroup.every((keyword) => haystack.includes(keyword));
}

function pickAdminThemes(themeList) {
  const picked = [];
  for (const keywordGroup of ADMIN_THEME_KEYWORDS) {
    const hit = themeList.find((theme) => themeMatches(theme, keywordGroup));
    if (hit && !picked.find((item) => item.QUERYNAME === hit.QUERYNAME)) {
      picked.push(hit);
    }
  }
  return picked;
}

function parseCoordinatePair(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.split(',').map((p) => Number(p.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return null;
  }
  return [parts[0], parts[1]];
}

function extractPathFromRecord(record) {
  const pathSource =
    record.LAT_LNG ||
    record.LATLNG ||
    record.LatLng ||
    record.SHAPE ||
    record.GEOMETRY ||
    record.POLY ||
    record.POLYGON;

  if (!pathSource || typeof pathSource !== 'string') {
    return null;
  }

  if (pathSource.includes('|')) {
    const points = pathSource
      .split('|')
      .map(parseCoordinatePair)
      .filter(Boolean);
    return points.length >= 3 ? points : null;
  }

  const wktMatch = pathSource.match(/-?\d+(\.\d+)?\s+-?\d+(\.\d+)?/g);
  if (wktMatch && wktMatch.length >= 3) {
    const points = wktMatch
      .map((pair) => {
        const [lng, lat] = pair.split(/\s+/).map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return [lat, lng];
      })
      .filter(Boolean);
    return points.length >= 3 ? points : null;
  }

  return null;
}

export default function StaffHome() {
  const [assistRequests, setAssistRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [poiStatus, setPoiStatus] = useState('Loading police, fire and hospital markers...');
  const [adminStatus, setAdminStatus] = useState('Loading administrative boundaries from OneMap themes...');
  const wsRef = useRef(null);
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);

  useEffect(() => {
    if (!localStorage.getItem('staffAuth')) {
      window.location.href = '/';
      return;
    }

    const ws = new WebSocketClient();
    wsRef.current = ws;

    ws.on('connect', () => {
      setIsLoading(false);
    });

    ws.on('assist_request', (event) => {
      setAssistRequests((prev) => [...prev, event.payload]);
    });

    ws.connect();

    return () => {
      ws.disconnect();
    };
  }, []);

  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) {
      return;
    }

    const singaporeCenter = [1.3521, 103.8198];
    const map = L.map(mapContainerRef.current, {
      center: singaporeCenter,
      zoom: 11,
      minZoom: 11,
      maxZoom: 18
    });

    L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png', {
      attribution: 'Map data (c) OpenStreetMap contributors, OneMap, Singapore Land Authority'
    }).addTo(map);

    const poiLayers = {};
    POI_TYPES.forEach((poiType) => {
      poiLayers[poiType.key] = L.layerGroup().addTo(map);
    });
    const adminBoundaryLayer = L.layerGroup().addTo(map);

    const toLatLng = (record) => {
      const lat = Number(record.LATITUDE || record.Latitude || record.lat);
      const lng = Number(record.LONGITUDE || record.Longitude || record.lng || record.LONGTITUDE);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }
      return [lat, lng];
    };

    const getName = (record) =>
      record.BUILDING || record.SEARCHVAL || record.NAME || record.POSTAL || 'Unknown location';

    const getAddress = (record) => record.ADDRESS || record.ROAD_NAME || '';

    const fetchAllPages = async (searchVal) => {
      const results = [];
      const pageLimit = 12;
      for (let pageNum = 1; pageNum <= pageLimit; pageNum += 1) {
        const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(
          searchVal
        )}&returnGeom=Y&getAddrDetails=Y&pageNum=${pageNum}`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`OneMap search failed (${response.status})`);
        }
        const data = await response.json();
        const pageResults = Array.isArray(data.results) ? data.results : [];
        results.push(...pageResults);
        const totalPages = Number(data.totalNumPages || 0);
        if (!totalPages || pageNum >= totalPages) {
          break;
        }
      }
      return results;
    };

    const uniqueByLatLng = (records) => {
      const seen = new Set();
      return records.filter((item) => {
        const latLng = toLatLng(item);
        if (!latLng) return false;
        const key = `${latLng[0].toFixed(6)},${latLng[1].toFixed(6)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const loadPoiMarkers = async () => {
      try {
        for (const poiType of POI_TYPES) {
          const rows = await fetchAllPages(poiType.query);
          const deduped = uniqueByLatLng(rows);
          deduped.forEach((row) => {
            const latLng = toLatLng(row);
            if (!latLng) return;
            const marker = L.circleMarker(latLng, {
              radius: 6,
              color: poiType.color,
              fillColor: poiType.color,
              fillOpacity: 0.9,
              weight: 1
            });
            marker.bindPopup(
              `<strong>${poiType.label}</strong><br/>${getName(row)}${getAddress(row) ? `<br/>${getAddress(row)}` : ''}`
            );
            marker.addTo(poiLayers[poiType.key]);
          });
        }
        setPoiStatus('Markers loaded from OneMap search API');
      } catch (error) {
        setPoiStatus(`Failed to load some markers: ${error.message}`);
      }
    };

    const fetchWithAuth = async (url) => {
      const response = await fetch(url, {
        headers: ONEMAP_TOKEN ? { Authorization: `Bearer ${ONEMAP_TOKEN}` } : undefined
      });
      if (!response.ok) {
        throw new Error(`OneMap themes API failed (${response.status})`);
      }
      return response.json();
    };

    const loadAdministrativeBoundaries = async () => {
      if (!ONEMAP_TOKEN) {
        setAdminStatus('Set REACT_APP_ONEMAP_API_TOKEN to enable OneMap administrative boundary layers.');
        return;
      }

      try {
        const allThemes = await fetchWithAuth(
          'https://www.onemap.gov.sg/api/public/themesvc/getAllThemesInfo?moreInfo=Y'
        );
        const themeList = Array.isArray(allThemes?.Theme_Names) ? allThemes.Theme_Names : [];
        const selectedThemes = pickAdminThemes(themeList);

        if (!selectedThemes.length) {
          setAdminStatus('No matching administrative themes found from OneMap.');
          return;
        }

        let drawn = 0;
        for (const theme of selectedThemes.slice(0, 3)) {
          const themeName = theme.THEMENAME || theme.QUERYNAME;
          const detail = await fetchWithAuth(
            `https://www.onemap.gov.sg/api/public/themesvc/retrieveTheme?queryName=${encodeURIComponent(
              theme.QUERYNAME
            )}`
          );
          const rows = Array.isArray(detail?.SrchResults) ? detail.SrchResults : [];

          for (const row of rows) {
            const path = extractPathFromRecord(row);
            if (path) {
              L.polygon(path, {
                color: '#367098',
                weight: 2,
                fillOpacity: 0.06
              })
                .bindTooltip(themeName)
                .addTo(adminBoundaryLayer);
              drawn += 1;
            }
          }
        }

        setAdminStatus(
          drawn > 0
            ? `Administrative boundaries loaded (${drawn} polygons).`
            : 'Administrative themes loaded, but no polygon geometry was found in the response.'
        );
      } catch (error) {
        setAdminStatus(`Failed to load administrative boundaries: ${error.message}`);
      }
    };

    loadPoiMarkers();
    loadAdministrativeBoundaries();
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const handleAccept = (requestId) => {
    wsRef.current?.send({
      type: 'assist_response',
      payload: {
        requestId,
        action: 'accept'
      }
    });

    setAssistRequests((prev) => prev.filter((r) => r.requestId !== requestId));
  };

  const handleDecline = (requestId) => {
    wsRef.current?.send({
      type: 'assist_response',
      payload: {
        requestId,
        action: 'decline'
      }
    });

    setAssistRequests((prev) => prev.filter((r) => r.requestId !== requestId));
  };

  return (
    <div className="staff-page">
      <header className="staff-header">
        <div className="staff-header-inner">
          <h1 className="staff-title">Staff Center</h1>
        </div>
      </header>

      <main className="staff-main">
        <section className="staff-panel">
          <h2 className="panel-title">Singapore Live Map</h2>
          <div ref={mapContainerRef} className="map-box" />
          <div className="legend-row">
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#2563eb' }} />Police</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#dc2626' }} />Fire</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#16a34a' }} />Hospital</span>
            <span className="legend-item"><span className="legend-dot" style={{ backgroundColor: '#367098' }} />Administrative Boundary</span>
          </div>
          <p className="status-text">{poiStatus}</p>
          <p className="status-text">{adminStatus}</p>
          <p className="source-text">
            Powered by OneMap API (
            <a href="https://www.onemap.gov.sg/" target="_blank" rel="noreferrer">
              onemap.gov.sg
            </a>
            )
          </p>
        </section>

        {isLoading ? (
          <div className="empty-state">Loading...</div>
        ) : assistRequests.length === 0 ? (
          <div className="empty-state">
            <h2>No pending requests</h2>
            <p>Waiting for new assist requests...</p>
          </div>
        ) : (
          <div className="request-list">
            {assistRequests.map((request) => (
              <div key={request.requestId} className="request-card">
                <div className="request-head">
                  <h3>Assist Request</h3>
                  <span
                    className={`severity-badge ${
                      request.severity === 'critical'
                        ? 'severity-critical'
                        : 'severity-warning'
                    }`}
                  >
                    {request.severity === 'critical' ? 'Critical' : 'Warning'}
                  </span>
                </div>

                <p className="request-text">
                  {request.type === 'fall' ? 'Fall detected' : 'Abnormal zone'} at {request.zoneId}
                </p>

                <div className="request-actions">
                  <button
                    onClick={() => handleAccept(request.requestId)}
                    className="btn btn-accept"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleDecline(request.requestId)}
                    className="btn btn-decline"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
