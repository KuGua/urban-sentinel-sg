"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RouteEvaluator = void 0;
class RouteEvaluator {
    getZoneRisk;
    getZoneIncident;
    getZoneLoadRatio;
    constructor(getZoneRisk, getZoneIncident, getZoneLoadRatio) {
        this.getZoneRisk = getZoneRisk;
        this.getZoneIncident = getZoneIncident;
        this.getZoneLoadRatio = getZoneLoadRatio;
    }
    evaluate(routeZones) {
        let maxRisk = 0;
        let hasIncidentBlock = false;
        let congestionViolationSoon = false;
        let entersHighRiskSoon = false;
        const violatingZones = [];
        for (let i = 0; i < Math.min(routeZones.length, 6); i++) {
            const zone = routeZones[i];
            const risk = this.getZoneRisk(zone);
            const incident = this.getZoneIncident(zone);
            const loadRatio = this.getZoneLoadRatio(zone);
            maxRisk = Math.max(maxRisk, risk);
            if (incident) {
                hasIncidentBlock = true;
                violatingZones.push(zone);
            }
            if (risk >= 0.75) {
                entersHighRiskSoon = true;
                violatingZones.push(zone);
            }
            if (loadRatio >= 1.15) {
                congestionViolationSoon = true;
                violatingZones.push(zone);
            }
        }
        return {
            hasIncidentBlock,
            entersHighRiskSoon,
            congestionViolationSoon,
            violatingZones,
            maxRisk,
        };
    }
}
exports.RouteEvaluator = RouteEvaluator;
