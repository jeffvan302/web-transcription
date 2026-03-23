import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";
import {
  buildAppState,
  changeUserPassword,
  closeCheckoutRecords,
  createJob,
  createPasswordRecoveryToken,
  createCheckoutRecord,
  createOrReplaceDraft,
  createSession,
  createUserAccount,
  createWorkspace,
  deleteUserAccount,
  deleteSession,
  deleteTitleRecord,
  findUserByIdentifier,
  getActiveCheckoutForUser,
  getDraftForTitle,
  getSessionWithUser,
  getStorageSettings,
  getTitleRow,
  getUserById,
  insertAuditRecord,
  listJobs,
  markStorageConnectionTest,
  redeemPasswordRecoveryToken,
  recoverInterruptedJobs,
  resetUserPassword,
  saveKeepAwakeSettings,
  sanitizeUser,
  saveStorageSettings,
  setUserCurrentWorkspace,
  updateUserAccount,
  updateTitleRecord,
  updateUserLastLogin,
} from "./database.js";
import { appConfig, paths } from "./config.js";
import { createAsrArchive } from "./asr.js";
import { listSubtitleStreams } from "./media.js";
import { startJobWorker } from "./jobs.js";
import { getYouTubeMetadata } from "./media.js";
import { getObjectKey, getStorageService } from "./storage.js";
import { getKeepAwakeStatus, noteKeepAwakeActivity, startKeepAwakeManager, triggerKeepAwakeCheck } from "./keep-awake.js";
import { deleteTitleSentenceState, persistTitleSentenceState } from "./title-state.js";
import { createCookieOptions, ensureDir, nowIso, parseJson, randomId } from "./helpers.js";

const app = express();

ensureDir(paths.inboxDir);
ensureDir(paths.tempDir);
ensureDir(paths.storageDir);

const upload = multer({
  dest: path.join(paths.inboxDir, "uploads"),
  limits: {
    fileSize: 1024 * 1024 * 1024,
  },
});

function parseByteRange(rangeHeader, size) {
  if (!rangeHeader || !String(rangeHeader).startsWith("bytes=")) {
    return null;
  }

  const firstRange = String(rangeHeader).replace("bytes=", "").split(",")[0];
  const [startRaw, endRaw] = firstRange.split("-");

  let start = startRaw ? Number(startRaw) : NaN;
  let end = endRaw ? Number(endRaw) : NaN;

  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= size) {
      return "invalid";
    }
    end = endRaw ? Number(endRaw) : size - 1;
    if (!Number.isFinite(end) || end < start) {
      return "invalid";
    }
    end = Math.min(end, size - 1);
  }

  return { start, end };
}

function applyAudioHeaders(res, size, range = null) {
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader("Content-Length", String(range.end - range.start + 1));
    return;
  }

  res.setHeader("Content-Length", String(size));
}

const mediaProbeDir = path.join(paths.inboxDir, "media-probes");
ensureDir(mediaProbeDir);

function validatePasswordStrength(password, fieldLabel = "Password") {
  const value = String(password || "");
  if (value.length < 8) {
    throw new Error(`${fieldLabel} must be at least 8 characters long.`);
  }
}

