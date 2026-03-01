import { WsServerEvent, WsClientEvent } from "../../../schema";
import { getWsBaseUrl } from "./config";

export class WebSocketClient {
  private ws: WebSocket;
  private eventHandlers: Record<string, ((event: WsServerEvent) => void)[]> = {};
  private pendingMessages: WsClientEvent[] = [];

  constructor() {
    this.ws = new WebSocket(getWsBaseUrl());
    this.ws.onopen = () => {
      for (const msg of this.pendingMessages) {
        this.ws.send(JSON.stringify(msg));
      }
      this.pendingMessages = [];
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsServerEvent;
        this.emit(data.type, data);
      } catch {
        // Ignore malformed payloads to keep ws client alive.
      }
    };
  }

  public on(type: string, handler: (event: WsServerEvent) => void) {
    if (!this.eventHandlers[type]) {
      this.eventHandlers[type] = [];
    }
    this.eventHandlers[type].push(handler);
  }

  private emit(type: string, event: WsServerEvent) {
    const handlers = this.eventHandlers[type];
    if (handlers) {
      handlers.forEach(handler => handler(event));
    }
  }

  public send(event: WsClientEvent) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
      return;
    }
    this.pendingMessages.push(event);
  }
}
