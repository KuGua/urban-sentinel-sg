"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMockCrowdHeatSnapshot = buildMockCrowdHeatSnapshot;
const SEED_HOTSPOTS = [
    { id: "mbs", name: "Marina Bay Sands", lat: 1.2839, lng: 103.8607, planningArea: "DOWNTOWN CORE", baseWeight: 0.84, activity: "tourism" },
    { id: "orchard", name: "Orchard Road", lat: 1.3043, lng: 103.8318, planningArea: "ORCHARD", baseWeight: 0.79, activity: "shopping" },
    { id: "bugis", name: "Bugis", lat: 1.2997, lng: 103.8555, planningArea: "ROCHOR", baseWeight: 0.7, activity: "shopping" },
    { id: "vivocity", name: "VivoCity / HarbourFront", lat: 1.2643, lng: 103.822, planningArea: "BUKIT MERAH", baseWeight: 0.67, activity: "shopping" },
    { id: "changi", name: "Changi Airport T3", lat: 1.3573, lng: 103.9879, planningArea: "CHANGI", baseWeight: 0.74, activity: "transit" },
    { id: "jurong-east", name: "Jurong East Interchange", lat: 1.3332, lng: 103.7423, planningArea: "JURONG EAST", baseWeight: 0.62, activity: "commute" },
    { id: "woodlands-cp", name: "Woodlands Checkpoint", lat: 1.4473, lng: 103.7699, planningArea: "WOODLANDS", baseWeight: 0.58, activity: "transit" },
    { id: "tampines-hub", name: "Our Tampines Hub", lat: 1.353, lng: 103.94, planningArea: "TAMPINES", baseWeight: 0.55, activity: "residential" },
    { id: "bishan", name: "Bishan Town Centre", lat: 1.3507, lng: 103.8482, planningArea: "BISHAN", baseWeight: 0.5, activity: "residential" },
    { id: "sentosa", name: "Sentosa Gateway", lat: 1.2547, lng: 103.8238, planningArea: "SOUTHERN ISLANDS", baseWeight: 0.52, activity: "tourism" }
];
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}
function getDayType(date) {
    const day = date.getDay();
    return day === 0 || day === 6 ? "weekend" : "weekday";
}
function getProfile(dayType, hour) {
    if (dayType === "weekday") {
        if (hour >= 7 && hour <= 9)
            return "morning-commute";
        if (hour >= 17 && hour <= 20)
            return "evening-commute";
        if (hour >= 12 && hour <= 14)
            return "lunch-peak";
        return "off-peak";
    }
    if (hour >= 13 && hour <= 21)
        return "weekend-leisure-peak";
    return "weekend-off-peak";
}
function mulberry32(seed) {
    let t = seed >>> 0;
    return () => {
        t += 0x6d2b79f5;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}
function activityMultiplier(activity, dayType, hour) {
    if (activity === "commute") {
        if (dayType === "weekday" && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 20)))
            return 1.34;
        if (dayType === "weekday" && hour >= 12 && hour <= 14)
            return 1.07;
        return 0.84;
    }
    if (activity === "tourism") {
        if (dayType === "weekend" && hour >= 13 && hour <= 22)
            return 1.3;
        if (hour >= 10 && hour <= 22)
            return 1.12;
        return 0.78;
    }
    if (activity === "shopping") {
        if (hour >= 12 && hour <= 21)
            return dayType === "weekend" ? 1.28 : 1.16;
        return 0.74;
    }
    if (activity === "transit") {
        if (hour >= 7 && hour <= 10)
            return 1.2;
        if (hour >= 17 && hour <= 21)
            return 1.18;
        return 0.9;
    }
    if (hour >= 18 && hour <= 22)
        return 1.13;
    if (dayType === "weekend" && hour >= 11 && hour <= 20)
        return 1.12;
    return 0.88;
}
function buildHotspots(now) {
    const dayType = getDayType(now);
    const hour = now.getHours();
    const seedBase = Number(`${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}${String(hour).padStart(2, "0")}`);
    const rand = mulberry32(seedBase);
    return SEED_HOTSPOTS.map((item) => {
        const activityBoost = activityMultiplier(item.activity, dayType, hour);
        const randomNoise = 0.92 + rand() * 0.18;
        const intensity = clamp01(item.baseWeight * activityBoost * randomNoise);
        return {
            id: item.id,
            name: item.name,
            lat: item.lat,
            lng: item.lng,
            planningArea: item.planningArea,
            intensity
        };
    }).sort((a, b) => b.intensity - a.intensity);
}
function buildDetailPoints(hotspots, now) {
    const seedBase = Number(`${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}${String(now.getUTCHours()).padStart(2, "0")}${String(Math.floor(now.getUTCMinutes() / 10)).padStart(2, "0")}`);
    const rand = mulberry32(seedBase);
    const points = [];
    for (const hotspot of hotspots) {
        const count = Math.round(14 + hotspot.intensity * 22);
        for (let i = 0; i < count; i += 1) {
            const angle = rand() * Math.PI * 2;
            const meters = 45 + rand() * (150 + hotspot.intensity * 140);
            const dx = Math.cos(angle) * meters;
            const dy = Math.sin(angle) * meters;
            const latOffset = dy / 111320;
            const lngOffset = dx / (111320 * Math.cos((hotspot.lat * Math.PI) / 180));
            const jitter = 0.72 + rand() * 0.35;
            points.push({
                lat: hotspot.lat + latOffset,
                lng: hotspot.lng + lngOffset,
                intensity: clamp01(hotspot.intensity * jitter),
                planningArea: hotspot.planningArea,
                sourceHotspot: hotspot.name
            });
        }
    }
    return points;
}
function buildAreaAlerts(hotspots) {
    const byArea = new Map();
    for (const hotspot of hotspots) {
        const area = hotspot.planningArea.toUpperCase();
        const prev = byArea.get(area) ?? 0;
        byArea.set(area, Math.max(prev, hotspot.intensity));
    }
    return Array.from(byArea.entries())
        .map(([planningArea, score]) => ({ planningArea, score: clamp01(score) }))
        .sort((a, b) => b.score - a.score);
}
function buildMockCrowdHeatSnapshot(now = new Date()) {
    const dayType = getDayType(now);
    const hour = now.getHours();
    const profile = getProfile(dayType, hour);
    const hotspots = buildHotspots(now);
    const detailPoints = buildDetailPoints(hotspots, now);
    const areaAlerts = buildAreaAlerts(hotspots);
    return {
        generatedAt: now.toISOString(),
        context: {
            dayType,
            hour,
            profile
        },
        hotspots,
        detailPoints,
        areaAlerts
    };
}
