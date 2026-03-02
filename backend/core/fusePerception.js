"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fusePerception = fusePerception;
/* =====================================
   Configurable Parameters
===================================== */
const WEIGHTS = {
    density: 0.6,
    anomaly: 0.4
};
const SEVERITY_THRESHOLDS = {
    warn: 0.5,
    critical: 0.8
};
/* =====================================
   Risk Fusion
===================================== */
function fusePerception(frame) {
    const now = Date.now();
    return frame.zones.map(zone => {
        // 1. Linear weighted fusion
        const rawRisk = WEIGHTS.density * zone.density +
            WEIGHTS.anomaly * zone.anomaly;
        // 2. Confidence modulation
        const confidenceAdjustedRisk = rawRisk * clamp01(zone.conf);
        // 3. Normalization
        const risk = clamp01(confidenceAdjustedRisk);
        // 4. Severity classification
        const severity = risk >= SEVERITY_THRESHOLDS.critical
            ? "critical"
            : risk >= SEVERITY_THRESHOLDS.warn
                ? "warn"
                : "info";
        return {
            analysisZoneId: zone.zoneId,
            risk,
            density: zone.density,
            anomaly: zone.anomaly,
            severity,
            confidence: zone.conf,
            timestamp: now
        };
    });
}
/* =====================================
   Utilities
===================================== */
function clamp01(x) {
    if (Number.isNaN(x))
        return 0;
    return Math.max(0, Math.min(1, x));
}
