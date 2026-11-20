export const storageKey = "easeWorkspace";

export const modules = [
  { id: "clipboard", icon: "clipboard", color: "#ba9aff", released: true },
  { id: "calendar", icon: "calendar", color: "#83acf9", released: true },
  { id: "markets", icon: "chart", color: "#68dbc3" },
  { id: "mail", icon: "mail", color: "#ffae85" },
  { id: "translate", icon: "translate", color: "#69d5fa" },
  { id: "assistant", icon: "sparkles", color: "#eca6e1" }
];

export const themes = ["dark", "light", "system"];

export const defaultWorkspace = {
  locale: "en",
  theme: "dark",
  tabs: ["clipboard", "calendar"],
  snippets: []
};

export async function readWorkspace() {
  const result = await chrome.storage.local.get(storageKey);
  return { ...defaultWorkspace, ...result[storageKey] };
}