function normalizeDisplayName(value, fallback = "User") {
  return String(value || "").trim() || fallback;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeLoginIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function parseYouTubeUrls(input) {
  const values = Array.isArray(input) ? input : [input];
  return [
    ...new Set(
      values
        .flatMap((value) => String(value || "").split(/[\r\n,\s]+/))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function buildMediaProbeManifest(file) {
  const probeToken = randomId("media-probe");
  const manifestPath = path.join(mediaProbeDir, `${probeToken}.json`);
  const payload = {
    probeToken,
    filePath: file.path,
    originalName: file.originalname,
    createdAt: nowIso(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2));
  return payload;
}

function readMediaProbeManifest(probeToken) {
  if (!probeToken) {
    return null;
  }
  const manifestPath = path.join(mediaProbeDir, `${probeToken}.json`);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return parseJson(fs.readFileSync(manifestPath, "utf8"), null);
}

function deleteMediaProbeManifest(probeToken) {
  if (!probeToken) {
    return;
  }

  const manifestPath = path.join(mediaProbeDir, `${probeToken}.json`);
  if (fs.existsSync(manifestPath)) {
    fs.rmSync(manifestPath, { force: true });
  }
}

app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());
app.use("/objects", express.static(paths.storageDir));

app.use((req, _res, next) => {
  const sessionId = req.cookies?.[appConfig.sessionCookieName];
  if (!sessionId) {
    req.user = null;
    next();
    return;
  }

  const session = getSessionWithUser(sessionId);
  req.user = session ? sanitizeUser(session) : null;
  req.sessionId = session ? session.session_id : null;
  next();
});

function requireUser(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (
    req.user.mustChangePassword &&
    req.path !== "/api/state" &&
    req.path !== "/api/auth/change-password" &&
    req.path !== "/api/auth/logout"
  ) {
    res.status(403).json({
      error: "Password change required before continuing.",
      requiresPasswordChange: true,
    });
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (req.user.mustChangePassword) {
    res.status(403).json({
      error: "Password change required before continuing.",
      requiresPasswordChange: true,
    });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
}

function syncWorkspaceToActiveCheckout(userId) {
  const activeCheckout = getActiveCheckoutForUser(userId);
  if (!activeCheckout?.workspace_id) {
    return null;
  }

  try {
    setUserCurrentWorkspace(userId, activeCheckout.workspace_id);
    return activeCheckout.workspace_id;
  } catch {
    return null;
  }
}

function sendAppState(res, userId, preferredWorkspaceId = null) {
  const state = {
    ...buildAppState(userId, preferredWorkspaceId),
    runtime: getKeepAwakeStatus(),
  };
  res.json({
    state,
    jobs: listJobs(userId, 25, state.selectedWorkspaceId || null),
  });
}

function getTitlePhrasesForUser(titleRow, userId) {
  const draft = titleRow.checked_out_by_user_id === userId ? getDraftForTitle(titleRow.id) : null;
  const phrases = draft ? parseJson(draft.phrases_json, []) : parseJson(titleRow.phrases_json, []);
  const savedSnapshot = draft ? parseJson(draft.saved_snapshot_json, []) : parseJson(titleRow.saved_snapshot_json, []);
  return { draft, phrases, savedSnapshot };
}

async function materializeObject(key, fileName) {
  const storage = getStorageService();
  if (!key) {
    return null;
  }

  if (storage.mode === "local") {
    return storage.resolveLocalPath(key);
  }

  const outputPath = path.join(paths.tempDir, randomId("asset"), fileName);
  ensureDir(path.dirname(outputPath));
  const buffer = await storage.getBuffer(key);
  await fs.promises.writeFile(outputPath, buffer);
  return outputPath;
}

function badgeForPhrases(phrases, fallback = null) {
  if (phrases.length > 0 && phrases.every((phrase) => phrase.reviewed)) {
    return "reviewed";
  }
  return fallback;
}

function updateSharedDraft(titleRow, userId, incomingTitle, kind) {
  const timestamp = nowIso();
  const { draft, phrases, savedSnapshot } = getTitlePhrasesForUser(titleRow, userId);
  const nextPhrases = incomingTitle?.phrases || phrases;
  const nextSnapshot = incomingTitle?.savedSnapshot || savedSnapshot || nextPhrases;
  const nextVersion = (draft?.version || 0) + 1;

  createOrReplaceDraft({
    titleId: titleRow.id,
    userId,
    phrases: nextPhrases,
    savedSnapshot: nextSnapshot,
    version: nextVersion,
    isDirty: false,
    status: kind === "checkin" ? "finalized" : "active",
    lastAutosaveAt: kind === "autosave" ? timestamp : draft?.last_autosave_at || null,
    lastSaveAt: kind === "manual" || kind === "checkin" ? timestamp : draft?.last_save_at || null,
    lastSyncAt: kind === "sync" ? timestamp : draft?.last_sync_at || null,
  });

  const basePatch = {
    ...titleRow,
    title: incomingTitle?.title || titleRow.title,
    source: incomingTitle?.source || titleRow.source,
    language: incomingTitle?.language || titleRow.language,
    duration: Number(incomingTitle?.duration || titleRow.duration || 0),
    phrase_count: nextPhrases.length,
    badge: badgeForPhrases(nextPhrases, titleRow.badge),
  };

  if (kind === "checkin") {
    updateTitleRecord(titleRow.id, {
      ...basePatch,
      phrases_json: JSON.stringify(nextPhrases),
      saved_snapshot_json: JSON.stringify(nextSnapshot),
      checked_out_by_user_id: null,
      checked_out_at: null,
    });
    closeCheckoutRecords(titleRow.id);
    insertAuditRecord({
      eventType: "checkin",
      titleId: titleRow.id,
      titleName: incomingTitle?.title || titleRow.title,
      actorUserId: userId,
      actorDisplayName: reqUserDisplayNameCache.get(userId) || "User",
      details: "Checked in the latest finalized working draft.",
    });
    return;
  }

  updateTitleRecord(titleRow.id, basePatch);
  if (kind === "sync") {
    insertAuditRecord({
      eventType: "sync",
      titleId: titleRow.id,
      titleName: incomingTitle?.title || titleRow.title,
      actorUserId: userId,
      actorDisplayName: reqUserDisplayNameCache.get(userId) || "User",
      details: "Synced working-draft changes while keeping the checkout.",
    });
  }
}

const reqUserDisplayNameCache = new Map();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.all("/api/internal/keepawake-ping", (_req, res) => {
  res.status(204).end();
});

app.get("/api/auth/session", (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: "No active session." });
    return;
  }

  reqUserDisplayNameCache.set(req.user.id, req.user.displayName);
  sendAppState(res, req.user.id, syncWorkspaceToActiveCheckout(req.user.id));
});

app.post("/api/auth/login", (req, res) => {
  const identifier = String(req.body?.identifier || req.body?.email || "").trim();
  const password = String(req.body?.password || "");

  if (!identifier || !password) {
    res.status(400).json({ error: "Login identity or email and password are required." });
    return;
  }

  const userRow = findUserByIdentifier(identifier);
  if (!userRow || userRow.status !== "active" || !bcrypt.compareSync(password, userRow.password_hash)) {
    res.status(401).json({ error: "Invalid login or password." });
    return;
  }

  const session = createSession(userRow.id);
  updateUserLastLogin(userRow.id);
  const user = sanitizeUser(userRow);
  reqUserDisplayNameCache.set(user.id, user.displayName);

  insertAuditRecord({
    eventType: "login",
    titleName: "Workspace",
    actorUserId: user.id,
    actorDisplayName: user.displayName,
    details: "Logged in to the hosted transcription workspace.",
  });

  res.cookie(
    appConfig.sessionCookieName,
    session.id,
    createCookieOptions(appConfig.sessionTtlMs, appConfig.environment === "production"),
  );

  sendAppState(res, user.id, syncWorkspaceToActiveCheckout(user.id));
});

app.post("/api/auth/logout", requireUser, (req, res) => {
  if (req.sessionId) {
    deleteSession(req.sessionId);
  }
  res.clearCookie(appConfig.sessionCookieName, {
    path: "/",
  });
  res.json({ ok: true });
});

app.post("/api/auth/change-password", requireUser, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const nextPassword = String(req.body?.nextPassword || "");

  try {
    validatePasswordStrength(nextPassword, "New password");
    changeUserPassword(req.user.id, currentPassword, nextPassword);
    insertAuditRecord({
      eventType: "password_change",
      titleName: "Workspace",
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: "Changed account password.",
    });
    sendAppState(res, req.user.id);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Password change failed." });
  }
});

app.post("/api/auth/redeem-reset-token", (req, res) => {
  const token = String(req.body?.token || "").trim();
  const nextPassword = String(req.body?.nextPassword || "");

  try {
    if (!token) {
      res.status(400).json({ error: "Recovery token is required." });
      return;
    }

    validatePasswordStrength(nextPassword);
    const user = redeemPasswordRecoveryToken(token, nextPassword);
    const session = createSession(user.id);
    updateUserLastLogin(user.id);

    insertAuditRecord({
      eventType: "password_recovery_redeem",
      titleName: "Workspace",
      actorUserId: user.id,
      actorDisplayName: user.displayName,
      details: "Recovered account access with an admin-issued recovery token.",
    });

    res.cookie(
      appConfig.sessionCookieName,
      session.id,
      createCookieOptions(appConfig.sessionTtlMs, appConfig.environment === "production"),
    );
    sendAppState(res, user.id, syncWorkspaceToActiveCheckout(user.id));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not redeem recovery token." });
  }
});

app.get("/api/state", requireUser, (req, res) => {
  reqUserDisplayNameCache.set(req.user.id, req.user.displayName);
  sendAppState(res, req.user.id);
});

app.get("/api/jobs", requireUser, (req, res) => {
  const state = buildAppState(req.user.id);
  res.json({ jobs: listJobs(req.user.id, 30, state.selectedWorkspaceId || null) });
});

app.post("/api/runtime/activity", requireUser, (_req, res) => {
  noteKeepAwakeActivity();
  res.json({ ok: true });
});

app.post("/api/workspaces/select", requireUser, (req, res) => {
  try {
    const workspaceId = String(req.body?.workspaceId || "").trim();
    if (!workspaceId) {
      res.status(400).json({ error: "Workspace selection is required." });
      return;
    }

    setUserCurrentWorkspace(req.user.id, workspaceId);
    sendAppState(res, req.user.id, workspaceId);
  } catch (error) {
    const statusCode = error instanceof Error && error.message === "Workspace not found." ? 404 : 400;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : "Could not select workspace." });
  }
});

