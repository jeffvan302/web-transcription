import type { AuditRecord, PersistedState, Phrase, TitleRecord, User } from "./types";

const now = "2026-03-20T08:00:00.000Z";

function buildPhrase(id: string, start: number, end: number, text: string, reviewed = false): Phrase {
  return { id, start, end, text, enabled: true, reviewed };
}

function clonePhrases(phrases: Phrase[]): Phrase[] {
  return phrases.map((phrase) => ({ ...phrase }));
}

function buildTitle(partial: Omit<TitleRecord, "savedSnapshot" | "draft">): TitleRecord {
  return {
    ...partial,
    savedSnapshot: clonePhrases(partial.phrases),
    draft: {
      version: 3,
      lastAutosaveAt: now,
      lastSaveAt: now,
      lastSyncAt: now,
      isDirty: false,
      status: "active",
    },
  };
}

const users: User[] = [
  {
    id: "user-maya",
    loginIdentity: "maya",
    displayName: "Maya Editor",
    email: "maya@yt-asr.local",
    role: "user",
    status: "active",
    mustChangePassword: false,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-19T20:17:00.000Z",
    lastLoginAt: "2026-03-19T20:17:00.000Z",
  },
  {
    id: "user-jordan",
    loginIdentity: "jordan",
    displayName: "Jordan Reviewer",
    email: "jordan@yt-asr.local",
    role: "user",
    status: "active",
    mustChangePassword: false,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-18T14:11:00.000Z",
    lastLoginAt: "2026-03-18T14:11:00.000Z",
  },
  {
    id: "admin-theo",
    loginIdentity: "theo",
    displayName: "Theo Admin",
    email: "theo@yt-asr.local",
    role: "admin",
    status: "active",
    mustChangePassword: false,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-20T06:42:00.000Z",
    lastLoginAt: "2026-03-20T06:42:00.000Z",
  },
];

const workspaces = [
  {
    id: "workspace-primary",
    name: "Shared Workspace",
    slug: "shared-workspace",
    createdByUserId: "admin-theo",
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-20T06:42:00.000Z",
  },
];

const titles: TitleRecord[] = [
  buildTitle({
    id: "title-atlantic",
    videoId: "atlantic-jetstream",
    title: "Atlantic Jetstream",
    source: "Helios Flight Lab",
    language: "en",
    duration: 12.8,
    sourceType: "youtube",
    uploadedAt: "2026-03-19T10:12:00.000Z",
    sizeLabel: "18.4 MB",
    checkedOutByUserId: "user-maya",
    checkedOutAt: "2026-03-20T07:10:00.000Z",
    phrases: [
      buildPhrase("phrase-a1", 0.22, 2.84, "We started the climb just after sunrise.", true),
      buildPhrase("phrase-a2", 3.04, 5.64, "The turbulence eased once we cleared the ridge.", true),
      buildPhrase("phrase-a3", 6.1, 8.74, "Keep the subtitle phrasing tight through the turn.", false),
      buildPhrase("phrase-a4", 9.14, 12.08, "The transcript still needs a final review pass.", false),
    ],
    badge: null,
  }),
  buildTitle({
    id: "title-clearwater",
    videoId: "clearwater-harbor",
    title: "Clearwater Harbor Bulletin",
    source: "Port District",
    language: "en",
    duration: 9.8,
    sourceType: "package",
    uploadedAt: "2026-03-17T15:40:00.000Z",
    sizeLabel: "14.1 MB",
    checkedOutByUserId: null,
    checkedOutAt: null,
    phrases: [
      buildPhrase("phrase-b1", 0.4, 3.02, "Welcome back to the harbor report.", true),
      buildPhrase("phrase-b2", 3.18, 5.34, "Freight traffic is lighter than expected today.", true),
      buildPhrase("phrase-b3", 5.58, 9.3, "We will hold this title as checked in for review.", true),
    ],
    badge: "reviewed",
  }),
  buildTitle({
    id: "title-kiln",
    videoId: "kiln-talk-07",
    title: "Kiln Talk Episode 7",
    source: "Stoneware Sessions",
    language: "en",
    duration: 8.4,
    sourceType: "youtube",
    uploadedAt: "2026-03-16T12:03:00.000Z",
    sizeLabel: "11.3 MB",
    checkedOutByUserId: "user-jordan",
    checkedOutAt: "2026-03-19T17:02:00.000Z",
    phrases: [
      buildPhrase("phrase-c1", 0.14, 2.58, "I fire these mugs longer than most people expect.", true),
      buildPhrase("phrase-c2", 2.72, 4.94, "The glaze only settles once the kiln cools slowly.", false),
      buildPhrase("phrase-c3", 5.1, 7.76, "That is where the current timing drift shows up.", false),
    ],
    badge: null,
  }),
  buildTitle({
    id: "title-local-draft",
    videoId: "draft-interview-local",
    title: "Draft Interview Local",
    source: "Imported Media",
    language: "en",
    duration: 5.4,
    sourceType: "local",
    uploadedAt: "2026-03-20T07:50:00.000Z",
    sizeLabel: "9.6 MB",
    checkedOutByUserId: null,
    checkedOutAt: null,
    phrases: [
      buildPhrase("phrase-d1", 0.1, 1.82, "Local import draft starts here.", false),
      buildPhrase("phrase-d2", 2.02, 4.18, "This title has not been uploaded yet.", false),
    ],
    badge: "downloaded",
  }),
];

