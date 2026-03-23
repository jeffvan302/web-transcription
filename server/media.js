import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appConfig } from "./config.js";
import { ensureDir } from "./helpers.js";
import {
  WAVEFORM_TILE_DURATION_SECONDS,
  WAVEFORM_TILE_HEIGHT,
  WAVEFORM_TILE_WIDTH,
} from "./waveform-tiles.js";

export const MONO_ARCHIVE_SAMPLE_RATE = 48000;
export const MONO_ARCHIVE_CODEC = "pcm_s24le";

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} exited with code ${code}\n${stderr || stdout || "No process output was captured."}`.trim(),
        ),
      );
    });
  });
}

export async function probeMedia(filePath) {
  const result = await runProcess(appConfig.ffprobePath, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return JSON.parse(result.stdout);
}

export async function listSubtitleStreams(filePath) {
  const probe = await probeMedia(filePath);
  return (probe.streams || [])
    .filter((stream) => stream.codec_type === "subtitle")
    .map((stream) => ({
      index: stream.index,
      codecName: stream.codec_name,
      language: stream.tags?.language || "und",
      title: stream.tags?.title || `Subtitle ${stream.index}`,
    }));
}

export async function extractEmbeddedSubtitle(filePath, streamIndex, outputPath) {
  ensureDir(path.dirname(outputPath));
  await runProcess(appConfig.ffmpegPath, [
    "-y",
    "-i",
    filePath,
    "-map",
    `0:${streamIndex}`,
    outputPath,
  ]);
  return outputPath;
}

export async function extractWorkingAudio(inputPath, outputPath) {
  ensureDir(path.dirname(outputPath));
  await runProcess(appConfig.ffmpegPath, [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(MONO_ARCHIVE_SAMPLE_RATE),
    "-c:a",
    MONO_ARCHIVE_CODEC,
    outputPath,
  ]);
  return outputPath;
}

export async function generateWaveform(audioPath, outputPath) {
  ensureDir(path.dirname(outputPath));
  const duration = Math.max(1, await getMediaDuration(audioPath));
  const pixelsPerSecond = duration <= 180 ? 70 : duration <= 900 ? 40 : 24;
  const width = Math.min(12000, Math.max(3200, Math.round(duration * pixelsPerSecond)));
  const height = 320;

  await runProcess(appConfig.ffmpegPath, [
    "-y",
    "-i",
    audioPath,
    "-filter_complex",
    `showwavespic=s=${width}x${height}:colors=0x6db5ff:filter=peak:draw=full:scale=sqrt`,
    "-frames:v",
    "1",
    outputPath,
  ]);
  return outputPath;
}

export async function generateWaveformTiles(audioPath, outputDir, totalDuration = 0) {
  ensureDir(outputDir);
  const duration = Math.max(0, Number(totalDuration) || (await getMediaDuration(audioPath)) || 0);
  if (duration <= 0) {
    return [];
  }

  const tileCount = Math.ceil(duration / WAVEFORM_TILE_DURATION_SECONDS);
  const tiles = [];

  for (let index = 0; index < tileCount; index += 1) {
    const startSeconds = index * WAVEFORM_TILE_DURATION_SECONDS;
    const tileDuration = Math.max(0, Math.min(WAVEFORM_TILE_DURATION_SECONDS, duration - startSeconds));
    if (tileDuration <= 0) {
      continue;
    }

    const width = Math.max(320, Math.round((tileDuration / WAVEFORM_TILE_DURATION_SECONDS) * WAVEFORM_TILE_WIDTH));
    const outputPath = path.join(outputDir, `${String(index).padStart(4, "0")}.png`);
    await runProcess(appConfig.ffmpegPath, [
      "-y",
      "-ss",
      String(startSeconds),
      "-t",
      String(tileDuration),
      "-i",
      audioPath,
      "-filter_complex",
      `showwavespic=s=${width}x${WAVEFORM_TILE_HEIGHT}:colors=0x6db5ff:filter=peak:draw=full:scale=sqrt`,
      "-frames:v",
      "1",
      outputPath,
    ]);

    tiles.push({
      index,
      startSeconds,
      durationSeconds: tileDuration,
      outputPath,
    });
  }

  return tiles;
}

export async function getMediaDuration(filePath) {
  const probe = await probeMedia(filePath);
  return Number(probe?.format?.duration || 0);
}

export async function getYouTubeMetadata(url) {
  const result = await runProcess(appConfig.ytDlpPath, ["--dump-single-json", "--no-warnings", "--skip-download", url]);
  return JSON.parse(result.stdout);
}

export async function downloadYouTubeAudio(url, outputDir) {
  ensureDir(outputDir);
  const outputTemplate = path.join(outputDir, "source.%(ext)s");

  await runProcess(appConfig.ytDlpPath, ["-f", "bestaudio/best", "--no-playlist", "-o", outputTemplate, url]);

  const file = fs
    .readdirSync(outputDir)
    .map((entry) => path.join(outputDir, entry))
    .find((entry) => path.basename(entry).startsWith("source."));

  if (!file) {
    throw new Error("yt-dlp did not produce an audio file.");
  }

  return file;
}

export async function downloadUrlToFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  ensureDir(path.dirname(outputPath));
  const arrayBuffer = await response.arrayBuffer();
  await fs.promises.writeFile(outputPath, Buffer.from(arrayBuffer));
  return outputPath;
}

export function pickBestSubtitleSource(metadata, language) {
  const exact = metadata.subtitles?.[language] || metadata.automatic_captions?.[language] || [];
  const languagePrefix =
    Object.entries(metadata.subtitles || {}).find(([code]) => code.startsWith(language))?.[1] ||
    Object.entries(metadata.automatic_captions || {}).find(([code]) => code.startsWith(language))?.[1] ||
    [];

  const candidates = Array.isArray(exact) && exact.length > 0 ? exact : languagePrefix;
  const preferred = [...candidates].sort((left, right) => {
    const score = (entry) => {
      if (entry.ext === "json3") {
        return 0;
      }
      if (entry.ext === "srv3") {
        return 1;
      }
      if (entry.ext === "vtt") {
        return 2;
      }
      return 3;
    };
    return score(left) - score(right);
  });

  return preferred[0] || null;
}
