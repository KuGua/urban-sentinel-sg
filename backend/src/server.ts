import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";

import { RiskEngine } from "../core/riskEngine";
import { IncidentEngine } from "../core/incidentEngine";
import { RoutingEngine } from "../core/routingEngine";

import { RouteEvaluator } from "../decision/RouteEvaluator";
import { AutoReroutePolicy } from "../decision/AutoReroutePolicy";
import { ExitSelector } from "../decision/ExitSelector";
import { GuidanceGenerator } from "../decision/GuidanceGenerator";
import { DecisionOrchestrator } from "../decision/DecisionOrchestrator";

import { WebSocketPublisher } from "../events/WebSocketPublisher";

import mapData from "../data/map.json";
import CONFIG from "./config";

/* =====================================================
   App + Server
===================================================== */

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.json());

/* =====================================================
   Global Mode
===================================================== */

let globalMode: "normal" | "alert" | "evacuation" = "normal";

/* =====================================================
   Core Engines
===================================================== */

const riskEngine = new RiskEngine();
const incidentEngine = new IncidentEngine();
const routingEngine = new RoutingEngine(mapData);

/* =====================================================
   Decision Layer Setup
===================================================== */

const evaluator = new RouteEvaluator(
  (zoneId: string) => riskEngine.getZoneRisk(zoneId),
  (zoneId: string) => incidentEngine.isZoneBlocked(zoneId),
  () => 1 
);

const policy = new AutoReroutePolicy();

const exits = routingEngine.getExitNodes();

const exitSelector = new ExitSelector(
  exits,
  (from, to) =>
    routingEngine.computeRoute(
      riskEngine.getAllZoneRisk(),
      incidentEngine.getLocalDeltas(),
      {},
      globalMode,
      from,
      to,
      "SYSTEM"
    )
);

const publisher = new WebSocketPublisher(io);

const orchestrator = new DecisionOrchestrator(
  evaluator,
  policy,
  exitSelector,
  routingEngine,
  publisher,
  () => globalMode
);

/* =====================================================
   User Store
===================================================== */

interface UserContext {
  userId: string;
  currentNodeId: string;
  destinationNodeId?: string;
  activeRoute?: any;
  lastRerouteAt?: number;
}

const users = new Map<string, UserContext>();

/* =====================================================
   REST Endpoints
===================================================== */

// Health check
app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

// Manual route testing
app.post("/route", (req, res) => {

  const { userId, currentNodeId, destinationNodeId } = req.body;

  const route = routingEngine.computeRoute(
    riskEngine.getAllZoneRisk(),
    incidentEngine.getLocalDeltas(),
    {},
    globalMode,
    currentNodeId,
    destinationNodeId,
    userId
  );

  res.json(route);
});

// Change global mode
app.post("/mode", (req, res) => {
  globalMode = req.body.mode;
  console.log("Global mode changed:", globalMode);

  users.forEach(user => orchestrator.evaluateUser(user));

  res.json({ ok: true });
});

// Mock risk injection
app.post("/mock-risk", (req, res) => {
  const { zoneId, risk } = req.body;
  riskEngine.setZoneRisk(zoneId, risk);
  res.json({ ok: true });
});

// Mock incident injection
app.post("/mock-incident", (req, res) => {
  incidentEngine.addIncident(req.body);
  res.json({ ok: true });
});

/* =====================================================
   WebSocket
===================================================== */

io.on("connection", socket => {

  console.log("User connected:", socket.id);

  socket.on("register", ({ userId }) => {
    socket.join(userId);
  });

  socket.on("location_update", data => {

    const { userId, currentNodeId, destinationNodeId } = data;

    let user = users.get(userId);

    if (!user) {
      user = {
        userId,
        currentNodeId,
        destinationNodeId
      };
      users.set(userId, user);
    }

    user.currentNodeId = currentNodeId;

    if (destinationNodeId) {
      user.destinationNodeId = destinationNodeId;
    }

    // Initial route
    if (!user.activeRoute && user.destinationNodeId) {

      const route = routingEngine.computeRoute(
        riskEngine.getAllZoneRisk(),
        incidentEngine.getLocalDeltas(),
        {},
        globalMode,
        user.currentNodeId,
        user.destinationNodeId,
        user.userId
      );

      user.activeRoute = route;

      publisher.emitRouteUpdate(user.userId, route);
    }

    orchestrator.evaluateUser(user);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

/* =====================================================
   Auto Re-evaluation Triggers
===================================================== */

riskEngine.on("riskUpdated", () => {
  users.forEach(user => orchestrator.evaluateUser(user));
});

incidentEngine.on("incidentUpdated", () => {
  users.forEach(user => orchestrator.evaluateUser(user));
});

/* =====================================================
   Start Server
===================================================== */

const PORT = CONFIG.PORT;

server.listen(PORT, () => {
  console.log(`SafeFlow backend running on port ${PORT}`);
});