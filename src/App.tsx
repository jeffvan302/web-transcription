import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type {
  AppStateResponse,
  JobRecord,
  PersistedState,
  Phrase,
  SaveKind,
  StatusTone,
  StorageProvider,
  TitleRecord,
  View,
} from "./types";

const LANGUAGES = ["en", "es", "fr", "de", "pt-BR"];
const WORKSPACES = ["Shared Workspace", "Review Queue", "Archive Preview"];
const DEV_ACCOUNTS = [
  { email: "maya@yt-asr.local", password: "maya1234", label: "Maya Editor" },
  { email: "jordan@yt-asr.local", password: "jordan1234", label: "Jordan Reviewer" },
  { email: "theo@yt-asr.local", password: "admin1234", label: "Theo Admin" },
];

type PlaybackState = "stopped" | "playing" | "paused";
type DragState =
  | { kind: "start" | "end"; pointerId: number }
  | { kind: "pan"; pointerId: number; startX: number; initialPan: number }
  | null;

interface StatusMessage {
  tone: StatusTone;
  text: string;
}

const EMPTY_STATE: PersistedState = {
  sessionUserId: null,
  selectedTitleId: "",
  selectedPhraseIds: [],
  currentView: "editor",
  youtubeUrl: "",
  importLanguage: "en",
  workspaceName: WORKSPACES[0],
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

function createWavePoints(width: number, height: number) {
  const points: string[] = [];

  for (let step = 0; step <= 120; step += 1) {
    const x = (step / 120) * width;
    const amplitude =
      (Math.sin(step * 0.31) * 0.34 +
        Math.sin(step * 0.13 + 1.5) * 0.22 +
        Math.cos(step * 0.61 + 0.9) * 0.18) *
      height;
    const y = height / 2 + amplitude;
    points.push(`${x},${y}`);
  }

  return points.join(" ");
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
  const [loginEmail, setLoginEmail] = useState(DEV_ACCOUNTS[2].email);
  const [loginPassword, setLoginPassword] = useState(DEV_ACCOUNTS[2].password);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("stopped");
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [playheadTime, setPlayheadTime] = useState<number | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [textDraftDirty, setTextDraftDirty] = useState(false);
  const [waveZoom, setWaveZoom] = useState(1.6);
  const [wavePan, setWavePan] = useState(0);
  const [dragState, setDragState] = useState<DragState>(null);
  const [timingDraft, setTimingDraft] = useState({ start: "0.00", end: "0.00" });
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [mediaTitle, setMediaTitle] = useState("");
  const [mediaSource, setMediaSource] = useState("");
  const [mediaLanguage, setMediaLanguage] = useState("en");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [storageAccessKeyId, setStorageAccessKeyId] = useState("");
  const [storageSecretAccessKey, setStorageSecretAccessKey] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const waveformRef = useRef<SVGSVGElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const asrImportInputRef = useRef<HTMLInputElement | null>(null);
  const seenTerminalJobsRef = useRef<Set<string>>(new Set());

  const currentUser = appState.users.find((user) => user.id === appState.sessionUserId) ?? null;
  const selectedTitle =
    appState.titles.find((title) => title.id === appState.selectedTitleId) ?? appState.titles[0] ?? null;
  const selectedPhrase =
    selectedTitle?.phrases.find((phrase) => appState.selectedPhraseIds.includes(phrase.id)) ??
    selectedTitle?.phrases[0] ??
    null;
  const editable = Boolean(currentUser && selectedTitle?.checkedOutByUserId === currentUser.id);
  const viewRange = selectedTitle ? selectedTitle.duration / waveZoom : 10;
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

  useEffect(() => {
    void hydrateSession();
  }, []);

  useEffect(() => {
    if (!selectedPhrase) {
      setTextDraft("");
      setTimingDraft({ start: "0.00", end: "0.00" });
      return;
    }

    setTextDraft(selectedPhrase.text);
    setTextDraftDirty(false);
    setTimingDraft({
      start: selectedPhrase.start.toFixed(2),
      end: selectedPhrase.end.toFixed(2),
    });
  }, [selectedPhrase?.id, selectedPhrase?.text, selectedPhrase?.start, selectedPhrase?.end]);

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
      const currentTitle = appState.titles.find((title) => title.id === selectedTitle.id);
      if (!currentTitle?.draft.isDirty || saveInFlight || textDraftDirty) {
        return;
      }

      void saveTitle("autosave", selectedTitle.id);
    }, 4500);

    return () => window.clearInterval(interval);
  }, [appState.titles, editable, saveInFlight, selectedTitle?.id, textDraftDirty]);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;

    const handlePause = () => {
      setPlaybackState((current) => (current === "stopped" ? current : "paused"));
    };
    const handleEnded = () => {
      setPlaybackState("stopped");
      setPlayheadTime(selectedPhrase?.end ?? null);
    };

    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.pause();
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audioRef.current = null;
    };
  }, [selectedPhrase?.end]);

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

    if (selectedTitle?.audioUrl) {
      audio.src = selectedTitle.audioUrl;
      audio.load();
      setPlayheadTime(selectedPhrase?.start ?? 0);
    } else {
      audio.pause();
      audio.removeAttribute("src");
      setPlayheadTime(null);
    }
    setPlaybackState("stopped");
  }, [selectedTitle?.id, selectedTitle?.audioUrl, selectedPhrase?.start]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !selectedPhrase) {
      return;
    }

    const handleTimeUpdate = () => {
      const current = audio.currentTime;
      setPlayheadTime(current);
      if (current >= selectedPhrase.end) {
        if (loopPlayback) {
          audio.currentTime = selectedPhrase.start;
          void audio.play().catch(() => undefined);
        } else {
          audio.pause();
          setPlaybackState("stopped");
          setPlayheadTime(selectedPhrase.end);
        }
      }
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [loopPlayback, selectedPhrase?.end, selectedPhrase?.start, selectedPhrase?.id]);

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
              applyServerResponse(stateResponse);
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
    setAppState((current) => updater(current));
  }

  function updateTitle(titleId: string, updater: (title: TitleRecord) => TitleRecord) {
    updateState((current) => ({
      ...current,
      titles: current.titles.map((title) => (title.id === titleId ? updater(title) : title)),
    }));
  }

  function markDirty(titleId: string) {
    updateTitle(titleId, (title) => ({
      ...title,
      draft: { ...title.draft, isDirty: true },
    }));
  }

  function applyServerResponse(response: AppStateResponse) {
    setAppState(response.state);
    setJobs(response.jobs);
    setLoadingState(false);
  }

  function resetToLoggedOutState(message: string) {
    setAppState(EMPTY_STATE);
    setJobs([]);
    setLoadingState(false);
    setPlaybackState("stopped");
    setPlayheadTime(null);
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
      applyServerResponse(response);
      if (showStatus) {
        postStatus("info", "Library metadata refreshed from the server.");
      }
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not refresh the library.");
    }
  }

  function buildTitlePayload(titleId: string) {
    const title = appState.titles.find((entry) => entry.id === titleId);
    if (!title) {
      return null;
    }

    if (!selectedTitle || selectedTitle.id !== titleId || !selectedPhrase || !textDraftDirty) {
      return title;
    }

    const nextText = textDraft.trim() || "<Sentence>";
    return {
      ...title,
      phrases: title.phrases.map((phrase) =>
        phrase.id === selectedPhrase.id ? { ...phrase, text: nextText, reviewed: true } : phrase,
      ),
    };
  }

  async function saveTitle(kind: SaveKind, titleId: string) {
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
      applyServerResponse(response);
      setTextDraftDirty(false);
      postStatus(
        "success",
        kind === "autosave"
          ? "Autosave complete. Draft is persisted on the server."
          : kind === "sync"
            ? "Sync complete. Working draft stayed checked out."
            : kind === "checkin"
              ? "Final save complete. Title checked in."
              : "Save complete. Latest phrase edits are in the working draft.",
      );
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaveInFlight(false);
    }
  }

  function markSelectedPhraseReviewed(message: string) {
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
    postStatus("success", message);
  }

  function commitText() {
    if (!selectedTitle || !selectedPhrase || !editable) {
      return;
    }

    const nextText = textDraft.trim() || "<Sentence>";
    if (!textDraftDirty && nextText === selectedPhrase.text) {
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
    setTextDraftDirty(false);
    postStatus("success", "Caption text committed and marked reviewed.");
  }

  function selectTitle(titleId: string) {
    commitText();
    const nextTitle = appState.titles.find((title) => title.id === titleId);
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

  function selectPhrase(phraseId: string, multi: boolean) {
    commitText();
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

  async function login() {
    if (!loginEmail.trim() || !loginPassword.trim()) {
      postStatus("warning", "Enter an email and password to sign in.");
      return;
    }

    setAuthInFlight(true);
    try {
      const response = await api.login(loginEmail.trim(), loginPassword);
      applyServerResponse(response);
      postStatus("success", `Signed in as ${response.state.users.find((user) => user.id === response.state.sessionUserId)?.displayName ?? "user"}.`);
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Sign in failed.");
    } finally {
      setAuthInFlight(false);
    }
  }

  async function logout() {
    if (!currentUser) {
      return;
    }

    commitText();
    try {
      await api.logout();
    } catch {
      // Clear the local shell even if the server session is already gone.
    }
    resetToLoggedOutState("Session ended. Any active checkout stayed on the server.");
  }

  function play(action: PlaybackState) {
    const audio = audioRef.current;
    if (!selectedPhrase || !audio || !selectedTitle?.audioUrl) {
      postStatus("warning", "This title does not have playable working audio yet.");
      return;
    }

    if (action === "playing") {
      if (audio.currentTime < selectedPhrase.start || audio.currentTime > selectedPhrase.end) {
        audio.currentTime = selectedPhrase.start;
      }
      audio.playbackRate = playbackSpeed;
      void audio.play().catch(() => undefined);
      setPlayheadTime(audio.currentTime || selectedPhrase.start);
      postStatus("info", `Playback ${playbackSpeed.toFixed(2)}x on the selected phrase.`);
    }
    if (action === "paused") {
      audio.pause();
    }
    if (action === "stopped") {
      audio.pause();
      audio.currentTime = selectedPhrase.start;
      setPlayheadTime(selectedPhrase.start);
    }
    setPlaybackState(action);
  }

  function startPan(pointerId: number, clientX: number) {
    if (!selectedTitle) {
      return;
    }
    setDragState({ kind: "pan", pointerId, startX: clientX, initialPan: wavePan });
  }

  function startMarkerDrag(kind: "start" | "end", pointerId: number) {
    if (!editable) {
      return;
    }
    setDragState({ kind, pointerId });
  }

  function applyTiming() {
    if (!selectedTitle || !selectedPhrase || !editable) {
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
    postStatus("success", "Manual timing applied to the selected phrase.");
  }

  function resetTiming() {
    if (!selectedTitle || !selectedPhrase || !editable) {
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
    postStatus("warning", "Segment reset to the latest server-saved draft.");
  }

  function toggleFlag(field: "enabled" | "reviewed", phraseId: string) {
    if (!selectedTitle || !editable) {
      return;
    }

    updateTitle(selectedTitle.id, (title) => ({
      ...title,
      phrases: title.phrases.map((phrase) =>
        phrase.id === phraseId ? { ...phrase, [field]: !phrase[field] } : phrase,
      ),
      draft: { ...title.draft, isDirty: true },
    }));
    postStatus("success", `${field === "enabled" ? "Include in export" : "Reviewed"} updated.`);
  }

  function addSentence() {
    if (!selectedTitle || !editable) {
      return;
    }

    const currentIndex = selectedPhrase
      ? selectedTitle.phrases.findIndex((phrase) => phrase.id === selectedPhrase.id)
      : selectedTitle.phrases.length - 1;
    const currentPhrase = selectedPhrase;
    const nextPhrase = selectedTitle.phrases[currentIndex + 1];
    const start = currentPhrase ? currentPhrase.end : 0;
    const provisionalEnd = nextPhrase ? nextPhrase.start : Math.min(selectedTitle.duration, start + 2.4);
    const newPhrase: Phrase = {
      id: makeId("phrase"),
      start: Number(start.toFixed(2)),
      end: Number(clamp(Math.max(start + 0.8, provisionalEnd), start + 0.8, selectedTitle.duration).toFixed(2)),
      text: "<Sentence>",
      enabled: true,
      reviewed: false,
    };

    updateTitle(selectedTitle.id, (title) => {
      const phrases = [...title.phrases];
      phrases.splice(currentIndex + 1, 0, newPhrase);
      return { ...title, phrases, draft: { ...title.draft, isDirty: true } };
    });
    updateState((current) => ({ ...current, selectedPhraseIds: [newPhrase.id] }));
    postStatus("success", "Added a new sentence and selected it for editing.");
  }

  function splitAtCursor() {
    if (!selectedTitle || !selectedPhrase || !editable || !textareaRef.current) {
      return;
    }

    const splitIndex = textareaRef.current.selectionStart;
    if (splitIndex <= 0 || splitIndex >= textDraft.length) {
      postStatus("warning", "Place the text cursor inside the phrase before splitting.");
      return;
    }

    const leftText = textDraft.slice(0, splitIndex).trim();
    const rightText = textDraft.slice(splitIndex).trim();
    if (!leftText || !rightText) {
      postStatus("warning", "Split needs text on both sides of the cursor.");
      return;
    }

    const midpoint = Number(((selectedPhrase.start + selectedPhrase.end) / 2).toFixed(2));
    const leftPhrase: Phrase = { ...selectedPhrase, text: leftText, end: midpoint, reviewed: true };
    const rightPhrase: Phrase = {
      ...selectedPhrase,
      id: makeId("phrase"),
      text: rightText,
      start: midpoint,
      reviewed: true,
    };

    updateTitle(selectedTitle.id, (title) => ({
      ...title,
      phrases: title.phrases.flatMap((phrase) =>
        phrase.id === selectedPhrase.id ? [leftPhrase, rightPhrase] : [phrase],
      ),
      draft: { ...title.draft, isDirty: true },
    }));
    updateState((current) => ({ ...current, selectedPhraseIds: [leftPhrase.id, rightPhrase.id] }));
    postStatus("success", "Split the selected phrase at the current text cursor.");
  }

  function combineSelected() {
    if (!selectedTitle || !editable || appState.selectedPhraseIds.length < 2) {
      postStatus("warning", "Select at least two adjacent phrases to combine.");
      return;
    }

    const selectedEntries = selectedTitle.phrases
      .map((phrase, index) => ({ phrase, index }))
      .filter(({ phrase }) => appState.selectedPhraseIds.includes(phrase.id));

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

    updateTitle(selectedTitle.id, (title) => {
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
    postStatus("success", "Combined the selected adjacent phrases.");
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

    commitText();
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

    commitText();
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
      applyServerResponse(response);
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

    if (!appState.youtubeUrl.trim()) {
      postStatus("warning", "Enter a YouTube URL before starting the import.");
      return;
    }

    try {
      const response = await api.queueYouTubeImport(appState.youtubeUrl.trim(), appState.importLanguage);
      setJobs((current) => [response.job, ...current].slice(0, 30));
      updateState((current) => ({ ...current, currentView: "shared" }));
      postStatus("info", "YouTube import queued on the server.");
    } catch (error) {
      postStatus("error", error instanceof Error ? error.message : "Could not queue the YouTube import.");
    }
  }

  function createImportedTitle(sourceType: TitleRecord["sourceType"]) {
    if (sourceType === "youtube") {
      void submitYouTubeImport();
      return;
    }

    if (sourceType === "package") {
      asrImportInputRef.current?.click();
      return;
    }

    updateState((current) => ({ ...current, currentView: "shared" }));
    postStatus("info", "Choose a media file and optional subtitle file in the upload form.");
  }

  async function submitMediaImport() {
    if (!mediaFile) {
      postStatus("warning", "Select a media file before uploading.");
      return;
    }

    const formData = new FormData();
    formData.append("media", mediaFile);
    if (subtitleFile) {
      formData.append("subtitle", subtitleFile);
    }
    formData.append("title", mediaTitle.trim() || mediaFile.name.replace(/\.[^.]+$/, ""));
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
      applyServerResponse(response);
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
    if (!appState.youtubeUrl.trim()) {
      postStatus("warning", "Enter a YouTube URL before probing for languages.");
      return;
    }

    try {
      const response = await api.probeLanguages(appState.youtubeUrl.trim());
      postStatus(
        "info",
        response.languages.length > 0
          ? `Available subtitle languages: ${response.languages.join(", ")}.`
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
  const wavePoints = createWavePoints(waveformWidth, waveformHeight);
  const regionStart =
    selectedPhrase && selectedTitle ? ((selectedPhrase.start - visibleStart) / viewRange) * waveformWidth : 0;
  const regionEnd =
    selectedPhrase && selectedTitle ? ((selectedPhrase.end - visibleStart) / viewRange) * waveformWidth : 0;
  const playheadX =
    playheadTime !== null && selectedTitle ? ((playheadTime - visibleStart) / viewRange) * waveformWidth : null;

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
            This app now signs into the real server workspace: authenticated sessions, durable drafts, background imports,
            and server-enforced checkout rules.
          </p>

          <div className="account-grid">
            {DEV_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                className={`account-card ${loginEmail === account.email ? "selected" : ""}`}
                onClick={() => {
                  setLoginEmail(account.email);
                  setLoginPassword(account.password);
                }}
                type="button"
              >
                <span className="account-role">Seeded Account</span>
                <strong>{account.label}</strong>
                <span>{account.email}</span>
                <span>Password: {account.password}</span>
              </button>
            ))}
          </div>

          <div className="login-actions">
            <label className="field">
              <span>Email</span>
              <input value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} />
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
        <div className="brand-block">
          <div className="eyebrow">yt-asr Browser Workspace</div>
          <strong>{appState.workspaceName}</strong>
        </div>

        <div className="toolbar-grid">
          <label className="field compact">
            <span>Workspace</span>
            <select
              value={appState.workspaceName}
              onChange={(event) => updateState((current) => ({ ...current, workspaceName: event.target.value }))}
            >
              {WORKSPACES.map((workspace) => (
                <option key={workspace} value={workspace}>
                  {workspace}
                </option>
              ))}
            </select>
          </label>
          <button className="toolbar-button" onClick={reloadLibrary} type="button">
            Reload
          </button>
          <button
            className="toolbar-button primary"
            onClick={() => selectedTitle && void saveTitle("manual", selectedTitle.id)}
            type="button"
            disabled={!selectedTitle}
          >
            Save
          </button>
          <button className="toolbar-button" onClick={() => handleExport("current")} type="button" disabled={!selectedTitle}>
            Export Current
          </button>
          <button className="toolbar-button" onClick={() => handleExport("all")} type="button">
            Export All
          </button>
          <button className="toolbar-button" onClick={() => handleExport("pack")} type="button">
            Pack .asr
          </button>
          <button className="toolbar-button" onClick={() => handleExport("import")} type="button">
            Import .asr
          </button>
          <div className="view-switch">
            {(["editor", "shared", "settings"] as View[]).map((view) => (
              <button
                key={view}
                className={`toolbar-button ${appState.currentView === view ? "selected-view" : ""}`}
                onClick={() => {
                  updateState((current) => ({ ...current, currentView: view }));
                  if (view === "shared") {
                    postStatus("info", "Shared library refreshed and ready for collaborative actions.");
                  }
                }}
                type="button"
                disabled={view === "settings" && currentUser.role !== "admin"}
              >
                {view === "editor" ? "Editor" : view === "shared" ? "Cloud / Library" : "Storage / Admin"}
              </button>
            ))}
          </div>
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
          <button className="toolbar-button" onClick={probeLanguages} type="button">
            Probe Languages
          </button>
          <label className="field url-field">
            <span>YouTube URL</span>
            <input
              value={appState.youtubeUrl}
              onChange={(event) => updateState((current) => ({ ...current, youtubeUrl: event.target.value }))}
              placeholder="https://www.youtube.com/watch?v=..."
            />
          </label>
          <button className="toolbar-button primary" onClick={() => createImportedTitle("youtube")} type="button">
            Download
          </button>
          <button className="toolbar-button" onClick={() => createImportedTitle("local")} type="button">
            Import Media
          </button>
        </div>

        <div className="user-chip">
          <span>{currentUser.displayName}</span>
          <small>{currentUser.role}</small>
          <button className="toolbar-button" onClick={() => void logout()} type="button">
            Logout
          </button>
        </div>
      </header>

      <input ref={asrImportInputRef} type="file" accept=".asr,.zip" hidden onChange={handleAsrImportChange} />

      {appState.currentView === "editor" && selectedTitle ? (
        <section className="workspace-grid">
          <aside className="panel library-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Library</span>
                <h2>Titles</h2>
              </div>
              <span className="pill">{libraryTitles.length} items</span>
            </div>

            <div className="title-list">
              {libraryTitles.map((title) => (
                <button
                  key={title.id}
                  className={`title-card ${title.id === selectedTitle.id ? "active" : ""} ${
                    title.checkedOutByUserId && title.checkedOutByUserId !== currentUser.id ? "locked" : ""
                  }`}
                  onClick={() => selectTitle(title.id)}
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
                <span className={`pill ${editable ? "accent" : ""}`}>{selectedTitleState}</span>
                <span className="draft-meta">Draft v{selectedTitle.draft.version}</span>
                <span className="draft-meta">Last sync {formatTimestamp(selectedTitle.draft.lastSyncAt)}</span>
              </div>
            </div>

            <div className="editor-stack">
              <section className="card">
                <div className="card-header">
                  <div>
                    <span className="eyebrow">Caption Editor</span>
                    <h3>Caption Text {editable ? "(editable)" : "(read-only)"}</h3>
                  </div>
                  <button className="toolbar-button" onClick={commitText} type="button" disabled={!editable}>
                    Commit Text
                  </button>
                </div>
                <textarea
                  ref={textareaRef}
                  className="caption-editor"
                  value={textDraft}
                  readOnly={!editable}
                  onBlur={commitText}
                  onChange={(event) => {
                    setTextDraft(event.target.value);
                    setTextDraftDirty(true);
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                      event.preventDefault();
                      commitText();
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
                  <div className="button-row">
                    <button className="toolbar-button" onClick={() => setWaveZoom((current) => clamp(current - 0.3, 1, 6))} type="button">
                      Zoom Out
                    </button>
                    <button className="toolbar-button" onClick={() => setWaveZoom((current) => clamp(current + 0.3, 1, 6))} type="button">
                      Zoom In
                    </button>
                  </div>
                </div>

                <svg
                  ref={waveformRef}
                  className="waveform"
                  viewBox={`0 0 ${waveformWidth} ${waveformHeight}`}
                  onPointerDown={(event) => startPan(event.pointerId, event.clientX)}
                  onWheel={(event) => {
                    event.preventDefault();
                    setWaveZoom((current) => clamp(current + (event.deltaY > 0 ? -0.18 : 0.18), 1, 6));
                  }}
                  role="img"
                  aria-label="Waveform editor"
                >
                  <defs>
                    <linearGradient id="wave-gradient" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#8ad6ff" />
                      <stop offset="100%" stopColor="#ffb86f" />
                    </linearGradient>
                  </defs>
                  {selectedTitle.waveformUrl ? (
                    <image
                      href={selectedTitle.waveformUrl}
                      x="0"
                      y="0"
                      width={waveformWidth}
                      height={waveformHeight}
                      preserveAspectRatio="none"
                      opacity="0.42"
                    />
                  ) : null}
                  <rect x="0" y="0" width={waveformWidth} height={waveformHeight} rx="18" />
                  <polyline points={wavePoints} fill="none" stroke="url(#wave-gradient)" strokeWidth="2.5" />
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
                        className={`region-marker ${editable ? "draggable" : ""}`}
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
                        className={`region-marker ${editable ? "draggable" : ""}`}
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
                  <span>Mouse wheel zoom, drag the background to pan, drag markers to retime.</span>
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
                        readOnly={!editable}
                      />
                    </label>
                    <label className="field">
                      <span>End</span>
                      <input
                        value={timingDraft.end}
                        onChange={(event) => setTimingDraft((current) => ({ ...current, end: event.target.value }))}
                        readOnly={!editable}
                      />
                    </label>
                  </div>
                  <div className="button-row">
                    <button className="toolbar-button primary" onClick={applyTiming} type="button" disabled={!editable}>
                      Apply
                    </button>
                    <button className="toolbar-button" onClick={resetTiming} type="button" disabled={!editable}>
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
                      disabled={!editable || !selectedPhrase}
                      onChange={() => selectedPhrase && toggleFlag("enabled", selectedPhrase.id)}
                    />
                    <span>Include in export</span>
                  </label>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={selectedPhrase?.reviewed ?? false}
                      disabled={!editable || !selectedPhrase}
                      onChange={() => selectedPhrase && toggleFlag("reviewed", selectedPhrase.id)}
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
                    <button className="toolbar-button" onClick={addSentence} type="button" disabled={!editable}>
                      Add Sentence
                    </button>
                    <button className="toolbar-button" onClick={splitAtCursor} type="button" disabled={!editable}>
                      Split at Cursor
                    </button>
                    <button className="toolbar-button" onClick={combineSelected} type="button" disabled={!editable}>
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
                    onClick={(event) => selectPhrase(phrase.id, event.metaKey || event.ctrlKey)}
                    type="button"
                  >
                    <span>{phrase.text}</span>
                    <span>{phrase.start.toFixed(2)}</span>
                    <span>{phrase.end.toFixed(2)}</span>
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={phrase.enabled}
                        disabled={!editable}
                        onChange={(event) => {
                          event.stopPropagation();
                          toggleFlag("enabled", phrase.id);
                        }}
                      />
                    </label>
                    <label className="mini-check">
                      <input
                        type="checkbox"
                        checked={phrase.reviewed}
                        disabled={!editable}
                        onChange={(event) => {
                          event.stopPropagation();
                          toggleFlag("reviewed", phrase.id);
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
                  onChange={(event) => setMediaFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <label className="field">
                <span>Subtitle File (optional)</span>
                <input
                  type="file"
                  accept=".srt,.vtt,.json,.json3,.srv3"
                  onChange={(event) => setSubtitleFile(event.target.files?.[0] ?? null)}
                />
              </label>
            </div>
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
              <div className="shared-row" key={title.id}>
                <div>
                  <strong>{title.title || title.videoId}</strong>
                  <span>{title.source}</span>
                  <span>{title.videoId}</span>
                </div>
                <span>{title.sizeLabel}</span>
                <span>{formatTimestamp(title.uploadedAt)}</span>
                <span>{getTitleStateLabel(title)}</span>
                <div className="action-cluster">
                  <button className="toolbar-button" onClick={() => checkout(title.id)} type="button">
                    Check Out
                  </button>
                  <button className="toolbar-button" onClick={() => void sync(title.id)} type="button">
                    Sync Checked Out
                  </button>
                  <button className="toolbar-button" onClick={() => void checkIn(title.id)} type="button">
                    Check In
                  </button>
                  {currentUser.role === "admin" ? (
                    <>
                      <button className="toolbar-button" onClick={() => forceCheckIn(title.id)} type="button">
                        Admin Force Check In
                      </button>
                      <button className="toolbar-button" onClick={() => takeOver(title.id)} type="button">
                        Admin Take Over
                      </button>
                      <button className="toolbar-button danger" onClick={() => deleteTitle(title.id)} type="button">
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
      {appState.currentView === "settings" && currentUser.role === "admin" ? (
        <section className="view-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Admin Settings</span>
              <h2>Storage Configuration</h2>
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

          <div className="settings-grid">
            <section className="card form-card">
              <div className="card-header">
                <div>
                  <span className="eyebrow">Provider</span>
                  <h3>S3-Compatible Preset</h3>
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
            </section>

            <section className="card">
              <div className="card-header">
                <div>
                  <span className="eyebrow">Security</span>
                  <h3>Server-Only Secrets</h3>
                </div>
              </div>
              <ul className="rule-list">
                <li>Users never see access key IDs or secret keys in the browser UI.</li>
                <li>The browser talks only to the application API, not directly to object storage.</li>
                <li>Short-lived signed URLs can be added later without exposing raw credentials.</li>
              </ul>
              <div className="settings-note">Last connection test: {formatTimestamp(appState.storage.lastConnectionTestAt)}</div>
            </section>
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
