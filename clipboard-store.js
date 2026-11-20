import { folderIcons, maxPinnedFolders } from "./workspace-data.js";

function cleanFolderName(name) {
  return typeof name === "string" ? name.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
}

export function hasFolder(workspace, id) {
  return workspace.folders.some((folder) => folder.id === id);
}

export function saveFolder(workspace, { id, name, icon }, create) {
  const cleanName = cleanFolderName(name);
  if (!cleanName) return "folderRequired";
  if (typeof id !== "string" || !id || !folderIcons.includes(icon)) throw new Error("Invalid folder");

  const existing = workspace.folders.find((folder) => folder.id === id);
  if (create && existing) {
    if (existing.name === cleanName && existing.icon === icon) return;
    throw new Error("Folder ID is already in use");
  }
  if (!create && !existing) return "folderMissing";

  const nameKey = cleanName.toLowerCase();
  if (workspace.folders.some((folder) => folder.id !== id && cleanFolderName(folder.name).toLowerCase() === nameKey)) {
    return "folderDuplicate";
  }

  if (existing) Object.assign(existing, { name: cleanName, icon });
  else workspace.folders = [...workspace.folders, { id, name: cleanName, icon, pinned: false }];
}

export function pinFolder(workspace, { id, pinned }) {
  const folder = workspace.folders.find((item) => item.id === id);
  if (!folder) return "folderMissing";
  if (typeof pinned !== "boolean") throw new Error("Invalid folder pin state");
  if (folder.pinned === pinned) return;
  if (pinned && workspace.folders.filter((item) => item.pinned).length >= maxPinnedFolders) return "folderPinLimit";
  folder.pinned = pinned;
}

export function deleteFolder(workspace, { id }) {
  if (!hasFolder(workspace, id)) return "folderMissing";
  workspace.folders = workspace.folders.filter((folder) => folder.id !== id);
  for (const snippet of workspace.snippets) {
    if (snippet.folderId === id) snippet.folderId = null;
  }
}

export function moveSnippet(workspace, { id, folderId, expectedFolderId }) {
  const snippet = workspace.snippets.find((item) => item.id === id);
  if (!snippet) throw new Error("Snippet no longer exists");
  if (folderId !== null && !hasFolder(workspace, folderId)) return "folderMissing";
  if (expectedFolderId !== undefined && (snippet.folderId ?? null) !== expectedFolderId) {
    throw new Error("Snippet moved before it could be restored");
  }
  snippet.folderId = folderId;
}
