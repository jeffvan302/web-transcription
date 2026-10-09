import crypto from "node:crypto";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { appConfig, defaultStorageSettings, paths, seededUsers } from "./config.js";
import { ensureDir, humanFileSize, normalizeEndpointUrl, nowIso, parseJson, randomId, slugify } from "./helpers.js";
import {
  decodeWaveformTilePrefix,
  getWaveformTileCount,
  WAVEFORM_TILE_DURATION_SECONDS,
} from "./waveform-tiles.js";

ensureDir(paths.dataDir);

export const db = new Database(paths.databaseFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    login_identity TEXT,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    current_workspace_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
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
    workspace_id TEXT,
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
    FOREIGN KEY (checked_out_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
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
    workspace_id TEXT,
    title_name TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_display_name TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    details TEXT NOT NULL,
    detail_json TEXT,
    FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE SET NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    title_id TEXT,
    workspace_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    error_text TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE SET NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    issued_by_user_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (issued_by_user_id) REFERENCES users(id) ON DELETE SET NULL
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

  CREATE TABLE IF NOT EXISTS keep_awake_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    admin_keep_awake INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

function ensureColumn(tableName, columnName, columnSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`).run();
}

ensureColumn("users", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "login_identity", "TEXT");
ensureColumn("users", "current_workspace_id", "TEXT");
ensureColumn("titles", "workspace_id", "TEXT");
ensureColumn("audits", "workspace_id", "TEXT");
ensureColumn("jobs", "workspace_id", "TEXT");

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_identity ON users(login_identity);
  CREATE INDEX IF NOT EXISTS idx_titles_workspace_id ON titles(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_audits_workspace_id ON audits(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_workspace_id ON jobs(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
`);

const DEFAULT_WORKSPACE_NAME = "Primary Workspace";
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60 * 12;

function normalizeLoginIdentity(value, fallback = "user") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function normalizeEmailValue(value, loginIdentity) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("@")) {
    return normalized;
  }
  return `${normalizeLoginIdentity(normalized || loginIdentity, loginIdentity)}@yt-asr.local`;
}

function preferredLoginIdentitySource(currentLoginIdentity, email, displayName) {
  const normalizedCurrent = String(currentLoginIdentity || "").trim().toLowerCase();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (normalizedEmail.includes("@")) {
    const localPart = normalizedEmail.split("@")[0] || normalizedEmail;
    const normalizedEmailAsIdentity = normalizeLoginIdentity(normalizedEmail, slugify(displayName || "user"));
    if (!normalizedCurrent || normalizedCurrent === normalizedEmailAsIdentity) {
      return localPart;
    }
  }
  return normalizedCurrent || normalizedEmail || displayName;
}

function makeUniqueLoginIdentity(baseValue, usedValues) {
  let candidate = baseValue;
  let suffix = 2;
  while (usedValues.has(candidate)) {
    candidate = `${baseValue}-${suffix}`;
    suffix += 1;
  }
  usedValues.add(candidate);
  return candidate;
}

function makeUniqueEmail(baseEmail, loginIdentity, usedValues) {
  let candidate = baseEmail;
  const [localPartRaw, domainPartRaw] = baseEmail.split("@");
  const localPart = localPartRaw || loginIdentity;
  const domainPart = domainPartRaw || "yt-asr.local";
  let suffix = 2;
  while (usedValues.has(candidate)) {
    candidate = `${localPart}+${loginIdentity}${suffix > 2 ? `-${suffix}` : ""}@${domainPart}`;
    suffix += 1;
  }
  usedValues.add(candidate);
  return candidate;
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getWorkspaceRow(workspaceId) {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) || null;
}

function getDefaultWorkspaceRow() {
  return db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC, name COLLATE NOCASE ASC LIMIT 1").get() || null;
}

const insertUserStatement = db.prepare(`
  INSERT INTO users (
    id, email, login_identity, display_name, password_hash, role, status, must_change_password, current_workspace_id, created_at, updated_at
  )
  VALUES (
    @id, @email, @loginIdentity, @displayName, @passwordHash, @role, @status, @mustChangePassword, @currentWorkspaceId, @createdAt, @updatedAt
  )
`);

