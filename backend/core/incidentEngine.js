"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IncidentEngine = void 0;
const events_1 = require("events");
const computeLocalDeltas_1 = require("./computeLocalDeltas");
class IncidentEngine extends events_1.EventEmitter {
    incidents = [];
    localDeltas = {};
    constructor() {
        super();
    }
    /* ================================
       Update incidents
    ================================ */
    setIncidents(incidents) {
        this.incidents = incidents;
        this.recompute();
    }
    addIncident(incident) {
        this.incidents.push(incident);
        this.recompute();
    }
    clearIncident(id) {
        this.incidents = this.incidents.filter(i => i.id !== id);
        this.recompute();
    }
    /* ================================
       Internal recompute
    ================================ */
    recompute() {
        this.localDeltas = (0, computeLocalDeltas_1.computeLocalDeltas)(this.incidents);
        this.emit("incidentUpdated", {
            changedZones: Object.keys(this.localDeltas)
        });
    }
    /* ================================
       Getters
    ================================ */
    getLocalDeltas() {
        return this.localDeltas;
    }
    isZoneBlocked(zoneId) {
        return (this.localDeltas[zoneId] ?? 0) >= 9999;
    }
}
exports.IncidentEngine = IncidentEngine;
