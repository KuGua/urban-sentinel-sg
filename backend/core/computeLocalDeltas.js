"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeLocalDeltas = computeLocalDeltas;
const config_1 = __importDefault(require("../src/config"));
function computeLocalDeltas(incidents) {
    const deltas = {};
    for (const inc of incidents) {
        const penalty = inc.routingImpact?.hazardPenalty ??
            config_1.default.INCIDENT_PENALTY_DEFAULT;
        if (inc.routingImpact?.affectedRoutingZoneIds) {
            for (const z of inc.routingImpact.affectedRoutingZoneIds) {
                deltas[z] = (deltas[z] ?? 0) + penalty;
            }
        }
        else {
            deltas[inc.loc.zoneId] =
                (deltas[inc.loc.zoneId] ?? 0) + penalty;
        }
    }
    return deltas;
}
