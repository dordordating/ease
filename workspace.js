import { renderCalendar } from "./calendar.js";
import { paintBrand } from "./brand.js";
import { accountStorageKey, calendarConnectionKeys, loadConnectedEvents, renderAccount, renderCalendarConnections } from "./connections.js";
import { icon } from "./icons.js";
import { isRtl, localeNames, translate } from "./locales.js";
import { calendarSystemFor, defaultWorkspace, densities, folderIcons, modules, palettes, readWorkspace, shortcutSlots, sizes, storageKey, themes } from "./workspace-data.js";

const view = document.querySelector("#workspace");
const editor = document.querySelector("#editor");
const tabBar = document.querySelector("#module-tabs");
const search = document.querySelector("#search");
const logo = document.querySelector("#brand-logo");
const toast = document.querySelector("#toast");
const toastMessage = document.querySelector("#toast-message");
const toastAction = document.querySelector("#toast-action");
const panelButton = document.querySelector("#panel-button");
const settingsButton = document.querySelector("#settings-button");
const inPanel = new URLSearchParams(location.search).get("surface") === "panel";

const clipboard = modules[0];
const library = { id: "library", icon: "plus" };
const settings = { id: "settings", icon: "settings" };
const destinations = [...modules, library, settings];
let workspace = defaultWorkspace;
let activePage = clipboard.id;
let activeFolder = "all";
let query = "";
let toastTimer;
let copyTimer;
let copiedId;
let currentWindowId;
let inToolbarPopup = false;
const calendarNavigation = {};
let calendarController;
let calendarConnectionsRefresh;
let calendarLocale;
let providerEvents = [];
let refreshVersion = 0;
let accountRefresh;
let calendarDayTimer;

document.body.dataset.surface = inPanel ? "panel" : "popup";
panelButton.hidden = inPanel;
if (!inPanel) {
  chrome.windows.getCurrent().then((window) => { currentWindowId = window.id; }).catch(() => {});
  chrome.runtime.getContexts({ contextTypes: ["POPUP"], documentUrls: [location.href] })
    .then((contexts) => { inToolbarPopup = contexts.length > 0; }).catch(() => {});
}

const t = (key, values) => translate(workspace.locale, key, values);
const reportError = (key) => showToast(t(key), undefined, true);

function calendarEvents() {
  return [...workspace.events, ...providerEvents];
}

async function refreshCalendarEvents() {
  const version = ++refreshVersion;
  const events = await loadConnectedEvents();
  if (version !== refreshVersion) return;
  providerEvents = events;
  calendarController?.update({ events: calendarEvents() });
  if (query) render();
}

function node(tag, className, label) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label !== undefined) element.textContent = label;
  return element;
}

function glyph(name, className) {
  const element = node("span", className);
  element.setAttribute("aria-hidden", "true");
  element.innerHTML = icon(name);
  return element;
}

function button(label, className, { symbol, iconOnly = false, onClick } = {}) {
  const element = node("button", className);
  element.type = "button";
  if (symbol) element.append(glyph(symbol));
  if (iconOnly) {
    element.title = label;
    element.setAttribute("aria-label", label);
  } else {
    element.append(node("span", "", label));
  }
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

function labelButton(element, label, symbol) {
  element.replaceChildren(glyph(symbol));
  element.title = label;
  element.setAttribute("aria-label", label);
}

function showToast(message, action, error = false) {
  if (editor.open && error) {
    const feedback = editor.querySelector(".dialog-feedback");
    feedback.hidden = false;
    feedback.textContent = message;
    return;
  }
  clearTimeout(toastTimer);
  toast.hidden = false;
  toast.dataset.kind = error ? "error" : "success";
  toastMessage.textContent = message;
  toastAction.hidden = !action;
  toastAction.onclick = null;
  if (action) {
    toastAction.textContent = t("undo");
    toastAction.onclick = action;
  }
  toastTimer = setTimeout(() => { toast.hidden = true; }, action ? 7000 : 2200);
}

async function mutate(action, data) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "ease-workspace-update", action, data });
    if (response?.workspace) return true;
    showToast(t(response?.error ?? "saveFailed"), undefined, true);
  } catch {
    showToast(t("saveFailed"), undefined, true);
  }
  return false;
}

function switchTo(page, focus = true) {
  activePage = page;
  query = "";
  search.value = "";
  render();
  view.scrollTop = 0;
  if (focus) {
    const tab = document.getElementById(`tab-${page}`);
    (tab ?? view).focus();
  }
}

