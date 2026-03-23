import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { updateTitleRecord } from "./database.js";
import { ensureDir, randomId, removeIfExists } from "./helpers.js";
import { generateWaveformTiles } from "./media.js";
import { getObjectKey, getStorageService } from "./storage.js";
import {
  buildWaveformTileObjectKey,
  decodeWaveformTilePrefix,
  encodeWaveformTilePrefix,
  getWaveformTileCount,
  WAVEFORM_TILE_DURATION_SECONDS,
} from "./waveform-tiles.js";

async function materializeStoredObject(key, fileName) {
  const storage = getStorageService();
  if (!key) {
    return null;
  }

  if (storage.mode === "local") {
    return storage.resolveLocalPath(key);
  }

  const outputPath = path.join(paths.tempDir, randomId("asset"), fileName);
  ensureDir(path.dirname(outputPath));
  const buffer = await storage.getBuffer(key);
  await fs.promises.writeFile(outputPath, buffer);
  return outputPath;
}

export async function deleteWaveformArtifacts(titleRow) {
  const storage = getStorageService();
  const waveformTilePrefix = decodeWaveformTilePrefix(titleRow?.waveform_object_key);
  if (!titleRow?.waveform_object_key) {
    return;
  }
  if (!waveformTilePrefix) {
    await storage.deleteObject(titleRow.waveform_object_key);
    return;
  }

  const tileCount = getWaveformTileCount(titleRow.duration);
  for (let index = 0; index < tileCount; index += 1) {
    await storage.deleteObject(buildWaveformTileObjectKey(waveformTilePrefix, index));
  }
}

export async function rebuildWaveformArtifactsForTitle(titleRow) {
  if (!titleRow?.audio_object_key) {
    throw new Error("Audio not available for waveform rebuild.");
  }

  const tempWaveformDir = path.join(paths.tempDir, randomId("waveform-tiles"));
  ensureDir(tempWaveformDir);

  try {
    const audioPath = await materializeStoredObject(titleRow.audio_object_key, "working_audio.wav");
    const waveformTiles = await generateWaveformTiles(audioPath, tempWaveformDir, titleRow.duration);
    if (waveformTiles.length === 0) {
      throw new Error("Could not generate waveform tiles for this title.");
    }

    await deleteWaveformArtifacts(titleRow).catch(() => {});

    const storage = getStorageService();
    const waveformTilePrefix = getObjectKey("artifacts", titleRow.id, "waveform_tiles");
    for (const tile of waveformTiles) {
      await storage.putFile(buildWaveformTileObjectKey(waveformTilePrefix, tile.index), tile.outputPath, "image/png");
    }

    const updatedTitle = updateTitleRecord(titleRow.id, {
      ...titleRow,
      waveform_object_key: encodeWaveformTilePrefix(waveformTilePrefix),
    });

    return {
      titleRow: updatedTitle,
      waveformTilePrefix,
    };
  } finally {
    removeIfExists(tempWaveformDir);
  }
}

export async function ensureTiledWaveformArtifacts(titleRow) {
  const existingPrefix = decodeWaveformTilePrefix(titleRow?.waveform_object_key);
  if (existingPrefix) {
    return {
      titleRow,
      waveformTilePrefix: existingPrefix,
    };
  }
  if (!titleRow?.audio_object_key || Number(titleRow.duration || 0) <= WAVEFORM_TILE_DURATION_SECONDS) {
    return null;
  }

  return rebuildWaveformArtifactsForTitle(titleRow);
}
