"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskStateEngine = void 0;
function clamp01(x) {
    if (x < 0)
        return 0;
    if (x > 1)
        return 1;
    return x;
}
function classifyTrend(slopePerSec, eps) {
    if (slopePerSec > eps)
        return "rising";
    if (slopePerSec < -eps)
        return "falling";
    return "flat";
}
class RiskStateEngine {
    cfg;
    states = new Map();
    constructor(cfg) {
        this.cfg = {
            emaAlpha: 0.35,
            warnUp: 0.55,
            warnDown: 0.45,
            criticalUp: 0.8,
            criticalDown: 0.65,
            toWarnHoldMs: 1200,
            toCriticalHoldMs: 900,
            toInfoHoldMs: 2000,
            toWarnFromCriticalHoldMs: 1500,
            minChangeIntervalMs: 1200,
            slopeEps: 0.05,
            clampToUnit: true,
            ...cfg,
        };
        if (!(this.cfg.emaAlpha > 0 && this.cfg.emaAlpha <= 1)) {
            throw new Error("emaAlpha must be in (0,1].");
        }
        if (!(this.cfg.warnDown < this.cfg.warnUp)) {
            throw new Error("warnDown must be < warnUp.");
        }
        if (!(this.cfg.criticalDown < this.cfg.criticalUp)) {
            throw new Error("criticalDown must be < criticalUp.");
        }
    }
    update(input) {
        const zoneId = input.zoneId;
        const ts = input.ts;
        let riskRaw = input.riskRaw;
        if (this.cfg.clampToUnit)
            riskRaw = clamp01(riskRaw);
        const prev = this.states.get(zoneId);
        if (!prev) {
            const sev = riskRaw >= this.cfg.criticalUp ? "critical" :
                riskRaw >= this.cfg.warnUp ? "warn" : "info";
            const init = {
                zoneId,
                riskEma: riskRaw,
                lastRiskRaw: riskRaw,
                trend: "flat",
                slopePerSec: 0,
                severity: sev,
                lastSeverityChangeTs: ts,
                lastTs: ts,
                sampleCount: 1,
                aboveWarnMs: 0,
                aboveCriticalMs: 0,
                belowWarnMs: 0,
                belowCriticalMs: 0,
            };
            this.states.set(zoneId, init);
            return {
                zoneId,
                ts,
                riskRaw,
                riskEma: init.riskEma,
                trend: init.trend,
                slopePerSec: init.slopePerSec,
                severity: init.severity,
                changed: false,
                density: input.density,
                anomaly: input.anomaly,
                conf: input.conf,
            };
        }
        const dtMs = Math.max(0, ts - prev.lastTs);
        const dtSec = dtMs / 1000;
        const alpha = this.cfg.emaAlpha;
        const riskEma = alpha * riskRaw + (1 - alpha) * prev.riskEma;
        let slopePerSec = prev.slopePerSec;
        if (dtSec > 0)
            slopePerSec = (riskEma - prev.riskEma) / dtSec;
        const trend = classifyTrend(slopePerSec, this.cfg.slopeEps);
        const aboveWarn = riskEma >= this.cfg.warnUp;
        const aboveCritical = riskEma >= this.cfg.criticalUp;
        const belowWarn = riskEma <= this.cfg.warnDown;
        const belowCritical = riskEma <= this.cfg.criticalDown;
        let aboveWarnMs = aboveWarn ? prev.aboveWarnMs + dtMs : 0;
        let aboveCriticalMs = aboveCritical ? prev.aboveCriticalMs + dtMs : 0;
        let belowWarnMs = belowWarn ? prev.belowWarnMs + dtMs : 0;
        let belowCriticalMs = belowCritical ? prev.belowCriticalMs + dtMs : 0;
        const nowSeverity = prev.severity;
        const canChange = (ts - prev.lastSeverityChangeTs) >= this.cfg.minChangeIntervalMs;
        let nextSeverity = nowSeverity;
        if (canChange) {
            if (nowSeverity === "info") {
                if (aboveWarnMs >= this.cfg.toWarnHoldMs)
                    nextSeverity = "warn";
            }
            else if (nowSeverity === "warn") {
                if (aboveCriticalMs >= this.cfg.toCriticalHoldMs)
                    nextSeverity = "critical";
                else if (belowWarnMs >= this.cfg.toInfoHoldMs)
                    nextSeverity = "info";
            }
            else {
                if (belowCriticalMs >= this.cfg.toWarnFromCriticalHoldMs)
                    nextSeverity = "warn";
            }
        }
        const changed = nextSeverity !== nowSeverity;
        const updated = {
            ...prev,
            riskEma,
            lastRiskRaw: riskRaw,
            trend,
            slopePerSec,
            severity: nextSeverity,
            lastSeverityChangeTs: changed ? ts : prev.lastSeverityChangeTs,
            lastTs: ts,
            sampleCount: prev.sampleCount + 1,
            aboveWarnMs,
            aboveCriticalMs,
            belowWarnMs,
            belowCriticalMs,
        };
        this.states.set(zoneId, updated);
        return {
            zoneId,
            ts,
            riskRaw,
            riskEma,
            trend,
            slopePerSec,
            severity: nextSeverity,
            changed,
            density: input.density,
            anomaly: input.anomaly,
            conf: input.conf,
        };
    }
    updateMany(inputs) {
        return inputs.map((x) => this.update(x));
    }
}
exports.RiskStateEngine = RiskStateEngine;
