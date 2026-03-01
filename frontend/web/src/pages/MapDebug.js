import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import mapData from '../data/map.debug.json';
import './MapDebug.css';

const SVG_SIZE = 820;
const DEFAULT_ONEMAP_LINK = 'https://www.onemap.gov.sg/main/v2/?lat=1.30092&lng=103.87418&zoom=19';

function zoneColor(zoneId) {
  if (!zoneId) return '#64748b';
  if (zoneId.startsWith('Z_LS_')) return '#0ea5e9';
  if (zoneId.startsWith('Z_US_')) return '#f97316';
  if (zoneId.startsWith('Z_CON_')) return '#22c55e';
  if (zoneId.startsWith('Z_STAIR_')) return '#a855f7';
  if (zoneId.startsWith('Z_PLAZA_')) return '#eab308';
  if (zoneId.startsWith('Z_EXIT_')) return '#ef4444';
  if (zoneId === 'Z_ARENA_CENTER') return '#1d4ed8';
  return '#64748b';
}

export default function MapDebug() {
  const [zoom, setZoom] = useState(1);
  const [showLabels, setShowLabels] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const oneMapRef = useRef(null);
  const oneMapInstanceRef = useRef(null);
  const oneMapLayerRef = useRef(null);

  const { nodesById, edges, bounds, stats, affine, anchorLatLngByNodeId } = useMemo(() => {
    const nodes = Array.isArray(mapData?.graph?.nodes) ? mapData.graph.nodes : [];
    const graphEdges = Array.isArray(mapData?.graph?.edges) ? mapData.graph.edges : [];
    const routingZones = Array.isArray(mapData?.routingZones) ? mapData.routingZones : [];
    const exits = new Set(Array.isArray(mapData?.exits) ? mapData.exits : []);
    const anchors = Array.isArray(mapData?.reference?.entrancesLatLng) ? mapData.reference.entrancesLatLng : [];

    const byId = new Map();
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const n of nodes) {
      const x = Number(n?.pos?.x);
      const y = Number(n?.pos?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      byId.set(n.id, {
        id: n.id,
        routingZoneId: n.routingZoneId,
        x,
        y,
        isExit: exits.has(n.id)
      });
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    const gaussSolve3 = (A, B) => {
      const m = [
        [A[0][0], A[0][1], A[0][2], B[0]],
        [A[1][0], A[1][1], A[1][2], B[1]],
        [A[2][0], A[2][1], A[2][2], B[2]]
      ];
      for (let col = 0; col < 3; col += 1) {
        let pivot = col;
        for (let r = col + 1; r < 3; r += 1) {
          if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
        }
        if (Math.abs(m[pivot][col]) < 1e-10) return null;
        if (pivot !== col) {
          const tmp = m[col];
          m[col] = m[pivot];
          m[pivot] = tmp;
        }
        const div = m[col][col];
        for (let c = col; c < 4; c += 1) m[col][c] /= div;
        for (let r = 0; r < 3; r += 1) {
          if (r === col) continue;
          const factor = m[r][col];
          for (let c = col; c < 4; c += 1) m[r][c] -= factor * m[col][c];
        }
      }
      return [m[0][3], m[1][3], m[2][3]];
    };

    const fitAffine = () => {
      const samples = anchors
        .map((a) => {
          const n = byId.get(a.id);
          if (!n) return null;
          return {
            x: n.x,
            y: n.y,
            lat: Number(a.lat),
            lng: Number(a.lng)
          };
        })
        .filter(Boolean);

      if (samples.length < 3) return null;

      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      let sx = 0;
      let sy = 0;
      const n = samples.length;
      for (const s of samples) {
        sxx += s.x * s.x;
        syy += s.y * s.y;
        sxy += s.x * s.y;
        sx += s.x;
        sy += s.y;
      }
      const A = [
        [sxx, sxy, sx],
        [sxy, syy, sy],
        [sx, sy, n]
      ];

      let bxLat = 0;
      let byLat = 0;
      let bLat = 0;
      let bxLng = 0;
      let byLng = 0;
      let bLng = 0;
      for (const s of samples) {
        bxLat += s.x * s.lat;
        byLat += s.y * s.lat;
        bLat += s.lat;
        bxLng += s.x * s.lng;
        byLng += s.y * s.lng;
        bLng += s.lng;
      }

      const latCoeff = gaussSolve3(A, [bxLat, byLat, bLat]);
      const lngCoeff = gaussSolve3(A, [bxLng, byLng, bLng]);
      if (!latCoeff || !lngCoeff) return null;

      return {
        latCoeff,
        lngCoeff,
        predict(pos) {
          const x = Number(pos?.x || 0);
          const y = Number(pos?.y || 0);
          const lat = latCoeff[0] * x + latCoeff[1] * y + latCoeff[2];
          const lng = lngCoeff[0] * x + lngCoeff[1] * y + lngCoeff[2];
          return { lat, lng };
        }
      };
    };

    const affineModel = fitAffine();

    const anchorMap = new Map(
      anchors
        .map((a) => [String(a.id || ''), { lat: Number(a.lat), lng: Number(a.lng), name: String(a.name || '') }])
        .filter((entry) => Number.isFinite(entry[1].lat) && Number.isFinite(entry[1].lng))
    );

    return {
      nodesById: byId,
      edges: graphEdges,
      bounds: {
        minX: Number.isFinite(minX) ? minX : -1,
        maxX: Number.isFinite(maxX) ? maxX : 1,
        minY: Number.isFinite(minY) ? minY : -1,
        maxY: Number.isFinite(maxY) ? maxY : 1
      },
      stats: {
        mapId: mapData?.mapId || 'unknown',
        analysisZones: Array.isArray(mapData?.analysisZones) ? mapData.analysisZones.length : 0,
        routingZones: routingZones.length,
        nodes: nodes.length,
        edges: graphEdges.length,
        exits: exits.size
      },
      affine: affineModel,
      anchorLatLngByNodeId: anchorMap
    };
  }, []);

  const worldWidth = bounds.maxX - bounds.minX || 1;
  const worldHeight = bounds.maxY - bounds.minY || 1;
  const padding = 80;
  const scaleBase = Math.min((SVG_SIZE - padding * 2) / worldWidth, (SVG_SIZE - padding * 2) / worldHeight);
  const scale = scaleBase * zoom;

  const toScreen = (x, y) => {
    const sx = (x - bounds.minX) * scale + padding;
    const sy = (bounds.maxY - y) * scale + padding;
    return [sx, sy];
  };

  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) : null;
  const projectedPoints = useMemo(() => {
    if (!affine && !anchorLatLngByNodeId.size) return [];
    return Array.from(nodesById.values())
      .map((n) => {
        const anchor = anchorLatLngByNodeId.get(n.id);
        const ll = anchor ?? (affine ? affine.predict(n) : null);
        if (!ll) return null;
        return {
          id: n.id,
          routingZoneId: n.routingZoneId,
          isExit: n.isExit,
          lat: ll.lat,
          lng: ll.lng,
          source: anchor ? 'anchor' : 'fitted'
        };
      })
      .filter(Boolean)
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  }, [nodesById, affine, anchorLatLngByNodeId]);

  const selectedPoint = selectedNodeId ? projectedPoints.find((p) => p.id === selectedNodeId) : null;
  const selectedPointSource = selectedPoint?.source || '--';
  const selectedNodeEstimatedLatLng = selectedPoint
    ? { lat: selectedPoint.lat, lng: selectedPoint.lng }
    : null;
  const oneMapSelectedLink =
    selectedNodeEstimatedLatLng &&
    Number.isFinite(selectedNodeEstimatedLatLng.lat) &&
    Number.isFinite(selectedNodeEstimatedLatLng.lng)
      ? `https://www.onemap.gov.sg/main/v2/?lat=${selectedNodeEstimatedLatLng.lat.toFixed(7)}&lng=${selectedNodeEstimatedLatLng.lng.toFixed(7)}&zoom=19`
      : '';

  useEffect(() => {
    if (!oneMapRef.current) {
      return;
    }

    if (!oneMapInstanceRef.current) {
      const map = L.map(oneMapRef.current, {
        center: [1.30092, 103.87418],
        zoom: 19,
        minZoom: 12,
        maxZoom: 20
      });

      L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default_HD/{z}/{x}/{y}.png', {
        attribution: 'Map data (c) OpenStreetMap contributors, OneMap, Singapore Land Authority',
        maxNativeZoom: 20,
        maxZoom: 20
      }).addTo(map);

      const layer = L.layerGroup().addTo(map);
      oneMapInstanceRef.current = map;
      oneMapLayerRef.current = layer;
    }

    if (!oneMapLayerRef.current || !oneMapInstanceRef.current) {
      return;
    }

    const layer = oneMapLayerRef.current;
    const map = oneMapInstanceRef.current;
    layer.clearLayers();

    const latLngs = [];
    for (const p of projectedPoints) {
      const latLng = [p.lat, p.lng];
      latLngs.push(latLng);
      const marker = L.circleMarker(latLng, {
        radius: p.isExit ? 7 : 4,
        color: p.isExit ? '#111827' : '#0f172a',
        fillColor: p.isExit ? '#ef4444' : '#0ea5e9',
        fillOpacity: 0.95,
        weight: 1
      });
      marker.bindTooltip(`${p.id} (${p.routingZoneId})`);
      marker.addTo(layer);
    }

    if (latLngs.length > 0) {
      map.fitBounds(latLngs, { padding: [28, 28], maxZoom: 19 });
    }
  }, [projectedPoints]);

  useEffect(() => {
    return () => {
      if (oneMapInstanceRef.current) {
        oneMapInstanceRef.current.remove();
        oneMapInstanceRef.current = null;
        oneMapLayerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="map-debug-page">
      <header className="map-debug-header">
        <h1>Map Debug Viewer</h1>
        <p>Snapshot of backend/data/map.json rendered as node-edge topology.</p>
      </header>

      <main className="map-debug-main">
        <section className="map-debug-controls">
          <button onClick={() => setZoom((v) => Math.min(3.5, v + 0.2))}>Zoom In</button>
          <button onClick={() => setZoom((v) => Math.max(0.5, v - 0.2))}>Zoom Out</button>
          <button onClick={() => setZoom(1)}>Reset</button>
          <button onClick={() => setShowLabels((v) => !v)}>
            {showLabels ? 'Hide Labels' : 'Show Labels'}
          </button>
        </section>

        <section className="map-debug-stats">
          <span>Map: {stats.mapId}</span>
          <span>Analysis Zones: {stats.analysisZones}</span>
          <span>Routing Zones: {stats.routingZones}</span>
          <span>Nodes: {stats.nodes}</span>
          <span>Edges: {stats.edges}</span>
          <span>Exits: {stats.exits}</span>
        </section>

        <section className="map-debug-compare-grid">
          <div className="map-debug-canvas-wrap">
            <svg className="map-debug-canvas" viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}>
              {edges.map((edge) => {
                const from = nodesById.get(edge.from);
                const to = nodesById.get(edge.to);
                if (!from || !to) return null;
                const [x1, y1] = toScreen(from.x, from.y);
                const [x2, y2] = toScreen(to.x, to.y);
                return (
                  <line
                    key={edge.id}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={zoneColor(edge.routingZoneId)}
                    strokeWidth="2"
                    strokeOpacity="0.75"
                  />
                );
              })}

              {Array.from(nodesById.values()).map((node) => {
                const [x, y] = toScreen(node.x, node.y);
                const active = selectedNodeId === node.id;
                return (
                  <g key={node.id}>
                    <circle
                      cx={x}
                      cy={y}
                      r={active ? 8 : node.isExit ? 7 : 5}
                      fill={node.isExit ? '#b91c1c' : zoneColor(node.routingZoneId)}
                      stroke={active ? '#fde047' : '#0f172a'}
                      strokeWidth={active ? '2' : '1'}
                      onClick={() => setSelectedNodeId(node.id)}
                      className="map-debug-node"
                    />
                    {showLabels && (
                      <text x={x + 8} y={y - 8} className="map-debug-label">
                        {node.id}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="map-debug-gmap-panel">
            <div className="map-debug-gmap-live-wrap">
              <div ref={oneMapRef} className="map-debug-gmap-live" />
            </div>
            <div className="map-debug-compare-card">
              <h3>Point-to-Point Compare</h3>
              <p>Click a node on the left map to estimate its real coordinate.</p>
              <p>OneMap point markers: <strong>{projectedPoints.length}</strong></p>
              <p>Selected Node: <strong>{selectedNode?.id || '--'}</strong></p>
              <p>Zone: <strong>{selectedNode?.routingZoneId || '--'}</strong></p>
              <p>
                Estimated Lat/Lng:{' '}
                <strong>
                  {selectedNodeEstimatedLatLng
                  ? `${selectedNodeEstimatedLatLng.lat.toFixed(7)}, ${selectedNodeEstimatedLatLng.lng.toFixed(7)}`
                  : '--'}
                </strong>
              </p>
              <p>Coordinate Source: <strong>{selectedPointSource}</strong></p>
              {oneMapSelectedLink ? (
                <a href={oneMapSelectedLink} target="_blank" rel="noreferrer">
                  Open Selected Point in OneMap
                </a>
              ) : (
                <span className="map-debug-muted">Select a node first.</span>
              )}
              <p className="map-debug-muted">
                OneMap base: <a href={DEFAULT_ONEMAP_LINK} target="_blank" rel="noreferrer">Open stadium center</a>
              </p>
            </div>
          </div>
        </section>

        <section className="map-debug-legend">
          <span><i style={{ background: '#1d4ed8' }} />Arena</span>
          <span><i style={{ background: '#0ea5e9' }} />Lower Seats</span>
          <span><i style={{ background: '#f97316' }} />Upper Seats</span>
          <span><i style={{ background: '#22c55e' }} />Concourse</span>
          <span><i style={{ background: '#a855f7' }} />Stairs</span>
          <span><i style={{ background: '#eab308' }} />Plaza</span>
          <span><i style={{ background: '#ef4444' }} />Exit</span>
        </section>
      </main>
    </div>
  );
}