function seedUsersIfNeeded() {
  const timestamp = nowIso();
  for (const user of seededUsers) {
    const normalizedLoginIdentity = normalizeLoginIdentity(user.loginIdentity || user.email, slugify(user.displayName || "user"));
    const normalizedEmail = normalizeEmailValue(user.email, normalizedLoginIdentity);
    const existing = db
      .prepare(`
        SELECT id
        FROM users
        WHERE lower(COALESCE(login_identity, '')) = lower(?)
          OR lower(email) = lower(?)
          OR lower(email) = lower(?)
      `)
      .get(normalizedLoginIdentity, normalizedEmail, normalizedLoginIdentity);
    if (existing) {
      continue;
    }

    let password = user.password;
    if (!password) {
      password = crypto.randomBytes(18).toString("base64url");
      console.log(
        `[bootstrap] Created admin account "${normalizedLoginIdentity}" with one-time password: ${password}\n` +
          "[bootstrap] Sign in and change it now. Set BOOTSTRAP_ADMIN_PASSWORD to choose your own instead.",
      );
    }

    insertUserStatement.run({
      id: randomId("user"),
      email: normalizedEmail,
      loginIdentity: normalizedLoginIdentity,
      displayName: user.displayName,
      passwordHash: bcrypt.hashSync(password, 12),
      role: user.role,
      status: user.status || "active",
      mustChangePassword: user.mustChangePassword ? 1 : 0,
      currentWorkspaceId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

function seedWorkspacesIfNeeded() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM workspaces").get();
  if (Number(existing?.count || 0) > 0) {
    return;
  }

  const owner = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get();
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO workspaces (id, name, slug, created_by_user_id, status, created_at, updated_at)
    VALUES (@id, @name, @slug, @createdByUserId, 'active', @createdAt, @updatedAt)
  `).run({
    id: randomId("workspace"),
    name: DEFAULT_WORKSPACE_NAME,
    slug: slugify(DEFAULT_WORKSPACE_NAME),
    createdByUserId: owner?.id || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function migrateUsersForIdentityAndWorkspace() {
  const defaultWorkspace = getDefaultWorkspaceRow();
  const users = db.prepare("SELECT * FROM users").all().sort((left, right) => {
    const leftScore = Number(!left.login_identity) + Number(!String(left.email || "").includes("@"));
    const rightScore = Number(!right.login_identity) + Number(!String(right.email || "").includes("@"));
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return String(left.created_at || "").localeCompare(String(right.created_at || ""));
  });
  const usedLoginIdentities = new Set();
  const usedEmails = new Set();

  for (const user of users) {
    const baseLoginIdentity = normalizeLoginIdentity(
      preferredLoginIdentitySource(user.login_identity, user.email, user.display_name),
      slugify(user.display_name || "user"),
    );
    const nextLoginIdentity = makeUniqueLoginIdentity(baseLoginIdentity, usedLoginIdentities);
    const baseEmail = normalizeEmailValue(user.email, nextLoginIdentity);
    const nextEmail = makeUniqueEmail(baseEmail, nextLoginIdentity, usedEmails);
    const nextWorkspaceId =
      user.current_workspace_id && getWorkspaceRow(user.current_workspace_id) ? user.current_workspace_id : defaultWorkspace?.id || null;

    if (
      user.login_identity === nextLoginIdentity &&
      user.email === nextEmail &&
      (user.current_workspace_id || null) === (nextWorkspaceId || null)
    ) {
      continue;
    }

    db.prepare(`
      UPDATE users
      SET
        email = @email,
        login_identity = @loginIdentity,
        current_workspace_id = @currentWorkspaceId,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: user.id,
      email: nextEmail,
      loginIdentity: nextLoginIdentity,
      currentWorkspaceId: nextWorkspaceId,
      updatedAt: nowIso(),
    });
  }
}