app.post("/api/admin/workspaces", requireAdmin, (req, res) => {
  try {
    const workspace = createWorkspace({
      name: String(req.body?.name || ""),
      createdByUserId: req.user.id,
    });
    setUserCurrentWorkspace(req.user.id, workspace.id);

    insertAuditRecord({
      eventType: "workspace_create",
      workspaceId: workspace.id,
      titleName: workspace.name,
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: `Created workspace ${workspace.name}.`,
    });

    sendAppState(res, req.user.id, workspace.id);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create workspace." });
  }
});

app.put("/api/admin/runtime/keep-awake", requireAdmin, (req, res) => {
  saveKeepAwakeSettings({
    adminKeepAwake: Boolean(req.body?.adminKeepAwake),
  });
  triggerKeepAwakeCheck();
  sendAppState(res, req.user.id);
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  try {
    const password = String(req.body?.password || "");
    validatePasswordStrength(password);
    const createdUser = createUserAccount({
      loginIdentity: normalizeLoginIdentity(req.body?.loginIdentity),
      email: normalizeEmail(req.body?.email),
      displayName: normalizeDisplayName(req.body?.displayName),
      role: req.body?.role === "admin" ? "admin" : "user",
      password,
      status: req.body?.status === "disabled" ? "disabled" : "active",
      mustChangePassword: Boolean(req.body?.mustChangePassword),
    });

    insertAuditRecord({
      eventType: "user_create",
      titleName: "Workspace",
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: `Created user ${createdUser.displayName} (${createdUser.loginIdentity}).`,
    });

    sendAppState(res, req.user.id);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create user." });
  }
});

