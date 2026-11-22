export const clipboardHistoryKey = "easeClipboardHistory";
export const clipboardHistoryMessage = "ease-clipboard-history";
export const maxClipboardHistoryTextLength = 20_000;

const maxEntries = 100;
const maxHistoryBytes = 2_000_000;
const utf8 = new TextEncoder();
let pendingWrite = Promise.resolve();

function isClipboardText(text) {
  return typeof text === "string" && text.length <= maxClipboardHistoryTextLength
    && Boolean(text.trim()) && text.isWellFormed();
}

export async function loadClipboardHistory(storage = chrome.storage.local) {
  const { [clipboardHistoryKey]: saved } = await storage.get(clipboardHistoryKey);
  const entries = Array.isArray(saved?.entries) ? saved.entries.slice(0, maxEntries) : [];
  return {
    enabled: saved?.enabled === true,
    entries: entries.filter((entry) => typeof entry?.id === "string" && Number.isFinite(entry.createdAt)
      && isClipboardText(entry.text))
  };
}

function updateHistory(update) {
  const queued = pendingWrite.then(async () => {
    const history = await loadClipboardHistory();
    const next = update(history);
    if (next !== history) await chrome.storage.local.set({ [clipboardHistoryKey]: next });
    return next;
  });
  pendingWrite = queued.catch(() => {});
  return queued;
}

export function setClipboardHistoryEnabled(enabled) {
  return updateHistory((history) => enabled === history.enabled ? history : { ...history, enabled });
}

export function recordClipboardHistoryText(text) {
  return updateHistory((history) => {
    if (!history.enabled || !isClipboardText(text) || history.entries[0]?.text === text) return history;

    const entry = { id: crypto.randomUUID(), text, createdAt: Date.now() };
    const entries = [entry, ...history.entries].slice(0, maxEntries);
    // Allow space for snippets and other modules sharing Chrome's local storage.
    let bytesLeft = maxHistoryBytes;
    for (const [index, item] of entries.entries()) {
      bytesLeft -= utf8.encode(JSON.stringify(item)).length + 1;
      if (bytesLeft < 0) return { ...history, entries: entries.slice(0, index) };
    }
    return { ...history, entries };
  });
}

export function removeClipboardHistoryEntry(id) {
  return updateHistory((history) => {
    const entries = history.entries.filter((entry) => entry.id !== id);
    return entries.length === history.entries.length ? history : { ...history, entries };
  });
}

export function clearClipboardHistory() {
  return updateHistory((history) => history.entries.length ? { ...history, entries: [] } : history);
}