function migrateWorkspaceAssignments() {
  const defaultWorkspace = getDefaultWorkspaceRow();
  if (!defaultWorkspace) {
    return;
  }

  db.prepare("UPDATE titles SET workspace_id = ? WHERE workspace_id IS NULL OR workspace_id = ''").run(defaultWorkspace.id);
  db.prepare(`
    UPDATE audits
    SET workspace_id = COALESCE(
      (SELECT workspace_id FROM titles WHERE titles.id = audits.title_id),
      (SELECT current_workspace_id FROM users WHERE users.id = audits.actor_user_id),
      ?
    )
    WHERE workspace_id IS NULL OR workspace_id = ''
  `).run(defaultWorkspace.id);
  db.prepare(`
    UPDATE jobs
    SET workspace_id = COALESCE(
      (SELECT workspace_id FROM titles WHERE titles.id = jobs.title_id),
      (SELECT current_workspace_id FROM users WHERE users.id = jobs.created_by_user_id),
      ?
    )
    WHERE workspace_id IS NULL OR workspace_id = ''
  `).run(defaultWorkspace.id);
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

function seedKeepAwakeSettingsIfNeeded() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM keep_awake_settings").get();
  if (existing.count > 0) {
    return;
  }

  db.prepare(`
    INSERT INTO keep_awake_settings (id, admin_keep_awake, updated_at)
    VALUES (1, 0, ?)
  `).run(nowIso());
}

function applyHostedStorageDefaultsIfNeeded() {
  if (defaultStorageSettings.provider === "Local Disk") {
    return;
  }

  const existing = db.prepare("SELECT * FROM storage_settings WHERE id = 1").get();
  if (!existing) {
    return;
  }

  const isStillLocalBootstrap =
    existing.provider === "Local Disk" &&
    existing.bucket === "yt-asr-local" &&
    !existing.endpoint_url &&
    !existing.access_key_id &&
    !existing.secret_access_key;

  if (!isStillLocalBootstrap) {
    return;
  }

  db.prepare(`
    UPDATE storage_settings
    SET
      provider = @provider,
      bucket = @bucket,
      prefix_value = @prefix,
      endpoint_url = @endpointUrl,
      region = @region,
      addressing_mode = @addressingMode,
      access_key_id = @accessKeyId,
      secret_access_key = @secretAccessKey,
      audit_visible = @auditVisible
    WHERE id = 1
  `).run({
    provider: defaultStorageSettings.provider,
    bucket: defaultStorageSettings.bucket,
    prefix: defaultStorageSettings.prefix,
    endpointUrl: defaultStorageSettings.endpointUrl,
    region: defaultStorageSettings.region,
    addressingMode: defaultStorageSettings.addressingMode,
    accessKeyId: defaultStorageSettings.accessKeyId,
    secretAccessKey: defaultStorageSettings.secretAccessKey,
    auditVisible: defaultStorageSettings.auditVisible ? 1 : 0,
  });
}

seedUsersIfNeeded();
seedWorkspacesIfNeeded();
migrateUsersForIdentityAndWorkspace();
migrateWorkspaceAssignments();
seedStorageIfNeeded();
seedKeepAwakeSettingsIfNeeded();
applyHostedStorageDefaultsIfNeeded();

