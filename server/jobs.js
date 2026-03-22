import fs from "node:fs";
import path from "node:path";
import { importAsrArchive } from "./asr.js";
import {
  claimNextQueuedJob,
  completeJob,
  createTitleRecord,
  failJob,
  getActiveCheckoutForUser,
  getJob,
  getTitleByVideoId,
  insertAuditRecord,
  updateJobProgress,
  updateTitleRecord,
} from "./database.js";
import { paths } from "./config.js";
import { ensureDir, nowIso, parseJson, randomId, removeIfExists, slugify } from "./helpers.js";
import {
  downloadUrlToFile,
  downloadYouTubeAudio,
  extractEmbeddedSubtitle,
  extractWorkingAudio,
  generateWaveform,
  getMediaDuration,
  getYouTubeMetadata,
  listSubtitleStreams,
  pickBestSubtitleSource,
} from "./media.js";
import { getObjectKey, getStorageService } from "./storage.js";
import { parseSubtitleFile } from "./subtitles.js";
import { transcribeAudio } from "./transcription.js";

function withUniqueVideoId(videoId) {
  if (!getTitleByVideoId(videoId)) {
    return videoId;
  }

  return `${videoId}-${Date.now().toString(36)}`;
}

async function persistArtifacts(titleId, audioPath, waveformPath) {
  const storage = getStorageService();
  const audioObjectKey = audioPath ? getObjectKey("artifacts", titleId, "working_audio.wav") : null;
  const waveformObjectKey = waveformPath ? getObjectKey("artifacts", titleId, "waveform.png") : null;

  if (audioPath) {
    await storage.putFile(audioObjectKey, audioPath, "audio/wav");
  }
  if (waveformPath) {
    await storage.putFile(waveformObjectKey, waveformPath, "image/png");
  }

  return { audioObjectKey, waveformObjectKey };
}

async function finalizeImportedTitle(job, payload) {
  const workDir = path.join(paths.tempDir, job.id);
  ensureDir(workDir);

  let phrases = payload.phrases || [];
  if (phrases.length === 0 && payload.audioFilePath) {
    updateJobProgress(job.id, 70, "Transcribing audio");
    phrases = await transcribeAudio(payload.audioFilePath, payload.language, workDir);
  }

  const audioPath = payload.audioFilePath || null;
  const duration = payload.duration || (audioPath ? await getMediaDuration(audioPath) : 0);
  let waveformPath = null;
  if (audioPath) {
    waveformPath = path.join(workDir, "waveform.png");
    updateJobProgress(job.id, 82, "Rendering waveform");
    await generateWaveform(audioPath, waveformPath);
  }

  const titleId = randomId("title");
  const videoId = withUniqueVideoId(payload.videoId || slugify(payload.title) || titleId);
  const sizeBytes = audioPath ? fs.statSync(audioPath).size : 0;
  const activeCheckout = getActiveCheckoutForUser(job.createdByUserId);
  const autoCheckout = !activeCheckout;

  updateJobProgress(job.id, 90, "Persisting title");
  const { audioObjectKey, waveformObjectKey } = await persistArtifacts(titleId, audioPath, waveformPath);

  createTitleRecord({
    id: titleId,
    videoId,
    title: payload.title,
    source: payload.source,
    language: payload.language || "en",
    duration,
    sourceType: payload.sourceType,
    uploadedAt: nowIso(),
    createdByUserId: job.createdByUserId,
    sizeBytes,
    phrases,
    savedSnapshot: phrases,
    checkedOutByUserId: autoCheckout ? job.createdByUserId : null,
    checkedOutAt: autoCheckout ? nowIso() : null,
    badge: payload.badge || null,
    audioObjectKey,
    waveformObjectKey,
  });

  insertAuditRecord({
    eventType: payload.auditEventType || "title_import",
    titleId,
    titleName: payload.title,
    actorUserId: job.createdByUserId,
    actorDisplayName: payload.actorDisplayName,
    details: payload.auditDetails,
  });

  return {
    titleId,
    videoId,
    autoCheckedOut: autoCheckout,
    title: payload.title,
  };
}

