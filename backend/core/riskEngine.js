"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskEngine = void 0;
const events_1 = require("events");
const fusePerception_1 = require("./fusePerception");
const zoneMapping_json_1 = __importDefault(require("../data/zoneMapping.json"));
const stateEngine_1 = require("./stateEngine");
class RiskEngine extends events_1.EventEmitter {
    state;
    analysisSnapshots = new Map();
    routingZoneRiskEma = new Map();
    constructor(cfg) {
        super();
        this.state = new stateEngine_1.RiskStateEngine(cfg);
    }
    /**
     * ML → fusePerception → RiskStateEngine (EMA + hysteresis) → expandToRoutingZones
     */
    ingestFrame(frame) {
        const fused = (0, fusePerception_1.fusePerception)(frame);
        const ts = Date.now();
        const outputs = this.state.updateMany(fused.map(z => ({
            zoneId: z.analysisZoneId,
            ts,
            riskRaw: z.risk,
            density: z.density,
            anomaly: z.anomaly,
            conf: z.confidence
        })));
        const changedAnalysisZones = [];
        for (const o of outputs) {
            const prev = this.analysisSnapshots.get(o.zoneId);
            const snapshot = {
                analysisZoneId: o.zoneId,
                riskRaw: o.riskRaw,
                riskEma: o.riskEma,
                severity: o.severity,
                trend: o.trend,
                slopePerSec: o.slopePerSec,
                ts: o.ts,
                density: o.density,
                anomaly: o.anomaly,
                conf: o.conf
            };
            this.analysisSnapshots.set(o.zoneId, snapshot);
            // "changed" from RiskStateEngine only flags severity transitions.
            // Also treat significant EMA delta as change for decision triggers.
            const prevEma = prev?.riskEma ?? snapshot.riskEma;
            const emaDelta = Math.abs(snapshot.riskEma - prevEma);
            if (o.changed || emaDelta >= 0.08) {
                changedAnalysisZones.push(o.zoneId);
            }
        }
        const changedRoutingZones = this.expandToRoutingZones(changedAnalysisZones);
        const payload = {
            ts,
            changedAnalysisZones,
            changedRoutingZones,
            globalMaxRiskEma: this.getGlobalMaxRiskEma()
        };
        // Emit always if you want maximum reactivity:
        // this.emit("riskUpdated", payload);
        // Emit only when meaningful changes happened:
        if (changedAnalysisZones.length > 0 || changedRoutingZones.length > 0) {
            this.emit("riskUpdated", payload);
        }
    }
    /**
     * Expand analysis-zone EMA risk to routing zones using routingToAnalysis mapping.
     * Returns routing zones that changed by >= threshold.
     */
    expandToRoutingZones(changedAnalysisZones) {
        const routingToAnalysis = zoneMapping_json_1.default.routingToAnalysis;
        const changedRoutingZones = [];
        // If you want smarter diffing: only recompute routing zones whose parent AZ changed.
        // Otherwise recompute all routing zones (still cheap for small maps).
        const shouldDiff = Array.isArray(changedAnalysisZones) && changedAnalysisZones.length > 0;
        for (const routingZoneId of Object.keys(routingToAnalysis)) {
            const analysisZoneId = routingToAnalysis[routingZoneId];
            if (shouldDiff && !changedAnalysisZones.includes(analysisZoneId)) {
                continue;
            }
            const ema = this.analysisSnapshots.get(analysisZoneId)?.riskEma ?? 0;
            const prev = this.routingZoneRiskEma.get(routingZoneId) ?? 0;
            this.routingZoneRiskEma.set(routingZoneId, ema);
            if (Math.abs(ema - prev) >= 0.08) {
                changedRoutingZones.push(routingZoneId);
            }
        }
        // If diffing skipped zones, ensure routingZoneRiskEma exists for all zones at least once.
        if (!shouldDiff)
            return changedRoutingZones;
        // One-time initialization fallback: if map expanded, fill missing routing zones.
        for (const routingZoneId of Object.keys(routingToAnalysis)) {
            if (!this.routingZoneRiskEma.has(routingZoneId)) {
                const analysisZoneId = routingToAnalysis[routingZoneId];
                const ema = this.analysisSnapshots.get(analysisZoneId)?.riskEma ?? 0;
                this.routingZoneRiskEma.set(routingZoneId, ema);
                changedRoutingZones.push(routingZoneId);
            }
        }
        return changedRoutingZones;
    }
    /**
     * Routing-zone EMA risk (0..1)
     */
    getZoneRisk(routingZoneId) {
        return this.routingZoneRiskEma.get(routingZoneId) ?? 0;
    }
    /**
     * Returns a plain object snapshot for routing risk.
     */
    getAllZoneRisk() {
        return Object.fromEntries(this.routingZoneRiskEma.entries());
    }
    /**
     * Analysis-zone snapshots (EMA + severity + trend). Useful for debugging / UI.
     */
    getAnalysisSnapshots() {
        return Object.fromEntries(this.analysisSnapshots.entries());
    }
    getGlobalMaxRiskEma() {
        let m = 0;
        for (const s of this.analysisSnapshots.values()) {
            if (s.riskEma > m)
                m = s.riskEma;
        }
        return m;
    }
    /**
     * Testing hook: override routing zone EMA risk directly.
     * Use this to validate auto-reroute logic without ML.
     */
    setZoneRisk(routingZoneId, riskEma) {
        const clamped = clamp01(riskEma);
        const prev = this.routingZoneRiskEma.get(routingZoneId) ?? 0;
        this.routingZoneRiskEma.set(routingZoneId, clamped);
        const payload = {
            ts: Date.now(),
            changedAnalysisZones: [],
            changedRoutingZones: Math.abs(clamped - prev) >= 0.01 ? [routingZoneId] : [],
            globalMaxRiskEma: this.getGlobalMaxRiskEma()
        };
        this.emit("riskUpdated", payload);
    }
}
exports.RiskEngine = RiskEngine;
function clamp01(x) {
    if (Number.isNaN(x))
        return 0;
    return Math.max(0, Math.min(1, x));
}