app.patch("/api/admin/users/:userId", requireAdmin, (req, res) => {
  try {
    const targetUser = getUserById(req.params.userId);
    if (!targetUser) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    if (targetUser.id === req.user.id && req.body?.status === "disabled") {
      res.status(400).json({ error: "You cannot disable your own account." });
      return;
    }

    const updated = updateUserAccount(req.params.userId, {
      loginIdentity: req.body?.loginIdentity,
      email: req.body?.email,
      displayName: req.body?.displayName,
      role: req.body?.role,
      status: req.body?.status,
    });

    insertAuditRecord({
      eventType: "user_update",
      titleName: "Workspace",
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: `Updated user ${updated.displayName}: login ${updated.loginIdentity}, role ${updated.role}, status ${updated.status}.`,
    });

    sendAppState(res, req.user.id);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not update user." });
  }
});

app.delete("/api/admin/users/:userId", requireAdmin, async (req, res, next) => {
  try {
    const deleted = deleteUserAccount(req.params.userId, req.user.id);

    reqUserDisplayNameCache.delete(deleted.user.id);

    const cloudSyncResults = await Promise.allSettled(
      deleted.releasedTitleIds.map(async (titleId) => {
        const titleRow = getTitleRow(titleId);
        if (!titleRow) {
          return;
        }

        await persistTitleSentenceState({
          titleRow,
          phrases: parseJson(titleRow.phrases_json, []),
          savedSnapshot: parseJson(titleRow.saved_snapshot_json, []),
          draftRow: null,
        });
      }),
    );

    cloudSyncResults.forEach((result, index) => {
      if (result.status === "rejected") {
        console.warn(`Could not refresh sentence state for released title ${deleted.releasedTitleIds[index]}.`, result.reason);
      }
    });

    const detailsParts = [`Deleted user ${deleted.user.displayName} (${deleted.user.loginIdentity}).`];
    if (deleted.reassignedTitleCount > 0) {
      detailsParts.push(`Reassigned ${deleted.reassignedTitleCount} title${deleted.reassignedTitleCount === 1 ? "" : "s"} to the current admin.`);
    }
    if (deleted.releasedTitleCount > 0) {
      detailsParts.push(`Released ${deleted.releasedTitleCount} checked-out title${deleted.releasedTitleCount === 1 ? "" : "s"}.`);
    }

    insertAuditRecord({
      eventType: "user_delete",
      titleName: "Workspace",
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: detailsParts.join(" "),
    });

    sendAppState(res, req.user.id);
  } catch (error) {
    if (error instanceof Error && (error.message === "User not found." || error.message === "Admin user not found.")) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (
      error instanceof Error &&
      (error.message === "You cannot delete your own account." ||
        error.message === "This user still has active imports or background jobs. Wait for them to finish before deleting the account." ||
        error.message === "At least one active admin account must remain available.")
    ) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/api/admin/users/:userId/reset-password", requireAdmin, (req, res) => {
  try {
    const nextPassword = String(req.body?.nextPassword || "");
    validatePasswordStrength(nextPassword);
    const updated = resetUserPassword(req.params.userId, nextPassword, req.body?.mustChangePassword !== false);

    insertAuditRecord({
      eventType: "password_reset",
      titleName: "Workspace",
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: `Reset password for ${updated.displayName}.`,
    });

    sendAppState(res, req.user.id);
  } catch (error) {
    const statusCode = error instanceof Error && error.message === "User not found." ? 404 : 400;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : "Could not reset password." });
  }
});

app.post("/api/admin/users/:userId/recovery-token", requireAdmin, (req, res) => {
  try {
    const issued = createPasswordRecoveryToken(req.params.userId, req.user.id);
    const resetUrl = appConfig.baseUrl
      ? `${appConfig.baseUrl.replace(/\/+$/, "")}/?resetToken=${encodeURIComponent(issued.token)}`
      : null;

    insertAuditRecord({
      eventType: "password_recovery_issue",
      titleName: "Workspace",
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: `Issued a password recovery token for ${issued.user.displayName}.`,
    });

    res.json({
      recovery: {
        token: issued.token,
        expiresAt: issued.expiresAt,
        resetUrl,
        userId: issued.user.id,
      },
    });
  } catch (error) {
    const statusCode = error instanceof Error && error.message === "User not found." ? 404 : 400;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : "Could not issue recovery token." });
  }
});

