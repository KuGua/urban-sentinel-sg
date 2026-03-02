"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketPublisher = void 0;
class WebSocketPublisher {
    wss;
    constructor(wss) {
        this.wss = wss;
    }
    emitRouteUpdate(userId, route) {
        this.wss.to(userId).emit("route_update", route);
    }
    emitGuidance(userId, guidance) {
        this.wss.to(userId).emit("guidance", guidance);
    }
}
exports.WebSocketPublisher = WebSocketPublisher;