function updateCalendarTab(button, today = new Date()) {
  const { locale, calendar, holidays } = workspace;
  const system = calendarSystemFor(locale, calendar?.system);
  const dayFormat = new Intl.DateTimeFormat(locale, { calendar: system, day: "numeric" });
  const dayNumber = dayFormat.formatToParts(today).find(({ type }) => type === "day").value;
  const fullDate = new Intl.DateTimeFormat(locale, { calendar: system, dateStyle: "full" }).format(today);
  const year = String(today.getFullYear()).padStart(4, "0");
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  const isHoliday = holidays.includes(`${year}-${month}-${day}`);
  const localeInfo = new Intl.Locale(locale);
  const weekend = (localeInfo.getWeekInfo?.() ?? localeInfo.weekInfo)?.weekend
    ?? (localeInfo.language === "fa" ? [5] : [6, 7]);
  const isWeekend = weekend.includes(today.getDay() || 7);
  const kind = isHoliday ? "holiday" : isWeekend ? "weekend" : "normal";
  const labelKey = isHoliday ? "calendarTabHoliday" : isWeekend ? "calendarTabWeekend" : "calendarTabToday";
  const label = t(labelKey, { date: fullDate });
  const mark = node("span", "calendar-date-icon");
  mark.dataset.dayKind = kind;
  mark.setAttribute("aria-hidden", "true");
  mark.append(node("span", "calendar-date-number", dayNumber));
  if (kind !== "normal") mark.append(node("span", "calendar-date-accent"));
  button.replaceChildren(mark);
  button.setAttribute("aria-label", label);
  button.title = label;
}

function refreshCalendarDay() {
  const tab = document.getElementById("tab-calendar");
  const now = new Date();
  if (tab) updateCalendarTab(tab, now);
  const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  clearTimeout(calendarDayTimer);
  calendarDayTimer = setTimeout(refreshCalendarDay, nextDay.getTime() - now.getTime());
}

function renderTabs() {
  tabBar.setAttribute("aria-label", t("modulesLabel"));
  tabBar.setAttribute("role", "tablist");
  tabBar.setAttribute("aria-orientation", "vertical");
  const tabs = [...modules.filter(({ id }) => workspace.tabs.includes(id)), library];
  tabBar.replaceChildren(...tabs.map((module) => {
    const isSelected = activePage === module.id && !query;
    const isLibrary = module === library;
    const item = button(t(module.id), `module-tab${isLibrary ? " module-tab--library" : ""}`, {
      symbol: module.icon,
      iconOnly: true,
      onClick: () => switchTo(module.id)
    });
    item.id = `tab-${module.id}`;
    item.dataset.module = module.id;
    item.setAttribute("role", "tab");
    item.setAttribute("aria-controls", "workspace");
    item.setAttribute("aria-selected", String(isSelected));
    item.tabIndex = isSelected || (!tabs.some(({ id }) => id === activePage && !query) && module === tabs[0]) ? 0 : -1;
    if (module.id === "calendar") updateCalendarTab(item);
    return item;
  }));
}

function section(title, description, action) {
  const header = node("div", "section-header");
  const content = node("div", "section-copy");
  content.append(node("h1", "", title));
  if (description) content.append(node("p", "", description));
  header.append(content);
  if (action) header.append(action);
  view.append(header);
}

function emptyState(title, description, symbol, action) {
  const empty = node("div", "empty-state");
  let illustration = glyph(symbol, "empty-illustration");
  if (symbol === "clipboard") {
    illustration.innerHTML = `<svg aria-hidden="true" viewBox="0 0 100 78" width="100" height="78" fill="none">
      <defs><linearGradient id="paper" x1="25" y1="12" x2="75" y2="72" gradientUnits="userSpaceOnUse"><stop stop-color="#bb99ff" stop-opacity=".33"/><stop offset="1" stop-color="#9367ed" stop-opacity=".05"/></linearGradient></defs>
      <path d="M14 57h8m-4-4v8M80 20h12m-6-6v12M75 69h5m-2.5-2.5v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".6"/>
      <rect x="22" y="21" width="45" height="48" rx="9" transform="rotate(-11 22 21)" stroke="currentColor" opacity=".35"/>
      <rect x="34" y="15" width="43" height="54" rx="9" fill="url(#paper)" stroke="currentColor" stroke-width="1.2"/>
      <rect x="45" y="10" width="21" height="10" rx="4" fill="currentColor" fill-opacity=".3" stroke="currentColor"/>
      <path d="M45 32h21M45 41h21M45 50h13" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"/>
    </svg>`;
  }
  empty.append(illustration, node("h2", "", title), node("p", "", description));
  if (action) empty.append(action);
  view.append(empty);
}

const displayTitle = ({ title, text }) => title || text.trim().split(/\r?\n/u)[0];

function folderFor(id) {
  return workspace.folders.find((folder) => folder.id === id);
}

