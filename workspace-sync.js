import { readLegacyWorkspace, readSyncedWorkspace, writeSyncedWorkspace } from "./ease-api.js";
import { localeNames } from "./locales.js";
import { getGoogleAccount, googleAccountStorageKey } from "./providers.js";
import { vaultSessionStorageKey } from "./vault-session.js";
import { defaultTodo, restoreTodo } from "./todo-store.js";
import { restoreSpaces } from "./spaces-store.js";
import { restoreShopping } from "./shopping-store.js";
import { defaultHome, normalizeHome } from "./home-store.js";
import { importedGuestWorkspace, legacyWorkspaceSyncStorageKey, workspaceStore } from "./workspace-accounts.js";
import {
  decryptWorkspaceSnapshot, encryptWorkspaceSnapshot, importWorkspaceAccountKey
} from "./workspace-sync-crypto.js";
import {
  defaultModuleOrder, defaultWorkspace, densities, normalizeModuleOrder, normalizeWorkspaceZoom, palettes, readWorkspace,
  sizes, storageKey, themes
} from "./workspace-data.js";

export const workspaceSyncMessage = "ease-workspace-sync";
export const workspaceSyncStorageKey = "easeAccountWorkspaceSync";
const wakeAlarm = "ease-workspace-sync-poll";
const safeErrors = new Set([
  "syncSignInRequired", "syncUnavailable", "syncTooLarge", "syncInvalidData",
  "syncConflict", "syncConflictChanged", "syncLegacyPending"
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
  // Keep the canonical snapshot stable for devices that have no custom rail order or zoom.
  const moduleOrder = normalizeModuleOrder(workspace.moduleOrder);
  if (moduleOrder.some((id, index) => id !== defaultModuleOrder[index])) snapshot.moduleOrder = moduleOrder;
  snapshot.zoom = normalizeWorkspaceZoom(snapshot.zoom);
  if (snapshot.zoom === defaultWorkspace.zoom) delete snapshot.zoom;
  snapshot.home = normalizeHome(snapshot.home);
  if (serialized(snapshot.home) === serialized(defaultHome)) delete snapshot.home;
  const { labels, layout, ...tasks } = snapshot.todo;
  snapshot.todo = { ...tasks, ...(labels?.length ? { labels } : {}), ...(layout === "stacked" ? { layout } : {}) };
  if (!tasks.items.length && !tasks.dailyTime && !tasks.retentionDays && !labels?.length && layout !== "stacked") delete snapshot.todo;
  if (!snapshot.spaces.length) delete snapshot.spaces;
  if (!snapshot.shopping.length) delete snapshot.shopping;
  if (snapshot.calendar.showTasks === true) {
    const { showTasks, ...calendar } = snapshot.calendar;
    snapshot.calendar = calendar;
  }
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
  if (!value.tabs.includes("clipboard") || value.tabs.some((tab) => !defaultModuleOrder.includes(tab))) invalid();
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
  const todo = restoreTodo(value.todo);
  const spaces = restoreSpaces(value.spaces);
  const shopping = restoreShopping(value.shopping);
  if (!todo || !spaces || !shopping) invalid();
  return portableWorkspace({ ...value, todo, spaces, shopping });
}

function localWorkspace(snapshot, current) {
  const existing = new Map(current.folders.map((folder) => [folder.id, folder.vault]));
  const folders = snapshot.folders.map((folder) => {
    const previous = existing.get(folder.id);
    if (!folder.vault || !previous?.device || serialized(folder.vault) !== serialized(portableVault(previous))) return folder;
    return { ...folder, vault: { ...folder.vault, device: previous.device } };
  });
  const { inlineEnabled, inlineSites } = { ...defaultWorkspace.translator, ...current.translator };
  return { ...snapshot, spaces: snapshot.spaces ?? [], shopping: snapshot.shopping ?? [],
    todo: snapshot.todo ?? defaultTodo, home: normalizeHome(snapshot.home), folders,
    translator: { ...snapshot.translator, inlineEnabled, inlineSites } };
}

async function requireAccount(accountId) {
  if ((await getGoogleAccount())?.id !== accountId) throw new SyncError("syncSignInRequired");
}

async function allMetadata() {
  return (await chrome.storage.local.get(workspaceSyncStorageKey))[workspaceSyncStorageKey] ?? {};
}

async function readMetadata(accountId) {
  return (await allMetadata())[accountId] ?? {};
}

async function writeMetadata(accountId, metadata) {
  await requireAccount(accountId);
  const stored = await allMetadata();
  if (serialized(stored[accountId] ?? {}) !== serialized(metadata)) {
    await requireAccount(accountId);
    await chrome.storage.local.set({ [workspaceSyncStorageKey]: { ...stored, [accountId]: metadata } });
  }
}

async function status() {
  const accountId = (await getGoogleAccount())?.id;
  if (!accountId) return { kind: "guest" };
  const metadata = await readMetadata(accountId);
  return {
    accountId,
    kind: metadata.conflict ? "conflict" : metadata.lastSyncedAt ? "active" : "pending",
    lastSyncedAt: metadata.lastSyncedAt,
    error: metadata.error,
    firstConflict: Boolean(metadata.conflict?.first)
  };
}

function completed(accountId, revision, digest) {
  return writeMetadata(accountId, { revision, digest, lastSyncedAt: Date.now() });
}

function saveConflict(accountId, metadata, remote, digest) {
  return writeMetadata(accountId, {
    ...metadata, error: undefined,
    conflict: { revision: remote.revision, legacyRevision: remote.legacyRevision, digest, first: !metadata.digest }
  });
}

async function legacyMetadata(accountId) {
  const previous = (await chrome.storage.local.get(legacyWorkspaceSyncStorageKey))[legacyWorkspaceSyncStorageKey];
  return previous?.accountId === accountId ? previous : {};
}

async function legacyWorkspace(accountId, remote, snapshot, digest, pristine, metadata) {
  const saved = await workspaceStore("ease-workspace-keys", "keys", "readonly", store => store.get(accountId));
  if (saved) {
    const legacy = await readLegacyWorkspace(accountId);
    if (legacy.revision !== remote.legacyRevision) throw new SyncError("syncConflict");
    if (legacy.envelope?.salt === saved.salt) {
      const cloud = readSnapshot(await decryptWorkspaceSnapshot(legacy.envelope, saved.key, accountId));
      return { cloud, baseline: metadata.digest };
    }
  }
  // The old browser may still hold its local copy after its legacy key was cleared.
  if (metadata.revision === remote.legacyRevision && metadata.digest && (!pristine || metadata.digest === digest)) {
    return { cloud: snapshot, baseline: metadata.digest };
  }
  throw new SyncError("syncLegacyPending");
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

  function capture(accountId) {
    return queueWorkspace(async () => {
      await requireAccount(accountId);
      return portableWorkspace(await readWorkspace());
    });
  }

  async function synchronize(accountId, metadata, remote, choice) {
    const snapshot = await capture(accountId);
    const digest = await fingerprint(snapshot);
    const conflict = metadata.conflict;
    if (choice && (conflict?.revision !== remote.revision || conflict?.legacyRevision !== remote.legacyRevision
      || conflict?.digest !== digest)) {
      await saveConflict(accountId, metadata, remote, digest);
      throw new SyncError("syncConflictChanged");
    }

    const key = await importWorkspaceAccountKey(remote.key);
    async function upload(value = snapshot, hash = digest) {
      const envelope = await encryptWorkspaceSnapshot(value, key, remote.salt, accountId);
      const uploaded = await writeSyncedWorkspace(accountId, remote.revision, envelope, { legacyRevision: remote.legacyRevision });
      await completed(accountId, uploaded.revision, hash);
    }

    if (!remote.envelope && !remote.legacyRevision) return upload();
    if (!choice && remote.revision && remote.revision === metadata.revision && metadata.digest) {
      if (digest !== metadata.digest) return upload();
      if (metadata.error || metadata.conflict) await completed(accountId, remote.revision, digest);
      return;
    }

    const pristine = !metadata.digest && digest === await fingerprint(portableWorkspace(defaultWorkspace));
    const previous = metadata.digest ? {} : await legacyMetadata(accountId);
    const { cloud, baseline } = remote.envelope
      ? { cloud: readSnapshot(await decryptWorkspaceSnapshot(remote.envelope, key, accountId)), baseline: metadata.digest ?? previous.digest }
      : await legacyWorkspace(accountId, remote, snapshot, digest, pristine, previous);
    const cloudDigest = await fingerprint(cloud);
    if (cloudDigest === digest) {
      return remote.revision ? completed(accountId, remote.revision, digest) : upload();
    }
    if (choice === "local" || (!choice && cloudDigest === baseline)) return upload();
    const guestCopy = !choice && !metadata.digest ? await importedGuestWorkspace(accountId) : undefined;
    const guestSeed = guestCopy && digest === await fingerprint(portableWorkspace({ ...defaultWorkspace, ...guestCopy }));
    if (choice === "cloud" || (!choice && (digest === baseline || pristine || guestSeed))) {
      const applied = await queueWorkspace(async () => {
        await requireAccount(accountId);
        const current = await readWorkspace();
        if (digest !== await fingerprint(portableWorkspace(current))) return false;
        await requireAccount(accountId);
        await chrome.storage.session.remove(vaultSessionStorageKey);
        await chrome.storage.local.set({ [storageKey]: localWorkspace(cloud, current) });
        return true;
      });
      if (applied) return remote.revision ? completed(accountId, remote.revision, cloudDigest) : upload(cloud, cloudDigest);
    }
    await saveConflict(accountId, metadata, remote, await fingerprint(await capture(accountId)));
  }

  async function act(action, accountId) {
    accountId ??= (await getGoogleAccount())?.id;
    if (!accountId) throw new SyncError("syncSignInRequired");
    await requireAccount(accountId);
    const metadata = await readMetadata(accountId);
    const choice = action === "sync" ? undefined : action;
    if (choice && (!["cloud", "local"].includes(choice) || !metadata.conflict)) throw new SyncError("syncConflictChanged");
    const read = () => readSyncedWorkspace(accountId);
    try {
      await synchronize(accountId, metadata, await read(), choice);
    } catch (error) {
      if (error?.code !== "syncConflict") throw error;
      await synchronize(accountId, metadata, await read(), choice);
    }
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
        const accountId = (await getGoogleAccount())?.id;
        if (!accountId) return;
        try {
          await act("sync", accountId);
        } catch (error) {
          if ((await getGoogleAccount())?.id !== accountId) return;
          const metadata = await readMetadata(accountId);
          const code = safeErrors.has(error?.code) ? error.code : "syncUnavailable";
          if (metadata.error !== code) await writeMetadata(accountId, { ...metadata, error: code });
        }
      }).catch(() => {}).finally(() => { automaticPending = false; });
    }, delay);
  }

  function start() {
    chrome.alarms?.create(wakeAlarm, { periodInMinutes: 1 }).catch(() => {});
    schedule(0);
  }
  chrome.runtime.onInstalled?.addListener(start);
  chrome.runtime.onStartup?.addListener(start);
  chrome.alarms?.onAlarm.addListener(alarm => { if (alarm.name === wakeAlarm) schedule(0); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const account = changes[googleAccountStorageKey];
    if (account && account.oldValue?.id !== account.newValue?.id) schedule(0);
    else if (changes[storageKey]) schedule();
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== workspaceSyncMessage || sender.id !== chrome.runtime.id) return;
    const url = chrome.runtime.getURL("workspace.html");
    if (sender.url !== url && !sender.url?.startsWith(`${url}?`)) return;
    if (message.action === "wake") {
      start();
      respond({ ok: true });
      return false;
    }
    const result = message.action === "status" ? status() : queue(() => act(message.action, message.accountId));
    result.then(value => respond({ status: value }), error => {
      respond({ error: safeErrors.has(error?.code) ? error.code : "syncUnavailable" });
    });
    return true;
  });
}