async function processYoutubeImport(job) {
  const payload = job.payload;
  const workDir = path.join(paths.tempDir, job.id);
  ensureDir(workDir);

  updateJobProgress(job.id, 5, "Fetching YouTube metadata");
  const metadata = await getYouTubeMetadata(payload.url);

  let phrases = [];
  const subtitleSource = pickBestSubtitleSource(metadata, payload.language || "en");
  if (subtitleSource?.url) {
    updateJobProgress(job.id, 20, "Downloading subtitle track");
    const subtitleFilePath = path.join(workDir, `captions.${subtitleSource.ext || "json3"}`);
    await downloadUrlToFile(subtitleSource.url, subtitleFilePath);
    phrases = parseSubtitleFile(subtitleFilePath);
  }

  updateJobProgress(job.id, 40, "Downloading YouTube audio");
  const sourceAudioPath = await downloadYouTubeAudio(payload.url, workDir);
  const workingAudioPath = path.join(workDir, "working_audio.wav");
  updateJobProgress(job.id, 55, "Converting working audio");
  await extractWorkingAudio(sourceAudioPath, workingAudioPath);

  return finalizeImportedTitle(job, {
    title: metadata.title || "Imported YouTube Title",
    source: metadata.channel || metadata.uploader || "YouTube",
    language: payload.language || "en",
    duration: Number(metadata.duration || 0),
    sourceType: "youtube",
    videoId: metadata.id || slugify(metadata.title || "youtube-title"),
    phrases,
    audioFilePath: workingAudioPath,
    actorDisplayName: payload.actorDisplayName,
    auditDetails: `Imported from YouTube URL ${payload.url}.`,
  });
}

async function processMediaImport(job) {
  const payload = job.payload;
  const workDir = path.join(paths.tempDir, job.id);
  ensureDir(workDir);

  const workingAudioPath = path.join(workDir, "working_audio.wav");
  updateJobProgress(job.id, 20, "Extracting working audio");
  await extractWorkingAudio(payload.mediaFilePath, workingAudioPath);

  let phrases = [];
  if (payload.subtitleFilePath) {
    updateJobProgress(job.id, 35, "Parsing subtitle file");
    phrases = parseSubtitleFile(payload.subtitleFilePath);
  } else if (payload.subtitleStreamIndex !== null && payload.subtitleStreamIndex !== undefined) {
    updateJobProgress(job.id, 35, "Extracting embedded subtitle track");
    const probeStreams = await listSubtitleStreams(payload.mediaFilePath);
    const matching = probeStreams.find((stream) => stream.index === payload.subtitleStreamIndex);
    if (matching) {
      const extractedSubtitlePath = path.join(workDir, `embedded.${matching.codecName || "srt"}`);
      await extractEmbeddedSubtitle(payload.mediaFilePath, matching.index, extractedSubtitlePath);
      phrases = parseSubtitleFile(extractedSubtitlePath);
    }
  }

  const duration = await getMediaDuration(payload.mediaFilePath);
  return finalizeImportedTitle(job, {
    title: payload.title || "Uploaded Media",
    source: payload.source || "Uploaded Media",
    language: payload.language || "en",
    duration,
    sourceType: "local",
    videoId: slugify(payload.title || path.basename(payload.mediaFilePath, path.extname(payload.mediaFilePath))),
    phrases,
    audioFilePath: workingAudioPath,
    actorDisplayName: payload.actorDisplayName,
    auditEventType: "title_upload",
    auditDetails: `Uploaded local media${payload.subtitleFilePath ? " with subtitle file" : ""}.`,
  });
}

async function processAsrImport(job) {
  const payload = job.payload;
  const workDir = path.join(paths.tempDir, job.id);
  ensureDir(workDir);

  updateJobProgress(job.id, 15, "Extracting .asr archive");
  const imported = await importAsrArchive(payload.archivePath, path.join(workDir, "archive"));

  return finalizeImportedTitle(job, {
    title: imported.title,
    source: imported.source,
    language: imported.language || "en",
    duration: imported.duration,
    sourceType: "package",
    videoId: imported.videoId,
    phrases: imported.phrases,
    audioFilePath: imported.audioPath,
    actorDisplayName: payload.actorDisplayName,
    auditDetails: `Imported archive ${path.basename(payload.archivePath)}.`,
  });
}

async function processJob(job) {
  if (job.type === "youtube_import") {
    return processYoutubeImport(job);
  }
  if (job.type === "media_import") {
    return processMediaImport(job);
  }
  if (job.type === "asr_import") {
    return processAsrImport(job);
  }

  throw new Error(`Unsupported job type: ${job.type}`);
}

let workerStarted = false;
let processing = false;

export function startJobWorker() {
  if (workerStarted) {
    return;
  }
  workerStarted = true;

  const tick = async () => {
    if (processing) {
      return;
    }

    const job = claimNextQueuedJob();
    if (!job) {
      return;
    }

    processing = true;
    try {
      const freshJob = getJob(job.id);
      const result = await processJob({
        ...freshJob,
        payload: parseJson(JSON.stringify(freshJob.payload), {}),
      });
      completeJob(job.id, result, result.titleId || null);
    } catch (error) {
      failJob(job.id, error instanceof Error ? error.message : String(error));
    } finally {
      processing = false;
    }
  };

  setInterval(() => {
    void tick();
  }, 1500);
}