function snippetList(title, snippets, showFolder = false) {
  const heading = node("div", "collection-heading");
  heading.append(node("h2", "", title));
  heading.append(node("small", "", new Intl.NumberFormat(workspace.locale).format(snippets.length)));
  const list = node("ul", "snippet-list");
  snippets.forEach((snippet) => {
    const name = displayTitle(snippet);
    const isCopied = copiedId === snippet.id;
    const row = node("li", `snippet-row${isCopied ? " is-copied" : ""}`);
    const copy = node("button", "snippet-copy");
    copy.id = `snippet-${snippet.id}`;
    copy.type = "button";
    copy.setAttribute("aria-label", t("copySnippet", { name }));
    copy.addEventListener("click", () => prepareCopy(snippet));
    copy.append(glyph(snippet.pinned ? "pin" : "clipboard", "snippet-glyph"));
    const text = node("span", "snippet-text");
    const snippetTitle = node("strong", "", name);
    snippetTitle.dir = "auto";
    text.append(snippetTitle);
    if (snippet.title) {
      const snippetText = node("span", "", snippet.text);
      snippetText.dir = "auto";
      text.append(snippetText);
    }
    if (showFolder && workspace.folders.length) {
      const folder = folderFor(snippet.folderId);
      const breadcrumb = node("span", "folder-breadcrumb");
      const label = node("span", "", folder?.name ?? t("noFolder"));
      label.dir = "auto";
      breadcrumb.append(glyph(folder?.icon ?? "folder"), label);
      text.append(breadcrumb);
      copy.setAttribute("aria-description", label.textContent);
    }
    copy.append(text);
    if (snippet.slot) {
      const slot = node("kbd", "snippet-slot", snippet.slot);
      slot.setAttribute("aria-hidden", "true");
      copy.append(slot);
      copy.setAttribute("aria-keyshortcuts", String(snippet.slot));
      copy.title = t("shortcutKey", { key: snippet.slot });
    }
    copy.append(glyph(isCopied ? "check" : "copy", "row-copy-icon"));
    const details = node("details", "snippet-actions");
    const summary = node("summary", "icon-button");
    summary.id = `actions-${snippet.id}`;
    labelButton(summary, t("more"), "more");
    const menu = node("div", "action-menu");
    function action(key, symbol, handler) {
      const item = button(t(key), "action-item", {
        symbol,
        onClick: () => {
          details.open = false;
          summary.focus();
          handler();
        }
      });
      if (key === "remove") item.dataset.action = "delete";
      return item;
    }
    menu.append(
      action(snippet.pinned ? "unpin" : "pin", "pin", () => mutate("pin-snippet", { id: snippet.id, pinned: !snippet.pinned })),
      action("edit", "edit", () => editSnippet(snippet))
    );
    if (workspace.folders.length) menu.append(action("moveToFolder", "folder", () => moveSnippet(snippet)));
    menu.append(
      action("shortcutAssign", "keyboard", () => editShortcut(snippet)),
      action("remove", "trash", () => removeSnippet(snippet))
    );
    details.append(summary, menu);
    row.append(copy, details);
    list.append(row);
  });
  view.append(heading, list);
}

function renderClipboard() {
  if (activeFolder !== "all" && activeFolder !== null && !folderFor(activeFolder)) activeFolder = "all";
  const add = (className) => {
    const action = button(t("newSnippet"), className, { symbol: "plus", onClick: () => editSnippet() });
    action.id = "new-snippet";
    return action;
  };
  const snippets = activeFolder === "all"
    ? workspace.snippets
    : workspace.snippets.filter(({ folderId }) => (folderId ?? null) === activeFolder);
  const hasSnippets = snippets.length > 0;
  section(t("clipboard"), undefined, hasSnippets ? add("primary-button") : undefined);
  renderFolderBar();
  if (!hasSnippets) {
    const filtered = activeFolder !== "all";
    emptyState(t(filtered ? "emptyFolder" : "emptyTitle"), t(filtered ? "emptyFolderHint" : "emptyHint"),
      filtered ? "folder" : "clipboard", add("secondary-button"));
    return;
  }
  const pinned = snippets.filter(({ pinned }) => pinned).sort((left, right) => (left.slot ?? 10) - (right.slot ?? 10));
  const others = snippets.filter(({ pinned }) => !pinned);
  if (pinned.length) snippetList(t("pinned"), pinned);
  if (others.length) snippetList(t("snippets"), others);
}

function selectFolder(id) {
  activeFolder = id;
  render();
  view.scrollTop = 0;
  document.getElementById(`folder-chip-${id ?? "unfiled"}`)?.focus();
}

function renderFolderBar() {
  const bar = node("nav", "folder-bar");
  bar.setAttribute("aria-label", t("clipboardFolders"));
  const quick = node("div", "folder-quick");
  const all = { id: "all", name: t("allFolders"), icon: "clipboard" };
  const unfiled = { id: null, name: t("noFolder"), icon: "folder" };
  const selected = folderFor(activeFolder);
  const quickFolders = [all, ...workspace.folders.filter(({ pinned }) => pinned)];
  if (activeFolder === null) quickFolders.push(unfiled);
  else if (selected && !selected.pinned) quickFolders.push(selected);

  function filterButton(folder, className) {
    const selected = activeFolder === folder.id;
    const item = button(folder.name, className, { symbol: folder.icon, onClick: () => selectFolder(folder.id) });
    item.title = folder.name;
    const label = item.lastElementChild;
    label.className = "folder-label";
    label.dir = "auto";
    item.setAttribute("aria-pressed", String(selected));
    return item;
  }

  for (const folder of quickFolders) {
    const chip = filterButton(folder, "folder-chip");
    chip.id = `folder-chip-${folder.id ?? "unfiled"}`;
    quick.append(chip);
  }
  const actions = node("div", "folder-actions");
  const create = button(t("newFolder"), "icon-button", { symbol: "folder-plus", iconOnly: true, onClick: () => editFolder() });
  create.id = "new-folder";
  actions.append(create);

  if (workspace.folders.length || activeFolder === null) {
    const overflow = node("details", "folder-overflow");
    const summary = node("summary", "icon-button");
    summary.id = "folder-overflow-button";
    labelButton(summary, t("manageFolders"), "more");
    const menu = node("div", "folder-menu");
    if (selected) {
      const management = node("div", "folder-menu-group");
      const menuAction = (key, symbol, run) => button(t(key), "folder-menu-item", {
        symbol,
        onClick: () => {
          overflow.open = false;
          summary.focus();
          run();
        }
      });
      management.append(
        menuAction("editFolder", "edit", () => editFolder(selected)),
        menuAction(selected.pinned ? "folderUnpinned" : "folderPinned", "pin",
          () => mutate("pin-folder", { id: selected.id, pinned: !selected.pinned })),
        menuAction("deleteFolder", "trash", () => deleteFolder(selected))
      );
      management.lastElementChild.dataset.action = "delete";
      menu.append(management);
    }
    const folders = node("div", "folder-menu-group");
    for (const folder of [unfiled, ...workspace.folders]) {
      folders.append(filterButton(folder, activeFolder === folder.id ? "folder-menu-item folder-menu-active" : "folder-menu-item"));
    }
    menu.append(folders);
    overflow.append(summary, menu);
    actions.append(overflow);
  }

  bar.append(quick, actions);
  view.append(bar);
}

