"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DecisionOrchestrator = void 0;
const GuidanceGenerator_1 = require("./GuidanceGenerator");
class DecisionOrchestrator {
    evaluator;
    policy;
    exitSelector;
    router;
    publisher;
    getGlobalMode;
    constructor(evaluator, policy, exitSelector, router, publisher, getGlobalMode) {
        this.evaluator = evaluator;
        this.policy = policy;
        this.exitSelector = exitSelector;
        this.router = router;
        this.publisher = publisher;
        this.getGlobalMode = getGlobalMode;
    }
    evaluateUser(user) {
        if (!user.activeRoute)
            return;
        const assessment = this.evaluator.evaluate(user.activeRoute.zonePath);
        const action = this.policy.decide(assessment, this.getGlobalMode(), user.lastRerouteAt || 0);
        if (action.type === "NOOP")
            return;
        let target = user.destinationNodeId;
        if (this.getGlobalMode() === "evacuation") {
            target = this.exitSelector.selectBestExit(user.currentNodeId);
        }
        if (!target)
            return;
        const newRoute = this.router.computeRoute(user.currentNodeId, target);
        user.activeRoute = newRoute;
        user.lastRerouteAt = Date.now();
        const guidance = new GuidanceGenerator_1.GuidanceGenerator().generate(action.reason, target);
        this.publisher.emitRouteUpdate(user.userId, newRoute);
        this.publisher.emitGuidance(user.userId, guidance);
    }
}
exports.DecisionOrchestrator = DecisionOrchestrator;
