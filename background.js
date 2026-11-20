import { defaultTranslator, densities, modules, palettes, readWorkspace, shortcutSlots, sizes, storageKey, themes, translatorEngines } from "./workspace-data.js";
import { localeNames } from "./locales.js";
import { setToolbarBrand } from "./brand.js";
import { changeCalendarPreferences, saveCalendarEvent, setCalendarHoliday } from "./calendar-store.js";
import { refreshConnectedGoogleCalendar, registerGoogleProviderHandlers } from "./providers.js";
import { getAppleCalendarState, syncAppleCalendar } from "./apple-calendar.js";
import { deleteFolder, hasFolder, moveSnippet, pinFolder, reorderFolder, saveFolder } from "./clipboard-store.js";
import { translatorLanguages } from "./translator-engine.js";
import { easeTranslationMessage, handleEaseTranslationMessage } from "./ease-api.js";
import { changeFlashcardPreferences, FlashcardError, removeFlashcard, reviewFlashcard, saveFlashcard } from "./flashcard-store.js";
import { registerTranslatorSelectionHandlers } from "./translator-selection.js";
import {
  configureInlineTranslator, injectInlineTranslatorOnActiveTab, registerTranslatorSiteHandlers,
  requestInlineTranslatorPermission
} from "./translator-site-access.js";
import {
  createFolderPin, createFolderVault, openSnippet, rewrapFolderPin, sealSnippet, unlockFolderPin, unlockFolderVault,
  unwrapDeviceKey, wrapDeviceKey
} from "./folder-vault.js";
import {
  activeVaultSession, clearVaultPinAttempts, defaultVaultPolicy, lockVaultSession, readVaultPinAttempts,
  readVaultSessions, reserveVaultPinAttempt, unlockVaultSession, vaultExpiryAlarm, vaultPinRetryAt, vaultPolicyFor
} from "./vault-session.js";

let pendingWrite = Promise.resolve();
registerGoogleProviderHandlers();
registerTranslatorSelectionHandlers();
registerTranslatorSiteHandlers();

function queueWorkspace(operation) {
  const result = pendingWrite.then(operation);
  pendingWrite = result.catch(() => {});
  return result;
}

const syncAlarm = "ease-calendar-sync";
async function initializeBrowser() {
  const { palette } = await readWorkspace();
  await Promise.all([
    setToolbarBrand(palette),
    chrome.alarms.create(syncAlarm, { periodInMinutes: 60 })
  ]);
}

chrome.runtime.onInstalled?.addListener(() => { initializeBrowser().catch(() => {}); });
chrome.runtime.onStartup?.addListener(() => { initializeBrowser().catch(() => {}); });
chrome.storage.onChanged.addListener(({ [storageKey]: change }, area) => {
  if (area === "local" && change?.newValue?.palette && change.newValue.palette !== change.oldValue?.palette) {
    setToolbarBrand(change.newValue.palette).catch(() => {});
  }
});
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === vaultExpiryAlarm) {
    queueWorkspace(readVaultSessions).catch(() => {});
    return;
  }
  if (alarm.name !== syncAlarm) return;
  Promise.allSettled([
    refreshConnectedGoogleCalendar(),
    getAppleCalendarState().then(({ connected }) => connected && syncAppleCalendar())
  ]);
});

class VaultLockedError extends Error {}

function folderFor(workspace, id) {
  return workspace.folders.find(folder => folder.id === id);
}

function unlockedKey(sessions, folder) {
  if (!folder?.vault) return undefined;
  const session = activeVaultSession(sessions, folder.id);
  if (!session) throw new VaultLockedError();
  return session.key;
}

function snippetAccess(workspace, sessions, snippet) {
  const key = unlockedKey(sessions, folderFor(workspace, snippet.folderId));
  if (Boolean(snippet.sealed) !== Boolean(key)) throw new Error("Invalid vault snippet state");
  return key;
}

function snippetMetadata({ id, folderId, pinned, slot, customShortcut }) {
  return {
    id, folderId, pinned,
    ...(slot === undefined ? {} : { slot }),
    ...(customShortcut === undefined ? {} : { customShortcut })
  };
}

