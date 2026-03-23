import { appConfig } from "./config.js";
import { countActiveJobs, getKeepAwakeSettings } from "./database.js";
import { nowIso } from "./helpers.js";

const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const ACTIVITY_WINDOW_MS = 75 * 1000;
const ACTIVE_JOB_WINDOW_MS = HEARTBEAT_INTERVAL_MS + 5 * 1000;
const INITIAL_HEARTBEAT_DELAY_MS = 5 * 1000;
const HEARTBEAT_PATH = "/api/internal/keepawake-ping";

let managerStarted = false;
let heartbeatInFlight = false;
let activityUntilMs = 0;
let lastHeartbeatAt = null;
let lastHeartbeatError = null;

function getHeartbeatUrl() {
  const baseUrl = String(appConfig.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return null;
  }

  return `${baseUrl}${HEARTBEAT_PATH}`;
}

function getReason(adminKeepAwake, activeJobCount, activityActive) {
  if (adminKeepAwake) {
    return "admin";
  }
  if (activeJobCount > 0) {
    return "jobs";
  }
  if (activityActive) {
    return "activity";
  }
  return "idle";
}

function buildStatus() {
  const now = Date.now();
  const settings = getKeepAwakeSettings();
  const activeJobCount = countActiveJobs();
  const activityActive = activityUntilMs > now;
  const jobWindowUntilMs = activeJobCount > 0 ? now + ACTIVE_JOB_WINDOW_MS : 0;
  const keepAwakeUntilMs = settings.adminKeepAwake ? 0 : Math.max(activityUntilMs, jobWindowUntilMs);
  const heartbeatUrl = getHeartbeatUrl();
  const heartbeatAvailable = Boolean(heartbeatUrl);
  const keepAwakeActive = Boolean(heartbeatAvailable && (settings.adminKeepAwake || activeJobCount > 0 || activityActive));

  return {
    adminKeepAwake: settings.adminKeepAwake,
    activeJobCount,
    keepAwakeUntil: settings.adminKeepAwake || keepAwakeUntilMs <= now ? null : new Date(keepAwakeUntilMs).toISOString(),
    keepAwakeActive,
    heartbeatAvailable,
    heartbeatUrl,
    heartbeatIntervalSeconds: Math.round(HEARTBEAT_INTERVAL_MS / 1000),
    activityWindowSeconds: Math.round(ACTIVITY_WINDOW_MS / 1000),
    lastHeartbeatAt,
    lastHeartbeatError,
    reason: getReason(settings.adminKeepAwake, activeJobCount, activityActive),
    updatedAt: settings.updatedAt,
  };
}

async function runHeartbeatCycle() {
  const snapshot = buildStatus();
  if (!snapshot.keepAwakeActive || !snapshot.heartbeatUrl || heartbeatInFlight) {
    return snapshot;
  }

  heartbeatInFlight = true;
  try {
    const response = await fetch(snapshot.heartbeatUrl, {
      method: "HEAD",
      cache: "no-store",
      headers: {
        "x-yt-asr-keepawake": "1",
      },
    });
    lastHeartbeatAt = nowIso();
    lastHeartbeatError = response.ok ? null : `Heartbeat responded with ${response.status}.`;
  } catch (error) {
    lastHeartbeatError = error instanceof Error ? error.message : String(error);
  } finally {
    heartbeatInFlight = false;
  }

  return buildStatus();
}

export function getKeepAwakeStatus() {
  return buildStatus();
}

export function noteKeepAwakeActivity() {
  activityUntilMs = Math.max(activityUntilMs, Date.now() + ACTIVITY_WINDOW_MS);
  void runHeartbeatCycle();
  return buildStatus();
}

export function triggerKeepAwakeCheck() {
  void runHeartbeatCycle();
}

export function startKeepAwakeManager() {
  if (managerStarted) {
    return;
  }

  managerStarted = true;
  setTimeout(() => {
    void runHeartbeatCycle();
  }, INITIAL_HEARTBEAT_DELAY_MS);
  setInterval(() => {
    void runHeartbeatCycle();
  }, HEARTBEAT_INTERVAL_MS);
}
