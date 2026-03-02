"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandToRoutingZones = expandToRoutingZones;
/**
 * Expand analysis-zone risk (EMA-based) to routing zones.
 * Does NOT mix in local deltas. Risk remains perception-derived only.
 */
function expandToRoutingZones(analysis, routingZones) {
    const byAZ = Object.fromEntries(analysis.map(a => [a.analysisZoneId, a]));
    return routingZones.map(rz => {
        const parent = byAZ[rz.parentAnalysisZoneId];
        const risk = clamp01(parent?.risk ?? 0);
        const severity = risk >= 0.8 ? "critical" :
            risk >= 0.5 ? "warn" : "info";
        return {
            routingZoneId: rz.id,
            parentAnalysisZoneId: rz.parentAnalysisZoneId,
            risk,
            severity,
            conf: parent?.conf
        };
    });
}
function clamp01(x) {
    if (Number.isNaN(x))
        return 0;
    return Math.max(0, Math.min(1, x));
}