async function hydrateWorkspace(workspace, sessions) {
  const vaultFolders = new Map();
  const pinAttempts = workspace.folders.some(({ vault }) => vault?.mode === "pin")
    ? await readVaultPinAttempts()
    : new Map();
  const folders = workspace.folders.map(({ vault, ...folder }) => {
    if (!vault) return folder;
    vaultFolders.set(folder.id, activeVaultSession(sessions, folder.id));
    const device = vault.device;
    return {
      ...folder,
      protected: true,
      vaultMode: vault.mode === "pin" ? "pin" : "password",
      ...(vault.mode === "pin" ? { pinRetryAt: vaultPinRetryAt(pinAttempts, folder.id) } : {}),
      vaultPolicy: vaultPolicyFor(folder.vaultPolicy),
      unlockedUntil: vaultFolders.get(folder.id)?.expiresAt ?? null,
      ...(device ? { device: { credentialId: device.credentialId, salt: device.salt } } : {})
    };
  });
  const snippets = await Promise.all(workspace.snippets.map(async (snippet) => {
    if (!snippet.sealed && !vaultFolders.has(snippet.folderId)) return snippet;
    const session = vaultFolders.get(snippet.folderId);
    if (session && snippet.sealed) {
      try {
        const opened = await openSnippet(snippet, session.key);
        if (session.expiresAt > Date.now()) return { ...opened, protected: true };
      } catch {
        // An unreadable payload must never fall back to stored plaintext.
      }
    }
    return { ...snippetMetadata(snippet), protected: true, locked: true };
  }));
  return { ...workspace, folders, snippets };
}