app.post("/api/youtube/probe", requireUser, async (req, res, next) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) {
      res.status(400).json({ error: "A YouTube URL is required." });
      return;
    }

    const metadata = await getYouTubeMetadata(url);
    const languages = [
      ...new Set([
        ...Object.keys(metadata.subtitles || {}),
        ...Object.keys(metadata.automatic_captions || {}),
      ]),
    ].sort();

    res.json({
      languages,
      title: metadata.title || null,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/titles/:titleId/checkout", requireUser, async (req, res, next) => {
  try {
    const titleRow = getTitleRow(req.params.titleId);
    if (!titleRow) {
      res.status(404).json({ error: "Title not found." });
      return;
    }

    if (titleRow.checked_out_by_user_id && titleRow.checked_out_by_user_id !== req.user.id) {
      res.status(409).json({ error: "This title is already checked out by another user." });
      return;
    }

    const activeCheckout = getActiveCheckoutForUser(req.user.id);
    if (activeCheckout && activeCheckout.id !== titleRow.id) {
      res.status(409).json({ error: "A user may hold only one active checkout at a time." });
      return;
    }

    if (!titleRow.checked_out_by_user_id) {
      const phrases = parseJson(titleRow.phrases_json, []);
      const savedSnapshot = parseJson(titleRow.saved_snapshot_json, []);
      const checkedOutAt = nowIso();
      const updatedTitle = updateTitleRecord(titleRow.id, {
        ...titleRow,
        checked_out_by_user_id: req.user.id,
        checked_out_at: checkedOutAt,
      });
      const draftRow = createOrReplaceDraft({
        titleId: titleRow.id,
        userId: req.user.id,
        phrases,
        savedSnapshot,
        version: 1,
        isDirty: false,
        status: "active",
        lastAutosaveAt: null,
        lastSaveAt: checkedOutAt,
        lastSyncAt: null,
      });
      await persistTitleSentenceState({
        titleRow: updatedTitle,
        phrases,
        savedSnapshot,
        draftRow,
      });
      createCheckoutRecord(titleRow.id, req.user.id, false);

      insertAuditRecord({
        eventType: "checkout",
        titleId: titleRow.id,
        titleName: titleRow.title,
        actorUserId: req.user.id,
        actorDisplayName: req.user.displayName,
        details: "Checked out title and resumed the latest server-side draft.",
      });
    }

    sendAppState(res, req.user.id);
  } catch (error) {
    next(error);
  }
});

app.post("/api/titles/:titleId/save", requireUser, async (req, res, next) => {
  try {
    const titleRow = getTitleRow(req.params.titleId);
    if (!titleRow) {
      res.status(404).json({ error: "Title not found." });
      return;
    }

    const kind = String(req.body?.kind || "manual");
    const title = req.body?.title || null;
    if (titleRow.checked_out_by_user_id !== req.user.id) {
      res.status(409).json({ error: "Only the checkout owner can save this title." });
      return;
    }

    const timestamp = nowIso();
    const draft = getDraftForTitle(titleRow.id);
    const phrases = Array.isArray(title?.phrases) ? title.phrases : parseJson(draft?.phrases_json || titleRow.phrases_json, []);
    const savedSnapshot = Array.isArray(title?.savedSnapshot)
      ? title.savedSnapshot
      : parseJson(draft?.saved_snapshot_json || titleRow.saved_snapshot_json, []);

    const nextDraft = createOrReplaceDraft({
      titleId: titleRow.id,
      userId: req.user.id,
      phrases,
      savedSnapshot,
      version: (draft?.version || 0) + 1,
      isDirty: false,
      status: kind === "checkin" ? "finalized" : "active",
      lastAutosaveAt: kind === "autosave" ? timestamp : draft?.last_autosave_at || null,
      lastSaveAt: kind === "manual" || kind === "checkin" ? timestamp : draft?.last_save_at || null,
      lastSyncAt: kind === "sync" ? timestamp : draft?.last_sync_at || null,
    });

    const basePatch = {
      ...titleRow,
      title: title?.title || titleRow.title,
      source: title?.source || titleRow.source,
      language: title?.language || titleRow.language,
      duration: Number(title?.duration || titleRow.duration || 0),
      phrase_count: phrases.length,
      badge: badgeForPhrases(phrases, titleRow.badge),
    };

    let updatedTitle = null;
    if (kind === "checkin") {
      updatedTitle = updateTitleRecord(titleRow.id, {
        ...basePatch,
        phrases_json: JSON.stringify(phrases),
        saved_snapshot_json: JSON.stringify(savedSnapshot),
        checked_out_by_user_id: null,
        checked_out_at: null,
      });
      closeCheckoutRecords(titleRow.id);
      insertAuditRecord({
        eventType: "checkin",
        titleId: titleRow.id,
        titleName: title?.title || titleRow.title,
        actorUserId: req.user.id,
        actorDisplayName: req.user.displayName,
        details: "Checked in the latest finalized working draft.",
      });
    } else {
      updatedTitle = updateTitleRecord(titleRow.id, basePatch);
      if (kind === "sync") {
        insertAuditRecord({
          eventType: "sync",
          titleId: titleRow.id,
          titleName: title?.title || titleRow.title,
          actorUserId: req.user.id,
          actorDisplayName: req.user.displayName,
          details: "Synced working-draft changes while keeping the checkout.",
        });
      }
    }

    await persistTitleSentenceState({
      titleRow: updatedTitle,
      phrases,
      savedSnapshot,
      draftRow: nextDraft,
    });

    sendAppState(res, req.user.id);
  } catch (error) {
    next(error);
  }
});

