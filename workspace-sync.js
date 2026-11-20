import { readSyncedWorkspace, writeSyncedWorkspace } from "./ease-api.js";
import { localeNames } from "./locales.js";
import { getGoogleAccount, googleAccountStorageKey } from "./providers.js";
import { vaultSessionStorageKey } from "./vault-session.js";
import {
  createWorkspaceSyncSalt, decryptWorkspaceSnapshot, deriveWorkspaceSyncKey, encryptWorkspaceSnapshot
} from "./workspace-sync-crypto.js";
import { defaultWorkspace, densities, modules, palettes, readWorkspace, sizes, storageKey, themes } from "./workspace-data.js";

export const workspaceSyncMessage = "ease-workspace-sync";
export const workspaceSyncStorageKey = "easeWorkspaceSync";
const wakeAlarm = "ease-workspace-sync-poll";
const safeErrors = new Set([
  "syncSignInRequired", "syncWrongPassphrase", "syncUnavailable", "syncTooLarge", "syncInvalidData",
  "syncConflict", "syncConflictChanged", "syncPasswordLength", "syncLocked"
]);

class SyncError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function portableVault(vault) {
  const { device, ...portable } = vault;
  return portable;
}

function portableWorkspace(workspace) {
  const snapshot = Object.fromEntries(Object.keys(defaultWorkspace).map((key) => [key, workspace[key] ?? defaultWorkspace[key]]));
  const { inlineEnabled, inlineSites, ...translator } = { ...defaultWorkspace.translator, ...snapshot.translator };
  snapshot.translator = translator;
  snapshot.folders = snapshot.folders.map((folder) => folder.vault ? { ...folder, vault: portableVault(folder.vault) } : folder);
  return snapshot;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
}

function serialized(value) {
  return JSON.stringify(sortedValue(value));
}

async function fingerprint(snapshot) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized(snapshot)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readSnapshot(value) {
  const invalid = () => { throw new SyncError("syncInvalidData"); };
  if (!object(value) || !Array.isArray(value.folders) || !Array.isArray(value.snippets)
    || !Array.isArray(value.events) || !Array.isArray(value.holidays) || !Array.isArray(value.tabs)
    || !object(value.calendar) || !object(value.translator) || !object(value.flashcards)
    || !Array.isArray(value.flashcards.cards) || !Object.hasOwn(localeNames, value.locale)
    || !themes.includes(value.theme) || !Object.hasOwn(palettes, value.palette)
    || !densities.includes(value.density) || !sizes.includes(value.size)) invalid();
  const known = new Set(modules.filter(({ released }) => released).map(({ id }) => id));
  if (!value.tabs.includes("clipboard") || value.tabs.some((tab) => !known.has(tab))) invalid();
  const ids = new Set();
  const protectedFolders = new Set();
  for (const folder of value.folders) {
    if (!object(folder) || typeof folder.id !== "string" || !folder.id || ids.has(folder.id)
      || typeof folder.name !== "string" || (folder.vault && !object(folder.vault))) invalid();
    ids.add(folder.id);
    if (folder.vault) protectedFolders.add(folder.id);
  }
  if (value.snippets.some((snippet) => !object(snippet) || typeof snippet.id !== "string"
    || protectedFolders.has(snippet.folderId) !== Boolean(snippet.sealed)
    || (!snippet.sealed && typeof snippet.text !== "string"))) invalid();
  if (value.events.some((event) => !object(event) || typeof event.id !== "string" || typeof event.date !== "string")
    || value.holidays.some((day) => typeof day !== "string")) invalid();
  return portableWorkspace(value);
}

function localWorkspace(snapshot, current) {
  const existing = new Map(current.folders.map((folder) => [folder.id, folder.vault]));
  const folders = snapshot.folders.map((folder) => {
    const previous = existing.get(folder.id);
    if (!folder.vault || !previous?.device || serialized(folder.vault) !== serialized(portableVault(previous))) return folder;
    return { ...folder, vault: { ...folder.vault, device: previous.device } };
  });
  const { inlineEnabled, inlineSites } = { ...defaultWorkspace.translator, ...current.translator };
  return { ...snapshot, folders, translator: { ...snapshot.translator, inlineEnabled, inlineSites } };
}

