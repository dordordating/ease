import { folderIcons, maxPinnedFolders, palettes } from "./workspace-data.js";

function cleanFolderName(name) {
  return typeof name === "string" ? name.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
}

export function hasFolder(workspace, id) {
  return workspace.folders.some((folder) => folder.id === id);
}

export function saveFolder(workspace, { id, name, icon, color }, create) {
  const cleanName = cleanFolderName(name);
  if (!cleanName) return "folderRequired";
  if (typeof id !== "string" || !id || !folderIcons.includes(icon)) throw new Error("Invalid folder");
  if (color !== undefined && color !== "default" && (typeof color !== "string" || !Object.hasOwn(palettes, color))) {
    throw new Error("Invalid folder color");
  }

  const existing = workspace.folders.find((folder) => folder.id === id);
  if (create && existing) {
    if (existing.name === cleanName && existing.icon === icon && (existing.color ?? "default") === (color ?? "default")) return;
    throw new Error("Folder ID is already in use");
  }
  if (!create && !existing) return "folderMissing";

  const nameKey = cleanName.toLowerCase();
  if (workspace.folders.some((folder) => folder.id !== id && cleanFolderName(folder.name).toLowerCase() === nameKey)) {
    return "folderDuplicate";
  }

  const changes = { name: cleanName, icon };
  if (color !== undefined) changes.color = color;
  if (existing) Object.assign(existing, changes);
  else workspace.folders = [...workspace.folders, { id, ...changes, pinned: false }];
}

export function pinFolder(workspace, { id, pinned }) {
  const folder = workspace.folders.find((item) => item.id === id);
  if (!folder) return "folderMissing";
  if (typeof pinned !== "boolean") throw new Error("Invalid folder pin state");
  if (folder.pinned === pinned) return;
  if (pinned && workspace.folders.filter((item) => item.pinned).length >= maxPinnedFolders) return "folderPinLimit";
  folder.pinned = pinned;
}

export function reorderFolder(workspace, { id, targetId, position }) {
  if (position !== "before" && position !== "after") throw new Error("Invalid folder position");
  const folder = workspace.folders.find((item) => item.id === id);
  if (!folder) return "folderMissing";
  if (id === targetId) return;

  const order = workspace.folders.filter((item) => item.id !== id);
  const targetIndex = order.findIndex((item) => item.id === targetId);
  if (targetIndex === -1) return "folderMissing";
  const insertionIndex = position === "after" ? targetIndex + 1 : targetIndex;
  order.splice(insertionIndex, 0, folder);
  workspace.folders = order;
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
