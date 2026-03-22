import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type {
  AppStateResponse,
  JobRecord,
  PersistedState,
  Phrase,
  Role,
  SaveKind,
  StatusTone,
  StorageProvider,
  SubtitleStreamRecord,
  TitleRecord,
  User,
  UserStatus,
  View,
} from "./types";

const LANGUAGES = ["en", "es", "fr", "de", "pt-BR"];

type PlaybackState = "stopped" | "playing" | "paused";
type DragState =
  | { kind: "start" | "end"; pointerId: number }
  | { kind: "pan"; pointerId: number; startX: number; initialPan: number }
  | null;

interface StatusMessage {
  tone: StatusTone;
  text: string;
}

interface UserAdminDraft {
  loginIdentity: string;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  resetPassword: string;
  mustChangePassword: boolean;
}

interface RecoveryTokenInfo {
  userId: string;
  token: string;
  expiresAt: string;
  resetUrl: string | null;
}

const EMPTY_STATE: PersistedState = {
  sessionUserId: null,
  selectedTitleId: "",
  selectedPhraseIds: [],
  currentView: "editor",
  youtubeUrl: "",
  importLanguage: "en",
  selectedWorkspaceId: "",
  workspaceName: "",
  workspaces: [],
  users: [],
  titles: [],
  storage: {
    provider: "Local Disk",
    bucket: "yt-asr-local",
    prefix: "workspace/",
    endpointUrl: "",
    region: "local",
    addressingMode: "path",
    lastConnectionTestAt: null,
    auditVisible: true,
  },
  audit: [],
};

function clonePhrases(phrases: Phrase[]) {
  return phrases.map((phrase) => ({ ...phrase }));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function parseYouTubeEntries(value: string) {
  return [
    ...new Set(
      String(value || "")
        .split(/[\r\n,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

const MIN_WAVE_WINDOW_SECONDS = 1;
const MAX_WAVE_WINDOW_SECONDS = 45;

function getWaveMinVisibleRange(duration: number) {
  return duration > 0 ? Math.min(MIN_WAVE_WINDOW_SECONDS, duration) : MIN_WAVE_WINDOW_SECONDS;
}

function getWaveViewRange(duration: number, requestedWindow: number) {
  if (!duration || duration <= 0) {
    return 10;
  }

  return clamp(requestedWindow, getWaveMinVisibleRange(duration), Math.min(MAX_WAVE_WINDOW_SECONDS, duration));
}

function getDefaultWaveViewRange(duration: number, phrase: Phrase | null) {
  if (!duration || duration <= 0) {
    return 10;
  }

  const phraseDuration = phrase ? Math.max(phrase.end - phrase.start, 0.75) : 3;
  const minRange = Math.min(duration, 6);
  const maxRange = Math.min(duration, MAX_WAVE_WINDOW_SECONDS);
  return clamp(phraseDuration * 6, minRange, maxRange);
}

function centerWavePan(duration: number, viewRange: number, focusTime: number) {
  return clamp(focusTime - viewRange / 2, 0, Math.max(0, duration - viewRange));
}

function waitForAudioMetadata(audio: HTMLAudioElement) {
  if (audio.readyState >= 1) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timeoutId = 0;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("error", handleError);
    };

    const handleLoadedMetadata = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("Audio metadata could not be loaded."));
    };

    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Audio metadata timed out while loading."));
    }, 5000);

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("error", handleError);
  });
}

function waitForAudioCanPlay(audio: HTMLAudioElement) {
  if (audio.readyState >= 3 && !audio.seeking) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timeoutId = 0;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("error", handleError);
    };

    const handleCanPlay = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("Audio data could not be buffered for playback."));
    };

    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Audio seek timed out before playback could begin."));
    }, 12000);

    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("error", handleError);
  });
}

function seekAudio(audio: HTMLAudioElement, time: number) {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
  const target = clamp(time, 0, duration ?? time);
  if (Math.abs(audio.currentTime - target) < 0.02) {
    return Promise.resolve(target);
  }

  return new Promise<number>((resolve, reject) => {
    let timeoutId = 0;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      audio.removeEventListener("seeked", handleSeeked);
      audio.removeEventListener("error", handleError);
    };

    const handleSeeked = () => {
      cleanup();
      resolve(audio.currentTime);
    };

    const handleError = () => {
      cleanup();
      reject(new Error("Audio seek failed."));
    };

    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Audio seek timed out."));
    }, 12000);

    audio.addEventListener("seeked", handleSeeked);
    audio.addEventListener("error", handleError);

    try {
      audio.currentTime = target;
    } catch {
      cleanup();
      reject(new Error("Audio seek could not be applied."));
    }
  });
}

