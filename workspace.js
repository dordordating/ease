import { renderCalendar } from "./calendar.js";
import { paintBrand } from "./brand.js";
import { accountStorageKey, calendarConnectionKeys, loadConnectedEvents, renderAccount, renderCalendarConnections } from "./connections.js";
import { icon } from "./icons.js";
import { isRtl, localeNames, translate } from "./locales.js";
import { defaultWorkspace, densities, modules, palettes, readWorkspace, shortcutSlots, sizes, storageKey, themes } from "./workspace-data.js";

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

function pinnedSnippets() {
  return workspace.snippets.filter(({ pinned }) => pinned);
}

function snippetList(title, snippets) {
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
      action("edit", "edit", () => editSnippet(snippet)),
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
  const add = (className) => {
    const action = button(t("newSnippet"), className, { symbol: "plus", onClick: () => editSnippet() });
    action.id = "new-snippet";
    return action;
  };
  const hasSnippets = workspace.snippets.length > 0;
  section(t("clipboard"), undefined, hasSnippets ? add("primary-button") : undefined);
  if (!hasSnippets) {
    emptyState(t("emptyTitle"), t("emptyHint"), "clipboard", add("secondary-button"));
    return;
  }
  const pinned = pinnedSnippets().sort((left, right) => (left.slot ?? 10) - (right.slot ?? 10));
  const others = workspace.snippets.filter(({ pinned }) => !pinned);
  if (pinned.length) snippetList(t("pinned"), pinned);
  if (others.length) snippetList(t("snippets"), others);
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

function renderSearch() {
  section(t("searchResults"));
  const searchText = searchable(query);
  const matches = (text) => searchable(text).includes(searchText);
  const snippets = workspace.snippets.filter(({ title, text }) => matches(`${title} ${text}`));
  const commands = destinations.filter((page) => (page === library || page === settings || workspace.tabs.includes(page.id))
    && matches(`${t(page.id)} ${translate("en", page.id)}`));
  const newSnippet = matches(`${t("newSnippet")} ${translate("en", "newSnippet")}`);
  if (!snippets.length && !commands.length && !newSnippet) {
    emptyState(t("emptySearch"), t("emptySearchHint"), "search");
    return;
  }
  if (snippets.length) snippetList(t("snippets"), snippets);
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
    calendarController.update({ preferences: workspace.calendar, events: calendarEvents() });
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
    section(t("calendar"));
    const calendarBody = node("div");
    view.append(calendarBody);
    calendarLocale = workspace.locale;
    calendarController = renderCalendar(calendarBody, {
      locale: workspace.locale,
      t,
      icon,
      navigation: calendarNavigation,
      preferences: workspace.calendar,
      events: calendarEvents(),
      onPreferences: (patch) => mutate("calendar-preferences", patch),
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
    if (opener) document.getElementById(opener)?.focus();
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
  const buttons = node("div", "dialog-footer");
  const submit = button(submitLabel, "primary-button");
  submit.type = "submit";
  buttons.append(button(t("cancel"), "secondary-button", { onClick: () => editor.close() }), submit);
  form.append(heading, fields, feedback, buttons);
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
    return mutate("save-snippet", { id: snippet?.id, title: title.value, text: text.value });
  });
  const title = field(fields, { label: `${t("snippetTitle")} (${t("optional")})`, value: snippet?.title, placeholder: t("snippetTitlePlaceholder"), maxLength: 100 });
  const text = field(fields, { label: t("snippetText"), value: snippet?.text, placeholder: t("snippetTextPlaceholder"), required: true, maxLength: 20000, multiline: true });
  fields.append(node("p", "field-hint", t("templateTip")));
  editor.showModal();
  text.focus();
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

document.addEventListener("click", (event) => {
  for (const menu of view.querySelectorAll(".snippet-actions[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (editor.open || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  const openMenu = view.querySelector(".snippet-actions[open]");
  if (event.key === "Escape" && openMenu) {
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
