import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { normalizeEndpointUrl } from "./helpers.js";

dotenv.config();

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(serverDir);
const dataDir = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(rootDir, "data");

export const paths = {
  rootDir,
  serverDir,
  dataDir,
  storageDir: path.join(dataDir, "storage"),
  inboxDir: path.join(dataDir, "inbox"),
  tempDir: path.join(dataDir, "temp"),
  databaseFile: path.join(dataDir, "app.db"),
  distDir: path.join(rootDir, "dist"),
};

export const appConfig = {
  port: Number(process.env.PORT || process.env.APP_PORT || 3001),
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "yt_asr_session",
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 30),
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  openAiTranscriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1",
  whisperModelPath: process.env.WHISPER_MODEL_PATH || "",
  ytDlpPath: process.env.YT_DLP_PATH || "yt-dlp",
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
  baseUrl: normalizeEndpointUrl(process.env.APP_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || ""),
  environment: process.env.NODE_ENV || "development",
};

function coerceStorageProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "local" || normalized === "local disk") {
    return "Local Disk";
  }
  if (normalized === "backblaze b2" || normalized === "b2") {
    return "Backblaze B2";
  }
  if (normalized === "amazon s3" || normalized === "s3") {
    return "Amazon S3";
  }
  if (normalized === "cloudflare r2" || normalized === "r2") {
    return "Cloudflare R2";
  }
  if (normalized === "minio") {
    return "MinIO";
  }
  return null;
}

const envStorageProvider =
  coerceStorageProvider(process.env.STORAGE_PROVIDER) ||
  (process.env.STORAGE_BUCKET ? "Amazon S3" : null) ||
  "Local Disk";

export const defaultStorageSettings = {
  provider: envStorageProvider,
  bucket: process.env.STORAGE_BUCKET || (envStorageProvider === "Local Disk" ? "yt-asr-local" : ""),
  prefix: process.env.STORAGE_PREFIX || "workspace/",
  endpointUrl: normalizeEndpointUrl(process.env.STORAGE_ENDPOINT_URL),
  region: process.env.STORAGE_REGION || (envStorageProvider === "Local Disk" ? "local" : "auto"),
  addressingMode: process.env.STORAGE_ADDRESSING_MODE || "path",
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || "",
  auditVisible: process.env.STORAGE_AUDIT_VISIBLE ? process.env.STORAGE_AUDIT_VISIBLE === "true" : true,
  lastConnectionTestAt: null,
};

const developmentUsers = [
  {
    loginIdentity: "admin",
    email: "admin@yt-asr.local",
    displayName: "Administrator",
    role: "admin",
    password: "password",
    mustChangePassword: true,
  },
  {
    loginIdentity: "maya",
    email: "maya@yt-asr.local",
    displayName: "Maya Editor",
    role: "user",
    password: "maya1234",
  },
  {
    loginIdentity: "jordan",
    email: "jordan@yt-asr.local",
    displayName: "Jordan Reviewer",
    role: "user",
    password: "jordan1234",
  },
  {
    loginIdentity: "theo",
    email: "theo@yt-asr.local",
    displayName: "Theo Admin",
    role: "admin",
    password: "admin1234",
  },
];

const fallbackBootstrapAdmin = {
  loginIdentity: process.env.BOOTSTRAP_ADMIN_LOGIN_IDENTITY || "admin",
  email: process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@yt-asr.local",
  displayName: process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME || "Administrator",
  role: "admin",
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD || "password",
  mustChangePassword: true,
};

function parseBootstrapUsers() {
  if (process.env.BOOTSTRAP_USERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.BOOTSTRAP_USERS_JSON);
      if (Array.isArray(parsed)) {
        return parsed.filter(Boolean);
      }
    } catch (error) {
      console.warn("BOOTSTRAP_USERS_JSON could not be parsed. Falling back to default bootstrap rules.", error);
    }
  }

  if (process.env.BOOTSTRAP_ADMIN_PASSWORD) {
    return [
      {
        ...fallbackBootstrapAdmin,
      },
    ];
  }

  if (appConfig.environment !== "production") {
    return developmentUsers;
  }

  return [fallbackBootstrapAdmin];
}

export const seededUsers = parseBootstrapUsers();
