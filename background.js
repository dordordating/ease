import { densities, modules, palettes, readWorkspace, shortcutSlots, sizes, storageKey, themes } from "./workspace-data.js";
import { localeNames } from "./locales.js";
import { setToolbarBrand } from "./brand.js";
import { changeCalendarPreferences, saveCalendarEvent, setCalendarHoliday } from "./calendar-store.js";
import { refreshConnectedGoogleCalendar, registerGoogleProviderHandlers } from "./providers.js";
import { getAppleCalendarState, syncAppleCalendar } from "./apple-calendar.js";
import { deleteFolder, hasFolder, moveSnippet, pinFolder, saveFolder } from "./clipboard-store.js";

let pendingWrite = Promise.resolve();
registerGoogleProviderHandlers();

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
  if (alarm.name !== syncAlarm) return;
  Promise.allSettled([
    refreshConnectedGoogleCalendar(),
    getAppleCalendarState().then(({ connected }) => connected && syncAppleCalendar())
  ]);
});

function updateWorkspace(workspace, action, data) {
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
      return saveFolder(workspace, data, false);
    case "pin-folder":
      return pinFolder(workspace, data);
    case "delete-folder":
      return deleteFolder(workspace, data);
    case "move-snippet":
      return moveSnippet(workspace, data);
    case "save-snippet": {
      const text = typeof data.text === "string" ? data.text.slice(0, 20000) : "";
      if (!text.trim()) throw new Error("Snippet text is required");
      const title = typeof data.title === "string" ? data.title.trim().slice(0, 100) : "";
      const { folderId } = data;
      if (folderId != null && !hasFolder(workspace, folderId)) return "folderMissing";
      if (data.id) {
        const snippet = workspace.snippets.find(({ id }) => id === data.id);
        if (!snippet) throw new Error("Snippet no longer exists");
        Object.assign(snippet, { title, text });
        if (folderId !== undefined) snippet.folderId = folderId;
      } else {
        const snippet = { id: crypto.randomUUID(), title, text, pinned: false, folderId: folderId ?? null };
        workspace.snippets = [snippet, ...workspace.snippets];
      }
      break;
    }
    case "pin-snippet": {
      const snippet = workspace.snippets.find(({ id }) => id === data.id);
      if (!snippet) throw new Error("Snippet no longer exists");
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
      if (data.slot !== null && !shortcutSlots.includes(data.slot)) throw new Error("Invalid shortcut");
      if (data.slot !== null && workspace.snippets.some(({ id, slot }) => id !== data.id && slot === data.slot)) {
        return "shortcutConflict";
      }
      snippet.slot = data.slot;
      snippet.customShortcut = true;
      break;
    }
    case "delete-snippet":
      workspace.snippets = workspace.snippets.filter(({ id }) => id !== data.id);
      break;
    case "restore-snippet":
      if (!workspace.snippets.some(({ id }) => id === data.snippet.id)) {
        const restored = { ...data.snippet };
        if (restored.slot && workspace.snippets.some(({ slot }) => slot === restored.slot)) {
          restored.slot = null;
        }
        if (!hasFolder(workspace, restored.folderId)) restored.folderId = null;
        workspace.snippets = workspace.snippets.toSpliced(data.index, 0, restored);
      }
      break;
    default:
      throw new Error("Unknown workspace action");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "ease-workspace-update") return;

  const write = pendingWrite.then(async () => {
    const workspace = await readWorkspace();
    const error = updateWorkspace(workspace, message.action, message.data);
    if (error) return { error };
    await chrome.storage.local.set({ [storageKey]: workspace });
    return { workspace };
  });
  pendingWrite = write.catch(() => {});
  write.then(respond, () => respond({ error: "saveFailed" }));
  return true;
});