function renderLibrary() {
  section(t("library"), t("libraryHint"));
  const list = node("ul", "catalog-list");
  for (const module of modules) {
    const item = node("li", "catalog-item");
    item.dataset.module = module.id;
    item.style.setProperty("--accent", module.color);
    const copy = node("div", "catalog-copy");
    copy.append(node("strong", "", t(module.id)), node("p", "", t(`${module.id}Hint`)));
    item.append(glyph(module.icon, "module-glyph"), copy);
    if (module.released && module !== clipboard) {
      const enabled = workspace.tabs.includes(module.id);
      const toggle = button(t(enabled ? "hide" : "add"), "secondary-button", {
        symbol: enabled ? undefined : "plus",
        onClick: async () => {
          toggle.disabled = true;
          if (await mutate("toggle-module", { id: module.id, enabled: !enabled })) {
            showToast(t(enabled ? "moduleHidden" : "moduleAdded", { name: t(module.id) }));
          } else {
            toggle.disabled = false;
          }
        }
      });
      toggle.id = `toggle-${module.id}`;
      toggle.setAttribute("aria-label", `${t(enabled ? "hide" : "add")} ${t(module.id)}`);
      item.append(toggle);
    } else {
      item.append(node("span", "status-tag", t(module.released ? "available" : "comingSoon")));
    }
    list.append(item);
  }
  view.append(list);
}

function radioOption(group, value, selected, className) {
  const label = node("label", className);
  const input = node("input");
  input.type = "radio";
  input.name = group;
  input.id = `${group}-${value}`;
  input.value = value;
  input.checked = value === selected;
  const face = node("span");
  label.append(input, face);
  return { label, input, face };
}

function displayPreference(key, label, values, symbols = {}) {
  const fieldset = node("fieldset", "choice-group");
  const options = node("div", "choice-options");
  fieldset.append(node("legend", "", t(label)), options);
  for (const value of values) {
    const choice = radioOption(`setting-${key}`, value, workspace[key], "choice-option");
    if (key === "palette") {
      const swatch = node("span", "palette-swatch");
      swatch.style.setProperty("--swatch", palettes[value]);
      swatch.setAttribute("aria-hidden", "true");
      choice.face.append(swatch);
    } else if (symbols[value]) {
      choice.face.append(glyph(symbols[value]));
    }
    choice.face.append(node("span", "", t(value)));
    options.append(choice.label);
  }
  options.addEventListener("change", async ({ target }) => {
    if (!await mutate("preferences", { [key]: target.value })) render();
  });
  return fieldset;
}

async function readActivationShortcut() {
  const value = document.querySelector("#activation-shortcut");
  if (!value || !chrome.commands) return;
  try {
    const commands = await chrome.commands.getAll();
    const activation = commands.find(({ name }) => name === "_execute_action");
    value.textContent = activation?.shortcut || t("shortcutNotSet");
    value.dir = activation?.shortcut ? "ltr" : "auto";
  } catch {
    value.textContent = t("shortcutNotSet");
  }
}

