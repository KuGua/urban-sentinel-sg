"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoutingEngine = void 0;
const config_1 = __importDefault(require("../src/config"));
class RoutingEngine {
    map;
    constructor(map) {
        this.map = map;
    }
    /* =========================================================
       Public API
    ========================================================= */
    computeRoute(routingRisk, localDeltas, zoneLoadRatio, globalMode, fromNodeId, toNodeId, userId) {
        const adjacency = this.buildAdjacency(routingRisk, localDeltas, zoneLoadRatio, globalMode);
        const result = this.aStar(adjacency, fromNodeId, toNodeId);
        if (!result) {
            throw new Error("No route found");
        }
        const edgeMap = Object.fromEntries(this.map.graph.edges.map(e => [e.id, e]));
        const zonePath = result.edges.map(edgeId => edgeMap[edgeId]?.routingZoneId ?? "UNKNOWN");
        return {
            userId,
            ts: Date.now(),
            mapId: this.map.mapId,
            pathNodeIds: result.path,
            pathEdgeIds: result.edges,
            zonePath,
            reason: "auto",
            est: {
                distance: result.distance
            }
        };
    }
    getExitNodes() {
        return (this.map.exits ?? []).map(id => ({ id }));
    }
    /* =========================================================
       Internal — Graph Construction
    ========================================================= */
    buildAdjacency(routingRisk, localDeltas, zoneLoadRatio, globalMode) {
        const adj = {};
        const modeMultiplier = config_1.default.MODE_MULTIPLIER[globalMode] ?? 1;
        for (const edge of this.map.graph.edges) {
            const zoneId = edge.routingZoneId;
            const risk = routingRisk[zoneId] ?? 0;
            const delta = localDeltas[zoneId] ?? 0;
            const loadRatio = zoneLoadRatio[zoneId] ?? 1;
            const isBlocked = edge.meta?.isBlocking === true ||
                delta >= 9999;
            if (isBlocked)
                continue;
            const congestionMultiplier = 1 + config_1.default.CONGESTION_SCALE *
                Math.max(0, loadRatio - 1);
            const baseCost = edge.length *
                modeMultiplier *
                congestionMultiplier;
            const riskPenalty = config_1.default.RISK_PENALTY_SCALE * risk;
            const cost = baseCost + riskPenalty + delta;
            (adj[edge.from] ??= []).push({
                to: edge.to,
                edgeId: edge.id,
                cost
            });
            if (!edge.meta?.isOneWay) {
                (adj[edge.to] ??= []).push({
                    to: edge.from,
                    edgeId: edge.id,
                    cost
                });
            }
        }
        return adj;
    }
    /* =========================================================
       A* Search
    ========================================================= */
    aStar(adj, start, goal) {
        const open = new Set([start]);
        const cameFrom = {};
        const gScore = {
            [start]: 0
        };
        const fScore = {
            [start]: this.heuristic(start, goal)
        };
        while (open.size > 0) {
            const current = this.lowestFScore(open, fScore);
            if (current === goal) {
                return this.reconstruct(cameFrom, current, gScore[current]);
            }
            open.delete(current);
            for (const neighbor of adj[current] ?? []) {
                const tentative = (gScore[current] ?? Infinity) + neighbor.cost;
                if (tentative < (gScore[neighbor.to] ?? Infinity)) {
                    cameFrom[neighbor.to] = {
                        prev: current,
                        edge: neighbor.edgeId
                    };
                    gScore[neighbor.to] = tentative;
                    fScore[neighbor.to] =
                        tentative +
                            this.heuristic(neighbor.to, goal);
                    open.add(neighbor.to);
                }
            }
        }
        return null;
    }
    /* =========================================================
       Utilities
    ========================================================= */
    heuristic(a, b) {
        const nodeMap = Object.fromEntries(this.map.graph.nodes.map(n => [n.id, n.pos]));
        const pa = nodeMap[a];
        const pb = nodeMap[b];
        if (!pa || !pb)
            return 0;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        return Math.sqrt(dx * dx + dy * dy) * 0.01;
    }
    lowestFScore(open, fScore) {
        let best = "";
        let bestVal = Infinity;
        for (const node of open) {
            const val = fScore[node] ?? Infinity;
            if (val < bestVal) {
                bestVal = val;
                best = node;
            }
        }
        return best;
    }
    reconstruct(cameFrom, current, distance) {
        const path = [current];
        const edges = [];
        let cur = current;
        while (cameFrom[cur]) {
            const step = cameFrom[cur];
            edges.push(step.edge);
            cur = step.prev;
            path.push(cur);
        }
        path.reverse();
        edges.reverse();
        return {
            path,
            edges,
            distance
        };
    }
}
exports.RoutingEngine = RoutingEngine;
