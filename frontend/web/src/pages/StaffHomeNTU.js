import React, { useEffect, useState, useRef } from 'react';
import { WebSocketClient } from '../api/websocket';
import './StaffHome.css';

const BACKEND_BASE_URL = (process.env.REACT_APP_API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

export default function StaffHomeNTU() {
  const [assistRequests, setAssistRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [systemMetrics, setSystemMetrics] = useState({
    workingCameras: null,
    totalUsers: null,
    generatedAt: null
  });
  const [systemStatus, setSystemStatus] = useState('Loading system metrics from backend...');
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
    return () => ws.disconnect();
  }, []);

  useEffect(() => {
    let isCancelled = false;

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
      } catch (error) {
        if (isCancelled) return;
        setSystemStatus(`Failed to load system metrics: ${error.message}`);
      }
    };

    fetchSystemMetrics();
    const intervalId = window.setInterval(fetchSystemMetrics, 5000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
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
          <h1 className="staff-title">Staff Center - NTU Map</h1>
        </div>
      </header>

      <main className="staff-main">
        <section className="staff-panel">
          <h2 className="panel-title">NTU Live Map</h2>
          <div className="map-and-system">
            <div className="ntu-map-box">
              <iframe
                title="NTU Maps"
                src="https://maps.ntu.edu.sg/"
                className="ntu-map-iframe"
                allow="geolocation; fullscreen"
              />
            </div>
            <aside className="system-panel" aria-label="System Module">
              <h3 className="system-title">System Module</h3>
              <div className="system-metric-grid">
                <div className="system-metric-card">
                  <p className="system-metric-label">Working Cameras</p>
                  <p className="system-metric-value">
                    {systemMetrics.workingCameras ?? '--'}
                  </p>
                </div>
                <div className="system-metric-card">
                  <p className="system-metric-label">Total Users</p>
                  <p className="system-metric-value">
                    {systemMetrics.totalUsers ?? '--'}
                  </p>
                </div>
              </div>
              <p className="system-status">{systemStatus}</p>
              <p className="system-status">
                Last update:{' '}
                {systemMetrics.generatedAt
                  ? new Date(systemMetrics.generatedAt).toLocaleTimeString()
                  : '--'}
              </p>
            </aside>
          </div>
          <p className="source-text">
            Map source:{' '}
            <a href="https://maps.ntu.edu.sg/" target="_blank" rel="noreferrer">
              maps.ntu.edu.sg
            </a>
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
                  {request.message || 'Assist request'}{request.loc?.zoneId ? ` (Zone ${request.loc.zoneId})` : ''}
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