function renderSettings() {
  section(t("settings"));
  const list = node("div", "settings-list");
  list.append(
    displayPreference("theme", "appearance", themes, { light: "sun", dark: "moon", system: "device" }),
    displayPreference("palette", "palette", Object.keys(palettes)),
    displayPreference("density", "density", densities),
    displayPreference("size", "windowSize", sizes)
  );
  if (inPanel) list.append(node("p", "setting-hint", t("panelSizeHint")));

  const language = node("div", "setting-row language-row");
  const label = node("label", "", t("language"));
  label.htmlFor = "setting-locale";
  const select = node("select");
  select.id = label.htmlFor;
  for (const [value, text] of Object.entries(localeNames)) {
    const option = node("option", "", text);
    option.value = value;
    option.lang = value;
    option.dir = isRtl(value) ? "rtl" : "ltr";
    select.append(option);
  }
  select.value = workspace.locale;
  select.addEventListener("change", async () => {
    if (!await mutate("preferences", { locale: select.value })) select.value = workspace.locale;
  });
  language.append(label, select);
  list.append(language);
  const shortcut = node("div", "account-card");
  const shortcutDetails = node("div", "account-details connection-actions");
  const shortcutValue = node("kbd", "keycap", t("shortcutNotSet"));
  shortcutValue.id = "activation-shortcut";
  shortcutValue.dir = "auto";
  shortcutDetails.append(shortcutValue, button(t("manageActivationShortcut"), "secondary-button", {
    symbol: "keyboard",
    onClick: () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }).catch(() => reportError("shortcutOpenFailed"))
  }));
  shortcut.append(node("h3", "", t("activationShortcut")), shortcutDetails);
  list.append(shortcut);
  const storage = node("div", "setting-row storage-note");
  const copy = node("div");
  copy.append(node("strong", "", t("storageTitle")), node("p", "", t("storageHint")));
  storage.append(glyph("device", "module-glyph"), copy);
  list.append(storage);
  view.append(list);
  accountRefresh = renderAccount(list, t, reportError);
  readActivationShortcut();
}

function searchable(text) {
  return text.toLocaleLowerCase(workspace.locale).normalize("NFD").replace(/\p{Mark}/gu, "")
    .replace(/ي/gu, "ی").replace(/ك/gu, "ک").replace(/\u200c/gu, " ");
}

function renderEventResults(results) {
  const heading = node("div", "collection-heading");
  heading.append(node("h2", "", t("calendarEvents")));
  const list = node("div", "command-list");
  const dateFormat = new Intl.DateTimeFormat(workspace.locale, {
    calendar: calendarSystemFor(workspace.locale, workspace.calendar?.system),
    dateStyle: "medium",
    timeZone: "UTC"
  });
  for (const event of results) {
    const result = node("button", "command-item search-event-result");
    result.type = "button";
    result.id = `event-result-${event.id}`;
    const copy = node("span", "search-event-copy");
    const title = node("strong", "", event.title || t("calendarEventTitle"));
    title.dir = "auto";
    const date = new Date(`${event.date}T00:00:00Z`);
    copy.append(title, node("small", "", dateFormat.format(date)));
    result.append(glyph("calendar"), copy);
    result.addEventListener("click", () => {
      switchTo("calendar", false);
      calendarController?.openEvent(event.id);
    });
    list.append(result);
  }
  view.append(heading, list);
}

function renderSearch() {
  section(t("searchResults"));
  const searchText = searchable(query);
  const matches = (text) => searchable(text).includes(searchText);
  const snippets = workspace.snippets.filter(({ title, text, folderId }) => {
    const folder = folderFor(folderId);
    return matches(`${title} ${text} ${folder?.name ?? ""}`);
  });
  const events = workspace.tabs.includes("calendar")
    ? calendarEvents().filter(({ title, date, location, notes }) => matches([title, date, location, notes].join(" ")))
      .sort((left, right) => left.date.localeCompare(right.date)
        || (left.start || left.end || "").localeCompare(right.start || right.end || ""))
    : [];
  const commands = destinations.filter((page) => (page === library || page === settings || workspace.tabs.includes(page.id))
    && matches(`${t(page.id)} ${translate("en", page.id)}`));
  const newSnippet = matches(`${t("newSnippet")} ${translate("en", "newSnippet")}`);
  if (!snippets.length && !events.length && !commands.length && !newSnippet) {
    emptyState(t("emptySearch"), t("emptySearchHint"), "search");
    return;
  }
  if (snippets.length) snippetList(t("snippets"), snippets, true);
  if (events.length) renderEventResults(events);
  if (commands.length || newSnippet) {
    const heading = node("div", "collection-heading");
    heading.append(node("h2", "", t("commands")));
    const list = node("div", "command-list");
    for (const page of commands) {
      list.append(button(t(page.id), "command-item", { symbol: page.icon, onClick: () => switchTo(page.id) }));
    }
    if (newSnippet) {
      list.append(button(t("newSnippet"), "command-item", {
        symbol: "plus",
        onClick: () => {
          switchTo("clipboard", false);
          editSnippet();
        }
      }));
    }
    view.append(heading, list);
  }
}

