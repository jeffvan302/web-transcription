export type Role = "user" | "admin";
export type StatusTone = "info" | "success" | "warning" | "error";
export type View = "editor" | "shared" | "settings";
export type SourceType = "youtube" | "local" | "package";
export type StorageProvider = "Local Disk" | "Backblaze B2" | "Amazon S3" | "Cloudflare R2" | "MinIO";
export type SaveKind = "manual" | "autosave" | "sync" | "checkin";

export interface User {
  id: string;
  displayName: string;
  email: string;
  role: Role;
  status: "active" | "disabled";
  lastLoginAt: string | null;
}

export interface Phrase {
  id: string;
  start: number;
  end: number;
  text: string;
  enabled: boolean;
  reviewed: boolean;
}

export interface TitleDraftMeta {
  version: number;
  lastAutosaveAt: string | null;
  lastSaveAt: string | null;
  lastSyncAt: string | null;
  isDirty: boolean;
  status: "active" | "finalized" | "archived";
}

export interface TitleRecord {
  id: string;
  videoId: string;
  title: string;
  source: string;
  language: string;
  duration: number;
  sourceType: SourceType;
  uploadedAt: string;
  sizeLabel: string;
  checkedOutByUserId: string | null;
  checkedOutAt: string | null;
  phrases: Phrase[];
  savedSnapshot: Phrase[];
  draft: TitleDraftMeta;
  badge: "reviewed" | "downloaded" | null;
  audioUrl?: string | null;
  waveformUrl?: string | null;
}

export interface AuditRecord {
  id: string;
  eventType:
    | "login"
    | "title_upload"
    | "title_import"
    | "checkout"
    | "sync"
    | "checkin"
    | "force_checkin"
    | "takeover"
    | "title_delete"
    | "export";
  titleId: string | null;
  titleName: string;
  actorUserId: string;
  actorDisplayName: string;
  timestamp: string;
  details: string;
}

export interface StorageConfig {
  provider: StorageProvider;
  bucket: string;
  prefix: string;
  endpointUrl: string;
  region: string;
  addressingMode: "path" | "virtual-hosted";
  lastConnectionTestAt: string | null;
  auditVisible: boolean;
}

export interface JobRecord {
  id: string;
  type: "youtube_import" | "media_import" | "asr_import";
  status: "queued" | "running" | "completed" | "failed";
  createdByUserId: string;
  titleId: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  progress: number;
  message: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PersistedState {
  sessionUserId: string | null;
  selectedTitleId: string;
  selectedPhraseIds: string[];
  currentView: View;
  youtubeUrl: string;
  importLanguage: string;
  workspaceName: string;
  users: User[];
  titles: TitleRecord[];
  storage: StorageConfig;
  audit: AuditRecord[];
}

export interface AppStateResponse {
  state: PersistedState;
  jobs: JobRecord[];
}
