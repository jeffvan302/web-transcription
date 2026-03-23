import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { appConfig } from "./config.js";
import { ensureDir, sanitizeFileSegment } from "./helpers.js";
import { runProcess } from "./media.js";

const TSV_HEADER = "audio_path\tsetence\tis_noise\tduration_s";

function normalizeSentenceText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDuration(seconds) {
  return (Math.round(Math.max(0, Number(seconds) || 0) * 1000) / 1000).toFixed(3);
}

function buildClipBaseName(title, titleIndex) {
  const rawBase = sanitizeFileSegment(`${title.title || title.videoId || title.id || "title"}-${title.videoId || title.id || titleIndex}`);
  return (rawBase || `title-${titleIndex}`).toLowerCase();
}

function getExportablePhrases(phrases) {
  return (Array.isArray(phrases) ? phrases : []).filter((phrase) => {
    const start = Number(phrase?.start);
    const end = Number(phrase?.end);
    return Boolean(phrase?.enabled) && Boolean(phrase?.reviewed) && Number.isFinite(start) && Number.isFinite(end) && end > start;
  });
}

async function exportPhraseClip(audioFilePath, outputPath, startSeconds, durationSeconds) {
  ensureDir(path.dirname(outputPath));
  await runProcess(appConfig.ffmpegPath, [
    "-y",
    "-ss",
    String(startSeconds),
    "-t",
    String(durationSeconds),
    "-i",
    audioFilePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    outputPath,
  ]);
}

export async function createDatasetArchive({ items, outputPath, workDir }) {
  ensureDir(path.dirname(outputPath));
  ensureDir(workDir);

  const clipsDir = path.join(workDir, "clips");
  ensureDir(clipsDir);

  const usedClipNames = new Set();
  const clips = [];
  const tsvRows = [TSV_HEADER];

  for (const [titleIndex, item] of (Array.isArray(items) ? items : []).entries()) {
    const exportablePhrases = getExportablePhrases(item?.phrases);
    if (exportablePhrases.length === 0) {
      continue;
    }
    if (!item?.audioFilePath) {
      throw new Error(`Audio not available for ${item?.title?.title || item?.title?.videoId || item?.title?.id || "the selected title"}.`);
    }

    const clipBaseName = buildClipBaseName(item.title || {}, titleIndex + 1);
    let clipNumber = 1;

    for (const phrase of exportablePhrases) {
      const startSeconds = Math.max(0, Number(phrase.start) || 0);
      const durationSeconds = Math.max(0, (Number(phrase.end) || 0) - startSeconds);
      if (durationSeconds <= 0) {
        continue;
      }

      let clipFileName = `${clipBaseName}-${String(clipNumber).padStart(4, "0")}.mp3`;
      while (usedClipNames.has(clipFileName)) {
        clipNumber += 1;
        clipFileName = `${clipBaseName}-${String(clipNumber).padStart(4, "0")}.mp3`;
      }
      usedClipNames.add(clipFileName);

      const clipPath = path.join(clipsDir, clipFileName);
      await exportPhraseClip(item.audioFilePath, clipPath, startSeconds, durationSeconds);

      clips.push({
        archivePath: `clips/${clipFileName}`,
        filePath: clipPath,
      });
      tsvRows.push(
        [
          `clips/${clipFileName}`,
          normalizeSentenceText(phrase.text),
          "0",
          formatDuration(durationSeconds),
        ].join("\t"),
      );
      clipNumber += 1;
    }
  }

  const tsvPath = path.join(workDir, "sentences.tsv");
  await fs.promises.writeFile(tsvPath, `${tsvRows.join("\n")}\n`, "utf8");

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.file(tsvPath, { name: "sentences.tsv" });
    if (clips.length === 0) {
      archive.append("", { name: "clips/" });
    } else {
      clips.forEach((clip) => {
        archive.file(clip.filePath, { name: clip.archivePath });
      });
    }
    archive.finalize();
  });

  return {
    outputPath,
    clipCount: clips.length,
  };
}
