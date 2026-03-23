import { nowIso } from "./helpers.js";
import { getObjectKey, getStorageService } from "./storage.js";

function jsonBuffer(payload) {
  return Buffer.from(JSON.stringify(payload, null, 2), "utf8");
}

export function getTitleSentenceStateObjectKey(titleId) {
  return getObjectKey("titles", titleId, "sentences.json");
}

export function buildCloudDraftMeta(draftRow) {
  if (!draftRow) {
    return null;
  }

  return {
    id: draftRow.id,
    userId: draftRow.user_id,
    version: draftRow.version,
    status: draftRow.status,
    isDirty: Boolean(draftRow.is_dirty),
    lastAutosaveAt: draftRow.last_autosave_at || null,
    lastSaveAt: draftRow.last_save_at || null,
    lastSyncAt: draftRow.last_sync_at || null,
    updatedAt: draftRow.updated_at || null,
  };
}

export async function persistTitleSentenceState({ titleRow, phrases, savedSnapshot, draftRow = null }) {
  if (!titleRow) {
    return null;
  }

  const payload = {
    titleId: titleRow.id,
    workspaceId: titleRow.workspace_id || null,
    videoId: titleRow.video_id,
    title: titleRow.title,
    source: titleRow.source,
    language: titleRow.language,
    duration: titleRow.duration,
    sourceType: titleRow.source_type,
    uploadedAt: titleRow.uploaded_at,
    updatedAt: titleRow.updated_at || nowIso(),
    checkedOutByUserId: titleRow.checked_out_by_user_id || null,
    checkedOutAt: titleRow.checked_out_at || null,
    badge: titleRow.badge || null,
    phraseCount: Array.isArray(phrases) ? phrases.length : 0,
    phrases: Array.isArray(phrases) ? phrases : [],
    savedSnapshot: Array.isArray(savedSnapshot) ? savedSnapshot : [],
    draft: buildCloudDraftMeta(draftRow),
  };

  const storage = getStorageService();
  const key = getTitleSentenceStateObjectKey(titleRow.id);
  await storage.putBuffer(key, jsonBuffer(payload), "application/json");
  return key;
}

export async function deleteTitleSentenceState(titleId) {
  if (!titleId) {
    return;
  }

  const storage = getStorageService();
  await storage.deleteObject(getTitleSentenceStateObjectKey(titleId));
}