export function sanitizeUser(row) {
  return {
    id: row.id,
    loginIdentity: row.login_identity,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

function sanitizeWorkspace(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

export function findUserByLoginIdentity(loginIdentity) {
  const row = db.prepare("SELECT * FROM users WHERE lower(login_identity) = lower(?)").get(loginIdentity);
  return row || null;
}

export function findUserByIdentifier(identifier) {
  const normalized = String(identifier || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return (
    db
      .prepare("SELECT * FROM users WHERE lower(login_identity) = lower(?) OR lower(email) = lower(?) LIMIT 1")
      .get(normalized, normalized) || null
  );
}

export function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY display_name ASC").all().map(sanitizeUser);
}

export function listWorkspaces() {
  return db.prepare("SELECT * FROM workspaces WHERE status = 'active' ORDER BY name COLLATE NOCASE ASC").all().map(sanitizeWorkspace);
}

export function getWorkspaceById(workspaceId) {
  const row = getWorkspaceRow(workspaceId);
  return row ? sanitizeWorkspace(row) : null;
}

export function createWorkspace({ name, createdByUserId }) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    throw new Error("Workspace name is required.");
  }

  let baseSlug = slugify(normalizedName);
  if (!baseSlug) {
    baseSlug = slugify(randomId("workspace"));
  }

  let slug = baseSlug;
  let suffix = 2;
  while (db.prepare("SELECT id FROM workspaces WHERE slug = ?").get(slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  if (db.prepare("SELECT id FROM workspaces WHERE lower(name) = lower(?)").get(normalizedName)) {
    throw new Error("A workspace with that name already exists.");
  }

  const timestamp = nowIso();
  const workspaceId = randomId("workspace");
  db.prepare(`
    INSERT INTO workspaces (id, name, slug, created_by_user_id, status, created_at, updated_at)
    VALUES (@id, @name, @slug, @createdByUserId, 'active', @createdAt, @updatedAt)
  `).run({
    id: workspaceId,
    name: normalizedName,
    slug,
    createdByUserId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return getWorkspaceById(workspaceId);
}

export function setUserCurrentWorkspace(userId, workspaceId) {
  const workspace = getWorkspaceRow(workspaceId);
  if (!workspace || workspace.status !== "active") {
    throw new Error("Workspace not found.");
  }

  db.prepare("UPDATE users SET current_workspace_id = ?, updated_at = ? WHERE id = ?").run(workspace.id, nowIso(), userId);
  return workspace.id;
}

function countActiveAdmins() {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'")
    .get();
  return Number(row?.count || 0);
}

function assertAdminRetention(targetUserId, nextRole, nextStatus) {
  const current = getUserById(targetUserId);
  if (!current) {
    throw new Error("User not found.");
  }

  const currentIsActiveAdmin = current.role === "admin" && current.status === "active";
  const nextIsActiveAdmin = nextRole === "admin" && nextStatus === "active";
  if (!currentIsActiveAdmin || nextIsActiveAdmin) {
    return;
  }

  if (countActiveAdmins() <= 1) {
    throw new Error("At least one active admin account must remain available.");
  }
}

export function createUserAccount({
  loginIdentity,
  email,
  displayName,
  role,
  password,
  status = "active",
  mustChangePassword = false,
}) {
  const normalizedLoginIdentity = normalizeLoginIdentity(loginIdentity || email, slugify(displayName || "user"));
  const normalizedEmail = String(email || "").trim() ? normalizeEmailValue(email, normalizedLoginIdentity) : "";
  const normalizedDisplayName = String(displayName || "").trim();
  const normalizedRole = role === "admin" ? "admin" : "user";
  const normalizedStatus = status === "disabled" ? "disabled" : "active";
  const normalizedPassword = String(password || "");
  const defaultWorkspace = getDefaultWorkspaceRow();

  if (!normalizedLoginIdentity) {
    throw new Error("Login identity is required.");
  }
  if (!normalizedEmail) {
    throw new Error("Email is required.");
  }
  if (!normalizedDisplayName) {
    throw new Error("Display name is required.");
  }
  if (normalizedPassword.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }
  if (findUserByLoginIdentity(normalizedLoginIdentity)) {
    throw new Error("A user with that login identity already exists.");
  }
  if (findUserByEmail(normalizedEmail)) {
    throw new Error("A user with that email already exists.");
  }

  const timestamp = nowIso();
  const userId = randomId("user");
  insertUserStatement.run({
    id: userId,
    email: normalizedEmail,
    loginIdentity: normalizedLoginIdentity,
    displayName: normalizedDisplayName,
    passwordHash: bcrypt.hashSync(normalizedPassword, 12),
    role: normalizedRole,
    status: normalizedStatus,
    mustChangePassword: mustChangePassword ? 1 : 0,
    currentWorkspaceId: defaultWorkspace?.id || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return sanitizeUser(getUserById(userId));
}

export function updateUserAccount(userId, patch) {
  const current = getUserById(userId);
  if (!current) {
    throw new Error("User not found.");
  }

  const nextLoginIdentity = normalizeLoginIdentity(
    patch.loginIdentity ?? current.login_identity,
    slugify((patch.displayName ?? current.display_name) || "user"),
  );
  const nextEmail = String(patch.email ?? current.email).trim()
    ? normalizeEmailValue(patch.email ?? current.email, nextLoginIdentity)
    : "";
  const nextDisplayName = String(patch.displayName ?? current.display_name).trim();
  const nextRole = patch.role === "admin" ? "admin" : patch.role === "user" ? "user" : current.role;
  const nextStatus = patch.status === "disabled" ? "disabled" : patch.status === "active" ? "active" : current.status;
  assertAdminRetention(userId, nextRole, nextStatus);

  if (!nextLoginIdentity) {
    throw new Error("Login identity is required.");
  }
  if (!nextEmail) {
    throw new Error("Email is required.");
  }
  if (!nextDisplayName) {
    throw new Error("Display name is required.");
  }
  const loginIdentityOwner = findUserByLoginIdentity(nextLoginIdentity);
  if (loginIdentityOwner && loginIdentityOwner.id !== userId) {
    throw new Error("A user with that login identity already exists.");
  }
  const emailOwner = findUserByEmail(nextEmail);
  if (emailOwner && emailOwner.id !== userId) {
    throw new Error("A user with that email already exists.");
  }

  db.prepare(`
    UPDATE users
    SET
      email = @email,
      login_identity = @loginIdentity,
      display_name = @displayName,
      role = @role,
      status = @status,
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id: userId,
    email: nextEmail,
    loginIdentity: nextLoginIdentity,
    displayName: nextDisplayName,
    role: nextRole,
    status: nextStatus,
    updatedAt: nowIso(),
  });

  return sanitizeUser(getUserById(userId));
}

const deleteUserAccountTransaction = db.transaction((targetUserId, actingAdminUserId) => {
  const current = getUserById(targetUserId);
  if (!current) {
    throw new Error("User not found.");
  }
  if (!actingAdminUserId || !getUserById(actingAdminUserId)) {
    throw new Error("Admin user not found.");
  }
  if (targetUserId === actingAdminUserId) {
    throw new Error("You cannot delete your own account.");
  }

  assertAdminRetention(targetUserId, "user", "disabled");

  const activeJobCount = Number(
    db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE created_by_user_id = ? AND status IN ('queued', 'running')")
      .get(targetUserId)?.count || 0,
  );
  if (activeJobCount > 0) {
    throw new Error("This user still has active imports or background jobs. Wait for them to finish before deleting the account.");
  }

  const timestamp = nowIso();
  const releasedTitleIds = db
    .prepare("SELECT id FROM titles WHERE checked_out_by_user_id = ? ORDER BY title COLLATE NOCASE ASC")
    .all(targetUserId)
    .map((row) => row.id);

  if (releasedTitleIds.length > 0) {
    db.prepare(`
      UPDATE titles
      SET checked_out_by_user_id = NULL, checked_out_at = NULL, updated_at = ?
      WHERE checked_out_by_user_id = ?
    `).run(timestamp, targetUserId);
  }

  db.prepare("DELETE FROM drafts WHERE user_id = ?").run(targetUserId);

  const reassignedTitleCount = db.prepare(`
    UPDATE titles
    SET created_by_user_id = ?, updated_at = ?
    WHERE created_by_user_id = ?
  `).run(actingAdminUserId, timestamp, targetUserId).changes;

  const deleted = db.prepare("DELETE FROM users WHERE id = ?").run(targetUserId);
  if (deleted.changes === 0) {
    throw new Error("User not found.");
  }

  return {
    user: sanitizeUser(current),
    reassignedTitleCount,
    releasedTitleIds,
    releasedTitleCount: releasedTitleIds.length,
  };
});

export function deleteUserAccount(targetUserId, actingAdminUserId) {
  return deleteUserAccountTransaction(targetUserId, actingAdminUserId);
}

export function resetUserPassword(userId, nextPassword, mustChangePassword = true) {
  const current = getUserById(userId);
  if (!current) {
    throw new Error("User not found.");
  }

  const normalizedPassword = String(nextPassword || "");
  if (normalizedPassword.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }

  db.prepare(`
    UPDATE users
    SET
      password_hash = @passwordHash,
      must_change_password = @mustChangePassword,
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id: userId,
    passwordHash: bcrypt.hashSync(normalizedPassword, 12),
    mustChangePassword: mustChangePassword ? 1 : 0,
    updatedAt: nowIso(),
  });

  return sanitizeUser(getUserById(userId));
}

export function createPasswordRecoveryToken(userId, issuedByUserId = null) {
  const user = getUserById(userId);
  if (!user || user.status !== "active") {
    throw new Error("User not found.");
  }

  const token = crypto.randomBytes(24).toString("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
  db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(createdAt, userId);
  db.prepare(`
    INSERT INTO password_reset_tokens (id, user_id, token_hash, issued_by_user_id, created_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(randomId("reset"), userId, hashResetToken(token), issuedByUserId, createdAt, expiresAt);

  return {
    token,
    expiresAt,
    user: sanitizeUser(user),
  };
}

export function redeemPasswordRecoveryToken(token, nextPassword) {
  const normalizedPassword = String(nextPassword || "");
  if (normalizedPassword.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }

  const tokenRow =
    db
      .prepare(`
        SELECT password_reset_tokens.*, users.*
        FROM password_reset_tokens
        JOIN users ON users.id = password_reset_tokens.user_id
        WHERE password_reset_tokens.token_hash = ?
          AND password_reset_tokens.used_at IS NULL
          AND password_reset_tokens.expires_at > ?
          AND users.status = 'active'
        LIMIT 1
      `)
      .get(hashResetToken(token), nowIso()) || null;

  if (!tokenRow) {
    throw new Error("Recovery token is invalid or has expired.");
  }

  const timestamp = nowIso();
  db.prepare(`
    UPDATE users
    SET password_hash = ?, must_change_password = 0, updated_at = ?
    WHERE id = ?
  `).run(bcrypt.hashSync(normalizedPassword, 12), timestamp, tokenRow.user_id);
  db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").run(timestamp, tokenRow.id);

  return sanitizeUser(getUserById(tokenRow.user_id));
}

export function changeUserPassword(userId, currentPassword, nextPassword) {
  const current = getUserById(userId);
  if (!current) {
    throw new Error("User not found.");
  }

  if (!bcrypt.compareSync(String(currentPassword || ""), current.password_hash)) {
    throw new Error("Current password is incorrect.");
  }

  const normalizedPassword = String(nextPassword || "");
  if (normalizedPassword.length < 8) {
    throw new Error("New password must be at least 8 characters long.");
  }

  db.prepare(`
    UPDATE users
    SET
      password_hash = @passwordHash,
      must_change_password = 0,
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id: userId,
    passwordHash: bcrypt.hashSync(normalizedPassword, 12),
    updatedAt: nowIso(),
  });

  return sanitizeUser(getUserById(userId));
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
        WHERE sessions.id = ? AND users.status = 'active'
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
    endpointUrl: normalizeEndpointUrl(row.endpoint_url),
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
  const normalizedEndpointUrl = normalizeEndpointUrl(input.endpointUrl);
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
    endpointUrl: normalizedEndpointUrl,
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

export function getKeepAwakeSettings() {
  const row = db.prepare("SELECT * FROM keep_awake_settings WHERE id = 1").get();
  if (!row) {
    return {
      adminKeepAwake: false,
      updatedAt: null,
    };
  }

  return {
    adminKeepAwake: Boolean(row.admin_keep_awake),
    updatedAt: row.updated_at || null,
  };
}

export function saveKeepAwakeSettings(input) {
  const timestamp = nowIso();
  db.prepare(`
    UPDATE keep_awake_settings
    SET admin_keep_awake = ?, updated_at = ?
    WHERE id = 1
  `).run(input.adminKeepAwake ? 1 : 0, timestamp);

  return getKeepAwakeSettings();
}

function resolveWorkspaceRowForState(userId, preferredWorkspaceId = null) {
  const preferredWorkspace = preferredWorkspaceId ? getWorkspaceRow(preferredWorkspaceId) : null;
  if (preferredWorkspace?.status === "active") {
    return preferredWorkspace;
  }

  const user = getUserById(userId);
  const userWorkspace = user?.current_workspace_id ? getWorkspaceRow(user.current_workspace_id) : null;
  if (userWorkspace?.status === "active") {
    return userWorkspace;
  }

  return getDefaultWorkspaceRow();
}

export function insertAuditRecord({
  eventType,
  titleId = null,
  workspaceId = null,
  titleName,
  actorUserId,
  actorDisplayName,
  details,
  detailJson = null,
}) {
  const titleWorkspaceId = titleId ? getTitleRow(titleId)?.workspace_id || null : null;
  const actorWorkspaceId = getUserById(actorUserId)?.current_workspace_id || null;
  const effectiveWorkspaceId = workspaceId || titleWorkspaceId || actorWorkspaceId || getDefaultWorkspaceRow()?.id || null;

  db.prepare(`
    INSERT INTO audits (
      id, event_type, title_id, workspace_id, title_name, actor_user_id, actor_display_name, timestamp, details, detail_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomId("audit"),
    eventType,
    titleId,
    effectiveWorkspaceId,
    titleName,
    actorUserId,
    actorDisplayName,
    nowIso(),
    details,
    detailJson ? JSON.stringify(detailJson) : null,
  );
}

export function listAuditRecords(limit = 20, workspaceId = null) {
  const rows = workspaceId
    ? db.prepare("SELECT * FROM audits WHERE workspace_id = ? ORDER BY timestamp DESC LIMIT ?").all(workspaceId, limit)
    : db.prepare("SELECT * FROM audits ORDER BY timestamp DESC LIMIT ?").all(limit);

  return rows.map((row) => ({
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

export function getTitleByVideoId(videoId, workspaceId = null) {
  const row = workspaceId
    ? db.prepare("SELECT * FROM titles WHERE video_id = ? AND workspace_id = ?").get(videoId, workspaceId)
    : db.prepare("SELECT * FROM titles WHERE video_id = ?").get(videoId);
  return row || null;
}

export function listTitleRows(workspaceId = null) {
  return workspaceId
    ? db.prepare("SELECT * FROM titles WHERE workspace_id = ? ORDER BY title COLLATE NOCASE ASC").all(workspaceId)
    : db.prepare("SELECT * FROM titles ORDER BY title COLLATE NOCASE ASC").all();
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
  const waveformTilePrefix = decodeWaveformTilePrefix(titleRow.waveform_object_key);
  const canBackfillTiledWaveform = Boolean(titleRow.audio_object_key) && Number(titleRow.duration || 0) > WAVEFORM_TILE_DURATION_SECONDS;
  const waveformUrl = titleRow.waveform_object_key || canBackfillTiledWaveform ? `/api/titles/${titleRow.id}/waveform` : null;
  const waveformMode = waveformTilePrefix || canBackfillTiledWaveform ? "tiled" : titleRow.waveform_object_key ? "single" : null;
  const waveformTileCount = waveformMode === "tiled" ? getWaveformTileCount(titleRow.duration) : waveformUrl ? 1 : 0;

  return {
    id: titleRow.id,
    videoId: titleRow.video_id,
    title: titleRow.title,
    source: titleRow.source,
    language: titleRow.language,
    duration: titleRow.duration,
    sourceType: titleRow.source_type,
    uploadedAt: titleRow.uploaded_at,
    updatedAt: titleRow.updated_at,
    sizeLabel: humanFileSize(titleRow.size_bytes),
    checkedOutByUserId: titleRow.checked_out_by_user_id,
    checkedOutAt: titleRow.checked_out_at,
    phrases,
    savedSnapshot,
    draft: buildDraftMeta(titleRow, draftRow, owner),
    badge: titleRow.badge,
    audioUrl: titleRow.audio_object_key ? `/api/titles/${titleRow.id}/audio` : null,
    waveformUrl,
    waveformMode,
    waveformTileCount,
    waveformTileDurationSeconds: waveformMode === "tiled" ? WAVEFORM_TILE_DURATION_SECONDS : Number(titleRow.duration || 0),
  };
}

export function buildAppState(userId, preferredWorkspaceId = null) {
  const currentUser = listUsers().find((user) => user.id === userId) || null;
  const workspace = resolveWorkspaceRowForState(userId, preferredWorkspaceId);
  const titles = listTitleRows(workspace?.id || null);
  const activeCheckout = getActiveCheckoutForUser(userId);
  const selectedTitle =
    activeCheckout && activeCheckout.workspace_id === workspace?.id ? activeCheckout : titles[0] || null;
  const serializedTitles = titles.map((titleRow) => serializeTitleForUser(titleRow, userId));
  const selectedSerializedTitle = serializedTitles.find((title) => title.id === selectedTitle?.id) || serializedTitles[0] || null;

  return {
    sessionUserId: userId,
    selectedTitleId: selectedSerializedTitle?.id || "",
    selectedPhraseIds: selectedSerializedTitle?.phrases[0] ? [selectedSerializedTitle.phrases[0].id] : [],
    currentView: currentUser?.mustChangePassword ? "settings" : selectedSerializedTitle ? "editor" : "shared",
    youtubeUrl: "",
    importLanguage: "en",
    selectedWorkspaceId: workspace?.id || "",
    workspaceName: workspace?.name || DEFAULT_WORKSPACE_NAME,
    workspaces: listWorkspaces(),
    users: listUsers(),
    titles: serializedTitles,
    storage: getStorageSettings(false),
    audit: getStorageSettings(false).auditVisible ? listAuditRecords(20, workspace?.id || null) : [],
  };
}

export function createTitleRecord(input) {
  const timestamp = nowIso();
  const badge = input.phrases.length > 0 && input.phrases.every((phrase) => phrase.reviewed) ? "reviewed" : input.badge || null;
  const workspaceId = input.workspaceId || getDefaultWorkspaceRow()?.id || null;

  db.prepare(`
    INSERT INTO titles (
      id, video_id, workspace_id, title, source, language, duration, source_type, uploaded_at, updated_at, created_by_user_id,
      size_bytes, phrase_count, phrases_json, saved_snapshot_json, checked_out_by_user_id, checked_out_at, badge,
      audio_object_key, waveform_object_key, latest_asr_object_key
    )
    VALUES (
      @id, @videoId, @workspaceId, @title, @source, @language, @duration, @sourceType, @uploadedAt, @updatedAt, @createdByUserId,
      @sizeBytes, @phraseCount, @phrasesJson, @savedSnapshotJson, @checkedOutByUserId, @checkedOutAt, @badge,
      @audioObjectKey, @waveformObjectKey, @latestAsrObjectKey
    )
  `).run({
    id: input.id,
    videoId: input.videoId,
    workspaceId,
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
      workspace_id = @workspace_id,
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

export function createJob(type, createdByUserId, payload, titleId = null, workspaceId = null) {
  const job = {
    id: randomId("job"),
    type,
    status: "queued",
    createdByUserId,
    titleId,
    workspaceId: workspaceId || getUserById(createdByUserId)?.current_workspace_id || getDefaultWorkspaceRow()?.id || null,
    payloadJson: JSON.stringify(payload || {}),
    progress: 0,
    message: "Queued",
    createdAt: nowIso(),
  };

  db.prepare(`
    INSERT INTO jobs (id, type, status, created_by_user_id, title_id, workspace_id, payload_json, progress, message, created_at)
    VALUES (@id, @type, @status, @createdByUserId, @titleId, @workspaceId, @payloadJson, @progress, @message, @createdAt)
  `).run(job);

  return getJob(job.id);
}

export function getJob(jobId) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  return row ? serializeJob(row) : null;
}

export function findActiveJobForTitle(type, titleId) {
  if (!type || !titleId) {
    return null;
  }
  const row = db
    .prepare("SELECT * FROM jobs WHERE type = ? AND title_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
    .get(type, titleId);
  return row ? serializeJob(row) : null;
}

export function listJobs(userId = null, limit = 20, workspaceId = null) {
  let rows;
  if (userId && workspaceId) {
    rows = db
      .prepare("SELECT * FROM jobs WHERE created_by_user_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, workspaceId, limit);
  } else if (userId) {
    rows = db.prepare("SELECT * FROM jobs WHERE created_by_user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit);
  } else if (workspaceId) {
    rows = db.prepare("SELECT * FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?").all(workspaceId, limit);
  } else {
    rows = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
  }
  return rows.map(serializeJob);
}

function serializeJob(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    titleId: row.title_id,
    workspaceId: row.workspace_id,
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

export function countActiveJobs() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running')").get();
  return Number(row?.count || 0);
}

export function recoverInterruptedJobs() {
  db.prepare(`
    UPDATE jobs
    SET status = 'queued', started_at = NULL, message = 'Recovered after process restart'
    WHERE status = 'running' AND title_id IS NULL
  `).run();

  db.prepare(`
    UPDATE jobs
    SET
      status = 'failed',
      error_text = 'The worker process restarted after the title was partially created. Review the title library before retrying.',
      message = 'Interrupted after partial processing',
      completed_at = ?
    WHERE status = 'running' AND title_id IS NOT NULL
  `).run(nowIso());
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
  const workspaceId = titleId ? getTitleRow(titleId)?.workspace_id || null : null;
  db.prepare(`
    UPDATE jobs
    SET
      status = 'completed',
      result_json = ?,
      progress = 100,
      message = 'Completed',
      completed_at = ?,
      title_id = COALESCE(?, title_id),
      workspace_id = COALESCE(?, workspace_id)
    WHERE id = ?
  `).run(JSON.stringify(result || {}), nowIso(), titleId, workspaceId, jobId);
}

export function failJob(jobId, errorText) {
  db.prepare(`
    UPDATE jobs
    SET status = 'failed', error_text = ?, message = 'Failed', completed_at = ?
    WHERE id = ?
  `).run(String(errorText || "Unknown job failure"), nowIso(), jobId);
}