app.post("/api/titles/:titleId/force-checkin", requireAdmin, async (req, res, next) => {
  try {
    const titleRow = getTitleRow(req.params.titleId);
    if (!titleRow) {
      res.status(404).json({ error: "Title not found." });
      return;
    }

    const draft = getDraftForTitle(titleRow.id);
    const phrases = draft ? parseJson(draft.phrases_json, []) : parseJson(titleRow.phrases_json, []);
    const updatedTitle = updateTitleRecord(titleRow.id, {
      ...titleRow,
      phrases_json: JSON.stringify(phrases),
      saved_snapshot_json: JSON.stringify(phrases),
      checked_out_by_user_id: null,
      checked_out_at: null,
      phrase_count: phrases.length,
      badge: badgeForPhrases(phrases, titleRow.badge),
    });
    const archivedDraft = draft
      ? createOrReplaceDraft({
          titleId: titleRow.id,
          userId: draft.user_id,
          phrases,
          savedSnapshot: phrases,
          version: draft.version,
          isDirty: false,
          status: "archived",
          lastAutosaveAt: draft.last_autosave_at,
          lastSaveAt: draft.last_save_at,
          lastSyncAt: draft.last_sync_at,
        })
      : null;
    await persistTitleSentenceState({
      titleRow: updatedTitle,
      phrases,
      savedSnapshot: phrases,
      draftRow: archivedDraft,
    });
    closeCheckoutRecords(titleRow.id);
    insertAuditRecord({
      eventType: "force_checkin",
      titleId: titleRow.id,
      titleName: titleRow.title,
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: "Admin forced a check-in using the latest server-persisted copy.",
    });

    sendAppState(res, req.user.id);
  } catch (error) {
    next(error);
  }
});