function render() {
  const focused = document.activeElement?.id;
  const root = document.documentElement;
  root.lang = workspace.locale;
  root.dir = isRtl(workspace.locale) ? "rtl" : "ltr";
  root.dataset.theme = workspace.theme;
  root.dataset.palette = workspace.palette;
  root.dataset.density = workspace.density;
  root.dataset.size = workspace.size;
  if (logo.dataset.palette !== workspace.palette) {
    const canvas = node("canvas");
    canvas.width = canvas.height = 96;
    paintBrand(canvas, workspace.palette);
    logo.src = canvas.toDataURL();
    logo.dataset.palette = workspace.palette;
  }
  search.placeholder = t("searchCompact");
  search.setAttribute("aria-label", t("searchLabel"));
  labelButton(panelButton, t("openPanel"), "panel");
  labelButton(settingsButton, t("settings"), "settings");
  settingsButton.setAttribute("aria-pressed", String(activePage === "settings" && !query));
  if (![library.id, settings.id, ...workspace.tabs].includes(activePage)) activePage = clipboard.id;
  renderTabs();
  if (!query && activePage === "calendar" && calendarController && calendarLocale === workspace.locale) {
    calendarController.update({ preferences: workspace.calendar, events: calendarEvents(), holidays: workspace.holidays });
    return;
  }
  calendarController = undefined;
  calendarConnectionsRefresh = undefined;
  accountRefresh = undefined;
  view.replaceChildren();
  if (query || activePage === "settings") {
    view.removeAttribute("role");
    view.removeAttribute("aria-labelledby");
  } else {
    view.setAttribute("role", "tabpanel");
    view.setAttribute("aria-labelledby", `tab-${activePage}`);
  }
  if (query) renderSearch();
  else if (activePage === "clipboard") renderClipboard();
  else if (activePage === "calendar") {
    const calendarSettings = button(t("calendarSettings"), "icon-button calendar-settings-trigger", {
      symbol: "calendar-settings",
      iconOnly: true
    });
    calendarSettings.id = "calendar-settings-button";
    section(t("calendar"), undefined, calendarSettings);
    const calendarBody = node("div");
    view.append(calendarBody);
    calendarLocale = workspace.locale;
    calendarController = renderCalendar(calendarBody, {
      locale: workspace.locale,
      t,
      icon,
      settingsButton: calendarSettings,
      navigation: calendarNavigation,
      preferences: workspace.calendar,
      events: calendarEvents(),
      holidays: workspace.holidays,
      onPreferences: (patch) => mutate("calendar-preferences", patch),
      onHoliday: (date, enabled) => mutate("calendar-holiday", { date, enabled }),
      onSaveEvent: (event) => mutate("save-event", event),
      onDeleteEvent: (id) => mutate("delete-event", { id }),
      renderConnections: (container) => {
        calendarConnectionsRefresh = renderCalendarConnections(container, {
          locale: workspace.locale, t, reportError, eventsChanged: refreshCalendarEvents
        });
      }
    });
    refreshCalendarEvents();
  } else if (activePage === "library") renderLibrary();
  else if (activePage === "settings") renderSettings();

  if (focused && focused !== "workspace" && !editor.open) {
    const element = document.getElementById(focused);
    if (element !== document.activeElement) element?.focus({ preventScroll: true });
  }
}

function openEditor(title, submitLabel, onSubmit) {
  const opener = document.activeElement?.id;
  editor.addEventListener("close", () => {
    if (opener) (document.getElementById(opener) ?? view).focus({ preventScroll: true });
  }, { once: true });
  const form = node("form");
  const heading = node("div", "dialog-heading");
  const headingText = node("h2", "", title);
  headingText.id = "editor-title";
  heading.append(headingText, button(t("close"), "icon-button", {
    symbol: "close",
    iconOnly: true,
    onClick: () => editor.close()
  }));
  const fields = node("div", "dialog-fields");
  const feedback = node("p", "dialog-feedback");
  feedback.setAttribute("role", "alert");
  feedback.hidden = true;
  form.append(heading, fields, feedback);
  if (onSubmit) {
    const buttons = node("div", "dialog-footer");
    const submit = button(submitLabel, "primary-button");
    submit.type = "submit";
    buttons.append(button(t("cancel"), "secondary-button", { onClick: () => editor.close() }), submit);
    form.append(buttons);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      feedback.hidden = true;
      try {
        if (await onSubmit()) editor.close();
      } finally {
        submit.disabled = false;
      }
    });
  }
  editor.setAttribute("aria-labelledby", headingText.id);
  editor.replaceChildren(form);
  return fields;
}

function field(container, { label, value = "", placeholder, multiline = false, maxLength, required = false }) {
  const wrapper = node("label", "field");
  const input = node(multiline ? "textarea" : "input");
  input.dir = "auto";
  input.value = value;
  input.required = required;
  if (maxLength) input.maxLength = maxLength;
  if (placeholder) input.placeholder = placeholder;
  if (multiline) input.rows = 5;
  wrapper.append(node("span", "", label), input);
  container.append(wrapper);
  return input;
}

function editSnippet(snippet) {
  const fields = openEditor(t(snippet ? "editSnippet" : "newSnippet"), t("save"), async () => {
    if (!text.value.trim()) {
      text.value = "";
      text.reportValidity();
      return false;
    }
    const initialFolder = snippet ? snippet.folderId ?? null : activeFolder === "all" ? null : activeFolder;
    const folderId = destination ? destination.value || null : initialFolder;
    const changeFolder = !snippet || folderId !== (snippet.folderId ?? null);
    return mutate("save-snippet", {
      id: snippet?.id, title: title.value, text: text.value, ...(changeFolder ? { folderId } : {})
    });
  });
  const title = field(fields, { label: `${t("snippetTitle")} (${t("optional")})`, value: snippet?.title, placeholder: t("snippetTitlePlaceholder"), maxLength: 100 });
  const text = field(fields, { label: t("snippetText"), value: snippet?.text, placeholder: t("snippetTextPlaceholder"), required: true, maxLength: 20000, multiline: true });
  const destination = workspace.folders.length ? node("select") : undefined;
  if (destination) {
    const row = node("label", "field folder-select");
    const choices = [{ id: "", name: t("noFolder") }, ...workspace.folders];
    for (const folder of choices) {
      const option = node("option", "", folder.name);
      option.value = folder.id;
      option.dir = "auto";
      destination.append(option);
    }
    const selectedId = snippet ? snippet.folderId : activeFolder;
    destination.value = folderFor(selectedId)?.id ?? "";
    row.append(node("span", "", t("folder")), destination);
    fields.append(row);
  }
  fields.append(node("p", "field-hint", t("templateTip")));
  editor.showModal();
  text.focus();
}

