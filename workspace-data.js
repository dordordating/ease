import { defaultFlashcards } from "./flashcard-store.js";
import { defaultMarkets } from "./markets-store.js";
import { defaultTodo } from "./todo-store.js";

export const storageKey = "easeWorkspace";

export const modules = [
  { id: "clipboard", icon: "clipboard", color: "#ba9aff", released: true },
  { id: "calendar", icon: "calendar", color: "#83acf9", released: true },
  { id: "markets", icon: "chart", color: "#68dbc3", released: true },
  { id: "mail", icon: "mail", color: "#ffae85", released: true },
  { id: "translate", icon: "translate", color: "#69d5fa", released: true },
  { id: "flashcards", icon: "flashcards", color: "#82b9ac", released: true },
  { id: "todo", icon: "todo", color: "#a0c98b", released: true },
  { id: "assistant", icon: "sparkles", color: "#eca6e1" }
];

const releasedModulesById = new Map(modules.filter(({ released }) => released).map((module) => [module.id, module]));
export const defaultModuleOrder = Object.freeze([...releasedModulesById.keys()]);

export function normalizeModuleOrder(order) {
  const recorded = Array.isArray(order) ? order.filter((id) => releasedModulesById.has(id)) : [];
  return [...new Set([...recorded, ...defaultModuleOrder])];
}

export function visibleModules({ tabs, moduleOrder }) {
  const enabled = Array.isArray(tabs) ? tabs : defaultWorkspace.tabs;
  return normalizeModuleOrder(moduleOrder)
    .filter((id) => id === "clipboard" || enabled.includes(id))
    .map((id) => releasedModulesById.get(id));
}

export function reorderModule(workspace, { id, targetId, position }) {
  const visible = visibleModules(workspace).map((module) => module.id);
  const sourceIndex = visible.indexOf(id);
  if (sourceIndex < 0 || !visible.includes(targetId) || !["before", "after"].includes(position)) {
    throw new Error("Invalid module order");
  }
  if (id === targetId) return false;

  const next = visible.filter((moduleId) => moduleId !== id);
  const insertIndex = next.indexOf(targetId) + (position === "after" ? 1 : 0);
  if (insertIndex === sourceIndex) return false;
  next.splice(insertIndex, 0, id);

  // Reuse the visible slots so hidden modules keep their saved positions.
  const enabled = new Set(visible);
  let index = 0;
  workspace.moduleOrder = normalizeModuleOrder(workspace.moduleOrder)
    .map((moduleId) => enabled.has(moduleId) ? next[index++] : moduleId);
  return true;
}

export const themes = ["dark", "light", "system"];
export const palettes = { violet: "#774be0", blue: "#2869dc", mint: "#118466", amber: "#a86a08" };
export const densities = ["compact", "comfortable"];
export const sizes = ["small", "medium", "large"];
export const workspaceZoomLevels = Object.freeze([80, 90, 100, 110, 125, 150]);
export const shortcutSlots = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export const folderIcons = ["folder", "briefcase", "user", "star", "link"];
export const maxPinnedFolders = 2;
export const defaultCalendar = { system: null, view: "month", firstDay: null, eventDisplay: "dots" };
export const translatorEngines = ["chrome", "economy", "standard", "premium"];
export const defaultTranslator = { engine: "chrome", source: "auto", target: "en", layout: "both", folderId: null, inlineEnabled: false, inlineSites: [] };

export function calendarSystemFor(locale, system) {
  return system ?? (new Intl.Locale(locale).language === "fa" ? "persian" : "gregory");
}

export function normalizeWorkspaceZoom(value) {
  return workspaceZoomLevels.includes(value) ? value : defaultWorkspace.zoom;
}

export const defaultWorkspace = {
  locale: "en",
  theme: "dark",
  palette: "violet",
  density: "compact",
  size: "medium",
  zoom: 100,
  libraryLayout: "grid",
  tabs: ["clipboard", "calendar", "translate"],
  snippets: [],
  folders: [],
  calendar: defaultCalendar,
  translator: defaultTranslator,
  flashcards: defaultFlashcards,
  markets: defaultMarkets,
  todo: defaultTodo,
  events: [],
  holidays: []
};

export async function readWorkspace() {
  const result = await chrome.storage.local.get(storageKey);
  const workspace = { ...defaultWorkspace, ...result[storageKey] };
  workspace.zoom = normalizeWorkspaceZoom(workspace.zoom);
  return workspace;
}