app.post("/api/titles/:titleId/takeover", requireAdmin, async (req, res, next) => {
  try {
    const titleRow = getTitleRow(req.params.titleId);
    if (!titleRow) {
      res.status(404).json({ error: "Title not found." });
      return;
    }

    const activeCheckout = getActiveCheckoutForUser(req.user.id);
    if (activeCheckout && activeCheckout.id !== titleRow.id) {
      res.status(409).json({ error: "You already hold another checked-out title." });
      return;
    }

    const previousOwnerId = titleRow.checked_out_by_user_id;
    const draft = getDraftForTitle(titleRow.id);
    const phrases = draft ? parseJson(draft.phrases_json, []) : parseJson(titleRow.phrases_json, []);
    const savedSnapshot = draft ? parseJson(draft.saved_snapshot_json, []) : parseJson(titleRow.saved_snapshot_json, []);
    const checkedOutAt = nowIso();

    const updatedTitle = updateTitleRecord(titleRow.id, {
      ...titleRow,
      checked_out_by_user_id: req.user.id,
      checked_out_at: checkedOutAt,
    });
    const nextDraft = createOrReplaceDraft({
      titleId: titleRow.id,
      userId: req.user.id,
      phrases,
      savedSnapshot,
      version: (draft?.version || 0) + 1,
      isDirty: false,
      status: "active",
      lastAutosaveAt: draft?.last_autosave_at || null,
      lastSaveAt: draft?.last_save_at || checkedOutAt,
      lastSyncAt: draft?.last_sync_at || null,
    });
    await persistTitleSentenceState({
      titleRow: updatedTitle,
      phrases,
      savedSnapshot,
      draftRow: nextDraft,
    });
    closeCheckoutRecords(titleRow.id);
    createCheckoutRecord(titleRow.id, req.user.id, true);
    insertAuditRecord({
      eventType: "takeover",
      titleId: titleRow.id,
      titleName: titleRow.title,
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: `Admin took over the checkout${previousOwnerId ? ` from ${previousOwnerId}` : ""} and preserved the stored draft.`,
    });

    sendAppState(res, req.user.id);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/titles/:titleId", requireAdmin, async (req, res, next) => {
  try {
    const titleRow = getTitleRow(req.params.titleId);
    if (!titleRow) {
      res.status(404).json({ error: "Title not found." });
      return;
    }

    const storage = getStorageService();
    for (const key of [titleRow.audio_object_key, titleRow.waveform_object_key, titleRow.latest_asr_object_key].filter(Boolean)) {
      await storage.deleteObject(key);
    }
    await deleteTitleSentenceState(titleRow.id);

    deleteTitleRecord(titleRow.id);
    insertAuditRecord({
      eventType: "title_delete",
      titleId: null,
      titleName: titleRow.title,
      actorUserId: req.user.id,
      actorDisplayName: req.user.displayName,
      details: "Deleted title and its stored artifacts.",
    });

    sendAppState(res, req.user.id);
  } catch (error) {
    next(error);
  }
});

app.post("/api/import/youtube", requireUser, (req, res) => {
  const urls = parseYouTubeUrls(req.body?.urls || req.body?.url);
  const language = String(req.body?.language || "en").trim() || "en";
  const state = buildAppState(req.user.id);
  const workspaceId = state.selectedWorkspaceId || null;
  if (urls.length === 0) {
    res.status(400).json({ error: "At least one YouTube URL is required." });
    return;
  }

  const jobs = urls.map((url) =>
    createJob("youtube_import", req.user.id, {
      url,
      language,
      workspaceId,
      actorDisplayName: req.user.displayName,
    }, null, workspaceId),
  );
  triggerKeepAwakeCheck();
  res.status(202).json({ jobs, job: jobs[0] || null });
});

app.post("/api/import/media/probe", requireUser, upload.single("media"), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "A media file is required for probing." });
      return;
    }

    const subtitleStreams = await listSubtitleStreams(req.file.path);
    const manifest = buildMediaProbeManifest(req.file);

    res.json({
      probeToken: manifest.probeToken,
      subtitleStreams,
      suggestedTitle: path.basename(req.file.originalname, path.extname(req.file.originalname)),
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/import/media",
  requireUser,
  upload.fields([
    { name: "media", maxCount: 1 },
    { name: "subtitle", maxCount: 1 },
  ]),
  (req, res) => {
    const state = buildAppState(req.user.id);
    const workspaceId = state.selectedWorkspaceId || null;
    const mediaFile = req.files?.media?.[0];
    const subtitleFile = req.files?.subtitle?.[0];
    const probeManifest = readMediaProbeManifest(req.body?.probeToken);
    const effectiveMediaPath = mediaFile?.path || probeManifest?.filePath || null;
    const effectiveMediaName = mediaFile?.originalname || probeManifest?.originalName || "";

    if (!effectiveMediaPath) {
      res.status(400).json({ error: "A media file is required." });
      return;
    }

    const job = createJob("media_import", req.user.id, {
      mediaFilePath: effectiveMediaPath,
      subtitleFilePath: subtitleFile?.path || null,
      subtitleStreamIndex:
        req.body?.subtitleStreamIndex !== undefined && req.body?.subtitleStreamIndex !== ""
          ? Number(req.body.subtitleStreamIndex)
          : null,
      title: String(req.body?.title || path.basename(effectiveMediaName, path.extname(effectiveMediaName))),
      source: String(req.body?.source || "Uploaded Media"),
      language: String(req.body?.language || "en"),
      workspaceId,
      actorDisplayName: req.user.displayName,
    }, null, workspaceId);
    deleteMediaProbeManifest(req.body?.probeToken);
    triggerKeepAwakeCheck();
    res.status(202).json({ job });
  },
);

app.post("/api/import/asr", requireUser, upload.single("archive"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "An .asr archive is required." });
    return;
  }

  const state = buildAppState(req.user.id);
  const workspaceId = state.selectedWorkspaceId || null;
  const job = createJob("asr_import", req.user.id, {
    archivePath: req.file.path,
    workspaceId,
    actorDisplayName: req.user.displayName,
  }, null, workspaceId);
  triggerKeepAwakeCheck();

  res.status(202).json({ job });
});