const audit: AuditRecord[] = [
  {
    id: "audit-1",
    eventType: "checkout",
    titleId: "title-atlantic",
    titleName: "Atlantic Jetstream",
    actorUserId: "user-maya",
    actorDisplayName: "Maya Editor",
    timestamp: "2026-03-20T07:10:00.000Z",
    details: "Checked out title and resumed the latest working draft.",
  },
  {
    id: "audit-2",
    eventType: "sync",
    titleId: "title-atlantic",
    titleName: "Atlantic Jetstream",
    actorUserId: "user-maya",
    actorDisplayName: "Maya Editor",
    timestamp: "2026-03-20T07:28:00.000Z",
    details: "Synced phrase timing edits to the server-side working draft.",
  },
  {
    id: "audit-3",
    eventType: "title_import",
    titleId: "title-local-draft",
    titleName: "Draft Interview Local",
    actorUserId: "admin-theo",
    actorDisplayName: "Theo Admin",
    timestamp: "2026-03-20T07:50:00.000Z",
    details: "Imported local media with an external subtitle track.",
  },
];

export const initialState: PersistedState = {
  sessionUserId: null,
  selectedTitleId: "title-atlantic",
  selectedPhraseIds: ["phrase-a3"],
  currentView: "editor",
  youtubeUrl: "https://www.youtube.com/watch?v=atlantic-jetstream",
  importLanguage: "en",
  selectedWorkspaceId: "workspace-primary",
  workspaceName: "Shared Workspace",
  workspaces,
  users,
  titles,
  storage: {
    provider: "Backblaze B2",
    bucket: "yt-asr-library",
    prefix: "production/",
    endpointUrl: "https://s3.us-west-000.backblazeb2.com",
    region: "us-west-000",
    addressingMode: "path",
    lastConnectionTestAt: "2026-03-20T06:45:00.000Z",
    auditVisible: true,
  },
  runtime: {
    adminKeepAwake: false,
    activeJobCount: 1,
    keepAwakeUntil: "2026-03-20T08:01:15.000Z",
    keepAwakeActive: true,
    heartbeatAvailable: true,
    heartbeatUrl: "https://yt-asr-example.up.railway.app/api/internal/keepawake-ping",
    heartbeatIntervalSeconds: 60,
    activityWindowSeconds: 75,
    lastHeartbeatAt: "2026-03-20T08:00:00.000Z",
    lastHeartbeatError: null,
    reason: "jobs",
    updatedAt: "2026-03-20T07:58:00.000Z",
  },
  audit,
};
