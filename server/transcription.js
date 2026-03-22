import fs from "node:fs";
import path from "node:path";
import { appConfig } from "./config.js";
import { ensureDir } from "./helpers.js";
import { getMediaDuration, runProcess } from "./media.js";

function buildPhrase(index, start, end, text) {
  return {
    id: `phrase-${String(index + 1).padStart(4, "0")}`,
    start: Number(start.toFixed(2)),
    end: Number(Math.max(end, start + 0.1).toFixed(2)),
    text: String(text || "").trim() || "<Sentence>",
    enabled: true,
    reviewed: false,
  };
}

function segmentsToPhrases(segments, fallbackDuration) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }

  return segments
    .map((segment, index) => {
      const start = Number(segment.start ?? segment.from ?? segment.t0 ?? 0);
      const endRaw = segment.end ?? segment.to ?? segment.t1;
      const end = Number(endRaw ?? start + Math.max(fallbackDuration / Math.max(segments.length, 1), 0.5));
      const text = segment.text ?? segment.value ?? segment.utf8 ?? "";
      return buildPhrase(index, start, end, text);
    })
    .filter((phrase) => phrase.text.trim().length > 0);
}

async function transcribeWithOpenAi(audioPath, language) {
  const audioBlob = await fs.openAsBlob(audioPath, { type: "audio/wav" });
  const form = new FormData();
  form.append("file", audioBlob, path.basename(audioPath));
  form.append("model", appConfig.openAiTranscriptionModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (language && language !== "auto") {
    form.append("language", language);
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appConfig.openAiApiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const duration = await getMediaDuration(audioPath);
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    return segmentsToPhrases(data.segments, duration);
  }

  if (data.text) {
    return [buildPhrase(0, 0, duration || 1, data.text)];
  }

  return [];
}

function escapeFfmpegFilterValue(value) {
  return String(value).replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

async function transcribeWithFfmpegWhisper(audioPath, language, workDir) {
  ensureDir(workDir);
  const outputPath = path.join(workDir, "whisper.json");
  const languageValue = language && language !== "auto" ? language : "auto";

  await runProcess(appConfig.ffmpegPath, [
    "-y",
    "-i",
    audioPath,
    "-vn",
    "-af",
    `whisper=model=${escapeFfmpegFilterValue(appConfig.whisperModelPath)}:language=${languageValue}:queue=10:destination=${escapeFfmpegFilterValue(outputPath)}:format=json`,
    "-f",
    "null",
    "-",
  ]);

  const raw = JSON.parse(await fs.promises.readFile(outputPath, "utf8"));
  const duration = await getMediaDuration(audioPath);
  const segments = raw.segments || raw.transcription || raw.parts || [];
  if (segments.length > 0) {
    return segmentsToPhrases(segments, duration);
  }

  if (raw.text) {
    return [buildPhrase(0, 0, duration || 1, raw.text)];
  }

  return [];
}

export async function transcribeAudio(audioPath, language, workDir) {
  let lastError = null;

  if (appConfig.openAiApiKey) {
    try {
      return await transcribeWithOpenAi(audioPath, language);
    } catch (error) {
      lastError = error;
      console.warn("OpenAI transcription unavailable, falling back.", error);
    }
  }

  if (appConfig.whisperModelPath) {
    try {
      return await transcribeWithFfmpegWhisper(audioPath, language, workDir);
    } catch (error) {
      lastError = error;
      console.warn("Local whisper transcription unavailable, falling back.", error);
    }
  }

  if (lastError) {
    return [];
  }

  return [];
}
