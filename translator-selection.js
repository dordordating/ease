import { translate } from "./locales.js";
import { maxTranslationLength } from "./translator-engine.js";
import { readWorkspace, storageKey } from "./workspace-data.js";

export const translatorSelectionKey = "easeTranslatorSelection";

const menuId = "ease-translate-selection";
const commandId = "translate-selection";
const takeMessage = "ease-translator-selection-take";
const expiryAlarm = "ease-translator-selection-expire";
const maxSelectionLength = maxTranslationLength + 1;
const maxPendingTabs = 16;
const selectionLifetime = 30_000;
const activeCaptures = new Map();
let pendingSelection = Promise.resolve();
let pendingMenu = Promise.resolve();

function validTab(tab) {
  return Number.isInteger(tab?.id) && tab.id >= 0 && Number.isInteger(tab.windowId) && tab.windowId >= 0;
}

function tabKey(tabId, windowId) {
  return `${windowId}:${tabId}`;
}

function editSelections(change) {
  const operation = pendingSelection.then(async () => {
    const storage = chrome.storage.session;
    const { [translatorSelectionKey]: saved = {} } = await storage.get(translatorSelectionKey);
    const now = Date.now();
    const entries = Object.fromEntries(Object.entries(saved).filter(([, selection]) => selection.expiresAt > now));
    const expired = Object.keys(entries).length !== Object.keys(saved).length;
    const { changed, text } = await change(entries);
    if (expired || changed) {
      if (Object.keys(entries).length) await storage.set({ [translatorSelectionKey]: entries });
      else await storage.remove(translatorSelectionKey);
      const nextExpiry = Math.min(...Object.values(entries).map(({ expiresAt }) => expiresAt));
      if (Number.isFinite(nextExpiry)) {
        try {
          await chrome.alarms?.create(expiryAlarm, { when: nextExpiry });
        } catch {
          // Expiration is still checked before every read.
        }
      }
    }
    return text ?? null;
  });
  pendingSelection = operation.catch(() => {});
  return operation;
}

function saveSelection(tab, capture, text) {
  return editSelections((entries) => {
    if (activeCaptures.get(tab.id) !== capture) return { changed: false };
    const key = tabKey(tab.id, tab.windowId);
    delete entries[key];
    entries[key] = { text, expiresAt: Date.now() + selectionLifetime };
    for (const oldKey of Object.keys(entries).slice(0, -maxPendingTabs)) delete entries[oldKey];
    return { changed: true };
  });
}

function discardTab(tabId) {
  activeCaptures.delete(tabId);
  return editSelections((entries) => {
    let changed = false;
    for (const key of Object.keys(entries)) {
      if (!key.endsWith(`:${tabId}`)) continue;
      delete entries[key];
      changed = true;
    }
    return { changed };
  });
}

// This function runs in Chrome's isolated world and cannot depend on module variables.
function readPageSelection(limit) {
  let target = document.activeElement;
  while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
  const focused = document.hasFocus();
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (target instanceof HTMLInputElement && (target.type === "password"
      || /(?:^|\s)(?:current-password|new-password)(?:\s|$)/iu.test(target.autocomplete ?? ""))) {
      return { focused, blocked: true };
    }
    const { selectionStart, selectionEnd } = target;
    const text = Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)
      ? target.value.slice(selectionStart, selectionEnd).trim().slice(0, limit) : "";
    return { focused, text };
  }
  if (target?.tagName === "IFRAME" || target?.tagName === "FRAME") return { focused, text: "" };
  return { focused, text: document.getSelection()?.toString().trim().slice(0, limit) ?? "" };
}

async function scriptSelection(tabId, frameId) {
  function execute(target) {
    return chrome.scripting.executeScript({ target: { tabId, ...target }, func: readPageSelection, args: [maxSelectionLength] });
  }
  let results;
  try {
    results = await execute(frameId === undefined ? { allFrames: true } : { frameIds: [frameId] });
  } catch {
    if (frameId !== undefined) return "";
    try {
      results = await execute({});
    } catch {
      return "";
    }
  }

  const selections = results.map(({ result }) => result).filter(Boolean);
  const focused = selections.filter((selection) => selection.focused);
  const candidates = focused.length ? focused : selections;
  if (candidates.some((selection) => selection.blocked)) return "";
  return candidates.find((selection) => selection.text)?.text ?? "";
}