function editFolder(folder) {
  const id = folder?.id ?? crypto.randomUUID();
  const fields = openEditor(t(folder ? "editFolder" : "newFolder"), t("save"), async () => {
    const chosenIcon = choices.querySelector("input:checked").value;
    if (!await mutate(folder ? "update-folder" : "create-folder", { id, name: name.value, icon: chosenIcon })) return false;
    if (!folder) {
      activeFolder = id;
      if (folderFor(id)) selectFolder(id);
    }
    return true;
  });
  const name = field(fields, { label: t("folderName"), value: folder?.name, placeholder: t("folderNamePlaceholder"), required: true, maxLength: 48 });
  const picker = node("fieldset", "choice-group folder-icon-options");
  const choices = node("div", "choice-options");
  const labelKeys = { folder: "folder", briefcase: "work", user: "person", star: "star", link: "link" };
  for (const symbol of folderIcons) {
    const choice = radioOption("folder-icon", symbol, folder?.icon ?? "folder", "choice-option");
    const label = t(labelKeys[symbol]);
    choice.input.setAttribute("aria-label", label);
    choice.label.title = label;
    choice.face.append(glyph(symbol));
    choices.append(choice.label);
  }
  picker.append(node("legend", "", t("folderIcon")), choices);
  fields.append(picker);
  editor.showModal();
  name.focus();
}

function deleteFolder(folder) {
  const fields = openEditor(t("deleteFolder"), t("remove"), async () => {
    if (!await mutate("delete-folder", { id: folder.id })) return false;
    selectFolder(null);
    showToast(t("folderDeleted"));
    return true;
  });
  fields.append(node("p", "", t("deleteFolderConfirm", { name: folder.name })));
  editor.showModal();
}

function moveSnippet(snippet) {
  const from = snippet.folderId ?? null;
  const fields = openEditor(t("moveToFolder"));
  const list = node("div", "folder-picker");
  const choices = [{ id: null, name: t("noFolder"), icon: "folder" }, ...workspace.folders];
  for (const folder of choices) {
    const selected = folder.id === from;
    const item = button(folder.name, selected ? "folder-picker-item folder-picker-active" : "folder-picker-item", {
      symbol: folder.icon,
      onClick: async () => {
        if (!selected) {
          for (const option of list.children) option.disabled = true;
          if (!await mutate("move-snippet", { id: snippet.id, folderId: folder.id, expectedFolderId: from })) {
            for (const option of list.children) option.disabled = false;
            item.focus();
            return;
          }
          showToast(t("snippetMoved", { name: folder.name }), async () => {
            if (await mutate("move-snippet", { id: snippet.id, folderId: from, expectedFolderId: folder.id })) toast.hidden = true;
          });
        }
        editor.close();
      }
    });
    item.setAttribute("aria-pressed", String(selected));
    item.lastElementChild.dir = "auto";
    if (selected) item.append(glyph("check"));
    list.append(item);
  }
  fields.append(list);
  editor.showModal();
  list.querySelector(".folder-picker-active")?.focus();
}

function editShortcut(snippet) {
  const fields = openEditor(t("shortcutAssign"), t("save"), async () => {
    const value = choices.querySelector("input:checked").value;
    if (!await mutate("set-shortcut", { id: snippet.id, slot: value === "none" ? null : Number(value) })) return false;
    showToast(t("shortcutSaved"));
    return true;
  });
  const choices = node("div", "shortcut-options");
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", t("shortcutAssign"));
  const selected = String(snippet.slot ?? "none");
  const occupied = new Map(workspace.snippets.filter(({ id, slot }) => id !== snippet.id && slot)
    .map((item) => [item.slot, displayTitle(item)]));
  for (const slot of [...shortcutSlots, "none"]) {
    const option = radioOption("snippet-shortcut", String(slot), selected, "shortcut-option");
    if (occupied.has(slot)) {
      const note = t("shortcutTaken", { name: occupied.get(slot) });
      option.input.disabled = true;
      option.input.setAttribute("aria-description", note);
      option.label.title = note;
    }
    option.face.append(slot === "none" ? node("span", "", t("shortcutNone")) : node("kbd", "", slot));
    choices.append(option.label);
  }
  fields.append(node("p", "field-hint", t("shortcutDialogHint")), choices);
  editor.showModal();
  choices.querySelector("input:checked").focus();
}

