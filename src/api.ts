import type {
  AppStateResponse,
  JobRecord,
  Role,
  SaveKind,
  StorageConfig,
  SubtitleStreamRecord,
  TitleRecord,
  UserStatus,
} from "./types";

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || `Request failed with ${response.status}`);
  }
  return payload;
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "include",
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers || {}),
    },
    ...init,
  });
  return readJson<T>(response);
}

export const api = {
  getSession() {
    return requestJson<AppStateResponse>("/api/auth/session");
  },
  login(identifier: string, password: string) {
    return requestJson<AppStateResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier, password }),
    });
  },
  logout() {
    return requestJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
  },
  changePassword(currentPassword: string, nextPassword: string) {
    return requestJson<AppStateResponse>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, nextPassword }),
    });
  },
  redeemRecoveryToken(token: string, nextPassword: string) {
    return requestJson<AppStateResponse>("/api/auth/redeem-reset-token", {
      method: "POST",
      body: JSON.stringify({ token, nextPassword }),
    });
  },
  getState() {
    return requestJson<AppStateResponse>("/api/state");
  },
  getJobs() {
    return requestJson<{ jobs: JobRecord[] }>("/api/jobs");
  },
  reportActivity() {
    return requestJson<{ ok: boolean }>("/api/runtime/activity", {
      method: "POST",
    });
  },
  selectWorkspace(workspaceId: string) {
    return requestJson<AppStateResponse>("/api/workspaces/select", {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    });
  },
  createWorkspace(name: string) {
    return requestJson<AppStateResponse>("/api/admin/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
  saveTitle(titleId: string, kind: SaveKind, title: TitleRecord) {
    return requestJson<AppStateResponse>(`/api/titles/${titleId}/save`, {
      method: "POST",
      body: JSON.stringify({ kind, title }),
    });
  },
  checkout(titleId: string) {
    return requestJson<AppStateResponse>(`/api/titles/${titleId}/checkout`, { method: "POST" });
  },
  forceCheckIn(titleId: string) {
    return requestJson<AppStateResponse>(`/api/titles/${titleId}/force-checkin`, { method: "POST" });
  },
  takeOver(titleId: string) {
    return requestJson<AppStateResponse>(`/api/titles/${titleId}/takeover`, { method: "POST" });
  },
  deleteTitle(titleId: string) {
    return requestJson<AppStateResponse>(`/api/titles/${titleId}`, { method: "DELETE" });
  },
  createUser(input: {
    loginIdentity: string;
    email: string;
    displayName: string;
    role: Role;
    password: string;
    status: UserStatus;
    mustChangePassword: boolean;
  }) {
    return requestJson<AppStateResponse>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateUser(
    userId: string,
    input: {
      loginIdentity?: string;
      email?: string;
      displayName?: string;
      role?: Role;
      status?: UserStatus;
    },
  ) {
    return requestJson<AppStateResponse>(`/api/admin/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  deleteUser(userId: string) {
    return requestJson<AppStateResponse>(`/api/admin/users/${userId}`, {
      method: "DELETE",
    });
  },
  resetUserPassword(userId: string, nextPassword: string, mustChangePassword = true) {
    return requestJson<AppStateResponse>(`/api/admin/users/${userId}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ nextPassword, mustChangePassword }),
    });
  },
  issueRecoveryToken(userId: string) {
    return requestJson<{ recovery: { token: string; expiresAt: string; resetUrl: string | null; userId: string } }>(
      `/api/admin/users/${userId}/recovery-token`,
      {
        method: "POST",
      },
    );
  },
  queueYouTubeImport(urls: string[], language: string) {
    return requestJson<{ jobs: JobRecord[]; job: JobRecord | null }>("/api/import/youtube", {
      method: "POST",
      body: JSON.stringify({ urls, language }),
    });
  },
  probeMedia(formData: FormData) {
    return requestJson<{ probeToken: string; subtitleStreams: SubtitleStreamRecord[]; suggestedTitle: string }>(
      "/api/import/media/probe",
      {
        method: "POST",
        body: formData,
      },
    );
  },
  queueMediaImport(formData: FormData) {
    return requestJson<{ job: JobRecord }>("/api/import/media", {
      method: "POST",
      body: formData,
    });
  },
  queueAsrImport(formData: FormData) {
    return requestJson<{ job: JobRecord }>("/api/import/asr", {
      method: "POST",
      body: formData,
    });
  },
  queueWaveformRebuild(titleId: string) {
    return requestJson<{ job: JobRecord }>(`/api/titles/${titleId}/rebuild-waveform`, {
      method: "POST",
    });
  },
  saveStorage(settings: StorageConfig, accessKeyId?: string, secretAccessKey?: string) {
    return requestJson<{ storage: StorageConfig }>("/api/admin/storage", {
      method: "PUT",
      body: JSON.stringify({
        ...settings,
        ...(accessKeyId !== undefined ? { accessKeyId } : {}),
        ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
      }),
    });
  },
  testStorage() {
    return requestJson<{ ok: boolean; testedAt: string; storage: StorageConfig }>("/api/admin/storage/test", {
      method: "POST",
    });
  },
  saveKeepAwake(adminKeepAwake: boolean) {
    return requestJson<AppStateResponse>("/api/admin/runtime/keep-awake", {
      method: "PUT",
      body: JSON.stringify({ adminKeepAwake }),
    });
  },
  async probeLanguages(url: string) {
    return requestJson<{ languages: string[]; title?: string | null }>("/api/youtube/probe", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  },
};