async function keyStorage(mode, access) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ease-workspace-keys", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onerror = () => reject(new SyncError("syncUnavailable"));
    request.onsuccess = () => {
      const database = request.result;
      try {
        const transaction = database.transaction("keys", mode);
        const operation = access(transaction.objectStore("keys"));
        transaction.oncomplete = () => { database.close(); resolve(operation.result); };
        transaction.onabort = () => { database.close(); reject(new SyncError("syncUnavailable")); };
      } catch {
        database.close();
        reject(new SyncError("syncUnavailable"));
      }
    };
  });
}

const readKey = (accountId) => keyStorage("readonly", (keys) => keys.get(accountId));
const deleteKey = (accountId) => keyStorage("readwrite", (keys) => keys.delete(accountId));
const rememberKey = (accountId, entry) => keyStorage("readwrite", (keys) => keys.put(entry, accountId));

async function readMetadata() {
  return (await chrome.storage.local.get(workspaceSyncStorageKey))[workspaceSyncStorageKey] ?? {};
}

const writeMetadata = (metadata) => chrome.storage.local.set({ [workspaceSyncStorageKey]: metadata });

async function requireAccount(accountId) {
  if ((await getGoogleAccount())?.id !== accountId) throw new SyncError("syncSignInRequired");
}

async function status() {
  const accountId = (await getGoogleAccount())?.id;
  if (!accountId) return { kind: "guest" };
  const metadata = await readMetadata();
  if (!metadata.enabled || metadata.accountId !== accountId) return { kind: "disabled" };
  const saved = await readKey(accountId);
  return {
    kind: !saved || saved.salt !== metadata.salt ? "locked" : metadata.conflict ? "conflict" : "active",
    lastSyncedAt: metadata.lastSyncedAt,
    error: metadata.error,
    firstConflict: Boolean(metadata.conflict?.first)
  };
}

async function completed(accountId, salt, revision, digest) {
  await requireAccount(accountId);
  await writeMetadata({ accountId, enabled: true, salt, revision, digest, lastSyncedAt: Date.now() });
}

function saveConflict(metadata, revision, digest) {
  return writeMetadata({ ...metadata, error: undefined, conflict: { revision, digest, first: !metadata.digest } });
}