const templatePattern = /(?<!\{)\{([\p{L}_][\p{L}\p{M}\p{N}\u200c_ -]{0,39})\}(?!\})/gu;

function templateFields(text) {
  return [...new Set(Array.from(text.matchAll(templatePattern), ([, name]) => name.trim()).filter(Boolean))];
}

function prepareCopy(snippet) {
  const names = templateFields(snippet.text);
  if (!names.length) {
    copySnippet(snippet, snippet.text);
    return;
  }
  const fields = openEditor(t("templateTitle"), t("copy"), () => {
    const text = snippet.text.replace(templatePattern, (match, name) => values.get(name.trim())?.value ?? match);
    return copySnippet(snippet, text);
  });
  fields.append(node("p", "field-hint", t("templateHint")));
  const values = new Map(names.map((name) => [name, field(fields, { label: name, required: true })]));
  editor.showModal();
  values.values().next().value.focus();
}

async function copySnippet(snippet, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    showToast(t("copyFailed"), undefined, true);
    return false;
  }
  copiedId = snippet.id;
  render();
  showToast(t("copied"));
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    if (inToolbarPopup) window.close();
    copiedId = undefined;
    for (const row of view.querySelectorAll(".is-copied")) row.classList.remove("is-copied");
    const rowIcon = document.getElementById(`snippet-${snippet.id}`)?.querySelector(".row-copy-icon");
    if (rowIcon) rowIcon.innerHTML = icon("copy");
  }, inToolbarPopup ? 420 : 1800);
  return true;
}

async function removeSnippet(snippet) {
  const index = workspace.snippets.findIndex(({ id }) => id === snippet.id);
  if (await mutate("delete-snippet", { id: snippet.id })) {
    showToast(t("deleted"), async () => {
      if (await mutate("restore-snippet", { snippet, index })) toast.hidden = true;
    });
  }
}

window.addEventListener("focus", readActivationShortcut);
window.addEventListener("focus", refreshCalendarDay);
document.querySelector(".search-icon").innerHTML = icon("search");
settingsButton.addEventListener("click", () => switchTo(activePage === "settings" && !query ? "clipboard" : "settings", false));
panelButton.addEventListener("click", async () => {
  if (currentWindowId === undefined) {
    showToast(t("panelFailed"), undefined, true);
    return;
  }
  try {
    await chrome.sidePanel.open({ windowId: currentWindowId });
    window.close();
  } catch {
    showToast(t("panelFailed"), undefined, true);
  }
});

search.addEventListener("input", () => {
  query = search.value.trim();
  render();
  view.scrollTop = 0;
});

tabBar.addEventListener("keydown", (event) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const allTabs = [...tabBar.querySelectorAll("button")];
  const index = allTabs.indexOf(document.activeElement);
  const next = {
    ArrowUp: (index - 1 + allTabs.length) % allTabs.length,
    ArrowDown: (index + 1) % allTabs.length,
    Home: 0,
    End: allTabs.length - 1
  }[event.key];
  event.preventDefault();
  switchTo(allTabs[next].dataset.module);
});

const openMenus = ".snippet-actions[open], .folder-overflow[open]";
document.addEventListener("click", (event) => {
  for (const menu of view.querySelectorAll(openMenus)) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (editor.open || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  const openMenu = view.querySelector(openMenus);
  if (event.key === "Escape" && openMenu) {
    event.preventDefault();
    openMenu.open = false;
    openMenu.querySelector("summary").focus();
    return;
  }
  if (event.key === "Escape" && query) {
    event.preventDefault();
    switchTo(activePage);
    return;
  }
  const results = query ? [...view.querySelectorAll(".snippet-copy, .command-item")] : [];
  if (results.length && document.activeElement === search && ["Enter", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    if (event.key === "Enter") results[0].click();
    else results[0].focus();
    return;
  }
  if (results.includes(document.activeElement) && ["ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    const offset = event.key === "ArrowUp" ? -1 : 1;
    (results[results.indexOf(document.activeElement) + offset] ?? search).focus();
    return;
  }
  if (event.target.closest("input, textarea, select, [contenteditable]") || openMenu) return;
  if (event.key === "/") {
    event.preventDefault();
    search.focus();
  } else if (/^[1-9١-٩۱-۹]$/u.test(event.key) && !event.repeat) {
    // The supported ASCII, Arabic and Persian digits share the same low nibble.
    const digit = event.key.codePointAt(0) & 0xf;
    const snippet = workspace.snippets.find(({ slot }) => slot === digit);
    if (snippet) {
      event.preventDefault();
      prepareCopy(snippet);
    }
  }
});

try {
  workspace = await readWorkspace();
} catch {
  showToast(t("saveFailed"), undefined, true);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[storageKey]) {
    workspace = { ...defaultWorkspace, ...changes[storageKey].newValue };
    render();
  }
  if (calendarConnectionKeys.some((key) => changes[key])) {
    calendarConnectionsRefresh?.().catch(() => reportError("syncFailed"));
    refreshCalendarEvents();
  }
  if (changes[accountStorageKey]) accountRefresh?.().catch(() => reportError("accountFailed"));
});
render();
refreshCalendarDay();
refreshCalendarEvents();
