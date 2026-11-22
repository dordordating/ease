import {
  clearClipboardHistory, clipboardHistoryMessage, loadClipboardHistory, maxClipboardHistoryTextLength,
  recordClipboardHistoryText, removeClipboardHistoryEntry, setClipboardHistoryEnabled
} from "./clipboard-history-store.js";

const captureMessage = "ease-clipboard-history-capture";
const readerPath = "clipboard-history-offscreen.html";
const recoveryAlarm = "ease-clipboard-history";
const permission = { permissions: ["clipboardRead"] };
const protectedCopiesKey = "easeProtectedClipboardCopies";
const maxProtectedCopies = 32;
let pending = Promise.resolve();

function queue(operation) {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}

function readerUrl() {
  return chrome.runtime.getURL(readerPath);
}

function currentReaderUrl(url) {
  const prefix = `${readerUrl()}?reader=`;
  return typeof url === "string" && url.startsWith(prefix)
    && /^[a-f0-9-]{36}$/u.test(url.slice(prefix.length));
}

async function readerContexts() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.filter(({ documentUrl }) => documentUrl === readerUrl() || currentReaderUrl(documentUrl));
}

async function closeReader() {
  if ((await readerContexts()).length) await chrome.offscreen.closeDocument();
}

async function stopReader() {
  await Promise.all([closeReader(), chrome.alarms.clear(recoveryAlarm)]);
}

async function ensureReader() {
  // Chrome 116 uses a one-minute minimum for periodic alarms.
  if (!await chrome.alarms.get(recoveryAlarm)) {
    await chrome.alarms.create(recoveryAlarm, { periodInMinutes: 1 });
  }
  const [reader] = await readerContexts();
  if (reader && currentReaderUrl(reader.documentUrl)) return;
  if (reader) await chrome.offscreen.closeDocument();
  await chrome.offscreen.createDocument({
    url: `${readerPath}?reader=${crypto.randomUUID()}`,
    reasons: ["CLIPBOARD"],
    justification: "Keep a device-only history of copied text when the user chooses to record it."
  });
}

async function disableHistory() {
  const history = await setClipboardHistoryEnabled(false);
  await stopReader();
  return history;
}

async function restoreHistory() {
  const [saved, allowed] = await Promise.all([loadClipboardHistory(), chrome.permissions.contains(permission)]);
  const history = saved.enabled && !allowed ? await disableHistory() : saved;
  if (history.enabled) await ensureReader();
  return { ok: true, history, allowed };
}

async function enableHistory() {
  if (!await chrome.permissions.contains(permission)) {
    return { ok: false, error: "clipboardHistoryPermission" };
  }
  const saved = await loadClipboardHistory();
  try {
    await ensureReader();
    const history = await setClipboardHistoryEnabled(true);
    return { ok: true, history, allowed: true };
  } catch (error) {
    if (!saved.enabled) await stopReader().catch(() => {});
    throw error;
  }
}

async function workspaceAction(message) {
  switch (message.action) {
    case "read":
      return restoreHistory();
    case "allow":
      return enableHistory();
    case "set-enabled": {
      if (message.enabled === true) return enableHistory();
      if (message.enabled !== false) break;
      const history = await disableHistory();
      return { ok: true, history, allowed: await chrome.permissions.contains(permission) };
    }
    case "clear":
      // Restart from the system clipboard's current value. Any messages from
      // the old reader come from a different URL and cannot repopulate the list.
      await closeReader();
      await clearClipboardHistory();
      return restoreHistory();
    case "remove": {
      const history = await removeClipboardHistoryEntry(message.id);
      return { ok: true, history, allowed: await chrome.permissions.contains(permission) };
    }
  }
  throw new Error("Invalid clipboard history action");
}

async function fingerprint(text) {
  // Some clipboard implementations convert newlines.
  const nativeText = text.replace(/\r\n?/gu, "\n");
  if (!nativeText || nativeText.length > maxClipboardHistoryTextLength) return null;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nativeText));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readProtectedCopies() {
  const { [protectedCopiesKey]: values } = await chrome.storage.session.get(protectedCopiesKey);
  return Array.isArray(values) ? values : [];
}

export function suppressClipboardHistoryText(text) {
  return queue(async () => {
    if (typeof text !== "string") throw new Error("Invalid protected clipboard copy");
    // Some native text formats are NUL-terminated.
    const nul = text.indexOf("\0");
    const candidates = nul > 0 ? [text, text.slice(0, nul)] : [text];
    const added = (await Promise.all(candidates.map(fingerprint))).filter(Boolean);
    if (!added.length) return;
    const previous = await readProtectedCopies();
    const signatures = [...new Set([...added, ...previous])].slice(0, maxProtectedCopies);
    // Keep only fingerprints for this browser session, including while paused
    // in case another workspace resumes recording before the OS write.
    await chrome.storage.session.set({ [protectedCopiesKey]: signatures });
  });
}

async function recordCapture(text, sourceUrl) {
  if (typeof text !== "string" || text.length > maxClipboardHistoryTextLength || !text.trim()) return;
  if (!(await readerContexts()).some(({ documentUrl }) => documentUrl === sourceUrl)) return;
  const signatures = await readProtectedCopies();
  if (signatures.length && signatures.includes(await fingerprint(text))) return;
  if (await chrome.permissions.contains(permission)) await recordClipboardHistoryText(text);
}

function trustedSender(sender) {
  return sender.id === chrome.runtime.id && (sender.frameId === undefined || sender.frameId === 0);
}

function fromWorkspace(sender) {
  const url = chrome.runtime.getURL("workspace.html");
  return sender.url === url || sender.url?.startsWith(`${url}?`);
}

function handleMessage(message, sender, respond) {
  if (!trustedSender(sender)) return;
  // Chrome may omit documentId for extension documents with no browser tab.
  if (message?.type === captureMessage && !sender.tab && currentReaderUrl(sender.url)) {
    queue(() => recordCapture(message.text, sender.url)).then(
      () => respond({ ok: true }), () => respond({ ok: false })
    );
    return true;
  }
  if (message?.type !== clipboardHistoryMessage || !fromWorkspace(sender)) return;
  // Send the permission request on the first hop while Chrome still treats
  // the message as a user gesture. The toolbar popup may close during it.
  const result = message.action === "allow"
    ? chrome.permissions.request(permission).catch(() => false).then((allowed) => allowed
      ? queue(() => workspaceAction(message)) : { ok: false, error: "clipboardHistoryPermission" })
    : queue(() => workspaceAction(message));
  result.then(respond, () => respond({ ok: false, error: "clipboardHistoryUnavailable" }));
  return true;
}

export function registerClipboardHistoryHandlers() {
  const restore = () => { queue(restoreHistory).catch(() => {}); };
  chrome.runtime.onMessage.addListener(handleMessage);
  chrome.runtime.onInstalled?.addListener(restore);
  chrome.runtime.onStartup?.addListener(restore);
  chrome.permissions.onRemoved?.addListener(({ permissions }) => {
    if (permissions?.includes("clipboardRead")) queue(disableHistory).catch(() => {});
  });
  chrome.alarms.onAlarm.addListener(({ name }) => {
    if (name === recoveryAlarm) restore();
  });
}
