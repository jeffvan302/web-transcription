import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";
import {
  buildAppState,
  closeCheckoutRecords,
  createJob,
  createCheckoutRecord,
  createOrReplaceDraft,
  createSession,
  deleteSession,
  deleteTitleRecord,
  findUserByEmail,
  getActiveCheckoutForUser,
  getDraftForTitle,
  getSessionWithUser,
  getStorageSettings,
  getTitleRow,
  insertAuditRecord,
  listJobs,
  markStorageConnectionTest,
  sanitizeUser,
  saveStorageSettings,
  updateTitleRecord,
  updateUserLastLogin,
} from "./database.js";
import { appConfig, paths } from "./config.js";
import { createAsrArchive } from "./asr.js";
import { startJobWorker } from "./jobs.js";
import { getYouTubeMetadata } from "./media.js";
import { getObjectKey, getStorageService } from "./storage.js";
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
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
}

function sendAppState(res, userId) {
  res.json({
    state: buildAppState(userId),
    jobs: listJobs(userId, 25),
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

app.get("/api/auth/session", (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: "No active session." });
    return;
  }

  reqUserDisplayNameCache.set(req.user.id, req.user.displayName);
  sendAppState(res, req.user.id);
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const userRow = findUserByEmail(email);
  if (!userRow || userRow.status !== "active" || !bcrypt.compareSync(password, userRow.password_hash)) {
    res.status(401).json({ error: "Invalid email or password." });
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

  sendAppState(res, user.id);
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

app.get("/api/state", requireUser, (req, res) => {
  reqUserDisplayNameCache.set(req.user.id, req.user.displayName);
  sendAppState(res, req.user.id);
});

app.get("/api/jobs", requireUser, (req, res) => {
  res.json({ jobs: listJobs(req.user.id, 30) });
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

app.post("/api/titles/:titleId/checkout", requireUser, (req, res) => {
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
    updateTitleRecord(titleRow.id, {
      ...titleRow,
      checked_out_by_user_id: req.user.id,
      checked_out_at: nowIso(),
    });
    createOrReplaceDraft({
      titleId: titleRow.id,
      userId: req.user.id,
      phrases,
      savedSnapshot,
      version: 1,
      isDirty: false,
      status: "active",
      lastAutosaveAt: null,
      lastSaveAt: nowIso(),
      lastSyncAt: null,
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
});

app.post("/api/titles/:titleId/save", requireUser, (req, res) => {
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

  createOrReplaceDraft({
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

  if (kind === "checkin") {
    updateTitleRecord(titleRow.id, {
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
    updateTitleRecord(titleRow.id, basePatch);
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

  sendAppState(res, req.user.id);
});

app.post("/api/titles/:titleId/force-checkin", requireAdmin, (req, res) => {
  const titleRow = getTitleRow(req.params.titleId);
  if (!titleRow) {
    res.status(404).json({ error: "Title not found." });
    return;
  }

  const draft = getDraftForTitle(titleRow.id);
  const phrases = draft ? parseJson(draft.phrases_json, []) : parseJson(titleRow.phrases_json, []);
  updateTitleRecord(titleRow.id, {
    ...titleRow,
    phrases_json: JSON.stringify(phrases),
    saved_snapshot_json: JSON.stringify(phrases),
    checked_out_by_user_id: null,
    checked_out_at: null,
    phrase_count: phrases.length,
    badge: badgeForPhrases(phrases, titleRow.badge),
  });
  if (draft) {
    createOrReplaceDraft({
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
    });
  }
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
});

app.post("/api/titles/:titleId/takeover", requireAdmin, (req, res) => {
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

  updateTitleRecord(titleRow.id, {
    ...titleRow,
    checked_out_by_user_id: req.user.id,
    checked_out_at: nowIso(),
  });
  createOrReplaceDraft({
    titleId: titleRow.id,
    userId: req.user.id,
    phrases,
    savedSnapshot,
    version: (draft?.version || 0) + 1,
    isDirty: false,
    status: "active",
    lastAutosaveAt: draft?.last_autosave_at || null,
    lastSaveAt: draft?.last_save_at || null,
    lastSyncAt: draft?.last_sync_at || null,
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
  const url = String(req.body?.url || "").trim();
  const language = String(req.body?.language || "en").trim() || "en";
  if (!url) {
    res.status(400).json({ error: "A YouTube URL is required." });
    return;
  }

  const job = createJob("youtube_import", req.user.id, {
    url,
    language,
    actorDisplayName: req.user.displayName,
  });
  res.status(202).json({ job });
});

app.post(
  "/api/import/media",
  requireUser,
  upload.fields([
    { name: "media", maxCount: 1 },
    { name: "subtitle", maxCount: 1 },
  ]),
  (req, res) => {
    const mediaFile = req.files?.media?.[0];
    const subtitleFile = req.files?.subtitle?.[0];
    if (!mediaFile) {
      res.status(400).json({ error: "A media file is required." });
      return;
    }

    const job = createJob("media_import", req.user.id, {
      mediaFilePath: mediaFile.path,
      subtitleFilePath: subtitleFile?.path || null,
      subtitleStreamIndex:
        req.body?.subtitleStreamIndex !== undefined && req.body?.subtitleStreamIndex !== ""
          ? Number(req.body.subtitleStreamIndex)
          : null,
      title: String(req.body?.title || path.basename(mediaFile.originalname, path.extname(mediaFile.originalname))),
      source: String(req.body?.source || "Uploaded Media"),
      language: String(req.body?.language || "en"),
      actorDisplayName: req.user.displayName,
    });

    res.status(202).json({ job });
  },
);

app.post("/api/import/asr", requireUser, upload.single("archive"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "An .asr archive is required." });
    return;
  }

  const job = createJob("asr_import", req.user.id, {
    archivePath: req.file.path,
    actorDisplayName: req.user.displayName,
  });

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
      res.sendFile(storage.resolveLocalPath(titleRow.audio_object_key));
      return;
    }

    const buffer = await storage.getBuffer(titleRow.audio_object_key);
    res.type("audio/wav").send(buffer);
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

startJobWorker();

app.listen(appConfig.port, () => {
  console.log(`yt-asr server listening on http://localhost:${appConfig.port}`);
});
