import fs from "node:fs";
import path from "node:path";
import { cleanText, sanitizeFileSegment } from "./helpers.js";

function parseTimestamp(timestamp) {
  const normalized = timestamp.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return Number(minutes) * 60 + Number(seconds);
  }
  return Number(normalized) || 0;
}

function createPhrase(index, start, end, text, reviewed = false) {
  return {
    id: `phrase-${String(index + 1).padStart(4, "0")}-${sanitizeFileSegment(text.slice(0, 24) || "segment")}`,
    start: Number(start.toFixed(2)),
    end: Number(Math.max(end, start + 0.1).toFixed(2)),
    text: cleanText(text) || "<Sentence>",
    enabled: true,
    reviewed,
  };
}

export function normalizePhrases(phrases) {
  return phrases
    .map((phrase, index) =>
      createPhrase(
        index,
        Number(phrase.start || 0),
        Number(phrase.end || Number(phrase.start || 0) + 0.1),
        phrase.text || "",
        Boolean(phrase.reviewed),
      ),
    )
    .filter((phrase) => phrase.end > phrase.start);
}

export function parseSrt(text) {
  const blocks = text.trim().split(/\r?\n\r?\n+/);
  const phrases = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) {
      continue;
    }

    const timingLine = lines.find((line) => line.includes("-->"));
    if (!timingLine) {
      continue;
    }

    const [startRaw, endRaw] = timingLine.split("-->");
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    const textLines = lines.filter((line) => line !== timingLine && !/^\d+$/.test(line));
    phrases.push(createPhrase(phrases.length, start, end, textLines.join(" ")));
  }

  return phrases;
}

export function parseVtt(text) {
  const withoutHeader = text.replace(/^WEBVTT.*?(\r?\n){2}/s, "");
  return parseSrt(withoutHeader);
}

export function parseJson3(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const events = Array.isArray(data?.events) ? data.events : [];
  const phrases = [];

  for (const event of events) {
    if (!Array.isArray(event?.segs) || event.segs.length === 0) {
      continue;
    }

    const text = cleanText(
      event.segs
        .map((segment) => segment.utf8 || "")
        .join("")
        .replace(/\n/g, " "),
    );

    if (!text) {
      continue;
    }

    const start = (event.tStartMs || 0) / 1000;
    const duration = (event.dDurationMs || 500) / 1000;
    phrases.push(createPhrase(phrases.length, start, start + duration, text));
  }

  return phrases;
}

export function parseJsonSubtitle(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (Array.isArray(data)) {
    return normalizePhrases(data);
  }
  if (Array.isArray(data?.phrases)) {
    return normalizePhrases(data.phrases);
  }
  if (Array.isArray(data?.events)) {
    return parseJson3(data);
  }
  return [];
}

export function parseSubtitleContent(content, extension) {
  const ext = extension.toLowerCase();
  if (ext === ".srt") {
    return parseSrt(content);
  }
  if (ext === ".vtt") {
    return parseVtt(content);
  }
  if (ext === ".json3" || ext === ".srv3") {
    return parseJson3(content);
  }
  if (ext === ".json") {
    return parseJsonSubtitle(content);
  }
  return [];
}

export function parseSubtitleFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, "utf8");
  return parseSubtitleContent(content, extension);
}

export function phrasesToJson3(phrases) {
  return {
    wireMagic: "pb3",
    events: phrases.map((phrase) => ({
      tStartMs: Math.round(phrase.start * 1000),
      dDurationMs: Math.max(100, Math.round((phrase.end - phrase.start) * 1000)),
      segs: [{ utf8: phrase.text }],
    })),
  };
}
