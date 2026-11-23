import { translate } from "./locales.js";
import { openSavedSpace } from "./spaces-browser.js";
import { normalizeSearchText } from "./workspace-search.js";
import { readWorkspace } from "./workspace-data.js";

const maxSuggestions = 5;
const xmlEntities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const descriptionText = value => value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/[&<>"']/gu, mark => xmlEntities[mark]);
const searchKey = (value, locale) => normalizeSearchText(value, locale).trim().replace(/\s+/gu, " ");

function candidates(workspace) {
  const spaces = workspace.spaces.filter(space => space.tabs.length);
  const names = new Map();
  for (const space of spaces) names.set(space.name, (names.get(space.name) ?? 0) + 1);
  return spaces.map(space => ({
    space,
    key: searchKey(space.name, workspace.locale),
    content: names.get(space.name) === 1 ? space.name : `${space.name} [${space.id}]`
  }));
}

function rankMatches(text, entries, locale) {
  const query = searchKey(text, locale);
  const words = query.split(" ").filter(Boolean);
  return entries.flatMap(entry => {
    let rank;
    if (!query || entry.key === query) rank = 0;
    else if (entry.key.startsWith(query)) rank = 1;
    else if (words.every(word => entry.key.includes(word))) rank = 2;
    else return [];
    return [{ ...entry, rank }];
  }).sort((a, b) => a.rank - b.rank || Number(b.space.favorite) - Number(a.space.favorite)
    || b.space.updatedAt - a.space.updatedAt);
}

function showSpaces(focused, { issue, spaceId, windowId } = {}) {
  const params = new URLSearchParams({ surface: "panel", open: "spaces" });
  if (issue) params.set("spaceIssue", issue);
  if (spaceId) params.set("spaceId", spaceId);
  return chrome.tabs.create({ url: chrome.runtime.getURL(`workspace.html?${params}`), active: focused, windowId });
}

export function registerSpaceOmnibox() {
  const api = chrome.omnibox;
  if (!api) return;
  let generation = 0;
  let suggestedIds = new Map();
  const defaultDescription = value => api.setDefaultSuggestion({ description: descriptionText(value) });

  api.onInputStarted.addListener(() => {
    const request = ++generation;
    suggestedIds.clear();
    readWorkspace().then(({ locale }) => {
      if (request === generation) return defaultDescription(translate(locale, "spaceOmniboxHint"));
    }).catch(() => {});
  });

  api.onInputChanged.addListener((text, suggest) => {
    const request = ++generation;
    readWorkspace().then(workspace => {
      if (request !== generation) return;
      const { locale } = workspace;
      const matches = rankMatches(text, candidates(workspace), locale).slice(0, maxSuggestions);
      suggestedIds = new Map(matches.map(({ space, content }) => [content, space.id]));
      const first = matches[0]?.space;
      const defaultKey = !text.trim() ? "spaceOmniboxHint" : first ? "spaceOpenLinked" : "spaceOmniboxNoMatch";
      const set = defaultDescription(translate(locale, defaultKey, { name: first?.name }));
      const numbers = new Intl.NumberFormat(locale);
      suggest(matches.map(({ space, content }) => ({
        content,
        description: `<match>${descriptionText(space.name)}</match> <dim>${descriptionText(
          translate(locale, "spaceTabCount", { count: numbers.format(space.tabs.length) })
        )}</dim>`
      })));
      return set;
    }).catch(() => {
      if (request === generation) suggest([]);
    });
  });

  api.onInputCancelled.addListener(() => {
    generation += 1;
    suggestedIds.clear();
  });
  api.onInputEntered.addListener((text, disposition) => {
    generation += 1;
    const focused = disposition !== "newBackgroundTab";
    const currentWindow = chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    const suggestedId = suggestedIds.get(text);
    suggestedIds.clear();
    const enter = async () => {
      const windowId = (await currentWindow)?.id;
      if (!text.trim()) return showSpaces(focused, { windowId });
      let id = suggestedId;
      if (!id) {
        const workspace = await readWorkspace();
        const entries = candidates(workspace);
        const match = entries.find(entry => entry.content === text) ?? rankMatches(text, entries, workspace.locale)[0];
        id = match?.space.id;
      }
      if (!id) return showSpaces(focused, { windowId, issue: "no-match" });
      try {
        await openSavedSpace(id, { mode: "group", windowId, focused });
      } catch (error) {
        const issue = error.code === "spaceGroupPermission" ? "group-permission" : "open-failed";
        await showSpaces(focused, { windowId, issue, spaceId: id });
      }
    };
    enter().catch(() => {});
  });
}
