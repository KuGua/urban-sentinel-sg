import React, { useEffect, useRef, useState } from 'react';
import { WebSocketClient } from '../api/websocket';
import './StaffHomeStadium.css';

const BACKEND_BASE_URL = (process.env.REACT_APP_API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const DISPATCH_ENDPOINT = process.env.REACT_APP_DISPATCH_ENDPOINT || '/dispatch/request';
const STADIUM_COORDINATE = { lat: 1.30092, lng: 103.87418 };

function buildBackendUrl(endpoint) {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (!normalizedEndpoint) {
    return `${BACKEND_BASE_URL}/dispatch/request`;
  }
  if (/^https?:\/\//i.test(normalizedEndpoint)) {
    return normalizedEndpoint;
  }
  if (normalizedEndpoint.startsWith('/')) {
    return `${BACKEND_BASE_URL}${normalizedEndpoint}`;
  }
  return `${BACKEND_BASE_URL}/${normalizedEndpoint}`;
}

export default function StaffHomeStadium() {
  const [assistRequests, setAssistRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [systemMetrics, setSystemMetrics] = useState({
    workingCameras: null,
    totalUsers: null,
    generatedAt: null
  });
  const [systemStatus, setSystemStatus] = useState('Loading system metrics from backend...');
  const [dispatchStatus, setDispatchStatus] = useState('Ready for one-click emergency dispatch.');
  const [isDispatching, setIsDispatching] = useState(false);
  const wsRef = useRef(null);

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
    let isCancelled = false;

    const toLocalFallbackMetrics = () => {
      const now = Date.now();
      const users = 4300 + (new Date().getSeconds() % 17) * 24;
      const cameras = 58 + (new Date().getSeconds() % 4);
      return {
        workingCameras: cameras,
        totalUsers: users,
        generatedAt: now
      };
    };

    const fetchSystemMetrics = async () => {
      try {
        const response = await fetch(`${BACKEND_BASE_URL}/system/metrics`);
        if (!response.ok) {
          throw new Error(`Backend request failed (${response.status})`);
        }
        const data = await response.json();
        if (isCancelled) return;

        setSystemMetrics({
          workingCameras: Number.isFinite(Number(data?.workingCameras))
            ? Number(data.workingCameras)
            : null,
          totalUsers: Number.isFinite(Number(data?.totalUsers))
            ? Number(data.totalUsers)
            : null,
          generatedAt: Number.isFinite(Number(data?.generatedAt))
            ? Number(data.generatedAt)
            : null
        });
        setSystemStatus('System metrics synced from backend.');
      } catch (_error) {
        if (isCancelled) return;
        setSystemMetrics(toLocalFallbackMetrics());
        setSystemStatus('Backend metrics unavailable. Showing local estimated stadium metrics.');
      }
    };

    fetchSystemMetrics();
    const intervalId = window.setInterval(fetchSystemMetrics, 5000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const handleDispatch = async (serviceType) => {
    setIsDispatching(true);
    setDispatchStatus('Sending dispatch request...');

    const payload = {
      type: 'emergency_dispatch',
      serviceType,
      strategy: 'nearest_unit',
      target: STADIUM_COORDINATE,
      requestedAt: new Date().toISOString(),
      source: 'staff_stadium'
    };

    try {
      const response = await fetch(buildBackendUrl(DISPATCH_ENDPOINT), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        let detail = '';
        try {
          const errorBody = await response.json();
          detail = errorBody?.error ? `: ${errorBody.error}` : '';
        } catch {
          // no-op
        }
        throw new Error(`Backend request failed (${response.status})${detail}`);
      }

      const result = await response.json();
      const unitText = result?.assignedUnit ? ` (${result.assignedUnit})` : '';
      const etaText = Number.isFinite(Number(result?.etaMinutes)) ? `, ETA ${Number(result.etaMinutes)} min` : '';
      setDispatchStatus(`Dispatch sent: ${serviceType}${unitText}${etaText}.`);
    } catch (error) {
      setDispatchStatus(`Dispatch failed: ${error.message}`);
    } finally {
      setIsDispatching(false);
    }
  };

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
    <div className="stadium-page">
      <header className="stadium-header">
        <div className="stadium-header-inner">
          <h1 className="stadium-title">Singapore Indoor Stadium Map</h1>
          <p className="stadium-subtitle">Independent map page (does not affect StaffHome / StaffHomeNTU)</p>
        </div>
      </header>

      <main className="stadium-main">
        <section className="stadium-panel">
          <h2 className="stadium-panel-title">Embedded Google Map</h2>
          <div className="stadium-map-and-system">
            <div className="stadium-map-frame-wrap">
              <iframe
                title="Singapore Indoor Stadium Map"
                className="stadium-map-frame"
                src="https://www.google.com/maps?q=1.30092,103.87418&z=19&output=embed"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                allowFullScreen
              />
            </div>
            <aside className="stadium-system-panel" aria-label="Stadium System Module">
              <h3 className="stadium-system-title">System Module</h3>
              <div className="stadium-system-metric-grid">
                <div className="stadium-system-metric-card">
                  <p className="stadium-system-metric-label">Working Cameras</p>
                  <p className="stadium-system-metric-value">{systemMetrics.workingCameras ?? '--'}</p>
                </div>
                <div className="stadium-system-metric-card">
                  <p className="stadium-system-metric-label">Total Users</p>
                  <p className="stadium-system-metric-value">{systemMetrics.totalUsers ?? '--'}</p>
                </div>
              </div>
              <p className="stadium-system-status">{systemStatus}</p>
              <p className="stadium-system-status">
                Last update:{' '}
                {systemMetrics.generatedAt ? new Date(systemMetrics.generatedAt).toLocaleTimeString() : '--'}
              </p>
              <div className="stadium-dispatch-panel">
                <h4 className="stadium-dispatch-title">Emergency Dispatch</h4>
                <p className="stadium-dispatch-text">
                  Target: Singapore Indoor Stadium ({STADIUM_COORDINATE.lat}, {STADIUM_COORDINATE.lng})
                </p>
                <div className="stadium-dispatch-actions">
                  <button
                    type="button"
                    className="stadium-dispatch-btn stadium-dispatch-police"
                    disabled={isDispatching}
                    onClick={() => handleDispatch('police')}
                  >
                    One-click Police
                  </button>
                  <button
                    type="button"
                    className="stadium-dispatch-btn stadium-dispatch-fire"
                    disabled={isDispatching}
                    onClick={() => handleDispatch('firefighter')}
                  >
                    One-click Fire Crew
                  </button>
                  <button
                    type="button"
                    className="stadium-dispatch-btn stadium-dispatch-ambulance"
                    disabled={isDispatching}
                    onClick={() => handleDispatch('ambulance')}
                  >
                    One-click Ambulance
                  </button>
                </div>
                <p className="stadium-dispatch-text">{dispatchStatus}</p>
              </div>
            </aside>
          </div>
          <p className="stadium-note">
            Source:{' '}
            <a
              href="https://www.google.com/maps/place/Singapore+Indoor+Stadium/"
              target="_blank"
              rel="noreferrer"
            >
              Google Maps - Singapore Indoor Stadium
            </a>
          </p>
        </section>

        {isLoading ? (
          <div className="stadium-empty-state">Loading...</div>
        ) : assistRequests.length === 0 ? (
          <div className="stadium-empty-state">
            <h2>No pending requests</h2>
            <p>Waiting for new assist requests...</p>
          </div>
        ) : (
          <div className="stadium-request-list">
            {assistRequests.map((request) => (
              <div key={request.requestId} className="stadium-request-card">
                <div className="stadium-request-head">
                  <h3>Assist Request</h3>
                  <span
                    className={`stadium-severity-badge ${
                      request.severity === 'critical'
                        ? 'stadium-severity-critical'
                        : 'stadium-severity-warning'
                    }`}
                  >
                    {request.severity === 'critical' ? 'Critical' : 'Warning'}
                  </span>
                </div>
                <p className="stadium-request-text">
                  {request.message || 'Assist request'}
                  {request.loc?.zoneId ? ` (Zone ${request.loc.zoneId})` : ''}
                </p>
                <div className="stadium-request-actions">
                  <button
                    onClick={() => handleAccept(request.requestId)}
                    className="stadium-btn stadium-btn-accept"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleDecline(request.requestId)}
                    className="stadium-btn stadium-btn-decline"
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
