import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

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
  baseUrl: process.env.APP_BASE_URL || "",
  environment: process.env.NODE_ENV || "development",
};

export const defaultStorageSettings = {
  provider: "Local Disk",
  bucket: "yt-asr-local",
  prefix: "workspace/",
  endpointUrl: "",
  region: "local",
  addressingMode: "path",
  accessKeyId: "",
  secretAccessKey: "",
  auditVisible: true,
  lastConnectionTestAt: null,
};

export const seededUsers = [
  {
    email: "maya@yt-asr.local",
    displayName: "Maya Editor",
    role: "user",
    password: "maya1234",
  },
  {
    email: "jordan@yt-asr.local",
    displayName: "Jordan Reviewer",
    role: "user",
    password: "jordan1234",
  },
  {
    email: "theo@yt-asr.local",
    displayName: "Theo Admin",
    role: "admin",
    password: "admin1234",
  },
];