function launchSelection(tab, captureText) {
  if (!validTab(tab)) return;
  // sidePanel.open requires the native menu/shortcut gesture, so call it before awaiting anything.
  let opening;
  try {
    opening = chrome.sidePanel.open({ tabId: tab.id });
  } catch {
    return;
  }
  discardTab(tab.id).catch(() => {});
  const capture = Symbol();
  activeCaptures.set(tab.id, capture);
  (async () => {
    try {
      const [selection] = await Promise.all([captureText(), opening]);
      const text = typeof selection === "string" ? selection.trim().slice(0, maxSelectionLength) : "";
      await saveSelection(tab, capture, text);
    } catch {
      // A closed/restricted tab can no longer supply text or receive a side panel.
    } finally {
      if (activeCaptures.get(tab.id) === capture) activeCaptures.delete(tab.id);
    }
  })();
}

async function panelCanTake(sender, windowId) {
  if (sender.id !== chrome.runtime.id || !sender.documentId || typeof sender.url !== "string") return false;
  const page = new URL(sender.url);
  if (page.protocol !== "chrome-extension:" || page.hostname !== chrome.runtime.id
    || page.pathname !== "/workspace.html" || page.searchParams.get("surface") !== "panel") return false;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"], documentIds: [sender.documentId] });
  return contexts.some((context) => context.windowId === -1 || context.windowId === windowId);
}

async function consumeSelection(sender, { tabId, windowId }) {
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(windowId) || windowId < 0
    || !await panelCanTake(sender, windowId)) return null;
  return editSelections(async (entries) => {
    const key = tabKey(tabId, windowId);
    if (!Object.hasOwn(entries, key)) return { changed: false };
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab?.id !== tabId || activeTab.windowId !== windowId) return { changed: false };
    const { text } = entries[key];
    delete entries[key];
    return { changed: true, text };
  });
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return validTab(tab) ? tab : null;
}

export async function takeTranslatorSelection() {
  try {
    const tab = await currentTab();
    if (!tab) return null;
    const { text } = await chrome.runtime.sendMessage({ type: takeMessage, tabId: tab.id, windowId: tab.windowId });
    if (typeof text !== "string") return null;
    const activeTab = await currentTab();
    return activeTab?.id === tab.id && activeTab.windowId === tab.windowId ? text : null;
  } catch {
    return null;
  }
}

function updateMenu() {
  if (!chrome.contextMenus) return;
  const api = chrome.contextMenus;
  pendingMenu = pendingMenu.then(async () => {
    const { locale } = await readWorkspace();
    const title = translate(locale, "translatorMenu");
    await new Promise((resolve) => {
      api.update(menuId, { title }, () => {
        if (!chrome.runtime.lastError) {
          resolve();
          return;
        }
        api.create({ id: menuId, title, contexts: ["selection"] }, () => {
          // Read lastError so a disappearing browser context does not generate console noise.
          void chrome.runtime.lastError;
          resolve();
        });
      });
    });
  }).catch(() => {});
}

export function registerTranslatorSelectionHandlers() {
  chrome.runtime.onInstalled?.addListener(updateMenu);
  chrome.runtime.onStartup?.addListener(updateMenu);
  chrome.storage.onChanged.addListener(({ [storageKey]: change }, area) => {
    if (area === "local" && change && change.oldValue?.locale !== change.newValue?.locale) updateMenu();
  });
  chrome.contextMenus?.onClicked?.addListener((info, tab) => {
    if (info.menuItemId !== menuId || !validTab(tab)) return;
    launchSelection(tab, () => info.editable ? scriptSelection(tab.id, info.frameId ?? 0) : info.selectionText);
  });
  chrome.commands?.onCommand?.addListener((command, tab) => {
    // Chrome supplies a tab for browser-window commands, but it is optional outside one.
    if (command === commandId && validTab(tab)) launchSelection(tab, () => scriptSelection(tab.id));
  });
  chrome.tabs?.onUpdated?.addListener((tabId, change) => {
    if (change.status === "loading") discardTab(tabId).catch(() => {});
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => { discardTab(tabId).catch(() => {}); });
  chrome.tabs?.onDetached?.addListener((tabId) => { discardTab(tabId).catch(() => {}); });
  chrome.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name === expiryAlarm) editSelections(() => ({ changed: false })).catch(() => {});
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== takeMessage || sender.id !== chrome.runtime.id) return;
    consumeSelection(sender, message).then((text) => respond({ text }), () => respond({ text: null }));
    return true;
  });
}