export function registerWorkspaceSyncHandlers(queueWorkspace) {
  let pending = Promise.resolve();
  let automaticPending = false;
  let idleTimer;

  function queue(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  async function synchronize(accountId, metadata, saved, remote, choice) {
    await requireAccount(accountId);
    if (remote.envelope && remote.envelope.salt !== saved.salt) {
      await deleteKey(accountId);
      throw new SyncError("syncLocked");
    }
    const snapshot = portableWorkspace(await readWorkspace());
    const digest = await fingerprint(snapshot);
    if (choice && (metadata.conflict?.revision !== remote.revision || metadata.conflict.digest !== digest)) {
      await saveConflict(metadata, remote.revision, digest);
      throw new SyncError("syncConflictChanged");
    }

    async function upload() {
      const envelope = await encryptWorkspaceSnapshot(snapshot, saved.key, saved.salt, accountId);
      const uploaded = await writeSyncedWorkspace(accountId, remote.revision, envelope);
      await completed(accountId, saved.salt, uploaded.revision, digest);
    }

    if (!remote.envelope) return upload();
    if (remote.revision === metadata.revision && metadata.digest && !choice) {
      if (digest !== metadata.digest) return upload();
      return completed(accountId, saved.salt, remote.revision, digest);
    }

    const cloud = readSnapshot(await decryptWorkspaceSnapshot(remote.envelope, saved.key, accountId));
    const cloudDigest = await fingerprint(cloud);
    if (cloudDigest === digest) return completed(accountId, saved.salt, remote.revision, digest);
    if (choice === "local" || (!choice && cloudDigest === metadata.digest)) return upload();
    const pristine = !metadata.digest && digest === await fingerprint(portableWorkspace(defaultWorkspace));
    if (choice === "cloud" || (!choice && (digest === metadata.digest || pristine))) {
      const applied = await queueWorkspace(async () => {
        await requireAccount(accountId);
        const current = await readWorkspace();
        if (digest !== await fingerprint(portableWorkspace(current))) return false;
        await requireAccount(accountId);
        await chrome.storage.session.remove(vaultSessionStorageKey);
        await chrome.storage.local.set({ [storageKey]: localWorkspace(cloud, current) });
        return true;
      });
      if (applied) return completed(accountId, saved.salt, remote.revision, cloudDigest);
      const latest = await fingerprint(portableWorkspace(await readWorkspace()));
      await saveConflict(metadata, remote.revision, latest);
      return;
    }
    await saveConflict(metadata, remote.revision, digest);
  }

  async function attempt(accountId, metadata, saved, remote, choice) {
    try {
      await synchronize(accountId, metadata, saved, remote, choice);
    } catch (error) {
      if (error?.code !== "syncConflict") throw error;
      const latest = await readSyncedWorkspace(accountId);
      await synchronize(accountId, metadata, saved, latest, choice);
    }
  }

  async function act(action, passphrase) {
    if (action === "status") return status();
    const accountId = (await getGoogleAccount())?.id;
    if (!accountId) throw new SyncError("syncSignInRequired");
    const stored = await readMetadata();
    const metadata = stored.accountId === accountId ? stored : {};
    if (action === "disable") {
      await deleteKey(accountId);
      if (stored.accountId === accountId) await writeMetadata({ ...metadata, enabled: false, error: undefined });
      return status();
    }
    if (action === "enable") {
      if (typeof passphrase !== "string" || Array.from(passphrase).length < 10 || passphrase.length > 256) {
        throw new SyncError("syncPasswordLength");
      }
      const remote = await readSyncedWorkspace(accountId);
      const salt = remote.envelope?.salt ?? metadata.salt ?? createWorkspaceSyncSalt();
      const key = await deriveWorkspaceSyncKey(passphrase, salt);
      if (remote.envelope) await decryptWorkspaceSnapshot(remote.envelope, key, accountId);
      await requireAccount(accountId);
      const saved = { key, salt };
      await rememberKey(accountId, saved);
      const updated = { ...metadata, accountId, salt, enabled: true, error: undefined };
      await writeMetadata(updated);
      await attempt(accountId, updated, saved, remote);
      return status();
    }
    if (!["sync", "cloud", "local"].includes(action) || !metadata.enabled) throw new SyncError("syncLocked");
    const saved = await readKey(accountId);
    if (!saved || saved.salt !== metadata.salt) throw new SyncError("syncLocked");
    const choice = action === "sync" ? undefined : action;
    await attempt(accountId, metadata, saved, await readSyncedWorkspace(accountId), choice);
    return status();
  }

  function schedule(delay = 1_200) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (automaticPending) {
        schedule();
        return;
      }
      automaticPending = true;
      queue(async () => {
        const owner = (await getGoogleAccount())?.id;
        if (!owner) return;
        const metadata = await readMetadata();
        if (!metadata.enabled || metadata.accountId !== owner || metadata.conflict || !await readKey(owner)) return;
        try {
          await act("sync");
        } catch (error) {
          const current = await readMetadata();
          if ((await getGoogleAccount())?.id !== owner || current.accountId !== owner) return;
          const code = safeErrors.has(error?.code) ? error.code : "syncUnavailable";
          if (current.error !== code) await writeMetadata({ ...current, error: code });
        }
      }).catch(() => {}).finally(() => { automaticPending = false; });
    }, delay);
  }

  const start = () => chrome.alarms?.create(wakeAlarm, { periodInMinutes: 1 }).catch(() => {});
  chrome.runtime.onInstalled?.addListener(start);
  chrome.runtime.onStartup?.addListener(start);
  chrome.alarms?.onAlarm.addListener((alarm) => { if (alarm.name === wakeAlarm) schedule(0); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[storageKey]) schedule();
    const account = changes[googleAccountStorageKey];
    if (account?.oldValue?.id && account.oldValue.id !== account.newValue?.id) {
      queue(() => deleteKey(account.oldValue.id)).catch(() => {});
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== workspaceSyncMessage || sender.id !== chrome.runtime.id) return;
    const url = chrome.runtime.getURL("workspace.html");
    if (sender.url !== url && !sender.url?.startsWith(`${url}?`)) return;
    if (message.action === "wake") {
      start();
      schedule();
      respond({ ok: true });
      return false;
    }
    const result = message.action === "status" ? status() : queue(() => act(message.action, message.passphrase));
    result.then((value) => respond({ status: value }), (error) => {
      respond({ error: safeErrors.has(error?.code) ? error.code : "syncUnavailable" });
    });
    return true;
  });
}
