import type { AppStateResponse, JobRecord, SaveKind, StorageConfig, TitleRecord } from "./types";

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
  login(email: string, password: string) {
    return requestJson<AppStateResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },
  logout() {
    return requestJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
  },
  getState() {
    return requestJson<AppStateResponse>("/api/state");
  },
  getJobs() {
    return requestJson<{ jobs: JobRecord[] }>("/api/jobs");
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
  queueYouTubeImport(url: string, language: string) {
    return requestJson<{ job: JobRecord }>("/api/import/youtube", {
      method: "POST",
      body: JSON.stringify({ url, language }),
    });
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
  async probeLanguages(url: string) {
    return requestJson<{ languages: string[]; title?: string | null }>("/api/youtube/probe", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  },
};
