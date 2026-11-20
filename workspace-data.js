import { defaultFlashcards } from "./flashcard-store.js";

export const storageKey = "easeWorkspace";

export const modules = [
  { id: "clipboard", icon: "clipboard", color: "#ba9aff", released: true },
  { id: "calendar", icon: "calendar", color: "#83acf9", released: true },
  { id: "markets", icon: "chart", color: "#68dbc3" },
  { id: "mail", icon: "mail", color: "#ffae85" },
  { id: "translate", icon: "translate", color: "#69d5fa", released: true },
  { id: "flashcards", icon: "flashcards", color: "#82b9ac", released: true },
  { id: "assistant", icon: "sparkles", color: "#eca6e1" }
];

export const themes = ["dark", "light", "system"];
export const palettes = { violet: "#774be0", blue: "#2869dc", mint: "#118466", amber: "#a86a08" };
export const densities = ["compact", "comfortable"];
export const sizes = ["small", "medium", "large"];
export const shortcutSlots = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export const folderIcons = ["folder", "briefcase", "user", "star", "link"];
export const maxPinnedFolders = 2;
export const defaultCalendar = { system: null, view: "month", firstDay: null, eventDisplay: "dots" };
export const translatorEngines = ["chrome", "economy", "standard", "premium"];
export const defaultTranslator = { engine: "chrome", source: "auto", target: "en", layout: "both", folderId: null, inlineEnabled: false, inlineSites: [] };

export function calendarSystemFor(locale, system) {
  return system ?? (new Intl.Locale(locale).language === "fa" ? "persian" : "gregory");
}

export const defaultWorkspace = {
  locale: "en",
  theme: "dark",
  palette: "violet",
  density: "compact",
  size: "medium",
  tabs: ["clipboard", "calendar", "translate"],
  snippets: [],
  folders: [],
  calendar: defaultCalendar,
  translator: defaultTranslator,
  flashcards: defaultFlashcards,
  events: [],
  holidays: []
};

export async function readWorkspace() {
  const result = await chrome.storage.local.get(storageKey);
  return { ...defaultWorkspace, ...result[storageKey] };
}