export default function App() {
  const [appState, setAppState] = useState<PersistedState>(EMPTY_STATE);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [status, setStatus] = useState<StatusMessage>({
    tone: "info",
    text: "Connecting to the server workspace...",
  });
  const [loadingState, setLoadingState] = useState(true);
  const [authInFlight, setAuthInFlight] = useState(false);
  const [loginIdentifier, setLoginIdentifier] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [recoveryForm, setRecoveryForm] = useState({
    token: "",
    nextPassword: "",
    confirmPassword: "",
  });
  const [playbackState, setPlaybackState] = useState<PlaybackState>("stopped");
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [playheadTime, setPlayheadTime] = useState<number | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [textDraftDirty, setTextDraftDirty] = useState(false);
  const [waveWindowSeconds, setWaveWindowSeconds] = useState(12);
  const [wavePan, setWavePan] = useState(0);
  const [dragState, setDragState] = useState<DragState>(null);
  const [topMenuOpen, setTopMenuOpen] = useState(false);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [timingDraft, setTimingDraft] = useState({ start: "0.00", end: "0.00" });
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [mediaTitle, setMediaTitle] = useState("");
  const [mediaSource, setMediaSource] = useState("");
  const [mediaLanguage, setMediaLanguage] = useState("en");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [mediaProbeToken, setMediaProbeToken] = useState("");
  const [mediaProbeInFlight, setMediaProbeInFlight] = useState(false);
  const [mediaSubtitleStreams, setMediaSubtitleStreams] = useState<SubtitleStreamRecord[]>([]);
  const [selectedSubtitleStreamIndex, setSelectedSubtitleStreamIndex] = useState<string>("");
  const [cloudListFilter, setCloudListFilter] = useState("");
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    nextPassword: "",
    confirmPassword: "",
  });
  const [createUserForm, setCreateUserForm] = useState({
    loginIdentity: "",
    email: "",
    displayName: "",
    password: "",
    role: "user" as Role,
    status: "active" as UserStatus,
    mustChangePassword: true,
  });
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [userDrafts, setUserDrafts] = useState<Record<string, UserAdminDraft>>({});
  const [selectedManagedUserId, setSelectedManagedUserId] = useState("");
  const [generatedRecovery, setGeneratedRecovery] = useState<RecoveryTokenInfo | null>(null);
  const [storageAccessKeyId, setStorageAccessKeyId] = useState("");
  const [storageSecretAccessKey, setStorageSecretAccessKey] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const waveformRef = useRef<SVGSVGElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const topMenuRef = useRef<HTMLDivElement | null>(null);
  const asrImportInputRef = useRef<HTMLInputElement | null>(null);
  const seenTerminalJobsRef = useRef<Set<string>>(new Set());
  const appStateRef = useRef<PersistedState>(EMPTY_STATE);
  const textDraftRef = useRef("");
  const textDraftDirtyRef = useRef(false);
  const selectedPhraseRef = useRef<Phrase | null>(null);
  const playbackCommandRef = useRef<"pause" | "stop" | "phrase-end" | null>(null);

  const currentUser = appState.users.find((user) => user.id === appState.sessionUserId) ?? null;
  const selectedWorkspace =
    appState.workspaces.find((workspace) => workspace.id === appState.selectedWorkspaceId) ?? appState.workspaces[0] ?? null;
  const selectedTitle =
    appState.titles.find((title) => title.id === appState.selectedTitleId) ?? appState.titles[0] ?? null;
  const selectedPhrase =
    selectedTitle?.phrases.find((phrase) => appState.selectedPhraseIds.includes(phrase.id)) ??
    selectedTitle?.phrases[0] ??
    null;
  const passwordChangeRequired = Boolean(currentUser?.mustChangePassword);
  const selectedManagedUser =
    appState.users.find((user) => user.id === selectedManagedUserId) ?? appState.users[0] ?? null;
  const selectedManagedUserDraft = selectedManagedUser ? userDrafts[selectedManagedUser.id] ?? null : null;
  const editable = Boolean(currentUser && selectedTitle?.checkedOutByUserId === currentUser.id);
  const canEdit = editable && !saveInFlight && !passwordChangeRequired;
  const activeCheckedOutTitleId = appState.titles.find((title) => title.checkedOutByUserId === currentUser?.id)?.id ?? null;
  const viewRange = selectedTitle ? getWaveViewRange(selectedTitle.duration, waveWindowSeconds) : 10;
  const visibleStart = clamp(wavePan, 0, Math.max(0, (selectedTitle?.duration ?? 0) - viewRange));
  const visibleEnd = visibleStart + viewRange;

  const libraryTitles = [...appState.titles].sort((left, right) => {
    const leftOwned = left.checkedOutByUserId === currentUser?.id ? 0 : 1;
    const rightOwned = right.checkedOutByUserId === currentUser?.id ? 0 : 1;
    if (leftOwned !== rightOwned) {
      return leftOwned - rightOwned;
    }
    return left.title.localeCompare(right.title);
  });
  const filteredCloudTitles = libraryTitles.filter((title) => {
    const query = cloudListFilter.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return [title.title, title.source, title.videoId].some((value) => value.toLowerCase().includes(query));
  });

  useEffect(() => {
    void hydrateSession();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const resetToken = params.get("resetToken");
    if (!resetToken) {
      return;
    }

    setRecoveryForm((current) => ({ ...current, token: resetToken }));
    postStatus("info", "Recovery token loaded from the link. Set a new password to continue.");
  }, []);

  useEffect(() => {
    appStateRef.current = appState;
  }, [appState]);

  useEffect(() => {
    textDraftRef.current = textDraft;
  }, [textDraft]);

  useEffect(() => {
    textDraftDirtyRef.current = textDraftDirty;
  }, [textDraftDirty]);

  useEffect(() => {
    selectedPhraseRef.current = selectedPhrase;
  }, [selectedPhrase]);

  useEffect(() => {
    if (!topMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!topMenuRef.current?.contains(event.target as Node)) {
        setTopMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [topMenuOpen]);

  useEffect(() => {
    setUserDrafts((current) => {
      const nextDrafts: Record<string, UserAdminDraft> = {};
      appState.users.forEach((user) => {
        nextDrafts[user.id] = current[user.id]
          ? {
              ...current[user.id],
              loginIdentity: current[user.id].loginIdentity || user.loginIdentity,
              email: current[user.id].email || user.email,
              displayName: current[user.id].displayName || user.displayName,
              role: current[user.id].role,
              status: current[user.id].status,
              mustChangePassword: current[user.id].mustChangePassword,
            }
          : {
              loginIdentity: user.loginIdentity,
              email: user.email,
              displayName: user.displayName,
              role: user.role,
              status: user.status,
              resetPassword: "",
              mustChangePassword: user.mustChangePassword,
            };
      });
      return nextDrafts;
    });
  }, [appState.users]);

  useEffect(() => {
    if (appState.users.length === 0) {
      setSelectedManagedUserId("");
      return;
    }

    setSelectedManagedUserId((current) =>
      current && appState.users.some((user) => user.id === current) ? current : appState.users[0].id,
    );
  }, [appState.users]);

  useEffect(() => {
    if (!selectedPhrase) {
      setTextDraft("");
      textDraftRef.current = "";
      setTimingDraft({ start: "0.00", end: "0.00" });
      return;
    }

    setTextDraft(selectedPhrase.text);
    textDraftRef.current = selectedPhrase.text;
    setTextDraftDirty(false);
    textDraftDirtyRef.current = false;
    setTimingDraft({
      start: selectedPhrase.start.toFixed(2),
      end: selectedPhrase.end.toFixed(2),
    });
  }, [selectedPhrase?.id, selectedPhrase?.text, selectedPhrase?.start, selectedPhrase?.end]);

  useEffect(() => {
    if (!selectedTitle) {
      setWaveWindowSeconds(12);
      setWavePan(0);
      return;
    }

    const nextViewRange = getDefaultWaveViewRange(selectedTitle.duration, selectedPhrase);
    const focusTime = selectedPhrase ? (selectedPhrase.start + selectedPhrase.end) / 2 : nextViewRange / 2;

    setWaveWindowSeconds(nextViewRange);
    setWavePan(centerWavePan(selectedTitle.duration, nextViewRange, focusTime));
  }, [selectedTitle?.id]);

  useEffect(() => {
    if (!selectedTitle || !selectedPhrase) {
      return;
    }

    const padding = Math.min(viewRange * 0.18, 2);
    if (selectedPhrase.start < visibleStart + padding || selectedPhrase.end > visibleEnd - padding) {
      const focusTime = (selectedPhrase.start + selectedPhrase.end) / 2;
      setWavePan(centerWavePan(selectedTitle.duration, viewRange, focusTime));
    }
  }, [selectedPhrase?.id, selectedTitle?.id, selectedTitle?.duration, viewRange]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (textDraftDirty || saveInFlight || selectedTitle?.draft.isDirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [saveInFlight, selectedTitle?.draft.isDirty, textDraftDirty]);

  useEffect(() => {
    if (!selectedTitle) {
      return;
    }

    setWavePan((current) => clamp(current, 0, Math.max(0, selectedTitle.duration - viewRange)));
  }, [selectedTitle?.id, selectedTitle?.duration, viewRange]);

  useEffect(() => {
    if (!editable || !selectedTitle) {
      return;
    }

    const interval = window.setInterval(() => {
      const currentTitle = appStateRef.current.titles.find((title) => title.id === selectedTitle.id);
      if (!currentTitle?.draft.isDirty || saveInFlight) {
        return;
      }

      void saveTitle("autosave", selectedTitle.id);
    }, 4500);

    return () => window.clearInterval(interval);
  }, [editable, saveInFlight, selectedTitle?.id]);

  useEffect(() => {
    if (!editable || !selectedTitle || !textDraftDirty || saveInFlight) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void saveTitle("autosave", selectedTitle.id);
    }, 2500);

    return () => window.clearTimeout(timeout);
  }, [editable, saveInFlight, selectedTitle?.id, textDraft, textDraftDirty]);

  useEffect(() => {
    if (!mediaFile || !currentUser) {
      setMediaProbeToken("");
      setMediaProbeInFlight(false);
      setMediaSubtitleStreams([]);
      setSelectedSubtitleStreamIndex("");
      return;
    }

    let cancelled = false;
    const formData = new FormData();
    formData.append("media", mediaFile);
    setMediaProbeInFlight(true);
    setMediaSubtitleStreams([]);
    setSelectedSubtitleStreamIndex("");

    void api
      .probeMedia(formData)
      .then((response) => {
        if (cancelled) {
          return;
        }

        setMediaProbeToken(response.probeToken);
        setMediaSubtitleStreams(response.subtitleStreams);
        setMediaTitle((current) => (current.trim() ? current : response.suggestedTitle));
      })
      .catch((error) => {
        if (!cancelled) {
          setMediaProbeToken("");
          setMediaSubtitleStreams([]);
          setSelectedSubtitleStreamIndex("");
          postStatus("warning", error instanceof Error ? error.message : "Could not inspect embedded subtitle tracks.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setMediaProbeInFlight(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentUser, mediaFile]);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;

    const handlePause = () => {
      const command = playbackCommandRef.current;
      if (command) {
        playbackCommandRef.current = null;
        return;
      }

      setPlaybackState((current) => (current === "playing" ? "paused" : current));
    };
    const handleEnded = () => {
      setPlaybackState("stopped");
      setPlayheadTime(selectedPhraseRef.current?.end ?? audio.currentTime ?? null);
    };

    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      pauseAudio(audio, "stop");
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.playbackRate = playbackSpeed;
  }, [playbackSpeed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    pauseAudio(audio, "stop");
    if (selectedTitle?.audioUrl) {
      const syncToSelectedPhraseStart = async () => {
        const nextStart = selectedPhraseRef.current?.start ?? 0;
        try {
          await waitForAudioMetadata(audio);
          const actualTime = await seekAudio(audio, nextStart);
          setPlayheadTime(actualTime);
        } catch {
          setPlayheadTime(nextStart);
        }
      };

      const handleLoadedMetadata = () => {
        void syncToSelectedPhraseStart();
      };

      audio.src = selectedTitle.audioUrl;
      audio.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
      audio.load();
      void syncToSelectedPhraseStart();
      setPlaybackState("stopped");
      return () => {
        audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      };
    } else {
      audio.removeAttribute("src");
      setPlayheadTime(null);
    }
    setPlaybackState("stopped");
  }, [selectedTitle?.id, selectedTitle?.audioUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || playbackState !== "playing" || !selectedPhrase) {
      return;
    }

    let frameId = 0;

    const tick = () => {
      const current = audio.currentTime;
      if (current >= selectedPhrase.end) {
        if (loopPlayback) {
          audio.currentTime = selectedPhrase.start;
          setPlayheadTime(selectedPhrase.start);
        } else {
          pauseAudio(audio, "phrase-end");
          audio.currentTime = selectedPhrase.end;
          setPlaybackState("stopped");
          setPlayheadTime(selectedPhrase.end);
          return;
        }
      } else {
        setPlayheadTime(current);
      }

      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [loopPlayback, playbackState, selectedPhrase?.end, selectedPhrase?.start, selectedPhrase?.id]);

  useEffect(() => {
    if (!currentUser) {
      setJobs([]);
      seenTerminalJobsRef.current.clear();
      return;
    }

    let cancelled = false;

    const pollJobs = async () => {
      try {
        const response = await api.getJobs();
        if (cancelled) {
          return;
        }

        setJobs(response.jobs);
        const unseenTerminalJobs = response.jobs.filter(
          (job) =>
            (job.status === "completed" || job.status === "failed") && !seenTerminalJobsRef.current.has(job.id),
        );

        if (unseenTerminalJobs.length > 0) {
          unseenTerminalJobs.forEach((job) => seenTerminalJobsRef.current.add(job.id));
          const latestJob = unseenTerminalJobs[0];
          if (latestJob.status === "completed") {
            postStatus("success", latestJob.message || `${latestJob.type.replaceAll("_", " ")} completed.`);
            const stateResponse = await api.getState();
            if (!cancelled) {
              applyServerResponse(stateResponse, { preserveView: true });
            }
          } else {
            postStatus("error", latestJob.error || `${latestJob.type.replaceAll("_", " ")} failed.`);
          }
        }
      } catch {
        if (!cancelled) {
          postStatus("warning", "Job polling could not reach the server.");
        }
      }
    };

    void pollJobs();
    const interval = window.setInterval(() => {
      void pollJobs();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    if (appState.currentView === "shared") {
      void refreshState(false);
    }
  }, [appState.currentView, currentUser?.id]);

  useEffect(() => {
    if (!selectedTitle || selectedTitle.checkedOutByUserId === currentUser?.id) {
      return;
    }

    if (playbackState === "playing") {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
      }
      setPlaybackState("stopped");
    }
  }, [currentUser?.id, playbackState, selectedTitle?.checkedOutByUserId]);

  useEffect(() => {
    if (!selectedTitle?.audioUrl && playbackState === "playing") {
      setPlaybackState("stopped");
    }
  }, [playbackState, selectedTitle?.audioUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!selectedPhrase) {
      setPlayheadTime(null);
      return;
    }

    if (playbackState === "playing" && audio) {
      pauseAudio(audio, "stop");
      setPlaybackState("stopped");
    }

    if (audio && selectedTitle?.audioUrl) {
      void waitForAudioMetadata(audio)
        .then(() => seekAudio(audio, selectedPhrase.start))
        .then((actualTime) => {
          setPlayheadTime(actualTime);
        })
        .catch(() => {
          setPlayheadTime(selectedPhrase.start);
        });
      return;
    }
    setPlayheadTime(selectedPhrase.start);
  }, [selectedPhrase?.id, selectedTitle?.id, selectedTitle?.audioUrl]);

  useEffect(() => {
    if (!dragState || !selectedTitle || !selectedPhrase || !waveformRef.current) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId || !waveformRef.current) {
        return;
      }

      const bounds = waveformRef.current.getBoundingClientRect();
      const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);

      if (dragState.kind === "pan") {
        const deltaRatio = (event.clientX - dragState.startX) / bounds.width;
        const nextPan = dragState.initialPan - deltaRatio * viewRange;
        setWavePan(clamp(nextPan, 0, Math.max(0, selectedTitle.duration - viewRange)));
        return;
      }

      const nextTime = visibleStart + ratio * viewRange;
      updateTitle(selectedTitle.id, (title) => ({
        ...title,
        phrases: title.phrases.map((phrase) => {
          if (phrase.id !== selectedPhrase.id) {
            return phrase;
          }

          return dragState.kind === "start"
            ? { ...phrase, start: clamp(nextTime, 0, phrase.end - 0.1) }
            : { ...phrase, end: clamp(nextTime, phrase.start + 0.1, title.duration) };
        }),
      }));
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      if (dragState.kind === "start" || dragState.kind === "end") {
        markSelectedPhraseReviewed("Timing markers updated and marked reviewed.");
      }
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, selectedPhrase?.id, selectedTitle?.id, selectedTitle?.duration, viewRange, visibleStart]);

  function postStatus(tone: StatusTone, text: string) {
    setStatus({ tone, text });
  }

  function updateState(updater: (current: PersistedState) => PersistedState) {
    const next = updater(appStateRef.current);
    appStateRef.current = next;
    setAppState(next);
  }

  function updateTitle(titleId: string, updater: (title: TitleRecord) => TitleRecord) {
    updateState((current) => ({
      ...current,
      titles: current.titles.map((title) => (title.id === titleId ? updater(title) : title)),
    }));
  }

  function applyServerResponse(
    response: AppStateResponse,
    options: { preserveView?: boolean; preserveSelection?: boolean } = {},
  ) {
    const current = appStateRef.current;
    const sessionUser = response.state.users.find((user) => user.id === response.state.sessionUserId) ?? null;
    const preservedTitle = options.preserveSelection
      ? response.state.titles.find((title) => title.id === current.selectedTitleId) ?? null
      : null;
    const preservedPhraseIds = preservedTitle
      ? current.selectedPhraseIds.filter((phraseId) => preservedTitle.phrases.some((phrase) => phrase.id === phraseId))
      : [];
    const nextState: PersistedState = {
      ...response.state,
      currentView: sessionUser?.mustChangePassword
        ? "settings"
        : options.preserveView
          ? current.currentView
          : response.state.currentView,
      selectedTitleId: preservedTitle?.id || response.state.selectedTitleId,
      selectedPhraseIds:
        preservedPhraseIds.length > 0
          ? preservedPhraseIds
          : preservedTitle?.phrases[0]
            ? [preservedTitle.phrases[0].id]
            : response.state.selectedPhraseIds,
      youtubeUrl: current.youtubeUrl,
      importLanguage: current.importLanguage || response.state.importLanguage,
    };
    appStateRef.current = nextState;
    setAppState(nextState);
    setJobs(response.jobs);
    setLoadingState(false);
  }

  function resetToLoggedOutState(message: string) {
    appStateRef.current = EMPTY_STATE;
    setAppState(EMPTY_STATE);
    setJobs([]);
    setLoadingState(false);
    setPlaybackState("stopped");
    setPlayheadTime(null);
    setTextDraft("");
    textDraftRef.current = "";
    setTextDraftDirty(false);
    textDraftDirtyRef.current = false;
    setPasswordForm({
      currentPassword: "",
      nextPassword: "",
      confirmPassword: "",
    });
    setCreateUserForm({
      loginIdentity: "",
      email: "",
      displayName: "",
      password: "",
      role: "user",
      status: "active",
      mustChangePassword: true,
    });
    setWorkspaceNameDraft("");
    setUserDrafts({});
    setSelectedManagedUserId("");
    setGeneratedRecovery(null);
    setMediaTitle("");
    setMediaSource("");
    setMediaLanguage("en");
    setMediaFile(null);
    setSubtitleFile(null);
    setMediaProbeToken("");
    setMediaProbeInFlight(false);
    setMediaSubtitleStreams([]);
    setSelectedSubtitleStreamIndex("");
    setLoginIdentifier("");
    setLoginPassword("");
    setRecoveryForm({
      token: "",
      nextPassword: "",
      confirmPassword: "",
    });
    postStatus("info", message);
  }

  async function hydrateSession() {
    try {
      const response = await api.getSession();
      applyServerResponse(response);
      postStatus("success", "Session restored from the server.");
    } catch {
      resetToLoggedOutState("Sign in to open the hosted transcription workspace.");
    }
  }

  async function refreshState(showStatus = true) {
    if (!currentUser) {
      return;
    }

    try {
      const response = await api.getState();
      applyServerResponse(response, { preserveView: true, preserveSelection: true });
      if (showStatus) {
        postStatus("info", "Library metadata refreshed from the server.");
      }
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not refresh the library.");
    }
  }

  function buildTitlePayload(titleId: string) {
    const currentState = appStateRef.current;
    const title = currentState.titles.find((entry) => entry.id === titleId);
    if (!title) {
      return null;
    }

    if (
      currentState.selectedTitleId !== titleId ||
      currentState.selectedPhraseIds.length === 0 ||
      !textDraftDirtyRef.current
    ) {
      return title;
    }

    const selectedPhraseId = currentState.selectedPhraseIds[0];
    const nextText = textDraftRef.current.trim() || "<Sentence>";
    return {
      ...title,
      phrases: title.phrases.map((phrase) =>
        phrase.id === selectedPhraseId ? { ...phrase, text: nextText, reviewed: true } : phrase,
      ),
    };
  }

  async function saveTitle(kind: SaveKind, titleId: string, successMessage?: string) {
    const title = buildTitlePayload(titleId);
    if (!title) {
      return;
    }

    setSaveInFlight(true);
    postStatus("info", kind === "autosave" ? "Autosaving working draft..." : "Saving working draft...");
    try {
      const response = await api.saveTitle(titleId, kind, {
        ...title,
        savedSnapshot: clonePhrases(title.phrases),
      });
      applyServerResponse(response, { preserveView: true, preserveSelection: true });
      if (appStateRef.current.selectedTitleId === titleId) {
        setTextDraftDirty(false);
        textDraftDirtyRef.current = false;
      }
      postStatus(
        "success",
        successMessage ||
          (kind === "autosave"
            ? "Autosave complete. Draft is persisted on the server."
            : kind === "sync"
              ? "Sync complete. Working draft stayed checked out."
              : kind === "checkin"
                ? "Final save complete. Title checked in."
                : "Save complete. Latest phrase edits are in the working draft."),
      );
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaveInFlight(false);
    }
  }

  async function markSelectedPhraseReviewed(message: string) {
    if (!selectedTitle || !selectedPhrase) {
      return;
    }

    updateTitle(selectedTitle.id, (title) => ({
      ...title,
      phrases: title.phrases.map((phrase) =>
        phrase.id === selectedPhrase.id ? { ...phrase, reviewed: true } : phrase,
      ),
      draft: { ...title.draft, isDirty: true },
    }));
    await saveTitle("manual", selectedTitle.id, message);
  }

  async function commitText(options: { persist?: boolean } = {}) {
    if (!selectedTitle || !selectedPhrase || !editable) {
      return;
    }

    const nextText = textDraftRef.current.trim() || "<Sentence>";
    if (!textDraftDirtyRef.current && nextText === selectedPhrase.text) {
      return;
    }

    updateTitle(selectedTitle.id, (title) => ({
      ...title,
      phrases: title.phrases.map((phrase) =>
        phrase.id === selectedPhrase.id ? { ...phrase, text: nextText, reviewed: true } : phrase,
      ),
      draft: { ...title.draft, isDirty: true },
    }));
    setTextDraft(nextText);
    textDraftRef.current = nextText;
    setTextDraftDirty(false);
    textDraftDirtyRef.current = false;
    if (options.persist === false) {
      postStatus("success", "Caption text committed locally.");
      return;
    }
    await saveTitle("manual", selectedTitle.id, "Caption text committed and marked reviewed.");
  }

  async function selectTitle(titleId: string) {
    await commitText();
    const nextTitle = appStateRef.current.titles.find((title) => title.id === titleId);
    if (!nextTitle) {
      return;
    }

    updateState((current) => ({
      ...current,
      currentView: "editor",
      selectedTitleId: nextTitle.id,
      selectedPhraseIds: nextTitle.phrases[0] ? [nextTitle.phrases[0].id] : [],
    }));
    postStatus("info", `${nextTitle.title} loaded.`);
  }

  async function focusSharedTitle(titleId: string) {
    await commitText();
    const nextTitle = appStateRef.current.titles.find((title) => title.id === titleId);
    if (!nextTitle) {
      return;
    }

    updateState((current) => ({
      ...current,
      currentView: "shared",
      selectedTitleId: nextTitle.id,
      selectedPhraseIds: nextTitle.phrases[0] ? [nextTitle.phrases[0].id] : [],
    }));
    postStatus("info", `${nextTitle.title} selected in the cloud list.`);
  }

  async function selectPhrase(phraseId: string, multi: boolean) {
    await commitText();
    updateState((current) => {
      const nextSelection = multi
        ? current.selectedPhraseIds.includes(phraseId)
          ? current.selectedPhraseIds.filter((id) => id !== phraseId)
          : [...current.selectedPhraseIds, phraseId]
        : [phraseId];
      return {
        ...current,
        selectedPhraseIds: nextSelection.length > 0 ? nextSelection : [phraseId],
      };
    });
  }

  function getTitleStateLabel(title: TitleRecord) {
    if (title.checkedOutByUserId === currentUser?.id) {
      return "Checked Out";
    }
    if (title.checkedOutByUserId) {
      const owner = appState.users.find((user) => user.id === title.checkedOutByUserId);
      return `Locked: ${owner?.displayName ?? "Unknown user"}`;
    }
    if (title.badge === "reviewed") {
      return "Reviewed";
    }
    if (title.badge === "downloaded") {
      return "Downloaded";
    }
    return "Checked In";
  }

  function getTitleHeaderSuffix(title: TitleRecord) {
    if (title.checkedOutByUserId === currentUser?.id) {
      return "Checked out";
    }
    if (title.checkedOutByUserId) {
      const owner = appState.users.find((user) => user.id === title.checkedOutByUserId);
      return `Locked by ${owner?.displayName ?? "Unknown user"} (read-only)`;
    }
    return "Checked in (read-only)";
  }

  function canCheckoutTitle(title: TitleRecord) {
    if (!currentUser || passwordChangeRequired) {
      return false;
    }
    if (title.checkedOutByUserId && title.checkedOutByUserId !== currentUser.id) {
      return false;
    }
    if (activeCheckedOutTitleId && activeCheckedOutTitleId !== title.id) {
      return false;
    }
    return title.checkedOutByUserId !== currentUser.id;
  }

  function canSyncTitle(title: TitleRecord) {
    return Boolean(currentUser && !passwordChangeRequired && title.checkedOutByUserId === currentUser.id);
  }

  function canCheckInTitle(title: TitleRecord) {
    return Boolean(currentUser && !passwordChangeRequired && title.checkedOutByUserId === currentUser.id);
  }

  function canForceCheckInTitle(title: TitleRecord) {
    return Boolean(currentUser?.role === "admin" && title.checkedOutByUserId);
  }

  function canTakeOverTitle(title: TitleRecord) {
    if (currentUser?.role !== "admin" || passwordChangeRequired) {
      return false;
    }
    if (title.checkedOutByUserId === currentUser.id) {
      return false;
    }
    if (activeCheckedOutTitleId && activeCheckedOutTitleId !== title.id) {
      return false;
    }
    return true;
  }

  function switchView(view: View) {
    setTopMenuOpen(false);
    updateState((current) => ({ ...current, currentView: view }));
    if (view === "shared") {
      postStatus("info", "Shared library refreshed and ready for collaborative actions.");
    }
    if (view === "editor") {
      postStatus("info", "Editor ready.");
    }
  }

  async function login() {
    if (!loginIdentifier.trim() || !loginPassword.trim()) {
      postStatus("warning", "Enter a login identity or email and a password to sign in.");
      return;
    }

    setAuthInFlight(true);
    try {
      const response = await api.login(loginIdentifier.trim(), loginPassword);
      applyServerResponse(response);
      setLoginPassword("");
      const signedInUser = response.state.users.find((user) => user.id === response.state.sessionUserId) ?? null;
      postStatus(
        signedInUser?.mustChangePassword ? "warning" : "success",
        signedInUser?.mustChangePassword
          ? `Signed in as ${signedInUser.displayName}. Change the password before continuing.`
          : `Signed in as ${signedInUser?.displayName ?? "user"}.`,
      );
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Sign in failed.");
    } finally {
      setAuthInFlight(false);
    }
  }

  async function redeemRecovery() {
    if (!recoveryForm.token.trim() || !recoveryForm.nextPassword) {
      postStatus("warning", "Enter the recovery token and a new password first.");
      return;
    }
    if (recoveryForm.nextPassword !== recoveryForm.confirmPassword) {
      postStatus("error", "Recovery password confirmation does not match.");
      return;
    }

    setAuthInFlight(true);
    try {
      const response = await api.redeemRecoveryToken(recoveryForm.token.trim(), recoveryForm.nextPassword);
      applyServerResponse(response);
      setRecoveryForm({
        token: "",
        nextPassword: "",
        confirmPassword: "",
      });
      postStatus("success", "Password reset complete. You are now signed in.");
      if (window.location.search.includes("resetToken=")) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not redeem the recovery token.");
    } finally {
      setAuthInFlight(false);
    }
  }

  async function logout() {
    if (!currentUser) {
      return;
    }

    await commitText();
    try {
      await api.logout();
    } catch {
      // Clear the local shell even if the server session is already gone.
    }
    resetToLoggedOutState("Session ended. Any active checkout stayed on the server.");
  }

  async function play(action: PlaybackState) {
    const audio = audioRef.current;
    if (!selectedPhrase || !audio || !selectedTitle?.audioUrl) {
      postStatus("warning", "This title does not have playable working audio yet.");
      return;
    }

    if (action === "playing") {
      try {
        await waitForAudioMetadata(audio);
        const actualStart = await seekAudio(audio, selectedPhrase.start);
        await waitForAudioCanPlay(audio);
        audio.playbackRate = playbackSpeed;
        playbackCommandRef.current = null;
        setPlayheadTime(actualStart);
        await audio.play();
        setPlaybackState("playing");
        postStatus("info", `Playback ${playbackSpeed.toFixed(2)}x on the selected phrase.`);
      } catch (error) {
        setPlaybackState("stopped");
        postStatus("error", error instanceof Error ? error.message : "Browser playback could not start for this phrase.");
      }
      return;
    }
    if (action === "paused") {
      pauseAudio(audio, "pause");
      setPlaybackState("paused");
      return;
    }
    if (action === "stopped") {
      pauseAudio(audio, "stop");
      void waitForAudioMetadata(audio)
        .then(() => seekAudio(audio, selectedPhrase.start))
        .then((actualTime) => {
          setPlayheadTime(actualTime);
        })
        .catch(() => {
          setPlayheadTime(selectedPhrase.start);
        });
      setPlaybackState("stopped");
      return;
    }
  }

  function pauseAudio(audio: HTMLAudioElement, command: "pause" | "stop" | "phrase-end") {
    const wasPlaying = !audio.paused;
    playbackCommandRef.current = command;
    audio.pause();
    if (!wasPlaying) {
      playbackCommandRef.current = null;
    }
  }

  function updateWaveWindow(windowSeconds: number, focusTime?: number) {
    if (!selectedTitle) {
      return;
    }

    const nextViewRange = getWaveViewRange(selectedTitle.duration, windowSeconds);
    const focus =
      focusTime ?? (selectedPhrase ? (selectedPhrase.start + selectedPhrase.end) / 2 : visibleStart + viewRange / 2);
    const anchorRatio = viewRange > 0 ? clamp((focus - visibleStart) / viewRange, 0, 1) : 0.5;

    setWaveWindowSeconds(nextViewRange);
    setWavePan(
      clamp(focus - anchorRatio * nextViewRange, 0, Math.max(0, selectedTitle.duration - nextViewRange)),
    );
  }

  function startPan(pointerId: number, clientX: number) {
    if (!selectedTitle) {
      return;
    }
    setDragState({ kind: "pan", pointerId, startX: clientX, initialPan: wavePan });
  }

  function startMarkerDrag(kind: "start" | "end", pointerId: number) {
    if (!canEdit) {
      return;
    }
    setDragState({ kind, pointerId });
  }

  function updateUserDraft(userId: string, updater: (draft: UserAdminDraft) => UserAdminDraft) {
    setUserDrafts((current) => ({
      ...current,
      [userId]: updater(
        current[userId] || {
          loginIdentity: appState.users.find((user) => user.id === userId)?.loginIdentity || "",
          email: appState.users.find((user) => user.id === userId)?.email || "",
          displayName: appState.users.find((user) => user.id === userId)?.displayName || "",
          role: appState.users.find((user) => user.id === userId)?.role || "user",
          status: appState.users.find((user) => user.id === userId)?.status || "active",
          resetPassword: "",
          mustChangePassword: true,
        },
      ),
    }));
  }

  async function submitPasswordChange() {
    if (!currentUser) {
      return;
    }
    if (!passwordForm.currentPassword || !passwordForm.nextPassword) {
      postStatus("warning", "Enter the current password and a new password first.");
      return;
    }
    if (passwordForm.nextPassword !== passwordForm.confirmPassword) {
      postStatus("warning", "New password confirmation does not match.");
      return;
    }

    try {
      const response = await api.changePassword(passwordForm.currentPassword, passwordForm.nextPassword);
      applyServerResponse(response, { preserveView: true });
      setPasswordForm({
        currentPassword: "",
        nextPassword: "",
        confirmPassword: "",
      });
      postStatus("success", "Password changed and saved on the server.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not change the password.");
    }
  }

  async function submitCreateUser() {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }
    if (!createUserForm.loginIdentity.trim() || !createUserForm.email.trim() || !createUserForm.displayName.trim() || !createUserForm.password) {
      postStatus("warning", "Login identity, email, display name, and password are required to create a user.");
      return;
    }

    try {
      const response = await api.createUser({
        loginIdentity: createUserForm.loginIdentity.trim(),
        email: createUserForm.email.trim(),
        displayName: createUserForm.displayName.trim(),
        password: createUserForm.password,
        role: createUserForm.role,
        status: createUserForm.status,
        mustChangePassword: createUserForm.mustChangePassword,
      });
      applyServerResponse(response, { preserveView: true });
      setCreateUserForm({
        loginIdentity: "",
        email: "",
        displayName: "",
        password: "",
        role: "user",
        status: "active",
        mustChangePassword: true,
      });
      postStatus("success", "New user account created.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not create the user.");
    }
  }

  async function saveManagedUser(userId: string) {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    const draft = userDrafts[userId];
    if (!draft) {
      return;
    }

    try {
      const response = await api.updateUser(userId, {
        loginIdentity: draft.loginIdentity.trim(),
        email: draft.email.trim(),
        displayName: draft.displayName.trim(),
        role: draft.role,
        status: draft.status,
      });
      applyServerResponse(response, { preserveView: true });
      postStatus("success", "User profile updated.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not update the user.");
    }
  }

  async function resetManagedUserPassword(userId: string) {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    const draft = userDrafts[userId];
    if (!draft?.resetPassword) {
      postStatus("warning", "Enter a temporary password before resetting.");
      return;
    }

    try {
      const response = await api.resetUserPassword(userId, draft.resetPassword, draft.mustChangePassword);
      applyServerResponse(response, { preserveView: true });
      setUserDrafts((current) => ({
        ...current,
        [userId]: {
          ...(current[userId] || draft),
          resetPassword: "",
        },
      }));
      postStatus("success", "User password reset on the server.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not reset the user password.");
    }
  }

  async function issueManagedUserRecovery(userId: string) {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    try {
      const response = await api.issueRecoveryToken(userId);
      setGeneratedRecovery(response.recovery);
      postStatus("success", "Recovery token generated. Share it securely with the user.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not generate a recovery token.");
    }
  }

  async function selectWorkspace(workspaceId: string) {
    if (!currentUser || workspaceId === appState.selectedWorkspaceId) {
      return;
    }

    try {
      const response = await api.selectWorkspace(workspaceId);
      applyServerResponse(response, { preserveView: true });
      postStatus("info", `Workspace switched to ${response.state.workspaceName}.`);
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not switch workspace.");
    }
  }

  async function submitCreateWorkspace() {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }
    if (!workspaceNameDraft.trim()) {
      postStatus("warning", "Enter a workspace name first.");
      return;
    }

    try {
      const response = await api.createWorkspace(workspaceNameDraft.trim());
      applyServerResponse(response, { preserveView: true });
      setWorkspaceNameDraft("");
      postStatus("success", `Workspace ${response.state.workspaceName} created.`);
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not create the workspace.");
    }
  }

  async function applyTiming() {
    if (!selectedTitle || !selectedPhrase || !canEdit) {
      return;
    }

    const nextStart = clamp(Number.parseFloat(timingDraft.start) || 0, 0, selectedTitle.duration - 0.1);
    const nextEnd = clamp(Number.parseFloat(timingDraft.end) || 0, nextStart + 0.1, selectedTitle.duration);
    updateTitle(selectedTitle.id, (title) => ({
      ...title,
      phrases: title.phrases.map((phrase) =>
        phrase.id === selectedPhrase.id
          ? { ...phrase, start: nextStart, end: nextEnd, reviewed: true }
          : phrase,
      ),
      draft: { ...title.draft, isDirty: true },
    }));
    await saveTitle("manual", selectedTitle.id, "Manual timing applied to the selected phrase.");
  }

  async function resetTiming() {
    if (!selectedTitle || !selectedPhrase || !canEdit) {
      return;
    }

    const savedPhrase = selectedTitle.savedSnapshot.find((phrase) => phrase.id === selectedPhrase.id);
    if (!savedPhrase) {
      postStatus("warning", "No saved server snapshot exists for this segment yet.");
      return;
    }

    updateTitle(selectedTitle.id, (title) => ({
      ...title,
      phrases: title.phrases.map((phrase) => (phrase.id === selectedPhrase.id ? { ...savedPhrase } : phrase)),
      draft: { ...title.draft, isDirty: true },
    }));
    await saveTitle("manual", selectedTitle.id, "Segment reset to the latest server-saved draft.");
  }

  async function toggleFlag(field: "enabled" | "reviewed", phraseId: string) {
    if (!selectedTitle || !canEdit) {
      return;
    }

    updateTitle(selectedTitle.id, (title) => ({
      ...title,
      phrases: title.phrases.map((phrase) =>
        phrase.id === phraseId ? { ...phrase, [field]: !phrase[field] } : phrase,
      ),
      draft: { ...title.draft, isDirty: true },
    }));
    await saveTitle("manual", selectedTitle.id, `${field === "enabled" ? "Include in export" : "Reviewed"} updated.`);
  }

  async function addSentence() {
    if (!selectedTitle || !canEdit) {
      return;
    }

    await commitText({ persist: false });

    const currentState = appStateRef.current;
    const currentTitle = currentState.titles.find((title) => title.id === selectedTitle.id);
    const currentPhraseId = currentState.selectedPhraseIds[0] ?? null;
    const currentPhrase = currentTitle?.phrases.find((phrase) => phrase.id === currentPhraseId) ?? null;
    if (!currentTitle) {
      return;
    }

    const currentIndex = currentPhrase
      ? currentTitle.phrases.findIndex((phrase) => phrase.id === currentPhrase.id)
      : currentTitle.phrases.length - 1;
    const nextPhrase = currentTitle.phrases[currentIndex + 1];
    const start = currentPhrase ? currentPhrase.end : 0;
    const provisionalEnd = nextPhrase ? nextPhrase.start : Math.min(currentTitle.duration, start + 2.4);
    const newPhrase: Phrase = {
      id: makeId("phrase"),
      start: Number(start.toFixed(2)),
      end: Number(clamp(Math.max(start + 0.8, provisionalEnd), start + 0.8, currentTitle.duration).toFixed(2)),
      text: "<Sentence>",
      enabled: true,
      reviewed: false,
    };

    updateTitle(currentTitle.id, (title) => {
      const phrases = [...title.phrases];
      phrases.splice(currentIndex + 1, 0, newPhrase);
      return { ...title, phrases, draft: { ...title.draft, isDirty: true } };
    });
    updateState((current) => ({ ...current, selectedPhraseIds: [newPhrase.id] }));
    await saveTitle("manual", currentTitle.id, "Added a new sentence and selected it for editing.");
  }

  async function splitAtCursor() {
    if (!selectedTitle || !selectedPhrase || !canEdit || !textareaRef.current) {
      return;
    }

    await commitText({ persist: false });

    const currentState = appStateRef.current;
    const currentTitle = currentState.titles.find((title) => title.id === selectedTitle.id);
    const currentPhrase = currentTitle?.phrases.find((phrase) => phrase.id === selectedPhrase.id);
    if (!currentTitle || !currentPhrase) {
      return;
    }

    const splitIndex = textareaRef.current.selectionStart;
    if (splitIndex <= 0 || splitIndex >= textDraftRef.current.length) {
      postStatus("warning", "Place the text cursor inside the phrase before splitting.");
      return;
    }

    const leftText = textDraftRef.current.slice(0, splitIndex).trim();
    const rightText = textDraftRef.current.slice(splitIndex).trim();
    if (!leftText || !rightText) {
      postStatus("warning", "Split needs text on both sides of the cursor.");
      return;
    }

    const midpoint = Number(((currentPhrase.start + currentPhrase.end) / 2).toFixed(2));
    const leftPhrase: Phrase = { ...currentPhrase, text: leftText, end: midpoint, reviewed: true };
    const rightPhrase: Phrase = {
      ...currentPhrase,
      id: makeId("phrase"),
      text: rightText,
      start: midpoint,
      reviewed: true,
    };

    updateTitle(currentTitle.id, (title) => ({
      ...title,
      phrases: title.phrases.flatMap((phrase) =>
        phrase.id === currentPhrase.id ? [leftPhrase, rightPhrase] : [phrase],
      ),
      draft: { ...title.draft, isDirty: true },
    }));
    updateState((current) => ({ ...current, selectedPhraseIds: [leftPhrase.id, rightPhrase.id] }));
    await saveTitle("manual", currentTitle.id, "Split the selected phrase at the current text cursor.");
  }

  async function combineSelected() {
    if (!selectedTitle || !canEdit || appStateRef.current.selectedPhraseIds.length < 2) {
      postStatus("warning", "Select at least two adjacent phrases to combine.");
      return;
    }

    await commitText({ persist: false });

    const currentState = appStateRef.current;
    const currentTitle = currentState.titles.find((title) => title.id === selectedTitle.id);
    if (!currentTitle) {
      return;
    }

    const selectedEntries = currentTitle.phrases
      .map((phrase, index) => ({ phrase, index }))
      .filter(({ phrase }) => currentState.selectedPhraseIds.includes(phrase.id));

    const contiguous = selectedEntries.every((entry, index, list) => index === 0 || entry.index === list[index - 1].index + 1);
    if (!contiguous) {
      postStatus("error", "Only adjacent phrases can be combined.");
      return;
    }

    const merged: Phrase = {
      id: makeId("phrase"),
      start: selectedEntries[0].phrase.start,
      end: selectedEntries[selectedEntries.length - 1].phrase.end,
      text: selectedEntries.map(({ phrase }) => phrase.text.trim()).join(" "),
      enabled: selectedEntries.every(({ phrase }) => phrase.enabled),
      reviewed: true,
    };
    const targetIds = new Set(selectedEntries.map(({ phrase }) => phrase.id));

    updateTitle(currentTitle.id, (title) => {
      const phrases: Phrase[] = [];
      title.phrases.forEach((phrase) => {
        if (!targetIds.has(phrase.id)) {
          phrases.push(phrase);
          return;
        }
        if (phrase.id === selectedEntries[0].phrase.id) {
          phrases.push(merged);
        }
      });
      return { ...title, phrases, draft: { ...title.draft, isDirty: true } };
    });
    updateState((current) => ({ ...current, selectedPhraseIds: [merged.id] }));
    await saveTitle("manual", currentTitle.id, "Combined the selected adjacent phrases.");
  }

  async function checkout(titleId: string) {
    if (!currentUser) {
      return;
    }

    try {
      const response = await api.checkout(titleId);
      const title = response.state.titles.find((entry) => entry.id === titleId);
      applyServerResponse({
        ...response,
        state: {
          ...response.state,
          currentView: "editor",
          selectedTitleId: titleId,
          selectedPhraseIds: title?.phrases[0] ? [title.phrases[0].id] : [],
        },
      });
      postStatus("success", `${title?.title ?? "Title"} is now checked out to you.`);
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Checkout failed.");
    }
  }

  async function sync(titleId: string) {
    if (!currentUser) {
      return;
    }

    await commitText({ persist: false });
    await saveTitle("sync", titleId);
  }

  async function checkIn(titleId: string) {
    if (!currentUser) {
      return;
    }

    const target = appState.titles.find((title) => title.id === titleId);
    if (!target || target.checkedOutByUserId !== currentUser.id) {
      postStatus("error", "Only the current checkout owner can check in this title.");
      return;
    }

    await commitText({ persist: false });
    await saveTitle("checkin", titleId);
    postStatus("success", `${target.title} is checked in and available to the library.`);
  }

  async function forceCheckIn(titleId: string) {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    const target = appState.titles.find((title) => title.id === titleId);
    if (!target || !target.checkedOutByUserId) {
      postStatus("warning", "This title is not actively checked out.");
      return;
    }

    try {
      const response = await api.forceCheckIn(titleId);
      applyServerResponse(response, { preserveView: true });
      postStatus("warning", `${target.title} was force checked in by admin.`);
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Force check-in failed.");
    }
  }

  async function takeOver(titleId: string) {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    const target = appState.titles.find((title) => title.id === titleId);
    if (!target) {
      return;
    }

    try {
      const response = await api.takeOver(titleId);
      const nextTitle = response.state.titles.find((entry) => entry.id === titleId);
      applyServerResponse({
        ...response,
        state: {
          ...response.state,
          currentView: "editor",
          selectedTitleId: titleId,
          selectedPhraseIds: nextTitle?.phrases[0] ? [nextTitle.phrases[0].id] : [],
        },
      });
      postStatus("warning", `${target.title} is now checked out to ${currentUser.displayName}.`);
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Take over failed.");
    }
  }

  async function submitYouTubeImport() {
    if (!currentUser) {
      return;
    }

    const urls = parseYouTubeEntries(appState.youtubeUrl);
    if (urls.length === 0) {
      postStatus("warning", "Enter a YouTube URL before starting the import.");
      return;
    }

    try {
      const response = await api.queueYouTubeImport(urls, appState.importLanguage);
      setJobs((current) => [...response.jobs, ...current].slice(0, 30));
      updateState((current) => ({ ...current, currentView: "shared", youtubeUrl: "" }));
      postStatus("info", `${response.jobs.length} YouTube import${response.jobs.length === 1 ? "" : "s"} queued on the server.`);
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not queue the YouTube import.");
    }
  }

  function createImportedTitle(sourceType: TitleRecord["sourceType"]) {
    if (sourceType === "package") {
      asrImportInputRef.current?.click();
      return;
    }

    updateState((current) => ({ ...current, currentView: "shared" }));
    postStatus("info", "Choose a media file and optional subtitle file in the upload form.");
  }

  async function submitMediaImport() {
    if (!mediaFile && !mediaProbeToken) {
      postStatus("warning", "Select a media file before uploading.");
      return;
    }

    const formData = new FormData();
    if (mediaProbeToken) {
      formData.append("probeToken", mediaProbeToken);
    } else if (mediaFile) {
      formData.append("media", mediaFile);
    }
    if (subtitleFile) {
      formData.append("subtitle", subtitleFile);
    }
    if (!subtitleFile && selectedSubtitleStreamIndex !== "") {
      formData.append("subtitleStreamIndex", selectedSubtitleStreamIndex);
    }
    formData.append("title", mediaTitle.trim() || mediaFile?.name.replace(/\.[^.]+$/, "") || "Uploaded Media");
    formData.append("source", mediaSource.trim() || "Uploaded Media");
    formData.append("language", mediaLanguage);

    try {
      const response = await api.queueMediaImport(formData);
      setJobs((current) => [response.job, ...current].slice(0, 30));
      setMediaFile(null);
      setSubtitleFile(null);
      setMediaTitle("");
      setMediaSource("");
      setMediaLanguage(appState.importLanguage);
      setMediaProbeToken("");
      setMediaProbeInFlight(false);
      setMediaSubtitleStreams([]);
      setSelectedSubtitleStreamIndex("");
      postStatus("info", "Media import queued on the server.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Media import failed to queue.");
    }
  }

  async function handleAsrImportChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append("archive", file);

    try {
      const response = await api.queueAsrImport(formData);
      setJobs((current) => [response.job, ...current].slice(0, 30));
      updateState((current) => ({ ...current, currentView: "shared" }));
      postStatus("info", ".asr archive queued for import on the server.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : ".asr import failed to queue.");
    } finally {
      event.target.value = "";
    }
  }

  async function deleteTitle(titleId: string) {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    const target = appState.titles.find((title) => title.id === titleId);
    if (!target) {
      return;
    }

    try {
      const response = await api.deleteTitle(titleId);
      applyServerResponse(response, { preserveView: true });
      postStatus("warning", `${target.title} was deleted from the library.`);
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Delete failed.");
    }
  }

  function handleExport(kind: "current" | "all" | "pack" | "import") {
    if (!currentUser) {
      return;
    }
    if (kind === "import") {
      asrImportInputRef.current?.click();
      return;
    }

    if (kind === "all") {
      window.location.href = "/api/export/all";
      postStatus("success", "Preparing export bundle from the server.");
      return;
    }

    if (!selectedTitle) {
      postStatus("warning", "Select a title before exporting.");
      return;
    }

    window.location.href = `/api/titles/${selectedTitle.id}/export.asr`;
    postStatus(
      "success",
      kind === "current"
        ? "Preparing the current title export on the server."
        : "Packing the current title into a compatible .asr archive.",
    );
  }

  async function probeLanguages() {
    const urls = parseYouTubeEntries(appState.youtubeUrl);
    if (urls.length === 0) {
      postStatus("warning", "Enter a YouTube URL before probing for languages.");
      return;
    }

    try {
      const response = await api.probeLanguages(urls[0]);
      postStatus(
        "info",
        response.languages.length > 0
          ? `Available subtitle languages for the first URL: ${response.languages.join(", ")}.`
          : "No subtitle languages were reported for that YouTube title.",
      );
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Language probe failed.");
    }
  }

  function reloadLibrary() {
    void refreshState(true);
  }

  function updateStorage(field: keyof PersistedState["storage"], value: string | boolean) {
    updateState((current) => ({
      ...current,
      storage: { ...current.storage, [field]: value },
    }));
  }

  async function saveStorageConfig() {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    try {
      const response = await api.saveStorage(
        appState.storage,
        storageAccessKeyId.trim() ? storageAccessKeyId.trim() : undefined,
        storageSecretAccessKey.trim() ? storageSecretAccessKey.trim() : undefined,
      );
      updateState((current) => ({ ...current, storage: response.storage }));
      setStorageAccessKeyId("");
      setStorageSecretAccessKey("");
      postStatus("success", "Storage configuration saved on the server.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not save storage settings.");
    }
  }

  async function testStorage() {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }

    try {
      const response = await api.testStorage();
      updateState((current) => ({ ...current, storage: response.storage }));
      postStatus("success", "Storage connection test passed from the server-side configuration.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Storage connection test failed.");
    }
  }

  const selectedTitleState = selectedTitle ? getTitleStateLabel(selectedTitle) : "No title";
  const headerSuffix = selectedTitle ? getTitleHeaderSuffix(selectedTitle) : "";
  const waveformWidth = 760;
  const waveformHeight = 160;
  const regionStart =
    selectedPhrase && selectedTitle ? ((selectedPhrase.start - visibleStart) / viewRange) * waveformWidth : 0;
  const regionEnd =
    selectedPhrase && selectedTitle ? ((selectedPhrase.end - visibleStart) / viewRange) * waveformWidth : 0;
  const playheadX =
    playheadTime !== null && selectedTitle && playheadTime >= visibleStart && playheadTime <= visibleEnd
      ? ((playheadTime - visibleStart) / viewRange) * waveformWidth
      : null;
  const waveformImageScale = selectedTitle ? Math.max(1, selectedTitle.duration / viewRange) : 1;
  const waveformImageWidth = waveformWidth * waveformImageScale;
  const waveformImageX =
    selectedTitle && selectedTitle.duration > 0 ? -((visibleStart / selectedTitle.duration) * waveformImageWidth) : 0;
  const waveformClipId = "editor-waveform-clip";
  const waveWindowSliderMin = selectedTitle ? getWaveMinVisibleRange(selectedTitle.duration) : MIN_WAVE_WINDOW_SECONDS;
  const waveWindowSliderMax = selectedTitle
    ? Math.min(MAX_WAVE_WINDOW_SECONDS, Math.max(waveWindowSliderMin, selectedTitle.duration))
    : MAX_WAVE_WINDOW_SECONDS;

  if (loadingState) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="eyebrow">yt-asr Web GUI</div>
          <h1>Connecting to the hosted workspace.</h1>
          <p className="lede">Checking the server session, title library, and background job queue.</p>
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="eyebrow">yt-asr Web GUI</div>
          <h1>Sign in to resume your checked-out title.</h1>
          <p className="lede">
            Sign in with a server-managed account. Sessions, drafts, imports, and checkout rules are all enforced on the
            hosted backend now.
          </p>

          <div className="login-actions">
            <label className="field">
              <span>Login identity or email</span>
              <input value={loginIdentifier} onChange={(event) => setLoginIdentifier(event.target.value)} />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void login();
                  }
                }}
              />
            </label>
            <button className="primary-button" onClick={() => void login()} type="button" disabled={authInFlight}>
              {authInFlight ? "Signing In..." : "Sign In"}
            </button>
          </div>
          <p className="helper-text">
            First-use bootstrap login: <code>admin</code> / <code>password</code>. That account is forced to change its
            password on first sign-in.
          </p>
          <section className="card form-card login-recovery-card">
            <div className="card-header">
              <div>
                <span className="eyebrow">Account Recovery</span>
                <h3>Redeem Recovery Token</h3>
              </div>
            </div>
            <div className="settings-form">
              <label className="field">
                <span>Recovery token</span>
                <input
                  value={recoveryForm.token}
                  onChange={(event) => setRecoveryForm((current) => ({ ...current, token: event.target.value }))}
                />
              </label>
              <label className="field">
                <span>New password</span>
                <input
                  type="password"
                  value={recoveryForm.nextPassword}
                  onChange={(event) => setRecoveryForm((current) => ({ ...current, nextPassword: event.target.value }))}
                />
              </label>
              <label className="field">
                <span>Confirm new password</span>
                <input
                  type="password"
                  value={recoveryForm.confirmPassword}
                  onChange={(event) => setRecoveryForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                />
              </label>
            </div>
            <div className="button-row">
              <button className="toolbar-button primary" onClick={() => void redeemRecovery()} type="button" disabled={authInFlight}>
                Reset With Token
              </button>
            </div>
            <p className="helper-text">An admin can generate a one-time recovery token from User Maintenance if you lose your password.</p>
          </section>
        </section>

        <section className="spec-panel">
          <div className="spec-card">
            <span className="eyebrow">MVP Focus</span>
            <h2>Desktop workflow, translated to the browser.</h2>
            <ul>
              <li>Responsive left-center-right editor with waveform, phrase list, and persistent status feedback.</li>
              <li>Shared library actions for check out, sync, check in, force check in, and admin take over.</li>
              <li>Admin-only storage settings aligned to server-managed S3-compatible providers.</li>
            </ul>
          </div>
          <div className="spec-card ghost">
            <span className="eyebrow">Working Drafts</span>
            <h2>Draft state persists across refresh and logout on the server.</h2>
            <p>
              Logging out ends the browser session only. The active checkout and latest persisted draft remain available so
              the next sign-in can reopen the title immediately.
            </p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="background-orb background-orb-left" />
      <div className="background-orb background-orb-right" />

      <header className="topbar">
        <div className="brand-block topbar-main">
          <div className="eyebrow">yt-asr Browser Workspace</div>
          <strong>{selectedWorkspace?.name || appState.workspaceName || "Workspace"}</strong>
        </div>

        <div className="toolbar-grid topbar-actions">
          <div className="view-switch">
            <button
              className={`toolbar-button ${appState.currentView === "editor" ? "selected-view" : ""}`}
              onClick={() => switchView("editor")}
              type="button"
              disabled={passwordChangeRequired}
            >
              Editor
            </button>
            <button
              className={`toolbar-button ${appState.currentView === "shared" ? "selected-view" : ""}`}
              onClick={() => switchView("shared")}
              type="button"
              disabled={passwordChangeRequired}
            >
              Cloud / Library
            </button>
          </div>
          <button className="toolbar-button" onClick={reloadLibrary} type="button">
            Reload
          </button>
          <button
            className="toolbar-button primary"
            onClick={() => selectedTitle && void saveTitle("manual", selectedTitle.id)}
            type="button"
            disabled={!selectedTitle || !editable || saveInFlight}
          >
            Save
          </button>
        </div>

        <div ref={topMenuRef} className="topbar-menu-shell">
          <button
            className={`toolbar-button ${topMenuOpen ? "selected-view" : ""}`}
            onClick={() => setTopMenuOpen((current) => !current)}
            type="button"
          >
            Menu
          </button>
          {topMenuOpen ? (
            <div className="topbar-menu">
              <div className="user-chip user-chip-inline">
                <span>{currentUser.displayName}</span>
                <small>
                  {currentUser.role} <span className="separator">/</span> {selectedWorkspace?.name || "Workspace"}
                </small>
              </div>
              <button
                className={`toolbar-button ${appState.currentView === "settings" ? "selected-view" : ""}`}
                onClick={() => switchView("settings")}
                type="button"
              >
                {currentUser.role === "admin" ? "Account / Admin" : "Account"}
              </button>
              <label className="field compact">
                <span>Workspace</span>
                <select
                  value={appState.selectedWorkspaceId}
                  onChange={(event) => void selectWorkspace(event.target.value)}
                  disabled={passwordChangeRequired || appState.workspaces.length === 0}
                >
                  {appState.workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field compact">
                <span>Language</span>
                <select
                  value={appState.importLanguage}
                  onChange={(event) => updateState((current) => ({ ...current, importLanguage: event.target.value }))}
                >
                  {LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {language}
                    </option>
                  ))}
                </select>
              </label>
              <div className="topbar-menu-group">
                <button className="toolbar-button primary" onClick={() => switchView("shared")} type="button" disabled={passwordChangeRequired}>
                  Imports
                </button>
                <button
                  className="toolbar-button"
                  onClick={() => {
                    setTopMenuOpen(false);
                    createImportedTitle("local");
                  }}
                  type="button"
                  disabled={passwordChangeRequired}
                >
                  Import Media
                </button>
              </div>
              <div className="topbar-menu-group">
                <button
                  className="toolbar-button"
                  onClick={() => {
                    setTopMenuOpen(false);
                    handleExport("current");
                  }}
                  type="button"
                  disabled={!selectedTitle || passwordChangeRequired}
                >
                  Export Current
                </button>
                <button
                  className="toolbar-button"
                  onClick={() => {
                    setTopMenuOpen(false);
                    handleExport("all");
                  }}
                  type="button"
                  disabled={passwordChangeRequired}
                >
                  Export All
                </button>
                <button
                  className="toolbar-button"
                  onClick={() => {
                    setTopMenuOpen(false);
                    handleExport("pack");
                  }}
                  type="button"
                  disabled={passwordChangeRequired}
                >
                  Pack .asr
                </button>
                <button
                  className="toolbar-button"
                  onClick={() => {
                    setTopMenuOpen(false);
                    handleExport("import");
                  }}
                  type="button"
                  disabled={passwordChangeRequired}
                >
                  Import .asr
                </button>
              </div>
              <button
                className="toolbar-button"
                onClick={() => {
                  setTopMenuOpen(false);
                  void logout();
                }}
                type="button"
              >
                Logout
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <input ref={asrImportInputRef} type="file" accept=".asr,.zip" hidden onChange={handleAsrImportChange} />

      {appState.currentView === "editor" && selectedTitle ? (
        <section className={`workspace-grid ${libraryCollapsed ? "library-collapsed" : ""}`}>
          {libraryCollapsed ? (
            <aside className="library-rail" aria-label="Collapsed titles panel">
              <div className="library-rail-line" />
              <button
                className="library-rail-toggle"
                onClick={() => setLibraryCollapsed(false)}
                type="button"
                aria-label="Show titles panel"
                title="Show titles panel"
              >
                {">"}
              </button>
            </aside>
          ) : (
            <aside className="panel library-panel">
              <div className="panel-header">
                <div>
                  <span className="eyebrow">Library</span>
                  <h2>Titles</h2>
                </div>
                <div className="action-cluster">
                  <span className="pill">{libraryTitles.length} items</span>
                  <button className="toolbar-button" onClick={() => setLibraryCollapsed(true)} type="button">
                    Hide
                  </button>
                </div>
              </div>

              <div className="title-list">
                {libraryTitles.map((title) => (
                  <button
                    key={title.id}
                    className={`title-card ${title.id === selectedTitle.id ? "active" : ""} ${
                      title.checkedOutByUserId && title.checkedOutByUserId !== currentUser.id ? "locked" : ""
                    }`}
                    onClick={() => void selectTitle(title.id)}
                    type="button"
                  >
                    <div className="title-card-top">
                      <strong>{title.title}</strong>
                      <span className={`status-dot ${title.id === selectedTitle.id ? "live" : ""}`} />
                    </div>
                    <span>{title.source}</span>
                    <div className="title-meta">
                      <span>{getTitleStateLabel(title)}</span>
                      <span>{title.phrases.length} phrases</span>
                    </div>
                    </button>
                  ))}
              </div>
            </aside>
          )}

          <section className="panel editor-panel">
            <div className="panel-header editor-header">
              <div>
                <span className="eyebrow">Current Title</span>
                <h2>{selectedTitle.title}</h2>
                <p>
                  {selectedTitle.source} <span className="separator">/</span> {headerSuffix}
                </p>
              </div>
              <div className="draft-summary">
                <span className={`pill ${canEdit ? "accent" : ""}`}>{selectedTitleState}</span>
                <span className="draft-meta">Draft v{selectedTitle.draft.version}</span>
                <span className="draft-meta">Last sync {formatTimestamp(selectedTitle.draft.lastSyncAt)}</span>
              </div>
            </div>

            <div className="editor-stack">
              <section className="card">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">Caption Editor</span>
                    <h3>Caption Text {canEdit ? "(editable)" : "(read-only)"}</h3>
                  </div>
                  <button className="toolbar-button" onClick={() => void commitText()} type="button" disabled={!canEdit}>
                    Commit Text
                  </button>
                </div>
                <textarea
                  ref={textareaRef}
                  className="caption-editor"
                  value={textDraft}
                  readOnly={!canEdit}
                  onBlur={() => void commitText()}
                  onChange={(event) => {
                    setTextDraft(event.target.value);
                    textDraftRef.current = event.target.value;
                    setTextDraftDirty(true);
                    textDraftDirtyRef.current = true;
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                      event.preventDefault();
                      void commitText();
                    }
                  }}
                />
                <p className="helper-text">Blur or press Ctrl+Enter to commit the selected phrase text and mark it reviewed.</p>
              </section>

              <section className="card waveform-card">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">Waveform</span>
                    <h3>Phrase Timing Editor</h3>
                  </div>
                  <label className="field compact waveform-zoom-field">
                    <span>Visible time {viewRange.toFixed(1)}s</span>
                    <input
                      type="range"
                      min={waveWindowSliderMin}
                      max={waveWindowSliderMax}
                      step="0.5"
                      value={viewRange}
                      onChange={(event) => updateWaveWindow(Number(event.target.value))}
                    />
                  </label>
                </div>

                <svg
                  ref={waveformRef}
                  className="waveform"
                  viewBox={`0 0 ${waveformWidth} ${waveformHeight}`}
                  onPointerDown={(event) => startPan(event.pointerId, event.clientX)}
                  role="img"
                  aria-label="Waveform editor"
                >
                  <defs>
                    <linearGradient id="wave-gradient" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#8ad6ff" />
                      <stop offset="100%" stopColor="#ffb86f" />
                    </linearGradient>
                    <clipPath id={waveformClipId}>
                      <rect x="0" y="0" width={waveformWidth} height={waveformHeight} rx="18" ry="18" />
                    </clipPath>
                  </defs>
                  <rect x="0" y="0" width={waveformWidth} height={waveformHeight} rx="18" className="waveform-base" />
                  {selectedTitle.waveformUrl ? (
                    <g clipPath={`url(#${waveformClipId})`}>
                      <image
                        href={selectedTitle.waveformUrl}
                        x={waveformImageX}
                        y="0"
                        width={waveformImageWidth}
                        height={waveformHeight}
                        preserveAspectRatio="none"
                        className="waveform-image"
                      />
                    </g>
                  ) : (
                    <>
                      <line x1="0" x2={waveformWidth} y1={waveformHeight / 2} y2={waveformHeight / 2} className="waveform-empty-line" />
                      <text x={waveformWidth / 2} y={waveformHeight / 2 + 6} textAnchor="middle" className="waveform-empty-label">
                        No waveform artifact is available for this title yet.
                      </text>
                    </>
                  )}
                  {selectedPhrase ? (
                    <>
                      <rect
                        x={clamp(regionStart, 0, waveformWidth)}
                        y={18}
                        width={Math.max(16, regionEnd - regionStart)}
                        height={waveformHeight - 36}
                        rx="14"
                        className="region-fill"
                      />
                      <line
                        x1={clamp(regionStart, 0, waveformWidth)}
                        x2={clamp(regionStart, 0, waveformWidth)}
                        y1={16}
                        y2={waveformHeight - 16}
                        className={`region-marker ${canEdit ? "draggable" : ""}`}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          startMarkerDrag("start", event.pointerId);
                        }}
                      />
                      <line
                        x1={clamp(regionEnd, 0, waveformWidth)}
                        x2={clamp(regionEnd, 0, waveformWidth)}
                        y1={16}
                        y2={waveformHeight - 16}
                        className={`region-marker ${canEdit ? "draggable" : ""}`}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          startMarkerDrag("end", event.pointerId);
                        }}
                      />
                    </>
                  ) : null}
                  {playheadX !== null ? (
                    <line x1={playheadX} x2={playheadX} y1={12} y2={waveformHeight - 12} className="playhead-marker" />
                  ) : null}
                </svg>

                <div className="waveform-footer">
                  <span>Visible range: {formatTime(visibleStart)} to {formatTime(visibleEnd)}</span>
                  <span>Drag the background to pan, drag markers to retime, and use the slider to choose a 1 to 45 second window.</span>
                </div>
              </section>

              <div className="editor-controls">
                <section className="card control-card">
                  <div className="card-header">
                    <div>
                      <span className="eyebrow">Playback</span>
                      <h3>Review Controls</h3>
                    </div>
                  </div>
                  <div className="button-row">
                    <button className="toolbar-button" onClick={() => play("playing")} type="button">
                      Play
                    </button>
                    <button className="toolbar-button" onClick={() => play("paused")} type="button">
                      Pause
                    </button>
                    <button className="toolbar-button" onClick={() => play("stopped")} type="button">
                      Stop
                    </button>
                    <button
                      className={`toolbar-button ${loopPlayback ? "selected-view" : ""}`}
                      onClick={() => setLoopPlayback((current) => !current)}
                      type="button"
                    >
                      Loop
                    </button>
                  </div>
                  <label className="field">
                    <span>Playback speed {playbackSpeed.toFixed(2)}x</span>
                    <input
                      type="range"
                      min="0.5"
                      max="1.5"
                      step="0.05"
                      value={playbackSpeed}
                      onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
                    />
                  </label>
                  <div className="status-inline">Playback status: {playbackState}</div>
                </section>

                <section className="card control-card">
                  <div className="card-header">
                    <div>
                      <span className="eyebrow">Timing</span>
                      <h3>Start / End</h3>
                    </div>
                  </div>
                  <div className="timing-grid">
                    <label className="field">
                      <span>Start</span>
                      <input
                        value={timingDraft.start}
                        onChange={(event) => setTimingDraft((current) => ({ ...current, start: event.target.value }))}
                        readOnly={!canEdit}
                      />
                    </label>
                    <label className="field">
                      <span>End</span>
                      <input
                        value={timingDraft.end}
                        onChange={(event) => setTimingDraft((current) => ({ ...current, end: event.target.value }))}
                        readOnly={!canEdit}
                      />
                    </label>
                  </div>
                  <div className="button-row">
                    <button className="toolbar-button primary" onClick={() => void applyTiming()} type="button" disabled={!canEdit}>
                      Apply
                    </button>
                    <button className="toolbar-button" onClick={() => void resetTiming()} type="button" disabled={!canEdit}>
                      Reset Segment
                    </button>
                  </div>
                </section>

                <section className="card control-card">
                  <div className="card-header">
                    <div>
                      <span className="eyebrow">Flags</span>
                      <h3>Phrase Status</h3>
                    </div>
                  </div>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={selectedPhrase?.enabled ?? false}
                      disabled={!canEdit || !selectedPhrase}
                      onChange={() => selectedPhrase && void toggleFlag("enabled", selectedPhrase.id)}
                    />
                    <span>Include in export</span>
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={selectedPhrase?.reviewed ?? false}
                      disabled={!canEdit || !selectedPhrase}
                      onChange={() => selectedPhrase && void toggleFlag("reviewed", selectedPhrase.id)}
                    />
                    <span>Reviewed</span>
                  </label>
                </section>

                <section className="card control-card">
                  <div className="card-header">
                    <div>
                      <span className="eyebrow">Edit Tools</span>
                      <h3>Sentence Actions</h3>
                    </div>
                  </div>
                  <div className="button-row stack">
                    <button className="toolbar-button" onClick={() => void addSentence()} type="button" disabled={!canEdit}>
                      Add Sentence
                    </button>
                    <button className="toolbar-button" onClick={() => void splitAtCursor()} type="button" disabled={!canEdit}>
                      Split at Cursor
                    </button>
                    <button className="toolbar-button" onClick={() => void combineSelected()} type="button" disabled={!canEdit}>
                      Combine Selected
                    </button>
                  </div>
                </section>
              </div>
            </div>
          </section>

          <aside className="panel phrase-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Phrase List</span>
                <h2>Sentences</h2>
              </div>
              <span className="pill">{selectedTitle.phrases.length} rows</span>
            </div>

            <div className="phrase-table">
              <div className="phrase-head">
                <span>Sentence</span>
                <span>Start</span>
                <span>End</span>
                <span>Use</span>
                <span>Reviewed</span>
              </div>
              {selectedTitle.phrases.map((phrase) => {
                const selected = appState.selectedPhraseIds.includes(phrase.id);
                const rowClass = phrase.enabled
                  ? phrase.reviewed
                    ? "reviewed"
                    : "normal"
                  : phrase.reviewed
                    ? "disabled-reviewed"
                    : "disabled";
                return (
                  <button
                    key={phrase.id}
                    className={`phrase-row ${rowClass} ${selected ? "selected" : ""}`}
                    onClick={(event) => void selectPhrase(phrase.id, event.metaKey || event.ctrlKey)}
                    type="button"
                  >
                    <span>{phrase.text}</span>
                    <span>{phrase.start.toFixed(2)}</span>
                    <span>{phrase.end.toFixed(2)}</span>
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={phrase.enabled}
                        disabled={!canEdit}
                        onChange={(event) => {
                          event.stopPropagation();
                          void toggleFlag("enabled", phrase.id);
                        }}
                      />
                    </label>
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={phrase.reviewed}
                        disabled={!canEdit}
                        onChange={(event) => {
                          event.stopPropagation();
                          void toggleFlag("reviewed", phrase.id);
                        }}
                      />
                    </label>
                  </button>
                );
              })}
            </div>
          </aside>
        </section>
      ) : null}
      {appState.currentView === "shared" ? (
        <section className="view-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Shared Library</span>
              <h2>Cloud Collaboration</h2>
            </div>
            <div className="button-row">
              <button className="toolbar-button" onClick={reloadLibrary} type="button">
                Refresh
              </button>
              <button className="toolbar-button primary" onClick={() => createImportedTitle("local")} type="button">
                Upload New Title
              </button>
            </div>
          </div>

          <section className="card form-card">
            <div className="card-header">
              <div>
                <span className="eyebrow">Import YouTube</span>
                <h3>Queue One or More URLs</h3>
              </div>
              <div className="button-row">
                <button className="toolbar-button" onClick={() => void probeLanguages()} type="button">
                  Probe First URL
                </button>
                <button className="toolbar-button primary" onClick={() => void submitYouTubeImport()} type="button">
                  Queue Import
                </button>
              </div>
            </div>
            <div className="settings-form single-column">
              <label className="field">
                <span>YouTube URLs</span>
                <textarea
                  className="caption-editor import-textarea"
                  value={appState.youtubeUrl}
                  onChange={(event) => updateState((current) => ({ ...current, youtubeUrl: event.target.value }))}
                  placeholder="Paste one or more YouTube URLs, separated by new lines, commas, or spaces."
                />
              </label>
              <div className="helper-text">Queued URLs: {parseYouTubeEntries(appState.youtubeUrl).length}</div>
            </div>
          </section>

          <section className="card form-card">
            <div className="card-header">
              <div>
                <span className="eyebrow">Import Media</span>
                <h3>Upload Local Media or Subtitle Pair</h3>
              </div>
              <button className="toolbar-button primary" onClick={() => void submitMediaImport()} type="button">
                Queue Upload
              </button>
            </div>
            <div className="settings-form">
              <label className="field">
                <span>Title</span>
                <input value={mediaTitle} onChange={(event) => setMediaTitle(event.target.value)} placeholder="Imported Media Title" />
              </label>
              <label className="field">
                <span>Source / Channel</span>
                <input value={mediaSource} onChange={(event) => setMediaSource(event.target.value)} placeholder="Uploaded Media" />
              </label>
              <label className="field">
                <span>Language</span>
                <select value={mediaLanguage} onChange={(event) => setMediaLanguage(event.target.value)}>
                  {LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {language}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Media File</span>
                <input
                  type="file"
                  accept="audio/*,video/*"
                  onChange={(event) => {
                    setMediaFile(event.target.files?.[0] ?? null);
                    setMediaProbeToken("");
                    setMediaSubtitleStreams([]);
                    setSelectedSubtitleStreamIndex("");
                  }}
                />
              </label>
              <label className="field">
                <span>Embedded Subtitle Track</span>
                <select
                  value={selectedSubtitleStreamIndex}
                  disabled={mediaProbeInFlight || mediaSubtitleStreams.length === 0 || Boolean(subtitleFile)}
                  onChange={(event) => setSelectedSubtitleStreamIndex(event.target.value)}
                >
                  <option value="">No embedded subtitle track</option>
                  {mediaSubtitleStreams.map((stream) => (
                    <option key={stream.index} value={String(stream.index)}>
                      {stream.language} / {stream.title} / {stream.codecName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Subtitle File (optional)</span>
                <input
                  type="file"
                  accept=".srt,.vtt,.json,.json3,.srv3"
                  onChange={(event) => {
                    setSubtitleFile(event.target.files?.[0] ?? null);
                    if (event.target.files?.[0]) {
                      setSelectedSubtitleStreamIndex("");
                    }
                  }}
                />
              </label>
            </div>
            <div className="helper-text">
              {mediaProbeInFlight
                ? "Inspecting the uploaded media for embedded subtitle tracks..."
                : mediaSubtitleStreams.length > 0
                  ? `${mediaSubtitleStreams.length} embedded subtitle track${mediaSubtitleStreams.length === 1 ? "" : "s"} found.`
                  : mediaFile
                    ? "No embedded subtitle tracks were detected, or the probe has not completed yet."
                    : "Choose a media file to detect embedded subtitle tracks automatically."}
            </div>
          </section>

          <section className="card form-card">
            <div className="card-header">
              <div>
                <span className="eyebrow">Cloud List</span>
                <h3>Titles on Cloud</h3>
              </div>
              <span className="pill">{filteredCloudTitles.length} title{filteredCloudTitles.length === 1 ? "" : "s"}</span>
            </div>
            <div className="cloud-list-toolbar">
              <label className="field">
                <span>Filter Cloud Titles</span>
                <input
                  value={cloudListFilter}
                  onChange={(event) => setCloudListFilter(event.target.value)}
                  placeholder="Search by title, source, or video ID"
                />
              </label>
              <div className="helper-text">
                {selectedTitle ? `Selected title: ${selectedTitle.title || selectedTitle.videoId}` : "Select a title to focus it in the cloud table."}
              </div>
            </div>
            {filteredCloudTitles.length === 0 ? (
              <p className="helper-text">No cloud titles match the current filter.</p>
            ) : (
              <div className="title-list cloud-list-grid">
                {filteredCloudTitles.map((title) => {
                  const checkoutOwner = title.checkedOutByUserId
                    ? appState.users.find((user) => user.id === title.checkedOutByUserId)?.displayName ?? "Unknown user"
                    : null;

                  return (
                    <button
                      className={`title-card ${selectedTitle?.id === title.id ? "active" : ""} ${
                        title.checkedOutByUserId && title.checkedOutByUserId !== currentUser.id ? "locked" : ""
                      }`}
                      key={title.id}
                      onClick={() => void focusSharedTitle(title.id)}
                      type="button"
                    >
                      <div className="title-card-top">
                        <strong>{title.title || title.videoId}</strong>
                        <span className={`pill ${title.checkedOutByUserId ? "accent" : ""}`}>{getTitleStateLabel(title)}</span>
                      </div>
                      <span>{title.source}</span>
                      <div className="title-meta">
                        <span>{title.videoId}</span>
                        <span>{title.sizeLabel}</span>
                      </div>
                      <div className="title-meta">
                        <span>Uploaded {formatTimestamp(title.uploadedAt)}</span>
                        <span>{checkoutOwner ? `Checked out by ${checkoutOwner}` : "Available for checkout"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <div className="shared-table">
            <div className="shared-head">
              <span>Title / Video ID</span>
              <span>Size</span>
              <span>Uploaded</span>
              <span>Status</span>
              <span>Actions</span>
            </div>
            {libraryTitles.map((title) => (
              <div className={`shared-row ${selectedTitle?.id === title.id ? "active" : ""}`} key={title.id}>
                <div>
                  <strong>{title.title || title.videoId}</strong>
                  <span>{title.source}</span>
                  <span>{title.videoId}</span>
                </div>
                <span>{title.sizeLabel}</span>
                <span>{formatTimestamp(title.uploadedAt)}</span>
                <span>{getTitleStateLabel(title)}</span>
                <div className="action-cluster">
                  <button
                    className="toolbar-button"
                    onClick={() => void checkout(title.id)}
                    type="button"
                    disabled={!canCheckoutTitle(title)}
                  >
                    {title.checkedOutByUserId === currentUser?.id ? "Checked Out" : "Check Out"}
                  </button>
                  <button className="toolbar-button" onClick={() => void sync(title.id)} type="button" disabled={!canSyncTitle(title)}>
                    Sync Checked Out
                  </button>
                  <button className="toolbar-button" onClick={() => void checkIn(title.id)} type="button" disabled={!canCheckInTitle(title)}>
                    Check In
                  </button>
                  {currentUser.role === "admin" ? (
                    <>
                      <button
                        className="toolbar-button"
                        onClick={() => void forceCheckIn(title.id)}
                        type="button"
                        disabled={!canForceCheckInTitle(title)}
                      >
                        Admin Force Check In
                      </button>
                      <button
                        className="toolbar-button"
                        onClick={() => void takeOver(title.id)}
                        type="button"
                        disabled={!canTakeOverTitle(title)}
                      >
                        Admin Take Over
                      </button>
                      <button className="toolbar-button danger" onClick={() => void deleteTitle(title.id)} type="button">
                        Delete from Cloud
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div className="audit-grid">
            <section className="card">
              <div className="card-header">
                <div>
                  <span className="eyebrow">Background Jobs</span>
                  <h3>Import Queue</h3>
                </div>
              </div>
              <div className="audit-list">
                {jobs.length === 0 ? <p className="helper-text">No queued or recent jobs yet.</p> : null}
                {jobs.map((job) => (
                  <article className="audit-item" key={job.id}>
                    <div className="audit-top">
                      <strong>{job.type.replaceAll("_", " ")}</strong>
                      <span>{job.progress}%</span>
                    </div>
                    <span>{job.status}</span>
                    <p>{job.error || job.message || "Waiting for server worker."}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <div>
                  <span className="eyebrow">Audit Trail</span>
                  <h3>Recent Events</h3>
                </div>
              </div>
              <div className="audit-list">
                {appState.audit.map((record) => (
                  <article className="audit-item" key={record.id}>
                    <div className="audit-top">
                      <strong>{record.eventType.replaceAll("_", " ")}</strong>
                      <span>{formatTimestamp(record.timestamp)}</span>
                    </div>
                    <span>{record.titleName}</span>
                    <p>
                      {record.actorDisplayName}: {record.details}
                    </p>
                  </article>
                ))}
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <div>
                  <span className="eyebrow">Checkout Rules</span>
                  <h3>Server-Enforced Model</h3>
                </div>
              </div>
              <ul className="rule-list">
                <li>One title can be checked out by only one user at a time.</li>
                <li>One user can have only one active checked-out title at a time.</li>
                <li>Logout ends the browser session only and does not release the checkout.</li>
                <li>Sync persists the working draft without checking the title back in.</li>
              </ul>
            </section>
          </div>
        </section>
      ) : null}
      {appState.currentView === "settings" ? (
        <section className="view-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">{currentUser.role === "admin" ? "Admin Settings" : "Account Settings"}</span>
              <h2>{currentUser.role === "admin" ? "Accounts and Storage" : "Account"}</h2>
            </div>
          </div>

          <div className="settings-grid">
            <section className="card form-card">
              <div className="card-header">
                <div>
                  <span className="eyebrow">Your Account</span>
                  <h3>Password and Session Settings</h3>
                </div>
              </div>
              <div className="settings-form">
                <label className="field">
                  <span>Login identity</span>
                  <input value={currentUser.loginIdentity} readOnly />
                </label>
                <label className="field">
                  <span>Display name</span>
                  <input value={currentUser.displayName} readOnly />
                </label>
                <label className="field">
                  <span>Email</span>
                  <input value={currentUser.email} readOnly />
                </label>
                <label className="field">
                  <span>Current password</span>
                  <input
                    type="password"
                    value={passwordForm.currentPassword}
                    onChange={(event) => setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>New password</span>
                  <input
                    type="password"
                    value={passwordForm.nextPassword}
                    onChange={(event) => setPasswordForm((current) => ({ ...current, nextPassword: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>Confirm new password</span>
                  <input
                    type="password"
                    value={passwordForm.confirmPassword}
                    onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                  />
                </label>
              </div>
              {currentUser.mustChangePassword ? (
                <div className="settings-note warning-note">
                  This account is marked to change its password before continuing normal work.
                </div>
              ) : null}
              <div className="button-row">
                <button className="toolbar-button primary" onClick={() => void submitPasswordChange()} type="button">
                  Change Password
                </button>
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <div>
                  <span className="eyebrow">Security</span>
                  <h3>Server-Only Secrets</h3>
                </div>
              </div>
              <ul className="rule-list">
                <li>Disabled accounts can no longer restore sessions from old cookies.</li>
                <li>Users never see access key IDs or secret keys in the browser UI.</li>
                <li>The browser talks only to the application API, not directly to object storage.</li>
                <li>Important editor commits now save to the server draft immediately.</li>
              </ul>
              <div className="settings-note">Last sign-in: {formatTimestamp(currentUser.lastLoginAt)}</div>
            </section>

            {currentUser.role === "admin" ? (
              <section className="card form-card span-two">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">Workspaces</span>
                    <h3>Project Scope</h3>
                  </div>
                  <button className="toolbar-button primary" onClick={() => void submitCreateWorkspace()} type="button">
                    Create Workspace
                  </button>
                </div>
                <div className="settings-form">
                  <label className="field">
                    <span>New workspace name</span>
                    <input
                      value={workspaceNameDraft}
                      onChange={(event) => setWorkspaceNameDraft(event.target.value)}
                      placeholder="Client Review Queue"
                    />
                  </label>
                  <label className="field">
                    <span>Current workspace</span>
                    <input value={selectedWorkspace?.name || appState.workspaceName} readOnly />
                  </label>
                </div>
                <div className="title-list cloud-list-grid">
                  {appState.workspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      className={`title-card ${appState.selectedWorkspaceId === workspace.id ? "active" : ""}`}
                      onClick={() => void selectWorkspace(workspace.id)}
                      type="button"
                    >
                      <div className="title-card-top">
                        <strong>{workspace.name}</strong>
                        <span className="pill">{workspace.slug}</span>
                      </div>
                      <div className="title-meta">
                        <span>Created {formatTimestamp(workspace.createdAt)}</span>
                        <span>{appState.selectedWorkspaceId === workspace.id ? "Active workspace" : "Switch workspace"}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {currentUser.role === "admin" ? (
              <section className="card form-card">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">Create User</span>
                    <h3>Add a New Account</h3>
                  </div>
                  <button className="toolbar-button primary" onClick={() => void submitCreateUser()} type="button">
                    Create User
                  </button>
                </div>

                <div className="settings-form">
                  <label className="field">
                    <span>Login identity</span>
                    <input
                      value={createUserForm.loginIdentity}
                      onChange={(event) => setCreateUserForm((current) => ({ ...current, loginIdentity: event.target.value }))}
                      placeholder="admin, maya, jordan"
                    />
                  </label>
                  <label className="field">
                    <span>Email</span>
                    <input
                      value={createUserForm.email}
                      onChange={(event) => setCreateUserForm((current) => ({ ...current, email: event.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span>Display name</span>
                    <input
                      value={createUserForm.displayName}
                      onChange={(event) => setCreateUserForm((current) => ({ ...current, displayName: event.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span>Temporary password</span>
                    <input
                      type="password"
                      value={createUserForm.password}
                      onChange={(event) => setCreateUserForm((current) => ({ ...current, password: event.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span>Role</span>
                    <select
                      value={createUserForm.role}
                      onChange={(event) => setCreateUserForm((current) => ({ ...current, role: event.target.value as Role }))}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Status</span>
                    <select
                      value={createUserForm.status}
                      onChange={(event) => setCreateUserForm((current) => ({ ...current, status: event.target.value as UserStatus }))}
                    >
                      <option value="active">Active</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={createUserForm.mustChangePassword}
                      onChange={(event) => setCreateUserForm((current) => ({ ...current, mustChangePassword: event.target.checked }))}
                    />
                    <span>Require password change at first sign-in</span>
                  </label>
                </div>
              </section>
            ) : null}

            {currentUser.role === "admin" ? (
              <section className="card form-card span-two">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">User Maintenance</span>
                    <h3>Select a User to Edit</h3>
                  </div>
                </div>

                <div className="user-maintenance-layout">
                  <div className="user-selector-list">
                    {appState.users.map((user) => (
                      <button
                        key={user.id}
                        className={`title-card user-selector ${selectedManagedUser?.id === user.id ? "active" : ""}`}
                        onClick={() => setSelectedManagedUserId(user.id)}
                        type="button"
                      >
                        <div className="title-card-top">
                          <strong>{user.displayName}</strong>
                          <span className="pill">{user.role}</span>
                        </div>
                        <span>{user.loginIdentity}</span>
                        <div className="title-meta">
                          <span>{user.email}</span>
                          <span>{user.status}</span>
                          <span>{user.mustChangePassword ? "Password reset pending" : "Password active"}</span>
                        </div>
                      </button>
                    ))}
                  </div>

                  {selectedManagedUser && selectedManagedUserDraft ? (
                    <article className="audit-item user-editor-panel">
                      <div className="audit-top">
                        <strong>{selectedManagedUser.displayName}</strong>
                        <span>{selectedManagedUser.loginIdentity}</span>
                      </div>
                      <div className="settings-form">
                        <label className="field">
                          <span>Login identity</span>
                          <input
                            value={selectedManagedUserDraft.loginIdentity}
                            onChange={(event) =>
                              updateUserDraft(selectedManagedUser.id, (current) => ({
                                ...current,
                                loginIdentity: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Email</span>
                          <input
                            value={selectedManagedUserDraft.email}
                            onChange={(event) =>
                              updateUserDraft(selectedManagedUser.id, (current) => ({
                                ...current,
                                email: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Display name</span>
                          <input
                            value={selectedManagedUserDraft.displayName}
                            onChange={(event) =>
                              updateUserDraft(selectedManagedUser.id, (current) => ({
                                ...current,
                                displayName: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Role</span>
                          <select
                            value={selectedManagedUserDraft.role}
                            onChange={(event) =>
                              updateUserDraft(selectedManagedUser.id, (current) => ({
                                ...current,
                                role: event.target.value as Role,
                              }))
                            }
                          >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                          </select>
                        </label>
                        <label className="field">
                          <span>Status</span>
                          <select
                            value={selectedManagedUserDraft.status}
                            onChange={(event) =>
                              updateUserDraft(selectedManagedUser.id, (current) => ({
                                ...current,
                                status: event.target.value as UserStatus,
                              }))
                            }
                          >
                            <option value="active">Active</option>
                            <option value="disabled">Disabled</option>
                          </select>
                        </label>
                        <label className="field">
                          <span>Reset password</span>
                          <input
                            type="password"
                            value={selectedManagedUserDraft.resetPassword}
                            onChange={(event) =>
                              updateUserDraft(selectedManagedUser.id, (current) => ({
                                ...current,
                                resetPassword: event.target.value,
                              }))
                            }
                            placeholder="Leave blank to keep current password"
                          />
                        </label>
                        <label className="check-field">
                          <input
                            type="checkbox"
                            checked={selectedManagedUserDraft.mustChangePassword}
                            onChange={(event) =>
                              updateUserDraft(selectedManagedUser.id, (current) => ({
                                ...current,
                                mustChangePassword: event.target.checked,
                              }))
                            }
                          />
                          <span>Require password change after reset</span>
                        </label>
                      </div>
                      <div className="button-row">
                        <button className="toolbar-button" onClick={() => void saveManagedUser(selectedManagedUser.id)} type="button">
                          Save User
                        </button>
                        <button
                          className="toolbar-button primary"
                          onClick={() => void resetManagedUserPassword(selectedManagedUser.id)}
                          type="button"
                        >
                          Reset Password
                        </button>
                        <button className="toolbar-button" onClick={() => void issueManagedUserRecovery(selectedManagedUser.id)} type="button">
                          Issue Recovery Token
                        </button>
                      </div>
                      {generatedRecovery?.userId === selectedManagedUser.id ? (
                        <div className="settings-note">
                          Recovery token expires {formatTimestamp(generatedRecovery.expiresAt)}.
                          {generatedRecovery.resetUrl ? ` Link: ${generatedRecovery.resetUrl}` : ` Token: ${generatedRecovery.token}`}
                        </div>
                      ) : null}
                      <div className="settings-note">
                        Last sign-in {formatTimestamp(selectedManagedUser.lastLoginAt)} / created{" "}
                        {formatTimestamp(selectedManagedUser.createdAt)} / updated{" "}
                        {formatTimestamp(selectedManagedUser.updatedAt)}
                      </div>
                    </article>
                  ) : null}
                </div>
              </section>
            ) : null}

            {currentUser.role === "admin" ? (
              <section className="card form-card span-two">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">Provider</span>
                    <h3>S3-Compatible Preset</h3>
                  </div>
                  <div className="button-row">
                    <button className="toolbar-button" onClick={() => void saveStorageConfig()} type="button">
                      Save Settings
                    </button>
                    <button className="toolbar-button primary" onClick={() => void testStorage()} type="button">
                      Test Connection
                    </button>
                  </div>
                </div>
                <div className="settings-form">
                  <label className="field">
                    <span>Provider preset</span>
                    <select
                      value={appState.storage.provider}
                      onChange={(event) => updateStorage("provider", event.target.value as StorageProvider)}
                    >
                      {["Local Disk", "Backblaze B2", "Amazon S3", "Cloudflare R2", "MinIO"].map((provider) => (
                        <option key={provider} value={provider}>
                          {provider}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Bucket</span>
                    <input value={appState.storage.bucket} onChange={(event) => updateStorage("bucket", event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Prefix</span>
                    <input value={appState.storage.prefix} onChange={(event) => updateStorage("prefix", event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Endpoint URL</span>
                    <input
                      value={appState.storage.endpointUrl}
                      onChange={(event) => updateStorage("endpointUrl", event.target.value)}
                      placeholder="s3.us-east-005.backblazeb2.com"
                    />
                  </label>
                  <label className="field">
                    <span>Region</span>
                    <input value={appState.storage.region} onChange={(event) => updateStorage("region", event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Addressing mode</span>
                    <select
                      value={appState.storage.addressingMode}
                      onChange={(event) => updateStorage("addressingMode", event.target.value)}
                    >
                      <option value="path">Path</option>
                      <option value="virtual-hosted">Virtual hosted</option>
                    </select>
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={appState.storage.auditVisible}
                      onChange={(event) => updateStorage("auditVisible", event.target.checked)}
                    />
                    <span>Audit visibility enabled</span>
                  </label>
                  <label className="field">
                    <span>Access key ID</span>
                    <input
                      value={storageAccessKeyId}
                      onChange={(event) => setStorageAccessKeyId(event.target.value)}
                      placeholder="Leave blank to keep current server secret"
                    />
                  </label>
                  <label className="field">
                    <span>Secret access key</span>
                    <input
                      type="password"
                      value={storageSecretAccessKey}
                      onChange={(event) => setStorageSecretAccessKey(event.target.value)}
                      placeholder="Leave blank to keep current server secret"
                    />
                  </label>
                </div>
                <div className="settings-note">
                  Bare hostnames are accepted here. For example, `s3.us-east-005.backblazeb2.com` will be normalized to
                  HTTPS automatically.
                </div>
                <div className="settings-note">Last connection test: {formatTimestamp(appState.storage.lastConnectionTestAt)}</div>
              </section>
            ) : null}
          </div>
        </section>
      ) : null}

      <footer className={`status-bar tone-${status.tone}`}>
        <span>{status.text}</span>
        <span>
          {selectedTitle ? `Draft v${selectedTitle.draft.version}` : "No title"} {saveInFlight ? "/ saving..." : ""}
        </span>
      </footer>
    </main>
  );
}
