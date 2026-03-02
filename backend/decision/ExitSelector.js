"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExitSelector = void 0;
class ExitSelector {
    exits;
    computeRoute;
    constructor(exits, computeRoute) {
        this.exits = exits;
        this.computeRoute = computeRoute;
    }
    selectBestExit(currentNode) {
        let bestExit = null;
        let bestScore = Infinity;
        for (const exit of this.exits) {
            const route = this.computeRoute(currentNode, exit.id);
            if (route.cost < bestScore) {
                bestScore = route.cost;
                bestExit = exit.id;
            }
        }
        return bestExit;
    }
}
exports.ExitSelector = ExitSelector;
