import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import unzipper from "unzipper";
import { ensureDir, fileExists, sanitizeFileSegment } from "./helpers.js";
import { normalizePhrases, parseJson3, parseJsonSubtitle, phrasesToJson3 } from "./subtitles.js";

function buildProjectPayload(title, phrases) {
  return {
    id: title.id,
    videoId: title.videoId,
    title: title.title,
    source: title.source,
    language: title.language,
    duration: title.duration,
    sourceType: title.sourceType,
    uploadedAt: title.uploadedAt,
    phrases,
  };
}

export async function createAsrArchive({ title, phrases, audioFilePath, outputPath }) {
  ensureDir(path.dirname(outputPath));

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    const videoId = sanitizeFileSegment(title.videoId || title.id);

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.append(
      JSON.stringify(
        {
          version: 1,
          titleId: title.id,
          videoId,
          title: title.title,
          language: title.language,
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { name: "manifest.json" },
    );

    archive.append(JSON.stringify(buildProjectPayload(title, phrases), null, 2), {
      name: `${videoId}/project.json`,
    });

    archive.append(JSON.stringify(phrasesToJson3(phrases), null, 2), {
      name: `${videoId}/caption.json3`,
    });

    if (audioFilePath && fileExists(audioFilePath)) {
      archive.file(audioFilePath, { name: `${videoId}/working_audio.wav` });
    }

    archive.finalize();
  });

  return outputPath;
}

export async function importAsrArchive(archivePath, extractionDir) {
  ensureDir(extractionDir);
  await fs.createReadStream(archivePath).pipe(unzipper.Extract({ path: extractionDir })).promise();

  const manifestPath = path.join(extractionDir, "manifest.json");
  const manifest = fileExists(manifestPath) ? JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) : {};
  const topLevelEntries = await fs.promises.readdir(extractionDir, { withFileTypes: true });
  const projectDir =
    topLevelEntries.find((entry) => entry.isDirectory() && entry.name !== "__MACOSX")?.name || sanitizeFileSegment(manifest.videoId || "");

  const baseDir = projectDir ? path.join(extractionDir, projectDir) : extractionDir;
  const projectPath = path.join(baseDir, "project.json");
  const captionJson3Path = path.join(baseDir, "caption.json3");
  const captionJsonPath = path.join(baseDir, "caption.json");
  const audioPath = path.join(baseDir, "working_audio.wav");

  const project = fileExists(projectPath) ? JSON.parse(await fs.promises.readFile(projectPath, "utf8")) : {};
  let phrases = [];

  if (Array.isArray(project?.phrases) && project.phrases.length > 0) {
    phrases = normalizePhrases(project.phrases);
  } else if (fileExists(captionJson3Path)) {
    phrases = parseJson3(await fs.promises.readFile(captionJson3Path, "utf8"));
  } else if (fileExists(captionJsonPath)) {
    phrases = parseJsonSubtitle(await fs.promises.readFile(captionJsonPath, "utf8"));
  }

  return {
    manifest,
    project,
    phrases,
    audioPath: fileExists(audioPath) ? audioPath : null,
    videoId: project.videoId || manifest.videoId || projectDir || sanitizeFileSegment(path.basename(archivePath, path.extname(archivePath))),
    title: project.title || manifest.title || "Imported Package",
    source: project.source || "Imported .asr",
    language: project.language || manifest.language || "en",
    duration: Number(project.duration || 0),
  };
}
