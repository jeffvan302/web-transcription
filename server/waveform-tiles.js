export const WAVEFORM_TILE_DURATION_SECONDS = 60;
export const WAVEFORM_TILE_WIDTH = 12000;
export const WAVEFORM_TILE_HEIGHT = 320;

const WAVEFORM_TILE_PREFIX_MARKER = "tiles:";

export function encodeWaveformTilePrefix(prefix) {
  return `${WAVEFORM_TILE_PREFIX_MARKER}${String(prefix || "").trim()}`;
}

export function decodeWaveformTilePrefix(value) {
  const normalized = String(value || "");
  if (!normalized.startsWith(WAVEFORM_TILE_PREFIX_MARKER)) {
    return null;
  }
  const prefix = normalized.slice(WAVEFORM_TILE_PREFIX_MARKER.length).trim();
  return prefix || null;
}

export function buildWaveformTileObjectKey(prefix, index) {
  return `${String(prefix || "").replace(/\/+$/, "")}/${String(index).padStart(4, "0")}.png`;
}

export function getWaveformTileCount(durationSeconds) {
  const normalizedDuration = Math.max(0, Number(durationSeconds) || 0);
  if (normalizedDuration <= 0) {
    return 0;
  }
  return Math.ceil(normalizedDuration / WAVEFORM_TILE_DURATION_SECONDS);
}

export function getWaveformTileDuration(durationSeconds, index) {
  const normalizedDuration = Math.max(0, Number(durationSeconds) || 0);
  const tileStart = Math.max(0, Number(index) || 0) * WAVEFORM_TILE_DURATION_SECONDS;
  return Math.max(0, Math.min(WAVEFORM_TILE_DURATION_SECONDS, normalizedDuration - tileStart));
}
