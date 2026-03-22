import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { appConfig, defaultStorageSettings, paths, seededUsers } from "./config.js";
import { ensureDir, humanFileSize, nowIso, parseJson, randomId } from "./helpers.js";

ensureDir(paths.dataDir);

export const db = new Database(paths.databaseFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS titles (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    language TEXT NOT NULL,
    duration REAL NOT NULL DEFAULT 0,
    source_type TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    phrase_count INTEGER NOT NULL DEFAULT 0,
    phrases_json TEXT NOT NULL DEFAULT '[]',
    saved_snapshot_json TEXT NOT NULL DEFAULT '[]',
    checked_out_by_user_id TEXT,
    checked_out_at TEXT,
    badge TEXT,
    audio_object_key TEXT,
    waveform_object_key TEXT,
    latest_asr_object_key TEXT,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (checked_out_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    title_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    last_autosave_at TEXT,
    last_save_at TEXT,
    last_sync_at TEXT,
    is_dirty INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    phrases_json TEXT NOT NULL DEFAULT '[]',
    saved_snapshot_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS checkouts (
    id TEXT PRIMARY KEY,
    title_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    checkout_timestamp TEXT NOT NULL,
    checkin_timestamp TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    takeover INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    title_id TEXT,
    title_name TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_display_name TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    details TEXT NOT NULL,
    detail_json TEXT,
    FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE SET NULL,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    title_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    error_text TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS storage_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL,
    bucket TEXT NOT NULL,
    prefix_value TEXT NOT NULL,
    endpoint_url TEXT NOT NULL,
    region TEXT NOT NULL,
    addressing_mode TEXT NOT NULL,
    access_key_id TEXT,
    secret_access_key TEXT,
    last_connection_test_at TEXT,
    audit_visible INTEGER NOT NULL DEFAULT 1
  );
`);

const insertUserStatement = db.prepare(`
  INSERT INTO users (id, email, display_name, password_hash, role, status, created_at, updated_at)
  VALUES (@id, @email, @displayName, @passwordHash, @role, 'active', @createdAt, @updatedAt)
`);

function seedUsersIfNeeded() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM users").get();
  if (existing.count > 0) {
    return;
  }

  const timestamp = nowIso();
  for (const user of seededUsers) {
    insertUserStatement.run({
      id: randomId("user"),
      email: user.email,
      displayName: user.displayName,
      passwordHash: bcrypt.hashSync(user.password, 12),
      role: user.role,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

function seedStorageIfNeeded() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM storage_settings").get();
  if (existing.count > 0) {
    return;
  }

  db.prepare(`
    INSERT INTO storage_settings (
      id, provider, bucket, prefix_value, endpoint_url, region, addressing_mode, access_key_id, secret_access_key,
      last_connection_test_at, audit_visible
    )
    VALUES (1, @provider, @bucket, @prefix, @endpointUrl, @region, @addressingMode, @accessKeyId, @secretAccessKey,
      @lastConnectionTestAt, @auditVisible)
  `).run({
    provider: defaultStorageSettings.provider,
    bucket: defaultStorageSettings.bucket,
    prefix: defaultStorageSettings.prefix,
    endpointUrl: defaultStorageSettings.endpointUrl,
    region: defaultStorageSettings.region,
    addressingMode: defaultStorageSettings.addressingMode,
    accessKeyId: defaultStorageSettings.accessKeyId,
    secretAccessKey: defaultStorageSettings.secretAccessKey,
    lastConnectionTestAt: defaultStorageSettings.lastConnectionTestAt,
    auditVisible: defaultStorageSettings.auditVisible ? 1 : 0,
  });
}

seedUsersIfNeeded();
seedStorageIfNeeded();

export function sanitizeUser(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
  };
}

export function getUserById(userId) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  return row || null;
}

export function findUserByEmail(email) {
  const row = db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(email);
  return row || null;
}

export function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY display_name ASC").all().map(sanitizeUser);
}

export function updateUserLastLogin(userId) {
  db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), userId);
}

export function createSession(userId) {
  const sessionId = randomId("session");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + appConfig.sessionTtlMs).toISOString();

  db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    sessionId,
    userId,
    createdAt,
    expiresAt,
  );

  return { id: sessionId, expiresAt };
}

export function deleteExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
}

export function deleteSession(sessionId) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function getSessionWithUser(sessionId) {
  deleteExpiredSessions();
  return (
    db
      .prepare(`
        SELECT sessions.id AS session_id, sessions.expires_at, users.*
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.id = ?
      `)
      .get(sessionId) || null
  );
}

export function getStorageSettings(includeSecrets = false) {
  const row = db.prepare("SELECT * FROM storage_settings WHERE id = 1").get();
  if (!row) {
    return { ...defaultStorageSettings };
  }

  const base = {
    provider: row.provider,
    bucket: row.bucket,
    prefix: row.prefix_value,
    endpointUrl: row.endpoint_url,
    region: row.region,
    addressingMode: row.addressing_mode,
    lastConnectionTestAt: row.last_connection_test_at,
    auditVisible: Boolean(row.audit_visible),
  };

  if (!includeSecrets) {
    return base;
  }

  return {
    ...base,
    accessKeyId: row.access_key_id || "",
    secretAccessKey: row.secret_access_key || "",
  };
}

export function saveStorageSettings(input) {
  db.prepare(`
    UPDATE storage_settings
    SET
      provider = @provider,
      bucket = @bucket,
      prefix_value = @prefix,
      endpoint_url = @endpointUrl,
      region = @region,
      addressing_mode = @addressingMode,
      access_key_id = CASE WHEN @accessKeyIdChanged = 1 THEN @accessKeyId ELSE access_key_id END,
      secret_access_key = CASE WHEN @secretAccessKeyChanged = 1 THEN @secretAccessKey ELSE secret_access_key END,
      audit_visible = @auditVisible
    WHERE id = 1
  `).run({
    provider: input.provider,
    bucket: input.bucket,
    prefix: input.prefix,
    endpointUrl: input.endpointUrl,
    region: input.region,
    addressingMode: input.addressingMode,
    accessKeyIdChanged: input.accessKeyIdChanged ? 1 : 0,
    secretAccessKeyChanged: input.secretAccessKeyChanged ? 1 : 0,
    accessKeyId: input.accessKeyId || "",
    secretAccessKey: input.secretAccessKey || "",
    auditVisible: input.auditVisible ? 1 : 0,
  });

  return getStorageSettings(false);
}

export function markStorageConnectionTest() {
  const timestamp = nowIso();
  db.prepare("UPDATE storage_settings SET last_connection_test_at = ? WHERE id = 1").run(timestamp);
  return timestamp;
}

export function insertAuditRecord({ eventType, titleId = null, titleName, actorUserId, actorDisplayName, details, detailJson = null }) {
  db.prepare(`
    INSERT INTO audits (id, event_type, title_id, title_name, actor_user_id, actor_display_name, timestamp, details, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomId("audit"),
    eventType,
    titleId,
    titleName,
    actorUserId,
    actorDisplayName,
    nowIso(),
    details,
    detailJson ? JSON.stringify(detailJson) : null,
  );
}

export function listAuditRecords(limit = 20) {
  return db
    .prepare("SELECT * FROM audits ORDER BY timestamp DESC LIMIT ?")
    .all(limit)
    .map((row) => ({
      id: row.id,
      eventType: row.event_type,
      titleId: row.title_id,
      titleName: row.title_name,
      actorUserId: row.actor_user_id,
      actorDisplayName: row.actor_display_name,
      timestamp: row.timestamp,
      details: row.details,
    }));
}

export function getActiveCheckoutForUser(userId) {
  return db
    .prepare("SELECT * FROM titles WHERE checked_out_by_user_id = ? ORDER BY checked_out_at DESC LIMIT 1")
    .get(userId);
}

export function getTitleRow(titleId) {
  return db.prepare("SELECT * FROM titles WHERE id = ?").get(titleId) || null;
}

export function getTitleByVideoId(videoId) {
  return db.prepare("SELECT * FROM titles WHERE video_id = ?").get(videoId) || null;
}

export function listTitleRows() {
  return db.prepare("SELECT * FROM titles ORDER BY title COLLATE NOCASE ASC").all();
}

export function getDraftForTitle(titleId) {
  return db.prepare("SELECT * FROM drafts WHERE title_id = ?").get(titleId) || null;
}

function buildDraftMeta(titleRow, draftRow, isOwner) {
  if (isOwner && draftRow) {
    return {
      version: draftRow.version,
      lastAutosaveAt: draftRow.last_autosave_at,
      lastSaveAt: draftRow.last_save_at,
      lastSyncAt: draftRow.last_sync_at,
      isDirty: Boolean(draftRow.is_dirty),
      status: draftRow.status,
    };
  }

  return {
    version: 1,
    lastAutosaveAt: null,
    lastSaveAt: titleRow.updated_at,
    lastSyncAt: null,
    isDirty: false,
    status: titleRow.checked_out_by_user_id ? "active" : "finalized",
  };
}

function serializeTitleForUser(titleRow, currentUserId) {
  const owner = titleRow.checked_out_by_user_id === currentUserId;
  const draftRow = owner ? getDraftForTitle(titleRow.id) : null;
  const phrases = owner && draftRow ? parseJson(draftRow.phrases_json, []) : parseJson(titleRow.phrases_json, []);
  const savedSnapshot =
    owner && draftRow ? parseJson(draftRow.saved_snapshot_json, []) : parseJson(titleRow.saved_snapshot_json, []);

  return {
    id: titleRow.id,
    videoId: titleRow.video_id,
    title: titleRow.title,
    source: titleRow.source,
    language: titleRow.language,
    duration: titleRow.duration,
    sourceType: titleRow.source_type,
    uploadedAt: titleRow.uploaded_at,
    sizeLabel: humanFileSize(titleRow.size_bytes),
    checkedOutByUserId: titleRow.checked_out_by_user_id,
    checkedOutAt: titleRow.checked_out_at,
    phrases,
    savedSnapshot,
    draft: buildDraftMeta(titleRow, draftRow, owner),
    badge: titleRow.badge,
    audioUrl: titleRow.audio_object_key ? `/api/titles/${titleRow.id}/audio` : null,
    waveformUrl: titleRow.waveform_object_key ? `/api/titles/${titleRow.id}/waveform` : null,
  };
}

export function buildAppState(userId) {
  const titles = listTitleRows();
  const activeCheckout = getActiveCheckoutForUser(userId);
  const selectedTitle = activeCheckout || titles[0] || null;
  const serializedTitles = titles.map((titleRow) => serializeTitleForUser(titleRow, userId));
  const selectedSerializedTitle = serializedTitles.find((title) => title.id === selectedTitle?.id) || serializedTitles[0] || null;

  return {
    sessionUserId: userId,
    selectedTitleId: selectedSerializedTitle?.id || "",
    selectedPhraseIds: selectedSerializedTitle?.phrases[0] ? [selectedSerializedTitle.phrases[0].id] : [],
    currentView: selectedSerializedTitle ? "editor" : "shared",
    youtubeUrl: "",
    importLanguage: "en",
    workspaceName: "Primary Workspace",
    users: listUsers(),
    titles: serializedTitles,
    storage: getStorageSettings(false),
    audit: listAuditRecords(20),
  };
}

export function createTitleRecord(input) {
  const timestamp = nowIso();
  const badge = input.phrases.length > 0 && input.phrases.every((phrase) => phrase.reviewed) ? "reviewed" : input.badge || null;

  db.prepare(`
    INSERT INTO titles (
      id, video_id, title, source, language, duration, source_type, uploaded_at, updated_at, created_by_user_id,
      size_bytes, phrase_count, phrases_json, saved_snapshot_json, checked_out_by_user_id, checked_out_at, badge,
      audio_object_key, waveform_object_key, latest_asr_object_key
    )
    VALUES (
      @id, @videoId, @title, @source, @language, @duration, @sourceType, @uploadedAt, @updatedAt, @createdByUserId,
      @sizeBytes, @phraseCount, @phrasesJson, @savedSnapshotJson, @checkedOutByUserId, @checkedOutAt, @badge,
      @audioObjectKey, @waveformObjectKey, @latestAsrObjectKey
    )
  `).run({
    id: input.id,
    videoId: input.videoId,
    title: input.title,
    source: input.source,
    language: input.language,
    duration: input.duration,
    sourceType: input.sourceType,
    uploadedAt: input.uploadedAt || timestamp,
    updatedAt: timestamp,
    createdByUserId: input.createdByUserId,
    sizeBytes: input.sizeBytes || 0,
    phraseCount: input.phrases.length,
    phrasesJson: JSON.stringify(input.phrases),
    savedSnapshotJson: JSON.stringify(input.savedSnapshot || input.phrases),
    checkedOutByUserId: input.checkedOutByUserId || null,
    checkedOutAt: input.checkedOutAt || null,
    badge,
    audioObjectKey: input.audioObjectKey || null,
    waveformObjectKey: input.waveformObjectKey || null,
    latestAsrObjectKey: input.latestAsrObjectKey || null,
  });

  if (input.checkedOutByUserId) {
    createOrReplaceDraft({
      titleId: input.id,
      userId: input.checkedOutByUserId,
      phrases: input.phrases,
      savedSnapshot: input.savedSnapshot || input.phrases,
      version: 1,
      isDirty: false,
      status: "active",
      lastAutosaveAt: null,
      lastSaveAt: timestamp,
      lastSyncAt: null,
    });
    createCheckoutRecord(input.id, input.checkedOutByUserId, false);
  }

  return getTitleRow(input.id);
}

export function updateTitleRecord(titleId, patch) {
  const title = getTitleRow(titleId);
  if (!title) {
    return null;
  }

  const next = {
    ...title,
    ...patch,
    updated_at: nowIso(),
  };

  db.prepare(`
    UPDATE titles
    SET
      video_id = @video_id,
      title = @title,
      source = @source,
      language = @language,
      duration = @duration,
      source_type = @source_type,
      uploaded_at = @uploaded_at,
      updated_at = @updated_at,
      created_by_user_id = @created_by_user_id,
      size_bytes = @size_bytes,
      phrase_count = @phrase_count,
      phrases_json = @phrases_json,
      saved_snapshot_json = @saved_snapshot_json,
      checked_out_by_user_id = @checked_out_by_user_id,
      checked_out_at = @checked_out_at,
      badge = @badge,
      audio_object_key = @audio_object_key,
      waveform_object_key = @waveform_object_key,
      latest_asr_object_key = @latest_asr_object_key
    WHERE id = @id
  `).run(next);

  return getTitleRow(titleId);
}

export function createOrReplaceDraft(input) {
  const existing = getDraftForTitle(input.titleId);
  const timestamp = nowIso();

  if (existing) {
    db.prepare(`
      UPDATE drafts
      SET
        user_id = @userId,
        version = @version,
        last_autosave_at = @lastAutosaveAt,
        last_save_at = @lastSaveAt,
        last_sync_at = @lastSyncAt,
        is_dirty = @isDirty,
        status = @status,
        phrases_json = @phrasesJson,
        saved_snapshot_json = @savedSnapshotJson,
        updated_at = @updatedAt
      WHERE title_id = @titleId
    `).run({
      titleId: input.titleId,
      userId: input.userId,
      version: input.version,
      lastAutosaveAt: input.lastAutosaveAt,
      lastSaveAt: input.lastSaveAt,
      lastSyncAt: input.lastSyncAt,
      isDirty: input.isDirty ? 1 : 0,
      status: input.status,
      phrasesJson: JSON.stringify(input.phrases),
      savedSnapshotJson: JSON.stringify(input.savedSnapshot || input.phrases),
      updatedAt: timestamp,
    });
  } else {
    db.prepare(`
      INSERT INTO drafts (
        id, title_id, user_id, version, last_autosave_at, last_save_at, last_sync_at, is_dirty, status,
        phrases_json, saved_snapshot_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomId("draft"),
      input.titleId,
      input.userId,
      input.version,
      input.lastAutosaveAt,
      input.lastSaveAt,
      input.lastSyncAt,
      input.isDirty ? 1 : 0,
      input.status,
      JSON.stringify(input.phrases),
      JSON.stringify(input.savedSnapshot || input.phrases),
      timestamp,
      timestamp,
    );
  }

  return getDraftForTitle(input.titleId);
}

export function deleteDraft(titleId) {
  db.prepare("DELETE FROM drafts WHERE title_id = ?").run(titleId);
}

export function createCheckoutRecord(titleId, userId, takeover) {
  db.prepare(`
    INSERT INTO checkouts (id, title_id, user_id, checkout_timestamp, active, takeover)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(randomId("checkout"), titleId, userId, nowIso(), takeover ? 1 : 0);
}

export function closeCheckoutRecords(titleId) {
  db.prepare(`
    UPDATE checkouts
    SET active = 0, checkin_timestamp = ?
    WHERE title_id = ? AND active = 1
  `).run(nowIso(), titleId);
}

export function deleteTitleRecord(titleId) {
  db.prepare("DELETE FROM titles WHERE id = ?").run(titleId);
}

export function createJob(type, createdByUserId, payload, titleId = null) {
  const job = {
    id: randomId("job"),
    type,
    status: "queued",
    createdByUserId,
    titleId,
    payloadJson: JSON.stringify(payload || {}),
    progress: 0,
    message: "Queued",
    createdAt: nowIso(),
  };

  db.prepare(`
    INSERT INTO jobs (id, type, status, created_by_user_id, title_id, payload_json, progress, message, created_at)
    VALUES (@id, @type, @status, @createdByUserId, @titleId, @payloadJson, @progress, @message, @createdAt)
  `).run(job);

  return getJob(job.id);
}

export function getJob(jobId) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  return row ? serializeJob(row) : null;
}

export function listJobs(userId = null, limit = 20) {
  const rows = userId
    ? db.prepare("SELECT * FROM jobs WHERE created_by_user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit)
    : db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map(serializeJob);
}

function serializeJob(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    titleId: row.title_id,
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, null),
    error: row.error_text,
    progress: row.progress,
    message: row.message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function claimNextQueuedJob() {
  const row = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
  if (!row) {
    return null;
  }

  const updated = db.prepare(`
    UPDATE jobs
    SET status = 'running', started_at = ?, message = 'Processing'
    WHERE id = ? AND status = 'queued'
  `).run(nowIso(), row.id);

  if (updated.changes === 0) {
    return null;
  }

  return getJob(row.id);
}

export function updateJobProgress(jobId, progress, message, titleId = undefined) {
  const values = {
    progress,
    message,
    id: jobId,
  };

  if (titleId === undefined) {
    db.prepare("UPDATE jobs SET progress = @progress, message = @message WHERE id = @id").run(values);
  } else {
    db.prepare("UPDATE jobs SET progress = @progress, message = @message, title_id = @titleId WHERE id = @id").run({
      ...values,
      titleId,
    });
  }
}

export function completeJob(jobId, result, titleId = null) {
  db.prepare(`
    UPDATE jobs
    SET status = 'completed', result_json = ?, progress = 100, message = 'Completed', completed_at = ?, title_id = COALESCE(?, title_id)
    WHERE id = ?
  `).run(JSON.stringify(result || {}), nowIso(), titleId, jobId);
}

export function failJob(jobId, errorText) {
  db.prepare(`
    UPDATE jobs
    SET status = 'failed', error_text = ?, message = 'Failed', completed_at = ?
    WHERE id = ?
  `).run(String(errorText || "Unknown job failure"), nowIso(), jobId);
}