function decodeDeviceBytes(input, minimum, maximum = minimum) {
  if (typeof input !== "string" || input.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9_-]+$/u.test(input)) {
    throw new Error("Invalid device credential");
  }
  const binary = atob(input.replace(/-/gu, "+").replace(/_/gu, "/"));
  const canonical = btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  if (canonical !== input || binary.length < minimum || binary.length > maximum) {
    throw new Error("Invalid device credential");
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function unsealFolder(workspace, folder, key) {
  if (!folder.vault) return;
  workspace.snippets = await Promise.all(workspace.snippets.map(snippet => (
    snippet.folderId === folder.id ? openSnippet(snippet, key) : snippet
  )));
}

function validPin(pin) {
  return typeof pin === "string" && pin.length === 4 && /^[0-9]{4}$/u.test(pin);
}

async function updateVault(workspace, action, data, transaction) {
  const { sessions } = transaction;
  const folder = folderFor(workspace, data.id);
  if (!folder) return "folderMissing";
  if (action === "protect-folder") {
    if (folder.vault) return "vaultLocked";
    const { pin, password, policy = defaultVaultPolicy } = data;
    if (policy !== vaultPolicyFor(policy)) throw new Error("Invalid vault lock policy");
    if (pin !== undefined) {
      if (!validPin(pin)) return "vaultPinFormat";
    } else {
      if (typeof password !== "string" || password.length > 256 || !password.isWellFormed()) return "vaultPasswordLength";
      const length = Array.from(password).length;
      if (length < 8 || length > 128) return "vaultPasswordLength";
    }
    const { vault, key } = pin === undefined
      ? await createFolderVault(password, folder.id)
      : await createFolderPin(pin, folder.id);
    workspace.snippets = await Promise.all(workspace.snippets.map(snippet => (
      snippet.folderId === folder.id ? sealSnippet(snippet, key) : snippet
    )));
    await lockVaultSession(sessions, folder.id);
    folder.vault = vault;
    folder.vaultPolicy = policy;
    // Commit ciphertext before granting access. Failure to start a session leaves the folder locked.
    transaction.afterCommit = async () => {
      if (pin !== undefined) await clearVaultPinAttempts(folder.id);
      await unlockVaultSession(sessions, folder.id, key, policy).catch(() => {});
    };
    return;
  }
  if (!folder.vault) return "vaultLocked";

  switch (action) {
    case "unlock-folder": {
      const usesPin = folder.vault.mode === "pin";
      if (usesPin) {
        if (!validPin(data.pin)) return "vaultPinFormat";
        if (!await reserveVaultPinAttempt(folder.id)) return "vaultPinWait";
      }
      let key;
      try {
        key = usesPin
          ? await unlockFolderPin(data.pin, folder.id, folder.vault)
          : await unlockFolderVault(data.password, folder.id, folder.vault);
      } catch {
        return usesPin ? "vaultPinInvalid" : "vaultPasswordInvalid";
      }
      if (usesPin) await clearVaultPinAttempts(folder.id);
      await unlockVaultSession(sessions, folder.id, key, folder.vaultPolicy);
      transaction.writeWorkspace = false;
      break;
    }
    case "lock-folder":
      await lockVaultSession(sessions, folder.id);
      transaction.writeWorkspace = false;
      break;
    case "set-vault-policy": {
      const { policy } = data;
      if (policy !== vaultPolicyFor(policy)) throw new Error("Invalid vault lock policy");
      const key = unlockedKey(sessions, folder);
      folder.vaultPolicy = policy;
      transaction.afterCommit = async () => {
        try {
          await unlockVaultSession(sessions, folder.id, key, policy);
        } catch (error) {
          await lockVaultSession(sessions, folder.id).catch(() => {});
          throw error;
        }
      };
      break;
    }
    case "set-vault-pin": {
      const key = unlockedKey(sessions, folder);
      if (!validPin(data.pin)) return "vaultPinFormat";
      const { device } = folder.vault;
      folder.vault = await rewrapFolderPin(data.pin, folder.id, key);
      if (device) folder.vault.device = device;
      transaction.afterCommit = () => clearVaultPinAttempts(folder.id);
      break;
    }
    case "unprotect-folder": {
      const key = unlockedKey(sessions, folder);
      const usesPin = folder.vault.mode === "pin";
      await unsealFolder(workspace, folder, key);
      delete folder.vault;
      delete folder.vaultPolicy;
      transaction.afterCommit = async () => {
        await lockVaultSession(sessions, folder.id).catch(() => {});
        if (usesPin) await clearVaultPinAttempts(folder.id);
      };
      break;
    }
    case "protect-device": {
      const key = unlockedKey(sessions, folder);
      let prf;
      try {
        decodeDeviceBytes(data.credentialId, 1, 1023);
        decodeDeviceBytes(data.salt, 32);
        prf = decodeDeviceBytes(data.prf, 32);
        const wrapped = await wrapDeviceKey(folder.id, key, prf);
        folder.vault.device = { credentialId: data.credentialId, salt: data.salt, wrapped };
      } catch {
        return "vaultDeviceFailed";
      } finally {
        prf?.fill(0);
      }
      break;
    }
    case "unlock-device": {
      if (!folder.vault.device) return "vaultDeviceFailed";
      let prf;
      try {
        prf = decodeDeviceBytes(data.prf, 32);
        const key = await unwrapDeviceKey(folder.id, folder.vault.device.wrapped, prf);
        if (folder.vault.mode === "pin") await clearVaultPinAttempts(folder.id);
        await unlockVaultSession(sessions, folder.id, key, folder.vaultPolicy);
        transaction.writeWorkspace = false;
      } catch {
        return "vaultDeviceFailed";
      } finally {
        prf?.fill(0);
      }
      break;
    }
    case "remove-device":
      unlockedKey(sessions, folder);
      delete folder.vault.device;
      break;
  }
}

async function updateWorkspace(workspace, action, data, transaction) {
  const { sessions } = transaction;
  switch (action) {
    case "preferences":
      if (Object.hasOwn(localeNames, data.locale)) workspace.locale = data.locale;
      if (themes.includes(data.theme)) workspace.theme = data.theme;
      if (Object.hasOwn(palettes, data.palette)) workspace.palette = data.palette;
      if (densities.includes(data.density)) workspace.density = data.density;
      if (sizes.includes(data.size)) workspace.size = data.size;
      break;
    case "calendar-preferences":
      changeCalendarPreferences(workspace, data);
      break;
    case "translator-preferences": {
      const settings = { ...defaultTranslator, ...workspace.translator };
      if (translatorEngines.includes(data.engine)) settings.engine = data.engine;
      if (data.source === "auto" || translatorLanguages.includes(data.source)) settings.source = data.source;
      if (translatorLanguages.includes(data.target)) settings.target = data.target;
      if (["both", "result"].includes(data.layout)) settings.layout = data.layout;
      if (data.folderId === null || hasFolder(workspace, data.folderId)) settings.folderId = data.folderId;
      workspace.translator = settings;
      break;
    }
    case "translator-inline-enabled": {
      if (typeof data.enabled !== "boolean") return "translatorInlineFailed";
      const settings = { ...defaultTranslator, ...workspace.translator };
      try {
        await configureInlineTranslator(data.enabled);
      } catch {
        return "translatorInlineFailed";
      }
      workspace.translator = { ...settings, inlineEnabled: data.enabled, inlineSites: [] };
      if (data.enabled) transaction.afterCommit = injectInlineTranslatorOnActiveTab;
      break;
    }
    case "flashcard-preferences":
      workspace.flashcards = changeFlashcardPreferences(workspace.flashcards, data);
      break;
    case "save-flashcard":
      workspace.flashcards = saveFlashcard(workspace.flashcards, data);
      if (data.showModule === true && !workspace.tabs.includes("flashcards")) {
        workspace.tabs.push("flashcards");
        workspace.flashcards = changeFlashcardPreferences(workspace.flashcards, { language: data.language });
      }
      break;
    case "remove-flashcard":
      workspace.flashcards = removeFlashcard(workspace.flashcards, data.id);
      break;
    case "review-flashcard":
      workspace.flashcards = reviewFlashcard(workspace.flashcards, data);
      break;
    case "calendar-holiday":
      setCalendarHoliday(workspace, data);
      break;
    case "save-event":
      return saveCalendarEvent(workspace, data);
    case "delete-event":
      workspace.events = workspace.events.filter(({ id }) => id !== data.id);
      break;
    case "toggle-module": {
      const module = modules.find(({ id, released }) => released && id === data.id);
      if (!module || module.id === "clipboard") throw new Error("Invalid module");
      const tabs = workspace.tabs.filter((id) => id !== module.id);
      workspace.tabs = data.enabled ? [...tabs, module.id] : tabs;
      break;
    }
    case "create-folder":
      return saveFolder(workspace, data, true);
    case "update-folder":
      unlockedKey(sessions, folderFor(workspace, data.id));
      return saveFolder(workspace, data, false);
    case "pin-folder":
      unlockedKey(sessions, folderFor(workspace, data.id));
      return pinFolder(workspace, data);
    case "reorder-folder":
      return reorderFolder(workspace, data);
    case "authorize-vault-copy": {
      const snippet = workspace.snippets.find(({ id }) => id === data.id);
      if (!snippet) throw new Error("Snippet no longer exists");
      snippetAccess(workspace, sessions, snippet);
      const folder = folderFor(workspace, snippet.folderId);
      if (folder?.vaultPolicy === "after-copy") await lockVaultSession(sessions, folder.id);
      transaction.writeWorkspace = false;
      break;
    }
    case "protect-folder":
    case "unlock-folder":
    case "lock-folder":
    case "set-vault-policy":
    case "set-vault-pin":
    case "unprotect-folder":
    case "protect-device":
    case "unlock-device":
    case "remove-device":
      return updateVault(workspace, action, data, transaction);
    case "delete-folder": {
      const folder = folderFor(workspace, data.id);
      if (!folder) return "folderMissing";
      const key = unlockedKey(sessions, folder);
      await unsealFolder(workspace, folder, key);
      if (workspace.translator.folderId === folder.id) workspace.translator = { ...workspace.translator, folderId: null };
      transaction.afterCommit = () => lockVaultSession(sessions, folder.id).catch(() => {});
      return deleteFolder(workspace, data);
    }
    case "move-snippet": {
      const index = workspace.snippets.findIndex(({ id }) => id === data.id);
      if (index < 0) throw new Error("Snippet no longer exists");
      const snippet = workspace.snippets[index];
      const sourceKey = snippetAccess(workspace, sessions, snippet);
      const destination = folderFor(workspace, data.folderId);
      if (data.folderId !== null && !destination) return "folderMissing";
      const destinationKey = unlockedKey(sessions, destination);
      workspace.snippets[index] = sourceKey ? await openSnippet(snippet, sourceKey) : { ...snippet };
      const error = moveSnippet(workspace, data);
      if (error) return error;
      if (destinationKey) workspace.snippets[index] = await sealSnippet(workspace.snippets[index], destinationKey);
      break;
    }
    case "save-snippet": {
      const text = typeof data.text === "string" ? data.text.slice(0, 20000) : "";
      if (!text.trim()) throw new Error("Snippet text is required");
      const title = typeof data.title === "string" ? data.title.trim().slice(0, 100) : "";
      const index = data.id ? workspace.snippets.findIndex(({ id }) => id === data.id) : -1;
      if (data.id && index < 0) throw new Error("Snippet no longer exists");
      const existing = workspace.snippets[index];
      if (existing) snippetAccess(workspace, sessions, existing);
      const folderId = data.folderId === undefined ? existing?.folderId ?? null : data.folderId;
      if (folderId != null && !hasFolder(workspace, folderId)) return "folderMissing";
      const metadata = existing ? snippetMetadata(existing) : { id: crypto.randomUUID(), pinned: false };
      const snippet = { ...metadata, title, text, folderId };
      const key = unlockedKey(sessions, folderFor(workspace, folderId));
      const saved = key ? await sealSnippet(snippet, key) : snippet;
      if (existing) workspace.snippets[index] = saved;
      else workspace.snippets = [saved, ...workspace.snippets];
      break;
    }
    case "pin-snippet": {
      const snippet = workspace.snippets.find(({ id }) => id === data.id);
      if (!snippet) throw new Error("Snippet no longer exists");
      snippetAccess(workspace, sessions, snippet);
      if (snippet.pinned === data.pinned) break;
      snippet.pinned = data.pinned;
      if (snippet.customShortcut) break;
      if (snippet.pinned) {
        const usedSlots = new Set(workspace.snippets.map(({ slot }) => slot));
        snippet.slot = shortcutSlots.find((slot) => !usedSlots.has(slot)) ?? null;
      } else {
        delete snippet.slot;
      }
      break;
    }
    case "set-shortcut": {
      const snippet = workspace.snippets.find(({ id }) => id === data.id);
      if (!snippet) return "shortcutUnavailable";
      snippetAccess(workspace, sessions, snippet);
      if (data.slot !== null && !shortcutSlots.includes(data.slot)) throw new Error("Invalid shortcut");
      if (data.slot !== null && workspace.snippets.some(({ id, slot }) => id !== data.id && slot === data.slot)) {
        return "shortcutConflict";
      }
      snippet.slot = data.slot;
      snippet.customShortcut = true;
      break;
    }
    case "delete-snippet": {
      const snippet = workspace.snippets.find(({ id }) => id === data.id);
      if (snippet) snippetAccess(workspace, sessions, snippet);
      workspace.snippets = workspace.snippets.filter(({ id }) => id !== data.id);
      break;
    }
    case "restore-snippet":
      if (!workspace.snippets.some(({ id }) => id === data.snippet.id)) {
        const { title = "", text } = data.snippet;
        if (typeof title !== "string" || typeof text !== "string") return "vaultLocked";
        const restored = { ...snippetMetadata(data.snippet), title, text };
        const folder = folderFor(workspace, restored.folderId);
        if (data.snippet.protected && !folder?.vault) return "vaultLocked";
        const key = unlockedKey(sessions, folder);
        if (restored.slot && workspace.snippets.some(({ slot }) => slot === restored.slot)) {
          restored.slot = null;
        }
        if (!folder) restored.folderId = null;
        const saved = key ? await sealSnippet(restored, key) : restored;
        workspace.snippets = workspace.snippets.toSpliced(data.index, 0, saved);
      }
      break;
    default:
      throw new Error("Unknown workspace action");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  const workspaceUrl = chrome.runtime.getURL("workspace.html");
  const fromWorkspace = sender.url === workspaceUrl || sender.url?.startsWith(`${workspaceUrl}?`);
  if (message?.type === easeTranslationMessage) {
    if (fromWorkspace) return handleEaseTranslationMessage(message, respond);
    return;
  }
  if (!fromWorkspace || !["ease-workspace-read", "ease-workspace-update"].includes(message?.type)) return;

  const requestInline = message.type === "ease-workspace-update" && message.action === "translator-inline-enabled"
    && message.data?.enabled === true && message.data.requestPermission === true;
  // Start permission UI on the first message hop so a toolbar popup can close without losing the action.
  const permission = requestInline ? requestInlineTranslatorPermission() : null;
  const result = queueWorkspace(async () => {
    const permissionError = await permission;
    if (permissionError) return { error: permissionError };
    const workspace = structuredClone(await readWorkspace());
    const sessions = await readVaultSessions();
    if (message.type === "ease-workspace-update") {
      const transaction = { sessions, writeWorkspace: true };
      const error = await updateWorkspace(workspace, message.action, message.data, transaction);
      if (error) return { error };
      if (transaction.writeWorkspace) await chrome.storage.local.set({ [storageKey]: workspace });
      await transaction.afterCommit?.();
    }
    return { workspace: await hydrateWorkspace(workspace, sessions) };
  });
  result.then(respond, (error) => {
    const code = error instanceof VaultLockedError ? "vaultLocked" : error instanceof FlashcardError ? error.code : "saveFailed";
    respond({ error: code });
  });
  return true;
});
