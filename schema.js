"use strict";
/* shared/schema.ts
 *
 * SafeFlow integration contract with TWO-LAYER ZONES:
 * - Analysis Zones (AZ*): coarse zones used by ML for stable perception on low-res CCTV
 * - Routing Zones (Z*): finer zones used by routing, UI, and targeted notifications
 *
 * Conventions:
 * - Coordinates are in the SAME coordinate space as rendered map (e.g., SVG pixels).
 * - Routing zones MUST belong to exactly one analysis zone via parentAnalysisZoneId.
 * - Graph edges reference routingZoneId (Z*), NOT analysis zone ids.
 * - Timestamps are epoch milliseconds (Date.now()).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandRiskToRoutingZones = expandRiskToRoutingZones;
exports.clamp01 = clamp01;
//////////////////////////////
// Backend Helper Functions (optional but recommended)
//////////////////////////////
/**
 * Expand analysis-zone risks to routing-zone risks using zone mapping.
 * - analysisRiskById: Map<"AZ*", AnalysisZoneRisk>
 * - routingZones: list of routing zones with parentAnalysisZoneId
 * - localDeltasByRoutingZoneId: optional local modifiers from incidents, etc.
 */
function expandRiskToRoutingZones(analysisRisks, routingZones, localDeltasByRoutingZoneId) {
    const byAZ = Object.fromEntries(analysisRisks.map((r) => [r.analysisZoneId, r]));
    return routingZones.map((rz) => {
        const parent = byAZ[rz.parentAnalysisZoneId];
        const baseRisk = parent?.risk ?? 0;
        const delta = localDeltasByRoutingZoneId?.[rz.id] ?? 0;
        const risk = clamp01(baseRisk + delta);
        const severity = risk >= 0.8 ? "critical" : risk >= 0.5 ? "warn" : "info";
        return {
            routingZoneId: rz.id,
            parentAnalysisZoneId: rz.parentAnalysisZoneId,
            risk,
            severity,
            localDelta: delta || undefined,
            conf: parent?.conf,
        };
    });
}
function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}