app.get("/api/titles/:titleId/export.asr", requireUser, async (req, res, next) => {
  try {
    const titleRow = getTitleRow(req.params.titleId);
    if (!titleRow) {
      res.status(404).json({ error: "Title not found." });
      return;
    }

    const { phrases } = getTitlePhrasesForUser(titleRow, req.user.id);
    const audioPath = await materializeObject(titleRow.audio_object_key, "working_audio.wav");
    const archivePath = path.join(paths.tempDir, `${titleRow.id}.asr`);

    await createAsrArchive(
      {
        title: {
          id: titleRow.id,
          videoId: titleRow.video_id,
          title: titleRow.title,
          source: titleRow.source,
          language: titleRow.language,
          duration: titleRow.duration,
          sourceType: titleRow.source_type,
          uploadedAt: titleRow.uploaded_at,
        },
        phrases,
        audioFilePath: audioPath,
        outputPath: archivePath,
      },
    );

    const storage = getStorageService();
    const asrKey = getObjectKey("titles", `${titleRow.id}.asr`);
    await storage.putFile(asrKey, archivePath, "application/zip");
    updateTitleRecord(titleRow.id, {
      ...titleRow,
      latest_asr_object_key: asrKey,
    });

    res.download(archivePath, `${titleRow.video_id}.asr`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/export/all", requireUser, async (req, res, next) => {
  try {
    const state = buildAppState(req.user.id);
    const selectedIds = String(req.query?.ids || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const titles = state.titles.filter((title) => selectedIds.length === 0 || selectedIds.includes(title.id));
    const bundlePath = path.join(paths.tempDir, `${randomId("bundle")}.zip`);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(bundlePath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);

      const tasks = titles.map(async (title) => {
        const titleRow = getTitleRow(title.id);
        const { phrases } = getTitlePhrasesForUser(titleRow, req.user.id);
        const audioPath = await materializeObject(titleRow.audio_object_key, "working_audio.wav");
        const tempAsrPath = path.join(paths.tempDir, `${title.id}.asr`);
        await createAsrArchive({
          title: {
            id: titleRow.id,
            videoId: titleRow.video_id,
            title: titleRow.title,
            source: titleRow.source,
            language: titleRow.language,
            duration: titleRow.duration,
            sourceType: titleRow.source_type,
            uploadedAt: titleRow.uploaded_at,
          },
          phrases,
          audioFilePath: audioPath,
          outputPath: tempAsrPath,
        });
        archive.file(tempAsrPath, { name: `${title.videoId}.asr` });
      });

      Promise.all(tasks)
        .then(() => archive.finalize())
        .catch(reject);
    });

    res.download(bundlePath, "yt-asr-export-bundle.zip");
  } catch (error) {
    next(error);
  }
});

app.get("/api/titles/:titleId/audio", requireUser, async (req, res, next) => {
  try {
    const titleRow = getTitleRow(req.params.titleId);
    if (!titleRow?.audio_object_key) {
      res.status(404).json({ error: "Audio not available." });
      return;
    }

    const storage = getStorageService();
    if (storage.mode === "local") {
      const audioPath = storage.resolveLocalPath(titleRow.audio_object_key);
      const stat = await fs.promises.stat(audioPath);
      const range = parseByteRange(req.headers.range, stat.size);

      if (range === "invalid") {
        res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
        return;
      }

      applyAudioHeaders(res, stat.size, range);
      fs.createReadStream(audioPath, range ? { start: range.start, end: range.end } : undefined).pipe(res);
      return;
    }

    const buffer = await storage.getBuffer(titleRow.audio_object_key);
    const range = parseByteRange(req.headers.range, buffer.length);
    if (range === "invalid") {
      res.status(416).setHeader("Content-Range", `bytes */${buffer.length}`).end();
      return;
    }

    applyAudioHeaders(res, buffer.length, range);
    res.send(range ? buffer.subarray(range.start, range.end + 1) : buffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/titles/:titleId/waveform", requireUser, async (req, res, next) => {
  try {
    const titleRow = getTitleRow(req.params.titleId);
    if (!titleRow?.waveform_object_key) {
      res.status(404).json({ error: "Waveform not available." });
      return;
    }

    const storage = getStorageService();
    if (storage.mode === "local") {
      res.sendFile(storage.resolveLocalPath(titleRow.waveform_object_key));
      return;
    }

    const buffer = await storage.getBuffer(titleRow.waveform_object_key);
    res.type("image/png").send(buffer);
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/storage", requireAdmin, (req, res) => {
  const body = req.body || {};
  const settings = saveStorageSettings({
    provider: String(body.provider || "Local Disk"),
    bucket: String(body.bucket || ""),
    prefix: String(body.prefix || ""),
    endpointUrl: String(body.endpointUrl || ""),
    region: String(body.region || ""),
    addressingMode: String(body.addressingMode || "path"),
    auditVisible: Boolean(body.auditVisible),
    accessKeyId: body.accessKeyId !== undefined ? String(body.accessKeyId || "") : "",
    secretAccessKey: body.secretAccessKey !== undefined ? String(body.secretAccessKey || "") : "",
    accessKeyIdChanged: body.accessKeyId !== undefined,
    secretAccessKeyChanged: body.secretAccessKey !== undefined,
  });

  res.json({ storage: settings });
});

app.post("/api/admin/storage/test", requireAdmin, async (_req, res, next) => {
  try {
    const storage = getStorageService();
    await storage.testConnection();
    const timestamp = markStorageConnectionTest();
    res.json({ ok: true, testedAt: timestamp, storage: getStorageSettings(false) });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected server error.",
  });
});

if (fs.existsSync(paths.distDir)) {
  app.use(express.static(paths.distDir));
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(paths.distDir, "index.html"));
  });
}

recoverInterruptedJobs();
startJobWorker();

app.listen(appConfig.port, () => {
  startKeepAwakeManager();
  triggerKeepAwakeCheck();
  console.log(`yt-asr server listening on http://localhost:${appConfig.port}`);
});
