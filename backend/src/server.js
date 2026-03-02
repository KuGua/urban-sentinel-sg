"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const crypto_1 = require("crypto");
const riskEngine_1 = require("../core/riskEngine");
const incidentEngine_1 = require("../core/incidentEngine");
const routingEngine_1 = require("../core/routingEngine");
const RouteEvaluator_1 = require("../decision/RouteEvaluator");
const AutoReroutePolicy_1 = require("../decision/AutoReroutePolicy");
const ExitSelector_1 = require("../decision/ExitSelector");
const DecisionOrchestrator_1 = require("../decision/DecisionOrchestrator");
const WebSocketPublisher_1 = require("../events/WebSocketPublisher");
const map_json_1 = __importDefault(require("../data/map.json"));
const config_1 = __importDefault(require("./config"));
const crowdHeat_1 = require("./mock/crowdHeat");
/* =====================================================
   App + Server
===================================================== */
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: { origin: "*" }
});
app.use(express_1.default.json());
app.use((0, cors_1.default)());
const ML_SERVICE_BASE_URL = (process.env.ML_SERVICE_BASE_URL || "http://127.0.0.1:8099").replace(/\/+$/, "");
const TRAFFIC_ML_ENDPOINT = `${ML_SERVICE_BASE_URL}/infer/traffic-camera`;
const trafficInferCache = new Map();
async function fetchImageAsDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Image fetch failed (${response.status})`);
    }
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString("base64")}`;
}
async function inferTrafficCamera(payload, cacheTtlMs) {
    const cacheKey = `${payload.cameraId}:${payload.capturedAt || ""}`;
    const now = Date.now();
    const cached = trafficInferCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }
    const response = await fetch(TRAFFIC_ML_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`ML infer failed (${response.status}): ${text.slice(0, 180)}`);
    }
    const data = (await response.json());
    trafficInferCache.set(cacheKey, { expiresAt: now + cacheTtlMs, value: data });
    return data;
}
function getOneMapToken() {
    const token = process.env.ONEMAP_API_TOKEN;
    if (!token) {
        throw new Error("Missing ONEMAP_API_TOKEN");
    }
    return token;
}
async function fetchOneMapJson(url) {
    const token = getOneMapToken();
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
        throw new Error(`OneMap request failed (${response.status})`);
    }
    return response.json();
}
async function fetchOneMapPublicJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`OneMap public request failed (${response.status})`);
    }
    return response.json();
}
/* =====================================================
   Global Mode
===================================================== */
let globalMode = "normal";
/* =====================================================
   Core Engines
===================================================== */
const riskEngine = new riskEngine_1.RiskEngine();
const incidentEngine = new incidentEngine_1.IncidentEngine();
const routingEngine = new routingEngine_1.RoutingEngine(map_json_1.default);
/* =====================================================
   Decision Layer Setup
===================================================== */
const evaluator = new RouteEvaluator_1.RouteEvaluator((zoneId) => riskEngine.getZoneRisk(zoneId), (zoneId) => incidentEngine.isZoneBlocked(zoneId), () => 1);
const policy = new AutoReroutePolicy_1.AutoReroutePolicy();
const exits = routingEngine.getExitNodes();
const exitSelector = new ExitSelector_1.ExitSelector(exits, (from, to) => routingEngine.computeRoute(riskEngine.getAllZoneRisk(), incidentEngine.getLocalDeltas(), {}, globalMode, from, to, "SYSTEM"));
const publisher = new WebSocketPublisher_1.WebSocketPublisher(io);
const orchestrator = new DecisionOrchestrator_1.DecisionOrchestrator(evaluator, policy, exitSelector, routingEngine, publisher, () => globalMode);
const users = new Map();
const userPresence = new Map();
const PRESENCE_DEFAULT_MAX_AGE_MS = 30000;
const PRESENCE_MAX_ENTRIES = 5000;
const SYSTEM_METRICS_CAMERA_TTL_MS = 45000;
let systemMetricsCameraCache = null;
function prunePresence(nowMs, maxAgeMs) {
    for (const [uid, item] of userPresence.entries()) {
        if (nowMs - item.ts > maxAgeMs) {
            userPresence.delete(uid);
        }
    }
    if (userPresence.size > PRESENCE_MAX_ENTRIES) {
        const sorted = Array.from(userPresence.values()).sort((a, b) => a.ts - b.ts);
        const removeN = userPresence.size - PRESENCE_MAX_ENTRIES;
        for (let i = 0; i < removeN; i += 1) {
            userPresence.delete(sorted[i].userId);
        }
    }
}
/* =====================================================
   REST Endpoints
===================================================== */
// Health check
app.get("/", (_, res) => {
    res.json({ status: "ok" });
});
app.get("/health", (_, res) => {
    res.json({ status: "ok" });
});
// Manual route testing
app.post("/route", (req, res) => {
    const { userId, currentNodeId, destinationNodeId } = req.body;
    const route = routingEngine.computeRoute(riskEngine.getAllZoneRisk(), incidentEngine.getLocalDeltas(), {}, globalMode, currentNodeId, destinationNodeId, userId);
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
app.post("/presence/update", (req, res) => {
    const userId = String(req.body?.userId || "").trim();
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const ts = Number(req.body?.ts) || Date.now();
    const source = String(req.body?.source || "").trim() || undefined;
    if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        res.status(400).json({ error: "lat/lng must be finite numbers" });
        return;
    }
    const payload = { userId, lat, lng, ts, source };
    userPresence.set(userId, payload);
    prunePresence(Date.now(), PRESENCE_DEFAULT_MAX_AGE_MS);
    io.emit("user_presence", payload);
    res.json({ ok: true });
});
app.post("/presence/register", (_req, res) => {
    const userId = `U_MOBILE_${(0, crypto_1.randomUUID)().slice(0, 8)}`;
    res.json({ ok: true, userId, ts: Date.now() });
});
app.post("/presence/offline", (req, res) => {
    const userId = String(req.body?.userId || "").trim();
    if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
    }
    const existed = userPresence.delete(userId);
    io.emit("user_presence_offline", { userId, ts: Date.now() });
    res.json({ ok: true, removed: existed });
});
app.get("/presence/users", (req, res) => {
    const maxAgeMs = Math.max(1000, Number(req.query.maxAgeMs ?? PRESENCE_DEFAULT_MAX_AGE_MS) || PRESENCE_DEFAULT_MAX_AGE_MS);
    const now = Date.now();
    prunePresence(now, maxAgeMs);
    const rows = Array.from(userPresence.values()).filter((item) => now - item.ts <= maxAgeMs);
    res.json({
        ts: now,
        count: rows.length,
        users: rows,
    });
});
app.get("/system/metrics", async (_req, res) => {
    const now = Date.now();
    prunePresence(now, PRESENCE_DEFAULT_MAX_AGE_MS);
    const totalUsers = Array.from(userPresence.values()).filter((item) => now - item.ts <= PRESENCE_DEFAULT_MAX_AGE_MS).length;
    let workingCameras = null;
    let cameraSource = "live";
    try {
        if (systemMetricsCameraCache && now - systemMetricsCameraCache.fetchedAt <= SYSTEM_METRICS_CAMERA_TTL_MS) {
            workingCameras = systemMetricsCameraCache.workingCameras;
            cameraSource = "cache";
        }
        else {
            const upstream = await fetchOneMapPublicJson("https://api.data.gov.sg/v1/transport/traffic-images");
            const latestItem = Array.isArray(upstream?.items) && upstream.items.length > 0 ? upstream.items[0] : null;
            const cameras = Array.isArray(latestItem?.cameras) ? latestItem.cameras : [];
            workingCameras = cameras.filter((camera) => {
                const cameraId = String(camera?.camera_id || "").trim();
                const imageUrl = String(camera?.image || "").trim();
                const lat = Number(camera?.location?.latitude);
                const lng = Number(camera?.location?.longitude);
                return Boolean(cameraId && imageUrl && Number.isFinite(lat) && Number.isFinite(lng));
            }).length;
            systemMetricsCameraCache = {
                fetchedAt: now,
                workingCameras,
            };
        }
    }
    catch {
        if (systemMetricsCameraCache) {
            workingCameras = systemMetricsCameraCache.workingCameras;
            cameraSource = "cache";
        }
        else {
            cameraSource = "unavailable";
        }
    }
    res.json({
        workingCameras,
        totalUsers,
        generatedAt: now,
        cameraSource,
        cameraUpdatedAt: systemMetricsCameraCache?.fetchedAt ?? null,
    });
});
app.get("/onemap/health", async (_req, res) => {
    try {
        await fetchOneMapJson("https://www.onemap.gov.sg/api/public/popapi/getPlanningareaNames?year=2019");
        res.json({ ok: true, provider: "onemap", auth: "token" });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown OneMap error";
        res.status(502).json({ ok: false, error: message });
    }
});
app.get("/onemap/search", async (req, res) => {
    try {
        const searchVal = String(req.query.searchVal ?? "").trim();
        const pageNum = String(req.query.pageNum ?? "1").trim();
        if (!searchVal) {
            res.status(400).json({ error: "searchVal is required" });
            return;
        }
        const data = await fetchOneMapPublicJson(`https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(searchVal)}&returnGeom=Y&getAddrDetails=Y&pageNum=${encodeURIComponent(pageNum)}`);
        res.json(data);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown OneMap error";
        res.status(502).json({ error: message });
    }
});
app.get("/onemap/planning-areas", async (req, res) => {
    try {
        const year = String(req.query.year ?? "2019").trim();
        const data = await fetchOneMapJson(`https://www.onemap.gov.sg/api/public/popapi/getAllPlanningarea?year=${encodeURIComponent(year)}`);
        res.json(data);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown OneMap error";
        res.status(502).json({ error: message });
    }
});
app.get("/onemap/crowd-heat", (req, res) => {
    try {
        const snapshot = (0, crowdHeat_1.buildMockCrowdHeatSnapshot)();
        res.json(snapshot);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown crowd heat error";
        res.status(500).json({ error: message });
    }
});
app.get("/traffic/cameras", async (_req, res) => {
    try {
        const data = await fetchOneMapPublicJson("https://api.data.gov.sg/v1/transport/traffic-images");
        res.json(data);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown traffic camera error";
        res.status(502).json({ error: message });
    }
});
app.get("/traffic/cameras/enriched", async (req, res) => {
    try {
        const maxCameras = Math.max(1, Math.min(30, Number(req.query.maxCameras ?? 8) || 8));
        const withInfer = String(req.query.withInfer ?? "1") !== "0";
        const cacheTtlMs = Math.max(1000, Number(req.query.cacheTtlMs ?? 45000) || 45000);
        const upstream = await fetchOneMapPublicJson("https://api.data.gov.sg/v1/transport/traffic-images");
        const latestItem = Array.isArray(upstream?.items) && upstream.items.length > 0 ? upstream.items[0] : null;
        const cameras = (latestItem?.cameras || []).slice(0, maxCameras);
        const enriched = await Promise.all(cameras.map(async (camera) => {
            const cameraId = String(camera?.camera_id || "").trim();
            const imageUrl = String(camera?.image || "").trim();
            const capturedAt = String(camera?.timestamp || latestItem?.timestamp || "");
            const lat = Number(camera?.location?.latitude);
            const lng = Number(camera?.location?.longitude);
            if (!cameraId || !imageUrl || !Number.isFinite(lat) || !Number.isFinite(lng)) {
                return null;
            }
            if (!withInfer) {
                return {
                    cameraId,
                    lat,
                    lng,
                    imageUrl,
                    capturedAt,
                    inference: { status: "skipped", reason: "withInfer=0" },
                };
            }
            try {
                const imageBase64 = await fetchImageAsDataUrl(imageUrl);
                const infer = await inferTrafficCamera({ cameraId, imageUrl, imageBase64, capturedAt }, cacheTtlMs);
                return {
                    cameraId,
                    lat,
                    lng,
                    imageUrl,
                    capturedAt,
                    inference: {
                        status: "ok",
                        vehicleCount: infer.vehicleCount,
                        model: infer.model,
                        ts: infer.ts,
                        imageWidth: Number.isFinite(Number(infer.imageWidth)) ? Number(infer.imageWidth) : undefined,
                        imageHeight: Number.isFinite(Number(infer.imageHeight)) ? Number(infer.imageHeight) : undefined,
                        detections: infer.detections,
                    },
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown ML infer error";
                return {
                    cameraId,
                    lat,
                    lng,
                    imageUrl,
                    capturedAt,
                    inference: { status: "error", error: message },
                };
            }
        }));
        res.json({
            generatedAt: new Date().toISOString(),
            source: "data.gov.sg",
            modelService: TRAFFIC_ML_ENDPOINT,
            cameras: enriched.filter(Boolean),
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown enriched camera error";
        res.status(502).json({ error: message });
    }
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
            const route = routingEngine.computeRoute(riskEngine.getAllZoneRisk(), incidentEngine.getLocalDeltas(), {}, globalMode, user.currentNodeId, user.destinationNodeId, user.userId);
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
const PORT = config_1.default.PORT;
server.listen(PORT, () => {
    console.log(`SafeFlow backend running on port ${PORT}`);
});
