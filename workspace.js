import { renderCalendar } from "./calendar.js";
import { renderTranslator } from "./translator.js";
import { renderFlashcards } from "./flashcards.js";
import { renderTodo } from "./todo.js";
import { renderSpaces } from "./spaces.js";
import { renderHome } from "./home.js";
import { findAssistantHistory, watchAssistantHistory } from "./assistant-history-store.js";
import { assistantSourceReady, captureAssistantSource, receiveAssistantSource } from "./home-sources.js";
import { spacesMessage } from "./spaces-browser.js";
import { spaceColors, spaceLimits, spaceNameTaken } from "./spaces-store.js";
import { collapsedTaskKey, defaultTodo, localTaskDay, taskCalendarEntries, taskLimits, taskLink, taskSections } from "./todo-store.js";
import { calendarReminderLabel, calendarReminderOffsets, calendarSuggestedEnd } from "./calendar-timing.js";
import { createDatePicker } from "./date-picker.js";
import { createTimePicker } from "./time-picker.js";
import { quickTaskKey, takeQuickTask } from "./todo-background.js";
import { renderMarkets } from "./markets.js";
import { inboxMessages, renderMail } from "./mail.js";
import { htmlText, mailMessageLink, senderAddress } from "./mail-api.js";
import { mailMessage, mailUpdateKey } from "./mail-background.js";
import { marketAlertStateKey, readMarketAlertState } from "./markets-alerts.js";
import { marketLabel, workspaceMarketInstruments } from "./markets-store.js";
import { flashcardFieldLimits } from "./flashcard-store.js";
import { selectableLanguage, translationLanguagePreferences, translatorLanguages } from "./translator-engine.js";
import { takeTranslatorSelection, translatorSelectionKey } from "./translator-selection.js";
import { renderTranslatorSites } from "./translator-sites-ui.js";
import { readTranslationHistory, translationHistoryKey, translationHistoryMessage } from "./translation-history-store.js";
import { renderTranslationHistory } from "./translation-history-view.js";
import { clipboardHistoryKey, clipboardHistoryMessage, loadClipboardHistory } from "./clipboard-history-store.js";
import { initClipboardHistoryView } from "./clipboard-history-view.js";
import { searchWorkspaceModules } from "./workspace-search.js";
import { renderModuleLibrary } from "./module-library.js";
import { workspaceSyncMessage, workspaceSyncStorageKey } from "./workspace-sync.js";
import { renderWorkspaceSync } from "./workspace-sync-ui.js";
import { initWorkspaceZoom, renderWorkspaceZoomControl } from "./workspace-zoom.js";
import { paintBrand } from "./brand.js";
import { accountStorageKey, calendarConnectionKeys, loadConnectedEvents, renderAccount, renderCalendarConnections } from "./connections.js";
import { getGoogleAccount, signInGoogle } from "./providers.js";
import { icon } from "./icons.js";
import { deviceUnlockAvailable, readDeviceUnlock, registerDeviceUnlock } from "./vault-device.js";
import { vaultPinAttemptsStorageKey, vaultPolicyFor, vaultSessionStorageKey } from "./vault-session.js";
import { isRtl, localeNames, translate } from "./locales.js";
import { calendarSystemFor, defaultCalendar, defaultTranslator, defaultWorkspace, densities, folderIcons, modules, palettes, readWorkspace, shortcutSlots, sizes, storageKey, themes, visibleModules } from "./workspace-data.js";

const view = document.querySelector("#workspace");
const editor = document.querySelector("#editor");
const tabBar = document.querySelector("#module-tabs");
const app = document.querySelector(".app");
const search = document.querySelector("#search");
const logo = document.querySelector("#brand-logo");
const toast = document.querySelector("#toast");
const toastMessage = document.querySelector("#toast-message");
const toastAction = document.querySelector("#toast-action");
const panelButton = document.querySelector("#panel-button");
const settingsButton = document.querySelector("#settings-button");
const workspaceRoute = new URLSearchParams(location.search);
const inPanel = workspaceRoute.get("surface") === "panel";

const clipboard = modules[0];
const lastWorkspaceTabKey = "easeLastWorkspaceTab";
const clipboardHistoryFolder = Symbol("clipboard history");
const clipboardReadPermission = { permissions: ["clipboardRead"] };
const home = { id: "home", icon: "home" };
const library = { id: "library", icon: "plus" };
const settings = { id: "settings", icon: "settings" };
const destinations = [home, ...modules, library, settings];
let workspace = defaultWorkspace;
let activePage = home.id;
let lastWorkspaceTab = home.id;
let activeFolder = "all";
let clipboardHistory = { enabled: false, entries: [] };
let clipboardHistoryAllowed = false;
let clipboardHistoryIssue;
let clipboardHistoryReadVersion = 0;
let clipboardHistoryController;
let clipboardHistoryLocale;
let query = "";
let toastTimer;
let copyTimer;
let copiedId;
let copyInProgress = false;
let vaultCopyFeedback;
let draggedModule;
let currentWindowId;
let inToolbarPopup = false;
let homeController;
let homeLocale;
let assistantHistorySearch;
const calendarNavigation = {};
let calendarController;
let calendarConnectionsRefresh;
let calendarLocale;
let translatorController;
let translatorSiteController;
let translatorLocale;
let translatorHistoryOpen = false;
let translatorHistoryController;
let translationHistory = { enabled: false, entries: [] };
let flashcardController;
let flashcardLocale;
let todoController;
let todoLocale;
let spacesController;
let spacesLocale;
const collapsedTodo = new Set();
let marketsController;
let marketsLocale;
let marketAlertState = {};
let mailAccounts = [];
let mailController;
let mailLocale;
let mailReadVersion = 0;
let pendingMailReply;
const translatorDraft = {};
let translatorAccountId = null;
let workspaceInitialized = false;
let providerEvents = [];
let refreshVersion = 0;
let accountRefresh;
let workspaceSyncRefresh;
let calendarDayTimer;
let vaultTimer;
let inlinePinTimer;
let inlinePinState;
let workspaceReadVersion = 0;
let protectedDialogFolder;
let protectedDialogSnippet;
let supportsDeviceUnlock = false;

document.body.dataset.surface = inPanel ? "panel" : "popup";
panelButton.hidden = inPanel;
chrome.windows.getCurrent().then((window) => { currentWindowId = window.id; }).catch(() => {});
if (!inPanel) {
  chrome.runtime.getContexts({ contextTypes: ["POPUP"], documentUrls: [location.href] })
    .then((contexts) => { inToolbarPopup = contexts.length > 0; }).catch(() => {});
}

const t = (key, values) => translate(workspace.locale, key, values);
const reportError = (key) => showToast(t(key), undefined, true);
const changeWorkspaceZoom = (zoom) => mutate("preferences", { zoom });
const workspaceZoom = initWorkspaceZoom({ app, zoom: workspace.zoom, onZoom: changeWorkspaceZoom });

function calendarEvents() {
  const showTasks = workspace.tabs.includes("todo") && workspace.calendar?.showTasks !== false;
  return [...appointmentEvents(), ...(showTasks ? taskCalendarEntries(workspace.todo?.items ?? []) : [])];
}

const appointmentEvents = () => [...workspace.events, ...providerEvents];

async function refreshCalendarEvents() {
  const version = ++refreshVersion;
  const events = await loadConnectedEvents();
  if (version !== refreshVersion) return;
  providerEvents = events;
  calendarController?.update({ events: calendarEvents() });
  todoController?.update(workspace.todo ?? defaultTodo, appointmentEvents());
  if (query) render();
  refreshCalendarDay();
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

function showToast(message, action, error = false, actionLabel = t("undo")) {
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
    toastAction.textContent = actionLabel;
    toastAction.onclick = action;
  }
  toastTimer = setTimeout(() => {
    toast.hidden = true;
    toastAction.onclick = null;
  }, action ? 7000 : 2200);
}

async function mutate(action, data, onError = reportError) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "ease-workspace-update", action, data });
    if (response?.workspace) return true;
    onError(response?.error ?? "saveFailed");
  } catch {
    onError("saveFailed");
  }
  return false;
}

function savedTabAvailable(page, state = workspace) {
  return page === home.id || page === clipboard.id
    || (state.tabs.includes(page) && modules.some(module => module.released && module.id === page));
}

function rememberWorkspaceTab(page) {
  if (page === lastWorkspaceTab || !savedTabAvailable(page)) return;
  lastWorkspaceTab = page;
  chrome.storage.local.set({ [lastWorkspaceTabKey]: page }).catch(() => {});
}

function workspaceDateLocale() {
  const calendar = calendarSystemFor(workspace.locale, workspace.calendar?.system);
  return new Intl.Locale(workspace.locale, { calendar }).toString();
}

function switchTo(page, focus = true, showHistory = false) {
  activePage = page;
  rememberWorkspaceTab(page);
  translatorHistoryOpen = page === "translate" && showHistory;
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
  const dateKey = `${year}-${month}-${day}`;
  const isHoliday = holidays.includes(dateKey);
  const eventCount = calendarEvents().filter(({ date }) => date === dateKey).length;
  const localeInfo = new Intl.Locale(locale);
  const weekend = (localeInfo.getWeekInfo?.() ?? localeInfo.weekInfo)?.weekend
    ?? (localeInfo.language === "fa" ? [5] : [6, 7]);
  const isWeekend = weekend.includes(today.getDay() || 7);
  const kind = isHoliday ? "holiday" : isWeekend ? "weekend" : "normal";
  const labelKey = isHoliday ? "calendarTabHoliday" : isWeekend ? "calendarTabWeekend" : "calendarTabToday";
  const countFormat = new Intl.NumberFormat(locale, { useGrouping: false });
  const label = [t(labelKey, { date: fullDate })];
  if (eventCount) label.push(t("calendarEventCount", { count: countFormat.format(eventCount) }));
  const mark = node("span", "calendar-date-icon");
  mark.dataset.dayKind = kind;
  mark.setAttribute("aria-hidden", "true");
  mark.append(node("span", "calendar-date-number", dayNumber));
  if (kind !== "normal") mark.append(node("span", "calendar-date-accent"));
  button.replaceChildren(mark);
  updateModuleBadge(button, eventCount, countFormat);
  button.setAttribute("aria-label", label.join(" · "));
  button.title = [label.join(" · "), button.draggable ? t("moduleOrderHint") : ""].filter(Boolean).join("\n");
}

function refreshCalendarDay() {
  const tab = document.getElementById("tab-calendar");
  const now = new Date();
  if (tab) updateCalendarTab(tab, now);
  todoController?.update(workspace.todo ?? defaultTodo, appointmentEvents());
  refreshHome();
  const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  clearTimeout(calendarDayTimer);
  calendarDayTimer = setTimeout(refreshCalendarDay, nextDay.getTime() - now.getTime());
}

function updateMailBadge(tab) {
  if (!tab) return;
  const total = mailAccounts.reduce((sum, account) => sum + account.unread, 0);
  const numbers = new Intl.NumberFormat(workspace.locale, { useGrouping: false });
  const label = total ? `${t("mail")} · ${t("mailUnreadCount", { count: numbers.format(total) })}` : t("mail");
  tab.setAttribute("aria-label", label);
  updateModuleBadge(tab, total, numbers);
}

function updateModuleBadge(tab, count, numbers) {
  tab.querySelector(".module-count-badge")?.remove();
  if (count) {
    const badge = node("span", "module-count-badge");
    const value = node("bdi", "", count > 9 ? `+${numbers.format(9)}` : numbers.format(count));
    value.dir = "ltr";
    badge.append(value);
    badge.setAttribute("aria-hidden", "true");
    tab.append(badge);
  }
}

function renderTabs() {
  const focused = tabBar.contains(document.activeElement) ? document.activeElement.id : null;
  clearModuleDrag();
  tabBar.setAttribute("aria-label", t("modulesLabel"));
  tabBar.setAttribute("role", "tablist");
  tabBar.setAttribute("aria-orientation", "vertical");
  const displayed = visibleModules(workspace);
  const tabs = [home, ...displayed, library];
  tabBar.replaceChildren(...tabs.map((module) => {
    const isSelected = activePage === module.id && !query;
    const isLibrary = module === library;
    const item = button(t(module.id), `module-tab${isLibrary ? " module-tab--library" : module === home ? " module-tab--home" : ""}`, {
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
    if (displayed.length > 1 && displayed.includes(module)) bindModuleReorder(item, module.id);
    if (module.id === "calendar") updateCalendarTab(item);
    if (module.id === "mail") updateMailBadge(item);
    return item;
  }));
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
}

function clearModuleDrag() {
  draggedModule = undefined;
  for (const tab of tabBar.querySelectorAll("[data-module-dragging], [data-module-drop]")) {
    delete tab.dataset.moduleDragging;
    delete tab.dataset.moduleDrop;
  }
}

function moveModule(id, targetId, position) {
  return mutate("reorder-module", { id, targetId, position });
}

function moduleNeighbors(id) {
  const visible = visibleModules(workspace);
  const index = visible.findIndex((module) => module.id === id);
  return index < 0 ? [] : [visible[index - 1], visible[index + 1]];
}

function bindModuleReorder(tab, id) {
  tab.draggable = true;
  tab.setAttribute("aria-description", t("moduleOrderHint"));
  tab.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
  tab.addEventListener("dragstart", (event) => {
    if (!event.dataTransfer) return;
    closeWorkspaceMenu();
    draggedModule = id;
    tab.dataset.moduleDragging = "";
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-ease-module", id);
  });
  tab.addEventListener("dragend", clearModuleDrag);
  tab.addEventListener("dragover", (event) => {
    if (!draggedModule || draggedModule === id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    tab.dataset.moduleDrop = dropEdge(event);
  });
  tab.addEventListener("dragleave", (event) => {
    if (!(event.relatedTarget instanceof Node) || !tab.contains(event.relatedTarget)) delete tab.dataset.moduleDrop;
  });
  tab.addEventListener("drop", (event) => {
    if (!draggedModule || draggedModule === id) return;
    event.preventDefault();
    const source = draggedModule;
    const position = dropEdge(event);
    clearModuleDrag();
    moveModule(source, id, position);
  });
  const openMenu = (point) => {
    const [previous, next] = moduleNeighbors(id);
    openWorkspaceMenu(tab, point, t(id), (action) => {
      if (previous) action("moduleMoveUp", "chevron-up", () => moveModule(id, previous.id, "before"));
      if (next) action("moduleMoveDown", "chevron-down", () => moveModule(id, next.id, "after"));
    });
  };
  bindWorkspaceMenu(tab, openMenu);
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

function emptyState(title, description, symbol, action, container = view) {
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
  container.append(empty);
}

const displayTitle = ({ title, text }) => title || text.trim().split(/\r?\n/u)[0];

function folderFor(id) {
  return workspace.folders.find((folder) => folder.id === id);
}

function folderLocked(folder) {
  return Boolean(folder?.protected && !(folder.unlockedUntil > Date.now()));
}

function snippetReadable(snippet) {
  return !snippet.locked && (!vaultCopyFeedback || vaultCopyFeedback.folderId !== snippet.folderId)
    && !folderLocked(folderFor(snippet.folderId));
}

function clearExpiredDialog() {
  if (!editor.open) return;
  const snippet = protectedDialogSnippet && workspace.snippets.find(({ id }) => id === protectedDialogSnippet);
  if ((snippet && !snippetReadable(snippet)) || folderLocked(folderFor(protectedDialogFolder))) editor.close();
}

function startVaultTimer() {
  clearTimeout(vaultTimer);
  const now = Date.now();
  const expiration = Math.min(...workspace.folders
    .map(({ unlockedUntil }) => unlockedUntil).filter((until) => until > now));
  if (!Number.isFinite(expiration)) return;
  vaultTimer = setTimeout(() => {
    clearExpiredDialog();
    render();
    refreshWorkspace();
  }, expiration - now);
}

async function refreshWorkspace(raw, initialTab) {
  const version = ++workspaceReadVersion;
  try {
    const snapshot = raw ?? await readWorkspace();
    let next = snapshot;
    const vaultFolders = new Set(snapshot.folders.filter(({ vault }) => vault).map(({ id }) => id));
    if (vaultFolders.size) {
      try {
        const response = await chrome.runtime.sendMessage({ type: "ease-workspace-read" });
        if (!response?.workspace) throw new Error("Workspace unavailable");
        next = response.workspace;
      } catch {
        // If the worker cannot hydrate the vault, keep the public data and hide the protected snippets.
        next = {
          ...snapshot,
          folders: snapshot.folders.map(({ vault, ...folder }) => vault
            ? { ...folder, protected: true, vaultMode: vault.mode === "pin" ? "pin" : "password" } : folder),
          snippets: snapshot.snippets.filter(({ sealed, folderId }) => !sealed && !vaultFolders.has(folderId))
        };
      }
    }
    if (version !== workspaceReadVersion) return;
    workspace = next;
    if (initialTab) activePage = next.home?.start === "home" || !savedTabAvailable(initialTab, next) ? home.id : initialTab;
    clearExpiredDialog();
    render();
    startVaultTimer();
  } catch {
    if (version === workspaceReadVersion) reportError("saveFailed");
  }
}

function snippetList(title, snippets, showFolder = false, container = view) {
  const heading = node("div", "collection-heading");
  heading.append(node("h2", "", title));
  heading.append(node("small", "", new Intl.NumberFormat(workspace.locale).format(snippets.length)));
  const list = node("ul", "snippet-list");
  snippets.forEach((snippet) => {
    const name = displayTitle(snippet);
    const isCopied = copiedId === snippet.id;
    const row = node("li", `snippet-row${isCopied ? " is-copied" : ""}`);
    allowDrag(row, "snippet", snippet.id);
    const copy = node("button", "snippet-copy");
    copy.id = `snippet-${snippet.id}`;
    copy.type = "button";
    copy.setAttribute("aria-label", t("copySnippet", { name }));
    copy.addEventListener("click", () => prepareCopy(snippet));
    const folder = folderFor(snippet.folderId);
    const useFolderIcon = showFolder || activeFolder === "all";
    const marker = glyph(useFolderIcon ? folder?.icon ?? "clipboard" : snippet.pinned ? "pin" : "clipboard", "snippet-glyph");
    if (useFolderIcon && folder?.color) marker.dataset.folderColor = folder.color;
    copy.append(marker);
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
      action("todoAddSnippet", "todo", () => addSnippetTask(snippet.id)),
      action("shortcutAssign", "keyboard", () => editShortcut(snippet)),
      action("remove", "trash", () => removeSnippet(snippet))
    );
    details.append(summary, menu);
    row.append(copy, details);
    list.append(row);
  });
  container.append(heading, list);
}

function renderClipboard() {
  if (activeFolder !== "all" && activeFolder !== clipboardHistoryFolder && !folderFor(activeFolder)) activeFolder = "all";
  const folder = folderFor(activeFolder);
  const showHistory = activeFolder === clipboardHistoryFolder;
  const add = (className) => {
    const action = button(t("newSnippet"), className, { symbol: "plus", onClick: () => editSnippet() });
    action.id = "new-snippet";
    return action;
  };
  const snippets = workspace.snippets.filter((snippet) => snippetReadable(snippet)
    && (activeFolder === "all" || snippet.folderId === activeFolder));
  const hasSnippets = snippets.length > 0;
  section(t(showHistory ? "clipboardHistory" : "clipboard"), undefined, !showHistory && hasSnippets ? add("primary-button") : undefined);
  const layout = node("div", "clipboard-layout");
  const content = node("div", "clipboard-content");
  layout.append(renderFolderBar(), content);
  view.append(layout);
  layout.querySelector(".folder-quick").scrollTop = folderRailScroll;
  if (showHistory) {
    clipboardHistoryLocale = workspaceDateLocale();
    clipboardHistoryController = initClipboardHistoryView(content, {
      locale: workspace.locale, dateLocale: clipboardHistoryLocale, t, icon, state: clipboardHistoryViewState(),
      onAllow: () => changeClipboardHistory("allow"),
      onStart: () => changeClipboardHistory("set-enabled", { enabled: true }),
      onDelete: (id) => changeClipboardHistory("remove", { id }),
      onCopy: ({ text }) => copyWorkspaceText(text),
      onSave: ({ text }) => {
        if (editor.open) return false;
        editSnippet(undefined, { draftText: text });
        return true;
      }
    });
    return;
  }
  if (activeFolder !== "all") {
    const current = node("div", "folder-current");
    current.dataset.folderColor = folder?.color ?? "default";
    const label = node("span", "folder-current-name", folder.name);
    label.dir = "auto";
    current.append(glyph(folder.icon), label);
    content.append(current);
  }
  if (folder && vaultCopyFeedback?.folderId === folder.id) {
    const confirmation = node("div", "vault-copy-confirmation");
    confirmation.setAttribute("role", "status");
    confirmation.append(glyph(vaultCopyFeedback.copied ? "check" : "copy", "snippet-glyph"),
      node("span", "", t(vaultCopyFeedback.copied ? "copied" : "copying")));
    content.append(confirmation);
    return;
  }
  if (folderLocked(folder)) {
    renderLockedFolder(folder, content);
    return;
  }
  if (!hasSnippets) {
    const filtered = activeFolder !== "all";
    emptyState(t(filtered ? "emptyFolder" : "emptyTitle"), t(filtered ? "emptyFolderHint" : "emptyHint"),
      filtered ? "folder" : "clipboard", add("secondary-button"), content);
    return;
  }
  const pinned = snippets.filter(({ pinned }) => pinned).sort((left, right) => (left.slot ?? 10) - (right.slot ?? 10));
  const others = snippets.filter(({ pinned }) => !pinned);
  if (pinned.length) snippetList(t("pinned"), pinned, false, content);
  if (others.length) snippetList(t("snippets"), others, false, content);
}

function selectFolder(id) {
  if (id === clipboardHistoryFolder) {
    openClipboardHistory();
    return;
  }
  if (activeFolder !== id) inlinePinState = undefined;
  activeFolder = id;
  render();
  view.scrollTop = 0;
  const pin = view.querySelector(".vault-inline-pin input:not(:disabled)");
  (pin ?? document.getElementById(`folder-chip-${id}`))?.focus();
}

function clipboardHistoryViewState() {
  return {
    allowed: clipboardHistoryAllowed,
    active: clipboardHistoryAllowed && clipboardHistory.enabled,
    entries: clipboardHistory.entries,
    issue: clipboardHistoryIssue
  };
}

function updateClipboardHistoryView() {
  if (query) render();
  else clipboardHistoryController?.update(clipboardHistoryViewState());
}

async function refreshClipboardHistory() {
  const version = ++clipboardHistoryReadVersion;
  const [history, allowed] = await Promise.all([
    loadClipboardHistory().catch(() => clipboardHistory),
    chrome.permissions.contains(clipboardReadPermission).catch(() => false)
  ]);
  if (version !== clipboardHistoryReadVersion) return;
  clipboardHistory = history;
  clipboardHistoryAllowed = allowed;
  updateClipboardHistoryView();
}

async function changeClipboardHistory(action, data) {
  clipboardHistoryIssue = undefined;
  try {
    const response = await chrome.runtime.sendMessage({ type: clipboardHistoryMessage, action, ...data });
    if (!response?.ok) clipboardHistoryIssue = response?.error === "clipboardHistoryPermission"
      ? "clipboardHistoryPermissionDenied" : "clipboardHistoryFailed";
    await refreshClipboardHistory();
    return Boolean(response?.ok);
  } catch {
    clipboardHistoryIssue = "clipboardHistoryFailed";
    updateClipboardHistoryView();
    return false;
  }
}

function openClipboardHistory(entryId) {
  activeFolder = clipboardHistoryFolder;
  inlinePinState = undefined;
  switchTo(clipboard.id, false);
  if (entryId) clipboardHistoryController?.focus(entryId);
  else document.getElementById("clipboard-history-nav")?.focus();
  changeClipboardHistory("read");
}

function confirmClipboardHistoryClear() {
  if (editor.open) return;
  const fields = openEditor(t("clipboardHistoryClearTitle"), t("clipboardHistoryClear"), async () => {
    const cleared = await changeClipboardHistory("clear");
    if (!cleared) reportError(clipboardHistoryIssue ?? "clipboardHistoryFailed");
    return cleared;
  });
  fields.append(node("p", "", t("clipboardHistoryClearConfirm")));
  editor.showModal();
  editor.querySelector(".dialog-footer .secondary-button").focus();
}

let folderRailScroll = 0;
let clipboardDrag;
let workspaceMenu;

function clearClipboardDrag() {
  clipboardDrag = undefined;
  for (const item of view.querySelectorAll(".is-dragging, .is-drop-target, [data-drop-edge]")) {
    item.classList.remove("is-dragging", "is-drop-target");
    delete item.dataset.dropEdge;
  }
}

function allowDrag(element, kind, id) {
  element.draggable = true;
  element.addEventListener("dragstart", (event) => {
    if (!event.dataTransfer) return;
    clearClipboardDrag();
    clipboardDrag = { kind, id };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(`application/x-ease-${kind}`, id);
    element.classList.add("is-dragging");
  });
  element.addEventListener("dragend", clearClipboardDrag);
}

function dropEdge(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function allowFolderDrop(chip, folder) {
  function acceptsDrag() {
    if (clipboardDrag?.kind === "folder") return clipboardDrag.id !== folder.id;
    if (clipboardDrag?.kind !== "snippet") return false;
    const snippet = workspace.snippets.find(({ id }) => id === clipboardDrag.id);
    return snippet && snippetReadable(snippet) && (snippet.folderId ?? null) !== folder.id;
  }

  chip.addEventListener("dragover", (event) => {
    if (!acceptsDrag()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (clipboardDrag.kind === "folder") chip.dataset.dropEdge = dropEdge(event);
    else chip.classList.add("is-drop-target");
  });
  chip.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && chip.contains(event.relatedTarget)) return;
    chip.classList.remove("is-drop-target");
    delete chip.dataset.dropEdge;
  });
  chip.addEventListener("drop", (event) => {
    if (!acceptsDrag()) return;
    event.preventDefault();
    const drag = clipboardDrag;
    clearClipboardDrag();
    if (drag.kind === "folder") {
      mutate("reorder-folder", { id: drag.id, targetId: folder.id, position: dropEdge(event) });
      return;
    }
    const snippet = workspace.snippets.find(({ id }) => id === drag.id);
    if (folderLocked(folder)) editVaultCredential(folder, "unlock", () => completeSnippetMove(snippet, folder));
    else completeSnippetMove(snippet, folder);
  });
}

function closeWorkspaceMenu() {
  if (!workspaceMenu) return;
  if (workspaceMenu.matches(":popover-open")) workspaceMenu.hidePopover();
  workspaceMenu.remove();
  workspaceMenu = undefined;
}

function bindWorkspaceMenu(anchor, open) {
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    open(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
  });
  anchor.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    open();
  });
}

function openWorkspaceMenu(anchor, point, label, populate) {
  closeWorkspaceMenu();
  const menu = node("div", "folder-context-menu");
  menu.setAttribute("popover", "auto");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  const group = node("div", "folder-menu-group");
  function action(key, symbol, run) {
    const item = button(t(key), "folder-menu-item", {
      symbol,
      onClick: () => {
        closeWorkspaceMenu();
        anchor.focus();
        run();
      }
    });
    item.setAttribute("role", "menuitem");
    if (["deleteFolder", "clipboardHistoryClear", "mailDelete", "spaceDelete"].includes(key)) item.dataset.action = "delete";
    group.append(item);
  }

  populate(action);
  if (!group.childElementCount) return;
  menu.append(group);
  menu.addEventListener("toggle", (event) => {
    if (event.newState === "closed" && workspaceMenu === menu) closeWorkspaceMenu();
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeWorkspaceMenu();
      anchor.focus();
      return;
    }
    const options = [...group.children];
    const index = options.indexOf(document.activeElement);
    const next = {
      ArrowDown: (index + 1) % options.length,
      ArrowUp: (index - 1 + options.length) % options.length,
      Home: 0,
      End: options.length - 1
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    options[next].focus();
  });
  workspaceMenu = menu;
  document.body.append(menu);
  menu.showPopover();
  const rect = anchor.getBoundingClientRect();
  const bounds = menu.getBoundingClientRect();
  const left = point?.x ?? rect.left;
  const top = point?.y ?? rect.top;
  menu.style.setProperty("--folder-menu-left", `${Math.max(4, Math.min(left - bounds.width, innerWidth - bounds.width - 4))}px`);
  menu.style.setProperty("--folder-menu-top", `${Math.max(4, Math.min(top, innerHeight - bounds.height - 4))}px`);
  group.firstElementChild.focus();
}

function openFolderContext(folder, anchor, point) {
  const position = workspace.folders.findIndex(({ id }) => id === folder.id);
  const before = workspace.folders[position - 1];
  const after = workspace.folders[position + 1];
  openWorkspaceMenu(anchor, point, t("folderContext"), (action) => {
    if (folderLocked(folder)) {
      action("vaultUnlock", "unlock", () => editVaultCredential(folder));
    } else {
      action("editFolder", "edit", () => editFolder(folder));
      if (folder.protected) {
        action("vaultLock", "lock", () => changeVault("lock-folder", { id: folder.id }));
        action("vaultPolicySettings", "settings", () => editVaultPolicy(folder));
        action(folder.vaultMode === "pin" ? "vaultChangePin" : "vaultSetPin", "edit", () => editVaultCredential(folder, "change"));
        if (folder.device) action("vaultDeviceRemove", "fingerprint", () => removeDeviceUnlock(folder));
        else if (supportsDeviceUnlock) action("vaultDeviceEnable", "fingerprint", () => enableDeviceUnlock(folder));
        action(folder.vaultMode === "pin" ? "vaultRemovePin" : "vaultRemove", "unlock", () => removeVaultPassword(folder));
      } else {
        action("vaultSetPin", "lock", () => editVaultCredential(folder, "setup"));
      }
      action("deleteFolder", "trash", () => deleteFolder(folder));
    }
    if (before) action("folderMoveUp", "chevron-up", () => mutate("reorder-folder", { id: folder.id, targetId: before.id, position: "before" }));
    if (after) action("folderMoveDown", "chevron-down", () => mutate("reorder-folder", { id: folder.id, targetId: after.id, position: "after" }));
  });
}

function renderFolderBar() {
  const bar = node("nav", "folder-bar");
  bar.setAttribute("aria-label", t("clipboardFolders"));
  const quick = node("div", "folder-quick");
  const all = { id: "all", name: t("allFolders"), icon: "clipboard" };
  const history = { id: clipboardHistoryFolder, name: t("clipboardHistory"), icon: "history" };
  for (const folder of [all, history, ...workspace.folders]) {
    const chip = button(folder.name, "folder-chip", { symbol: folder.icon, onClick: () => selectFolder(folder.id) });
    chip.id = folder === history ? "clipboard-history-nav" : `folder-chip-${folder.id}`;
    chip.title = folder.name;
    chip.dataset.folderColor = folder.color ?? "default";
    chip.lastElementChild.className = "folder-label";
    chip.lastElementChild.dir = "auto";
    chip.setAttribute("aria-pressed", String(activeFolder === folder.id));
    if (folder === history) {
      chip.title = `${folder.name}\n${t("folderContextHint")}`;
      bindWorkspaceMenu(chip, (point) => {
        openWorkspaceMenu(chip, point, folder.name, (action) => {
          if (clipboardHistory.enabled && clipboardHistoryAllowed) {
            action("clipboardHistoryPause", "pause", async () => {
              if (!await changeClipboardHistory("set-enabled", { enabled: false }) && !clipboardHistoryController) {
                reportError(clipboardHistoryIssue ?? "clipboardHistoryFailed");
              }
            });
          }
          if (clipboardHistory.entries.length) action("clipboardHistoryClear", "trash", confirmClipboardHistoryClear);
        });
      });
      quick.append(chip);
      continue;
    }
    if (folderLocked(folder)) {
      chip.classList.add("is-locked");
      chip.append(glyph("lock", "folder-lock-mark"));
      chip.setAttribute("aria-description", t("vaultLockedFolder"));
    }
    if (folder.id !== "all") allowFolderDrop(chip, folder);
    if (folder.id !== "all") {
      chip.title = `${folder.name}
${t("folderContextHint")}`;
      allowDrag(chip, "folder", folder.id);
      bindWorkspaceMenu(chip, (point) => openFolderContext(folder, chip, point));
    }
    quick.append(chip);
  }
  const actions = node("div", "folder-actions");
  const create = button(t("newFolder"), "icon-button", { symbol: "plus", iconOnly: true, onClick: () => editFolder() });
  create.id = "new-folder";
  actions.append(create);
  bar.append(quick, actions);
  return bar;
}

function renderLibrary() {
  const body = node("div");
  const switcher = renderModuleLibrary(body, {
    t, icon, modules, tabs: workspace.tabs, layout: workspace.libraryLayout,
    onLayout: (libraryLayout) => mutate("preferences", { libraryLayout }),
    async onToggle(id) {
      const enabled = !workspace.tabs.includes(id);
      const changed = await mutate("toggle-module", { id, enabled });
      if (changed) showToast(t(enabled ? "moduleAdded" : "moduleHidden", { name: t(id) }));
      return changed;
    }
  });
  section(t("library"), t("libraryHint"), switcher);
  view.append(body);
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

async function readWorkspaceShortcuts() {
  const values = [
    ["_execute_action", document.getElementById("activation-shortcut")],
    ["translate-selection", document.getElementById("translation-shortcut")],
    ["quick-task", document.getElementById("todo-shortcut")]
  ].filter(([, element]) => element);
  if (!values.length) return;
  let commands = [];
  try {
    commands = await chrome.commands?.getAll?.() ?? [];
  } catch {
    // Chrome may not expose commands in every extension surface.
  }
  for (const [command, element] of values) {
    const shortcut = commands.find(({ name }) => name === command)?.shortcut;
    element.textContent = shortcut || t("shortcutNotSet");
    element.dir = shortcut ? "ltr" : "auto";
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
  renderWorkspaceZoomControl(list, {
    locale: workspace.locale, t, zoom: workspace.zoom,
    onZoom: (zoom) => workspaceZoom.setZoom(zoom)
  });

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
    onClick: openChromeShortcuts
  }));
  shortcut.append(node("h3", "", t("activationShortcut")), shortcutDetails);
  list.append(shortcut);
  const storage = node("div", "setting-row storage-note");
  const copy = node("div");
  copy.append(node("strong", "", t("storageTitle")), node("p", "", t("storageHint")));
  storage.append(glyph("device", "module-glyph"), copy);
  list.append(storage);
  view.append(list);
  accountRefresh = renderAccount(list, t, reportError, { inToolbarPopup });
  workspaceSyncRefresh = renderWorkspaceSync(list, { locale: workspace.locale, dateLocale: workspaceDateLocale(), t, send: sendWorkspaceSync });
  readWorkspaceShortcuts();
}

function sendWorkspaceSync(action, passphrase) {
  return chrome.runtime.sendMessage({ type: workspaceSyncMessage, action, ...(passphrase === undefined ? {} : { passphrase }) });
}

function calendarSearchSource() {
  const dateFormat = new Intl.DateTimeFormat(workspace.locale, {
    calendar: calendarSystemFor(workspace.locale, workspace.calendar?.system),
    dateStyle: "medium",
    timeZone: "UTC"
  });
  const events = appointmentEvents().sort((left, right) => left.date.localeCompare(right.date)
    || (left.start || left.end || "").localeCompare(right.start || right.end || ""));
  return {
    label: "calendarEvents",
    entries: events.map((event) => {
      const date = new Date(`${event.date}T00:00:00Z`);
      return {
        id: `event-result-${event.id}`,
        title: event.title || t("calendarEventTitle"),
        detail: Number.isFinite(date.getTime()) ? dateFormat.format(date) : event.date,
        keywords: [event.title, event.date, event.location, event.notes],
        open() {
          switchTo("calendar", false);
          calendarController?.openEvent(event.id);
        }
      };
    })
  };
}

const moduleSearchSources = {
  clipboard: () => ({
    label: "snippets",
    entries: workspace.snippets.filter(snippetReadable).map((snippet) => ({
      snippet, keywords: [snippet.title, snippet.text, folderFor(snippet.folderId)?.name]
    })),
    render: (entries) => snippetList(t("snippets"), entries.map(({ snippet }) => snippet), true)
  }),
  calendar: calendarSearchSource,
  todo: () => ({
    label: "todo",
    entries: workspace.tabs.includes("todo") ? (workspace.todo?.items ?? []).map(task => ({
      id: `task-result-${task.id}`, title: task.title, detail: task.notes || (task.done ? t("todoCompleted") : undefined),
      keywords: [task.title, task.notes, task.dueDate, task.planDate, ...(task.checklist ?? []).map(item => item.text),
        workspace.spaces?.find(space => space.id === task.spaceId)?.name,
        ...(workspace.todo?.labels ?? []).filter(label => task.labelIds?.includes(label.id)).map(label => label.name)],
      open: () => openTodoTask(task.id)
    })) : []
  }),
  spaces: () => ({
    label: "spaces",
    entries: workspace.tabs.includes("spaces") ? workspace.spaces.map(space => ({
      id: `space-result-${space.id}`, title: space.name, detail: space.notes,
      keywords: [space.name, space.notes, ...space.groups.map(group => group.title), ...space.tabs.flatMap(tab => [tab.title, tab.url])],
      open: () => openSpaceDetail(space.id)
    })) : []
  }),
  markets: marketSearchSource,
  mail: () => ({
    label: "mail",
    entries: workspace.tabs.includes("mail") ? [...inboxMessages(mailAccounts), ...inboxMessages(mailAccounts, "sent")].map(message => ({
      title: message.subject || t("mailNoSubject"), detail: message.sender || message.email,
      keywords: [message.subject, message.sender, message.email],
      open() {
        switchTo("mail", false);
        mailController?.showMessage(message);
      }
    })) : []
  }),
  translate: () => ({
    label: "translationHistory", icon: "history",
    entries: translationHistory.entries.map((entry) => ({
      id: `history-result-${entry.id}`, title: entry.translation, detail: entry.text,
      keywords: [entry.text, entry.translation, entry.learning?.usage, entry.learning?.example, entry.learning?.exampleTranslation],
      open: () => openTranslationHistory(entry.id)
    }))
  }),
  flashcards: () => ({
    label: "flashcards",
    entries: (workspace.flashcards?.cards ?? []).map((card) => ({
      id: `flashcard-result-${card.id}`, title: card.term, detail: card.answer,
      keywords: [card.term, card.answer, card.usage, card.example, card.exampleTranslation],
      open() {
        switchTo("flashcards", false);
        flashcardController?.openCard(card.id);
      }
    }))
  })
};

function marketSearchSource() {
  const names = new Intl.DisplayNames([workspace.locale], { type: "currency" });
  const coinNames = { BTC: "marketsBitcoin", ETH: "marketsEthereum", SOL: "marketsSolana", XRP: "marketsXrp" };
  return {
    label: "markets",
    entries: workspaceMarketInstruments(workspace.markets).map(instrument => {
      const { symbol, name, kind, base, quote } = instrument;
      const baseName = kind === "fx" ? names.of(base) : coinNames[base] && !symbol.startsWith("cg:") ? t(coinNames[base]) : name;
      const quoteName = instrument.quoteName || (quote === "TMN" ? t("marketsToman") : /^[A-Z]{3}$/u.test(quote) ? names.of(quote) : quote);
      const label = marketLabel(instrument);
      const detail = `${baseName} · ${quoteName}`;
      return {
        id: symbol === label ? `market-result-${base}-${quote}` : `market-result-${symbol.replaceAll("/", "--")}`, title: label, detail,
        keywords: [label, `${base}${quote}`, base, quote, name, baseName, quoteName, base === "XRP" ? "Ripple" : ""],
        open() {
          switchTo("markets", false);
          marketsController?.openInstrument(symbol);
        }
      };
    })
  };
}

function renderSearchGroup({ id, label, icon: symbol, entries, render: renderEntries }) {
  if (renderEntries) return renderEntries(entries);
  const heading = node("div", "collection-heading");
  heading.append(node("h2", "", t(label)));
  const list = node("div", "command-list");
  for (const entry of entries) {
    const result = node("button", id === "calendar" ? "command-item search-event-result" : "command-item search-module-result");
    result.type = "button";
    if (entry.id) result.id = entry.id;
    const copy = node("span", "search-event-copy");
    const title = node("strong", "", entry.title);
    title.dir = "auto";
    copy.append(title);
    if (entry.detail) {
      const detail = node("small", "", entry.detail);
      detail.dir = "auto";
      copy.append(detail);
    }
    result.append(glyph(entry.icon ?? symbol), copy);
    result.addEventListener("click", entry.open);
    list.append(result);
  }
  view.append(heading, list);
}

function renderSearch() {
  section(t("searchResults"));
  const sources = modules.filter(({ id, released }) => released && Object.hasOwn(moduleSearchSources, id))
    .map(({ id, icon }) => ({ id, icon, ...moduleSearchSources[id]() }));
  const commands = destinations.filter((page) => [home, library, settings].includes(page) || workspace.tabs.includes(page.id))
    .map((page) => ({ title: t(page.id), icon: page.icon, keywords: [t(page.id), translate("en", page.id)], open: () => switchTo(page.id) }));
  commands.push(
    {
      title: t("assistantAsk"), icon: "sparkles", keywords: [t("assistant"), t("assistantAsk"), "AI", "assistant"],
      open() {
        switchTo(home.id, false);
        homeController?.focusPrompt();
      }
    },
    {
      title: t("assistantHistory"), icon: "history", keywords: [t("assistantHistory"), translate("en", "assistantHistory")],
      open: () => openHomeHistory()
    },
    {
      title: t("newSnippet"), icon: "plus", keywords: [t("newSnippet"), translate("en", "newSnippet")],
      open() {
        switchTo("clipboard", false);
        editSnippet();
      }
    },
    {
      title: t("clipboardHistory"), icon: "history",
      keywords: [t("clipboardHistory"), translate("en", "clipboardHistory")],
      open: () => openClipboardHistory()
    }
  );
  const history = {
    id: "clipboard-history", label: "clipboardHistorySearch", icon: "history",
    entries: clipboardHistory.entries.map(({ id, text }) => ({
      id: `clipboard-history-result-${id}`, title: text, keywords: [text],
      open: () => openClipboardHistory(id)
    }))
  };
  const results = searchWorkspaceModules(query, workspace.locale, [...sources, history, { id: "commands", label: "commands", entries: commands }]);
  results.forEach(renderSearchGroup);
  const noResults = () => { if (!results.length) emptyState(t("emptySearch"), t("emptySearchHint"), "search"); };
  const account = translatorAccountId;
  if (!account) return noResults();
  const { locale } = workspace;
  const controller = new AbortController();
  assistantHistorySearch = controller;
  findAssistantHistory(account, query, locale, controller.signal).then(matches => {
    if (controller.signal.aborted) return;
    if (!matches.length) return noResults();
    renderSearchGroup({
      id: "assistant-history", label: "assistantHistory", icon: "history",
      entries: matches.map(({ id, prompt, answer }) => ({
        id: `assistant-history-result-${id}`, title: prompt, detail: answer.slice(0, 180).toWellFormed(),
        open: () => openHomeHistory(id)
      }))
    });
  }, () => { if (!controller.signal.aborted) noResults(); });
}

function render() {
  assistantHistorySearch?.abort();
  assistantHistorySearch = undefined;
  clearTimeout(inlinePinTimer);
  closeWorkspaceMenu();
  const folderRail = view.querySelector(".folder-quick");
  if (folderRail) folderRailScroll = folderRail.scrollTop;
  const focused = document.activeElement?.id;
  const root = document.documentElement;
  const dateLocale = workspaceDateLocale();
  root.lang = workspace.locale;
  root.dir = isRtl(workspace.locale) ? "rtl" : "ltr";
  root.dataset.theme = workspace.theme;
  root.dataset.palette = workspace.palette;
  root.dataset.density = workspace.density;
  root.dataset.size = workspace.size;
  workspaceZoom.update({ zoom: workspace.zoom });
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
  if (![home.id, library.id, settings.id].includes(activePage)
    && !modules.some(({ id, released }) => released && id === activePage)) activePage = clipboard.id;
  renderTabs();
  if (!query && activePage === home.id && homeController?.root.isConnected && homeLocale === dateLocale) {
    refreshHome();
    return;
  }
  if (!query && activePage === "calendar" && calendarController && calendarLocale === workspace.locale) {
    calendarController.update({ preferences: { ...defaultCalendar, ...workspace.calendar }, events: calendarEvents(), holidays: workspace.holidays });
    return;
  }
  if (!query && activePage === "translate" && translatorHistoryOpen && translatorHistoryController && translatorLocale === dateLocale) {
    translatorHistoryController.update(translationHistory);
    return;
  }
  if (!query && activePage === "translate" && !translatorHistoryOpen && translatorController && translatorLocale === workspace.locale) {
    translatorController.update(translatorOptions());
    translatorSiteController?.update(inlineTranslatorEnabled());
    return;
  }
  if (!query && activePage === "flashcards" && flashcardController && flashcardLocale === dateLocale) {
    flashcardController.update({ state: workspace.flashcards });
    return;
  }
  if (!query && activePage === "todo" && todoController && todoLocale === dateLocale) {
    todoController.update(workspace.todo ?? defaultTodo, appointmentEvents());
    return;
  }
  if (!query && activePage === "spaces" && spacesController && spacesLocale === dateLocale) {
    spacesController.update(workspace.spaces);
    return;
  }
  if (!query && activePage === "markets" && marketsController && marketsLocale === dateLocale) {
    marketsController.update({ state: workspace.markets, alertState: marketAlertState });
    return;
  }
  if (!query && activePage === "mail" && mailController && mailLocale === dateLocale && !pendingMailReply) {
    mailController.update(mailAccounts);
    return;
  }
  if (!query && activePage === clipboard.id && activeFolder === clipboardHistoryFolder
    && clipboardHistoryController && clipboardHistoryLocale === dateLocale) {
    view.querySelector(".folder-bar").replaceWith(renderFolderBar());
    view.querySelector(".folder-quick").scrollTop = folderRailScroll;
    if (focused === "clipboard-history-nav") document.getElementById(focused)?.focus({ preventScroll: true });
    clipboardHistoryController.update(clipboardHistoryViewState());
    return;
  }
  translatorController?.dispose?.();
  homeController?.hide();
  translatorController = undefined;
  translatorSiteController = undefined;
  translatorHistoryController = undefined;
  flashcardController?.dispose();
  flashcardController = undefined;
  todoController?.dispose();
  todoController = undefined;
  spacesController = undefined;
  marketsController?.dispose();
  marketsController = undefined;
  mailController?.dispose();
  mailController = undefined;
  calendarController = undefined;
  clipboardHistoryController = undefined;
  calendarConnectionsRefresh = undefined;
  accountRefresh = undefined;
  workspaceSyncRefresh = undefined;
  view.replaceChildren();
  if (query || activePage === "settings" || !document.getElementById(`tab-${activePage}`)) {
    view.removeAttribute("role");
    view.removeAttribute("aria-labelledby");
  } else {
    view.setAttribute("role", "tabpanel");
    view.setAttribute("aria-labelledby", `tab-${activePage}`);
  }
  if (query) renderSearch();
  else if (activePage === home.id) showHome(dateLocale);
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
      onOpenTask: openTodoTask,
      onCompleteTask: completeTodo,
      renderConnections: (container) => {
        calendarConnectionsRefresh = renderCalendarConnections(container, {
          locale: workspace.locale, dateLocale: workspaceDateLocale(), t, reportError, eventsChanged: refreshCalendarEvents, inToolbarPopup
        });
      }
    });
    refreshCalendarEvents();
  } else if (activePage === "translate" && translatorHistoryOpen) {
    const close = button(t("close"), "icon-button", { symbol: "close", iconOnly: true, onClick: () => switchTo("translate", false) });
    close.id = "translator-history-button";
    section(t("translationHistory"), undefined, close);
    const body = node("div");
    view.append(body);
    translatorLocale = dateLocale;
    translatorHistoryController = renderTranslationHistory(body, {
      locale: workspace.locale, dateLocale, t, icon, state: translationHistory,
      onCopy: (entry) => copyWorkspaceText(entry.translation),
      onDelete: (entry) => updateTranslationHistory("remove", { id: entry.id }),
      onFlashcard: (entry) => editFlashcard(undefined, entry)
    });
  } else if (activePage === "translate") {
    const translatorSettings = button(t("translatorConfig"), "icon-button", { symbol: "translate-settings", iconOnly: true });
    translatorSettings.id = "translator-settings-button";
    const history = button(t("translationHistory"), "icon-button", {
      symbol: "history", iconOnly: true, onClick: () => openTranslationHistory()
    });
    history.id = "translator-history-button";
    const actions = node("div", "module-title-actions");
    actions.append(history, translatorSettings);
    section(t("translate"), undefined, actions);
    const body = node("div");
    view.append(body);
    translatorLocale = workspace.locale;
    translatorController = renderTranslator(body, {
      ...translatorOptions(),
      locale: workspace.locale, t, icon, settingsButton: translatorSettings, draft: translatorDraft,
      onPreferences: (patch) => mutate("translator-preferences", patch),
      onCopy: copyWorkspaceText,
      onSave: saveTranslation,
      onFlashcard: (translation) => editFlashcard(undefined, translation),
      onHistory: (entry) => updateTranslationHistory("record", entry),
      onHistoryToggle: (enabled) => updateTranslationHistory("set-enabled", { enabled }),
      onShortcut: openChromeShortcuts,
      onSignIn: signInForTranslation
    });
    translatorSiteController = renderTranslatorSites(body.querySelector(".translator-settings-view"), {
      t, icon, enabled: inlineTranslatorEnabled(),
      requestInWorker: inToolbarPopup,
      onUpdate: (enabled, onError, requestPermission) =>
        mutate("translator-inline-enabled", { enabled, requestPermission }, onError)
    });
    readWorkspaceShortcuts();
  } else if (activePage === "flashcards") {
    const add = button(t("flashcardAdd"), "primary-button", { symbol: "plus", onClick: () => editFlashcard() });
    add.id = "new-flashcard";
    const flashcardSettings = button(t("flashcardsSettings"), "icon-button flashcards-settings-button", {
      symbol: "flashcards-settings", iconOnly: true
    });
    flashcardSettings.id = "flashcard-settings-button";
    const actions = node("div", "module-title-actions");
    actions.append(add, flashcardSettings);
    section(t("flashcards"), undefined, actions);
    const body = node("div");
    view.append(body);
    flashcardLocale = dateLocale;
    flashcardController = renderFlashcards(body, {
      locale: workspace.locale, dateLocale, t, icon, state: workspace.flashcards,
      settingsButton: flashcardSettings, addButton: add,
      onPreferences: (patch) => mutate("flashcard-preferences", patch),
      onAdd: () => editFlashcard(),
      onEdit: editFlashcard,
      onDelete: confirmFlashcardDeletion,
      onReview: (review) => mutate("review-flashcard", review)
    });
  } else if (activePage === "todo") {
    const settings = button(t("todoSettings"), "icon-button", { symbol: "todo-settings", iconOnly: true });
    settings.id = "todo-settings-button";
    section(t("todo"), undefined, settings);
    const body = node("section", "todo-module");
    view.append(body);
    todoLocale = dateLocale;
    todoController = renderTodo(body, {
      t, icon, locale: workspace.locale, dateLocale, settingsButton: settings,
      state: workspace.todo ?? defaultTodo, events: appointmentEvents(),
      change: updateTodo, complete: completeTodo, openSource: openTodoSource, edit: editTodo, editLabel: editTodoLabel,
      spaceFor: id => workspace.spaces.find(space => space.id === id),
      openSpace: space => restoreSpace(space, "window"),
      collapsed: collapsedTodo,
      onCollapse(section, closing) {
        const previous = collapsedTodo.has(section);
        if (closing) collapsedTodo.add(section);
        else collapsedTodo.delete(section);
        chrome.storage.local.set({ [collapsedTaskKey(section)]: closing }).catch(() => {
          if (previous) collapsedTodo.add(section);
          else collapsedTodo.delete(section);
          todoController?.updateCollapsed();
          reportError("saveFailed");
        });
      },
      openEvent(id) {
        switchTo("calendar", false);
        calendarController?.openEvent(id);
      },
      shortcuts() {
        const value = node("kbd", "keycap", t("shortcutNotSet"));
        value.id = "todo-shortcut";
        queueMicrotask(readWorkspaceShortcuts);
        return [value, button(t("manageActivationShortcut"), "secondary-button", { symbol: "keyboard", onClick: openChromeShortcuts })];
      }
    });
    if (workspace.tabs.includes("calendar")) refreshCalendarEvents();
  } else if (activePage === "spaces") {
    section(t("spaces"));
    const body = node("section", "spaces-module");
    view.append(body);
    spacesLocale = dateLocale;
    spacesController = renderSpaces(body, {
      node, button, glyph, t, locale: workspace.locale, dateLocale, spaces: workspace.spaces,
      open: restoreSpace, capture: changeSpaceCapture, edit: editSpace, addLinks: editSpaceLinks, task: createSpaceTask,
      remove: confirmSpaceDeletion, removeTab: (space, tab) => mutate("space-remove-tab", { id: space.id, tabId: tab.id }),
      favorite: space => mutate("space-favorite", { id: space.id, favorite: !space.favorite }),
      openMenu: (anchor, populate) => openWorkspaceMenu(anchor, undefined, t("spaces"), populate)
    });
  } else if (activePage === "markets") {
    section(t("markets"));
    const body = node("div");
    view.append(body);
    marketsLocale = dateLocale;
    marketsController = renderMarkets(body, {
      locale: workspace.locale, dateLocale, t, icon, state: workspace.markets, alertState: marketAlertState,
      onWatchlist: (change) => mutate("markets-watchlist", change),
      onWatchlistMenu: (anchor, label, populate) => bindWorkspaceMenu(anchor, (point) => openWorkspaceMenu(anchor, point, label, populate)),
      onAddAlert: createMarketAlert,
      onRemoveAlert: (id) => mutate("markets-remove-alert", { id })
    });
  } else if (activePage === "mail") {
    const mailSettings = button(t("mailAccounts"), "icon-button", { symbol: "mail-settings", iconOnly: true });
    mailSettings.id = "mail-settings-button";
    const composeMail = button(t("mailCompose"), "icon-button", {
      symbol: "plus", iconOnly: true, onClick: () => mailController?.openComposer()
    });
    composeMail.id = "mail-compose-button";
    const actions = node("div", "module-title-actions");
    actions.append(composeMail, mailSettings);
    section(t("mail"), undefined, actions);
    mailLocale = dateLocale;
    const replyDraft = pendingMailReply;
    pendingMailReply = undefined;
    mailController = renderMail(view, {
      dateLocale, t, icon, settingsButton: mailSettings, composeButton: composeMail, accounts: mailAccounts, send: sendMail,
      replyDraft,
      followUp: followUpMail, followUpTask: followUpTodo, askAssistant: askAboutMail, requestInWorker: inToolbarPopup,
      openMenu: (anchor, populate) => openWorkspaceMenu(anchor, undefined, t("mailActions"), populate),
      confirmDelete: (subject, remove) => {
        if (editor.open) return;
        const fields = openEditor(t("mailDelete"), t("mailDelete"), remove);
        fields.append(node("p", "", t("mailDeleteConfirm", { subject })));
        editor.showModal();
      }
    });
  } else if (activePage === "library") renderLibrary();
  else if (activePage === "settings") renderSettings();

  if (focused && focused !== "workspace" && !editor.open) {
    const element = document.getElementById(focused);
    if (element !== document.activeElement) element?.focus({ preventScroll: true });
  }
}

function refreshHome() {
  if (!homeController?.root.isConnected) return;
  homeController.update({
    home: workspace.home, tabs: workspace.tabs, accountId: translatorAccountId, events: appointmentEvents(),
    tasks: (workspace.todo ?? defaultTodo).items, taskLabels: workspace.todo?.labels ?? [], spaces: workspace.spaces,
    flashcards: workspace.flashcards, translationTarget: translationLanguagePreferences(workspace.translator).target,
    mail: inboxMessages(mailAccounts)
  });
}

function showHome(dateLocale) {
  if (!homeController || homeLocale !== dateLocale) {
    homeController?.dispose();
    homeLocale = dateLocale;
    homeController = renderHome({
      node, glyph, button, t, locale: workspace.locale, dateLocale,
      calendar: calendarSystemFor(workspace.locale, workspace.calendar?.system),
      async onPreferences(patch) {
        if (await mutate("home-preferences", patch)) await refreshWorkspace();
      },
      openModule: openHomeModule,
      async openTask(id) {
        if (await openHomeModule("todo")) todoController?.openTask(id);
      },
      addTask: focusQuickTask,
      completeTask: completeTodo,
      restoreSpace,
      async openEvent(id) {
        if (await openHomeModule("calendar")) calendarController?.openEvent(id);
      },
      openMail: openHomeMail,
      capture: kind => captureAssistantSource(kind, currentWindowId),
      chooseTabs: chooseAssistantTabs,
      previewSource: previewHomeSource,
      openSource: openHomeSource,
      onAction: reviewAssistantAction,
      taskLabelFor: assistantTaskLabel,
      onCopy: copyWorkspaceText,
      confirmClear(clear) {
        if (editor.open) return;
        const fields = openEditor(t("assistantHistoryClear"), t("remove"), clear);
        fields.append(node("p", "", t("assistantHistoryClearConfirm")));
        editor.showModal();
        editor.querySelector(".dialog-footer .secondary-button").focus();
      },
      onSignIn: async () => {
        try { return await signInWorkspaceAccount(); }
        catch (error) { reportError(error?.code ?? "accountFailed"); return false; }
      },
      reportError
    });
  }
  view.append(homeController.root);
  homeController.show();
  refreshHome();
}

function openHomeHistory(id) {
  switchTo(home.id, false);
  homeController?.openHistory(id);
}

async function openHomeModule(id, replyDraft) {
  if (!savedTabAvailable(id)) {
    if (!await mutate("toggle-module", { id, enabled: true })) return false;
    await refreshWorkspace();
  }
  if (id === "mail") pendingMailReply = replyDraft;
  switchTo(id, false);
  return true;
}

async function openHomeMail(message) {
  if (!mailAccounts.some(account => account.id === message.accountId)) return reportError("todoMailUnavailable");
  if (await openHomeModule("mail")) mailController?.showMessage(message, () => switchTo(home.id, false));
}

function addHomeSource(source) {
  switchTo(home.id, false);
  homeController?.attach(source);
}

async function receiveHomeSource() {
  if (!inPanel || editor.open) return;
  const windowId = currentWindowId ?? (await chrome.windows.getCurrent().catch(() => null))?.id;
  const token = workspaceRoute.get("assistantSource") || undefined;
  const source = await receiveAssistantSource(windowId, token);
  if (!source || editor.open) return;
  if (token) {
    workspaceRoute.delete("assistantSource");
    history.replaceState(null, "", `workspace.html?${workspaceRoute}`);
  }
  addHomeSource(source);
}

function askAboutMail(message, body) {
  const text = (body.format === "html" ? htmlText(body.body ?? "") : body.body ?? "").trim();
  if (!text) return reportError("mailEmptyBody");
  addHomeSource({
    kind: "mail", label: message.subject || t("mailNoSubject"), text, truncated: body.partial,
    url: message.url, message,
    reply: { replyAddress: body.replyAddress, messageId: body.messageId, references: body.references, threadId: body.threadId }
  });
}

function openHomeSource(source) {
  if (source.message) {
    openHomeMail(source.message);
    return;
  }
  const url = taskLink(source.url);
  if (url) chrome.tabs.create({ url }).catch(() => reportError("todoSourceUnavailable"));
  else previewHomeSource(source);
}

function previewHomeSource(source) {
  if (editor.open) return;
  const fields = openEditor(t("assistantPreviewSource", { name: source.label }));
  const text = node("p", "assistant-source-excerpt", source.text);
  text.dir = "auto";
  fields.append(text);
  if (source.truncated) fields.append(node("p", "setting-hint", t("assistantTruncated")));
  editor.showModal();
}

function chooseAssistantTabs(limit, add) {
  if (editor.open) return;
  const spaces = workspace.spaces.filter(space => space.tabs.length).toSorted((a, b) => b.updatedAt - a.updatedAt);
  const selected = new Map();
  const fields = openEditor(t("assistantSourceTabs"), t("assistantAddTabs"), spaces.length ? () => {
    if (!selected.size) return false;
    add([...selected.values()]);
    editor.addEventListener("close", () => homeController?.focusPrompt(), { once: true });
    return true;
  } : undefined);
  if (!spaces.length) {
    fields.append(node("p", "", t("homeNoSpaces")));
    editor.showModal();
    return;
  }
  fields.append(node("p", "setting-hint", t("assistantTabDetails")));
  const picker = node("label", "field");
  const choice = node("select");
  choice.append(...spaces.map(space => new Option(space.name, space.id)));
  picker.append(node("span", "", t("spaces")), choice);
  const list = node("div", "assistant-tab-choices");
  fields.append(picker, list);
  const submit = editor.querySelector("button[type='submit']");
  submit.disabled = true;

  function renderChoices() {
    const space = spaces.find(space => space.id === choice.value);
    list.replaceChildren(...space.tabs.map(tab => {
      const key = `${space.id}:${tab.id}`;
      const title = tab.title.trim() || new URL(tab.url).hostname;
      const row = node("label", "assistant-tab-choice");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked && selected.size >= limit) {
          checkbox.checked = false;
          return reportError("assistantAttachLimit");
        }
        if (checkbox.checked) selected.set(key, { kind: "tab", label: title, text: title, url: tab.url, spaceId: space.id });
        else selected.delete(key);
        submit.disabled = !selected.size;
      });
      row.append(checkbox, node("bdi", "", title));
      return row;
    }));
  }
  choice.addEventListener("change", renderChoices);
  renderChoices();
  editor.showModal();
  choice.focus();
}

function mailTaskSource(message) {
  return {
    kind: "mail", accountId: message.accountId, messageId: message.id, folder: message.folder,
    uidValidity: message.uidValidity, senderAddress: senderAddress(message), url: message.url
  };
}

function assistantTaskLabel(id) {
  const labels = workspace.todo?.labels ?? [];
  return labels.find(label => label.id === id) ?? labels[0];
}

async function reviewAssistantAction(action, source, { immediately, labelId, onSaved }) {
  if (editor.open) return;
  const message = source?.message;
  const url = taskLink(source?.url);
  async function markSaved(operation) {
    if (!await operation) return;
    onSaved();
    showToast(t("assistantSaved"));
  }
  switch (action.kind) {
    case "task": {
      const taskLabel = assistantTaskLabel(labelId);
      const task = {
        title: action.title, notes: action.notes, dueDate: action.date, dueTime: action.time, reminderMinutes: action.reminder,
        ...(action.checklist?.length && {
          checklist: action.checklist.map(text => ({ id: crypto.randomUUID(), text, done: false }))
        }),
        spaceId: workspace.spaces.some(space => space.id === source?.spaceId) ? source.spaceId : undefined,
        labelIds: taskLabel ? [taskLabel.id] : [],
        source: message ? mailTaskSource(message) : url ? { kind: "web", url } : undefined
      };
      if (immediately) await markSaved(updateTodo("save-task", { ...task, showModule: true }));
      else editTodo(task, "draft", { onSaved });
      break;
    }
    case "event":
      if (await openHomeModule("calendar")) calendarController?.openDraft({
        title: action.title, date: action.date, start: action.start, end: action.end, notes: action.notes,
        reminderMinutes: action.reminder, mailUrl: message?.url
      }, onSaved);
      break;
    case "snippet":
      if (immediately) await markSaved(mutate("save-snippet", { text: action.text, title: action.title, folderId: null }));
      else editSnippet(undefined, { draftText: action.text, draftTitle: action.title, initialFolder: "all", onSaved });
      break;
    case "flashcard": {
      const draft = {
        term: action.front, answer: action.back, language: selectableLanguage(action.language) ?? workspace.flashcards.language,
        usage: action.notes
      };
      if (immediately) await markSaved(mutate("save-flashcard", { ...draft, showModule: true }));
      else editFlashcard(undefined, undefined, { draft, onSaved });
      break;
    }
    case "reply":
      if (!message || !mailAccounts.some(account => account.id === message.accountId)) return reportError("todoMailUnavailable");
      await openHomeModule("mail", {
        message, metadata: source.reply, body: action.body, returnTo: () => switchTo(home.id, false), onSent: onSaved
      });
      break;
  }
}

function sendMail(action, data) {
  return chrome.runtime.sendMessage({ type: mailMessage, action, ...data });
}

async function refreshMailSnapshot() {
  const version = ++mailReadVersion;
  const answer = await sendMail("read").catch(() => null);
  if (version !== mailReadVersion || !answer?.ok) return;
  mailAccounts = answer.value;
  updateMailBadge(document.getElementById("tab-mail"));
  if (query && workspace.tabs.includes("mail")) render();
  else mailController?.update(mailAccounts);
  refreshHome();
}

async function followUpMail(message) {
  if (!workspace.tabs.includes("calendar") && !await mutate("toggle-module", { id: "calendar", enabled: true })) return;
  switchTo("calendar", false);
  calendarController?.openFollowUp({ title: message.subject || t("mailNoSubject"), url: message.url });
}

async function updateTodo(action, data) {
  const needsNotifications = (action === "todo-preferences" && data.dailyTime)
    || (action === "save-task" && calendarReminderOffsets.includes(data.reminderMinutes));
  if (needsNotifications && !inToolbarPopup) {
    const allowed = await chrome.permissions.request({ permissions: ["notifications"] }).catch(() => false);
    if (!allowed) {
      reportError("todoNotificationDenied");
      return false;
    }
  }
  return mutate(action, { ...data, requestPermission: Boolean(needsNotifications && inToolbarPopup) });
}

async function completeTodo(id, done) {
  if (!await mutate("complete-task", { id, done })) return;
  showToast(t(done ? "todoMarkedDone" : "todoReopened"), () => {
    toast.hidden = true;
    mutate("complete-task", { id, done: !done });
  });
}

function openTodoTask(id) {
  switchTo("todo", false);
  todoController?.openTask(id);
}

function openSpaceDetail(id) {
  switchTo("spaces", false);
  spacesController?.show(id);
}

async function sendSpaceAction(action, options) {
  try {
    const reply = await chrome.runtime.sendMessage({ type: spacesMessage, action, windowId: currentWindowId, ...options });
    if (reply && !reply.error) return reply;
    reportError(reply?.error ?? (action === "open" ? "spaceOpenFailed" : "spaceSaveFailed"));
  } catch {
    reportError(action === "open" ? "spaceOpenFailed" : "spaceSaveFailed");
  }
  return null;
}

async function restoreSpace(space, mode) {
  const result = await sendSpaceAction("open", { id: space.id, mode, groups: space.groups.length > 0 });
  if (!result) return;
  if (result.missed || result.degraded) return reportError("spacePartialRestore");
  const count = new Intl.NumberFormat(workspace.locale).format(result.count);
  const status = mode === "group" ? "spaceGroupOpened"
    : result.focused ? "spaceWindowFocused" : result.count ? "spaceOpenedCount" : "spaceAlreadyOpen";
  showToast(t(status, { count, name: space.name }));
}

async function captureSpace(mode, data) {
  const result = await sendSpaceAction("capture", { mode, ...data });
  if (!result) return false;
  const numbers = new Intl.NumberFormat(workspace.locale);
  showToast(t(result.skipped ? "spaceCapturedSome" : "spaceCaptured", {
    count: numbers.format(result.count), skipped: numbers.format(result.skipped)
  }));
  if (mode === "create") {
    await refreshWorkspace();
    openSpaceDetail(result.id);
  }
  return true;
}

function changeSpaceCapture(mode, space) {
  const data = { id: space.id, expectedUpdatedAt: space.updatedAt };
  if (mode !== "replace") return captureSpace(mode, data);
  if (editor.open) return;
  const fields = openEditor(t("spaceReplaceTabs"), t("save"), () => captureSpace(mode, data));
  fields.append(node("p", "", t("spaceReplaceConfirm", { name: space.name })));
  editor.showModal();
}

function editSpace(space, mode) {
  if (editor.open) return;
  const newId = space ? undefined : crypto.randomUUID();
  const fields = openEditor(t(mode === "capture" ? "spaceSaveWindow" : space ? "spaceEdit" : "spaceNew"), t("save"), async () => {
    const data = { id: space?.id, newId, name: name.value.trim(), notes: notes.value,
      color: colorPicker.querySelector("input:checked").value };
    if (!data.name) {
      reportError("spaceNameRequired");
      return false;
    }
    if (mode === "capture") {
      if (spaceNameTaken(workspace.spaces, data.name)) {
        reportError("spaceDuplicateName");
        return false;
      }
      return captureSpace("create", data);
    }
    const saved = await mutate("save-space", data);
    if (saved && !space) {
      await refreshWorkspace();
      openSpaceDetail(newId);
    }
    return saved;
  });
  const name = field(fields, { label: t("spaceName"), value: space?.name, maxLength: spaceLimits.name, required: true });
  const notes = field(fields, { label: t("calendarNotes"), value: space?.notes, maxLength: spaceLimits.notes, multiline: true });
  notes.rows = 2;
  const colorPicker = node("fieldset", "choice-group space-color-picker");
  const options = node("div", "space-color-options");
  const selected = space?.color ?? workspace.palette;
  for (const key of spaceColors) {
    const choice = radioOption("space-color", key, selected, "choice-option space-color-option");
    choice.label.dataset.spaceColor = key;
    const swatch = node("span", "space-color-swatch");
    swatch.setAttribute("aria-hidden", "true");
    choice.face.append(swatch, node("span", "space-color-name", t(key)), glyph("check", "space-color-check"));
    options.append(choice.label);
  }
  colorPicker.append(node("legend", "", t("spaceColor")), options);
  fields.append(colorPicker);
  if (mode === "capture") fields.append(node("p", "field-hint", t("spaceCaptureHint")));
  editor.showModal();
  name.focus();
}

function editSpaceLinks(space) {
  if (editor.open) return;
  const fields = openEditor(t("spaceAddLinks"), t("save"), () => mutate("space-add-links", { id: space.id, links: links.value }));
  const links = field(fields, { label: t("spaceLinksField"), required: true, multiline: true });
  links.placeholder = "https://";
  links.dir = "ltr";
  editor.showModal();
  links.focus();
}

function createSpaceTask(space) {
  if (editor.open) return;
  const fields = openEditor(t("spaceCreateTask"), t("save"), async () => {
    const saved = await mutate("save-task", { title: title.value, spaceId: space.id, showModule: true });
    if (saved) showToast(t("spaceTaskAdded"));
    return saved;
  });
  const title = field(fields, { label: t("todoTitle"), value: space.name, required: true, maxLength: taskLimits.title });
  editor.showModal();
  title.select();
}

function confirmSpaceDeletion(space) {
  if (editor.open) return;
  const fields = openEditor(t("spaceDelete"), t("remove"), () => mutate("remove-space", { id: space.id }));
  fields.append(node("p", "", t("spaceDeleteConfirm", { name: space.name })));
  editor.showModal();
  editor.querySelector(".dialog-footer .secondary-button").focus();
}

async function focusQuickTask() {
  if (!workspace.tabs.includes("todo")) {
    if (!await mutate("toggle-module", { id: "todo", enabled: true })) return;
    await refreshWorkspace();
  }
  switchTo("todo", false);
  todoController?.quickAdd();
}

async function followUpTodo(message, offset) {
  const saved = await mutate("save-task", {
    title: message.subject || t("mailNoSubject"), dueDate: localTaskDay(offset), showModule: true,
    source: mailTaskSource(message)
  });
  if (saved) showToast(t(offset ? "todoAddedTomorrow" : "todoAddedToday"));
}

async function addSnippetTask(id) {
  if (await mutate("add-snippet-task", { id })) showToast(t("todoSnippetAdded"));
}

async function openTodoSource(task) {
  const source = task.source;
  if (source.kind === "snippet") {
    const snippet = workspace.snippets.find(item => item.id === source.snippetId);
    if (!snippet) return reportError("todoSnippetMissing");
    switchTo("clipboard", false);
    selectFolder(snippet.folderId ?? "all");
    const trigger = document.getElementById(`snippet-${snippet.id}`);
    trigger?.focus();
    trigger?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (source.kind === "mail") {
    if (!workspace.tabs.includes("mail")) {
      if (!await mutate("toggle-module", { id: "mail", enabled: true })) return;
      await refreshWorkspace();
    }
    await refreshMailSnapshot();
    const account = mailAccounts.find(item => item.id === source.accountId);
    if (account) {
      switchTo("mail", false);
      const cached = inboxMessages([account], source.folder).find(item => item.id === source.messageId
        && (item.uidValidity || "") === source.uidValidity);
      mailController?.showMessage({
        ...(cached ?? {
          id: source.messageId, accountId: account.id, provider: account.provider, email: account.email, folder: source.folder,
          subject: task.title, sender: source.senderAddress, unread: false, url: mailMessageLink(account.provider, source.url)
        }), taskId: task.id
      }, () => openTodoTask(task.id));
      return;
    }
    const link = mailMessageLink(null, source.url);
    if (link) await chrome.tabs.create({ url: link }).catch(() => reportError("mailReadFailed"));
    else reportError("todoMailUnavailable");
  } else {
    await chrome.tabs.create({ url: source.url }).catch(() => reportError("todoSourceUnavailable"));
  }
}

function editTodoLabel(label) {
  if (editor.open) return;
  const fields = openEditor(t(label ? "todoEditLabel" : "todoNewLabel"), t("save"), () => mutate("save-todo-label", {
    id: label?.id, name: name.value, color: color.value
  }));
  const name = field(fields, { label: t("todoLabelName"), value: label?.name, maxLength: 32, required: true });
  const colorRow = node("label", "todo-label-color-field");
  const color = node("input");
  color.type = "color";
  color.value = label?.color ?? palettes[workspace.palette];
  colorRow.append(node("span", "", t("todoLabelColor")), color);
  fields.append(colorRow);

  if (label) {
    fields.append(button(t("remove"), "secondary-button todo-remove-label", {
      symbol: "trash",
      onClick() {
        const confirmation = openEditor(t("remove"), t("remove"), () => mutate("remove-todo-label", { id: label.id }));
        confirmation.append(node("p", "", t("todoRemoveLabel", { name: label.name })));
      }
    }));
  }
  editor.showModal();
  name.focus();
}

function editTodoContent(fields, task) {
  const choices = node("fieldset", "choice-group todo-content-types");
  choices.setAttribute("aria-label", t("todoContentType"));
  const switcher = node("div", "choice-options");
  const initial = task.checklist ? "checklist" : "notes";
  for (const [value, label, symbol] of [["notes", "calendarNotes", "edit"], ["checklist", "todoChecklist", "todo"]]) {
    const { label: option, face } = radioOption("todo-content-type", value, initial, "choice-option");
    face.append(glyph(symbol), node("span", "", t(label)));
    switcher.append(option);
  }
  choices.append(switcher);

  const textRow = node("div", "field");
  const notes = node("textarea");
  notes.dir = "auto";
  notes.maxLength = taskLimits.notes;
  notes.rows = 3;
  notes.placeholder = t("calendarNotes");
  notes.setAttribute("aria-label", t("calendarNotes"));
  notes.value = task.notes ?? "";
  textRow.append(notes);

  const checklist = node("div", "todo-checklist-editor");
  const rows = node("div", "todo-checklist-rows");
  const add = button(t("todoChecklistAdd"), "secondary-button todo-checklist-add", {
    symbol: "plus", onClick: () => addItem()?.focus()
  });
  checklist.append(rows, add);
  fields.append(choices, textRow, checklist);

  function addItem(item) {
    if (rows.childElementCount >= taskLimits.checklistItems) return undefined;
    const row = node("div", "todo-checklist-edit-row");
    row.dataset.id = item?.id ?? crypto.randomUUID();
    const check = node("input");
    check.type = "checkbox";
    check.checked = item?.done === true;
    check.setAttribute("aria-label", t("todoComplete"));
    const input = node("input", "translator-select");
    input.type = "text";
    input.dir = "auto";
    input.maxLength = taskLimits.checklistText;
    input.value = item?.text ?? "";
    input.placeholder = t("todoChecklistItem");
    input.setAttribute("aria-label", t("todoChecklistItem"));
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (input.value.trim()) addItem()?.focus();
    });
    const remove = button(t("remove"), "icon-button", { symbol: "close", iconOnly: true, onClick: () => {
      const neighbor = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      add.disabled = false;
      (neighbor?.querySelector('input[type="text"]') ?? add).focus();
    } });
    row.append(check, input, remove);
    rows.append(row);
    add.disabled = rows.childElementCount === taskLimits.checklistItems;
    return input;
  }

  function select(type) {
    textRow.hidden = type === "checklist";
    checklist.hidden = !textRow.hidden;
    if (!checklist.hidden && !rows.childElementCount) addItem();
  }

  for (const item of task.checklist ?? []) addItem(item);
  select(initial);
  switcher.addEventListener("change", event => select(event.target.value));

  return () => checklist.hidden ? { notes: notes.value, checklist: null } : {
    notes: "", checklist: Array.from(rows.children, row => ({
      id: row.dataset.id, text: row.querySelector('input[type="text"]').value.trim(), done: row.firstElementChild.checked
    })).filter(item => item.text)
  };
}

function editTodo(task, mode, { onSaved } = {}) {
  if (editor.open) return;
  if (mode === "remove") {
    const fields = openEditor(t("remove"), t("remove"), () => mutate("remove-task", { id: task.id }));
    fields.append(node("p", "", t("todoConfirmDelete", { title: task.title })));
    editor.showModal();
    return;
  }

  const dateLocale = workspaceDateLocale();
  const labelIds = new Set(task.labelIds ?? []);
  let dueEdited = false;
  const manualPlan = new Set();
  const isDraft = mode === "draft";
  const fields = openEditor(t(isDraft ? "todoAdd" : "todoEdit"), t("save"), async () => {
    const usePlan = Boolean(planTime.value && (task.planDate || dueEdited || manualPlan.size));
    const planDate = usePlan ? plan.value : "";
    const start = usePlan ? planTime.value : "";
    const end = usePlan ? planEnd.value : "";
    const keepLegacy = reminder.value === "legacy";
    const saved = await updateTodo("save-task", {
      id: task.id, title: title.value, ...content(), labelIds: [...labelIds],
      ...(isDraft ? { source: task.source, showModule: true } : {}),
      ...(spaceSelect ? { spaceId: spaceSelect.value } : {}),
      dueDate: due.value, dueTime: dueTime.value, planDate, planTime: start, planEnd: end,
      planEndNextDay: Boolean(start && end && end < start),
      reminderMinutes: !reminder.disabled && !keepLegacy && reminder.value !== "" ? Number(reminder.value) : null,
      reminderDate: keepLegacy ? task.reminderDate : "",
      reminderTime: keepLegacy ? task.reminderTime : ""
    });
    if (saved) onSaved?.({ dueDate: due.value });
    return saved;
  });
  const title = field(fields, { label: t("todoTitle"), value: task.title, required: true, maxLength: taskLimits.title });
  const content = editTodoContent(fields, task);
  let spaceSelect;
  if (workspace.spaces.length) {
    const selection = node("label", "field");
    spaceSelect = node("select", "translator-select");
    spaceSelect.append(new Option(t("spaceNoLink"), ""));
    for (const space of workspace.spaces) spaceSelect.add(new Option(space.name, space.id));
    spaceSelect.value = workspace.spaces.some(space => space.id === task.spaceId) ? task.spaceId : "";
    selection.append(node("span", "", t("spaceTaskLink")), spaceSelect);
    fields.append(selection);
  }

  if (workspace.todo?.labels?.length) {
    const labels = node("fieldset", "choice-group todo-assign-labels");
    labels.append(node("legend", "", t("todoLabels")));
    const choices = node("div", "todo-labels");
    for (const label of workspace.todo.labels) {
      const choice = button(label.name, "secondary-button", {
        onClick() {
          if (labelIds.has(label.id)) labelIds.delete(label.id);
          else labelIds.add(label.id);
          choice.setAttribute("aria-pressed", String(labelIds.has(label.id)));
        }
      });
      choice.firstElementChild.classList.add("todo-label");
      choice.firstElementChild.style.setProperty("--label-color", label.color);
      choice.firstElementChild.dir = "auto";
      choice.setAttribute("aria-pressed", String(labelIds.has(label.id)));
      choices.append(choice);
    }
    labels.append(choices);
    fields.append(labels);
  }

  function timingGroup(label, open) {
    const group = node("details", "snippet-advanced todo-edit-group");
    group.open = open;
    const row = node("div", "todo-edit-fields");
    group.append(node("summary", "", t(label)), row);
    fields.append(group);
    return row;
  }

  const pickers = [];
  function dateField(row, key, value, onChange) {
    const picker = createDatePicker({
      dateLocale, firstDay: workspace.calendar?.firstDay, label: t("calendarEventDate"), t, icon, value, onChange,
      onOpen(panel) {
        for (const other of pickers) if (other.panel !== panel) other.close();
      }
    });
    picker.field.dataset.dateField = key;
    pickers.push(picker);
    row.append(picker.field);
    return picker;
  }

  function timeField(row, key, label, value) {
    const wrapper = node("div", "field");
    wrapper.dataset.timeField = key;
    const picker = createTimePicker({ locale: workspace.locale, t, label: t(label), value });
    wrapper.append(node("span", "", t(label)), picker.element);
    row.append(wrapper);
    return picker;
  }

  const dueRow = timingGroup("todoDue", true);
  const due = dateField(dueRow, "dueDate", task.dueDate, copyDue);
  const dueTime = timeField(dueRow, "dueTime", "todoTime", task.dueTime);
  dueRow.append(due.panel);

  const planRow = timingGroup("todoPlan", Boolean(task.planDate));
  const plan = dateField(planRow, "planDate", task.planDate || task.dueDate, () => {
    manualPlan.add("date");
    updateReminder();
  });
  const planTime = timeField(planRow, "planTime", "calendarStarts", task.planTime || (!task.planDate ? task.dueTime : ""));
  const planEnd = timeField(planRow, "planEnd", "calendarEnds", task.planDate ? task.planEnd : calendarSuggestedEnd(planTime.value).time);
  const overnight = node("small", "todo-overnight", t("calendarEndNextDay"));
  planEnd.element.after(overnight);
  planTime.element.parentElement.after(plan.panel);

  if (task.planDate) {
    manualPlan.add("date");
    manualPlan.add("start");
    if (task.planEnd !== calendarSuggestedEnd(task.planTime).time) manualPlan.add("end");
  }

  const reminderRow = timingGroup("todoReminder", Boolean(task.reminderDate || calendarReminderOffsets.includes(task.reminderMinutes)));
  reminderRow.classList.add("todo-reminder-fields");
  const reminder = node("select", "calendar-select");
  reminder.name = "reminderMinutes";
  reminder.setAttribute("aria-label", t("todoReminder"));
  reminder.add(new Option(t("calendarNoReminder"), ""));
  const numbers = new Intl.NumberFormat(workspace.locale);
  for (const minutes of calendarReminderOffsets) reminder.add(new Option(calendarReminderLabel(t, numbers, minutes), String(minutes)));
  if (task.reminderDate) {
    const format = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" });
    reminder.add(new Option(format.format(new Date(task.reminderDate + "T" + task.reminderTime)), "legacy"));
  }
  reminder.value = task.reminderDate ? "legacy" : String(task.reminderMinutes ?? "");
  const hint = node("small", "todo-reminder-hint");
  hint.setAttribute("aria-live", "polite");
  reminderRow.append(reminder, hint);

  function updateReminder() {
    const hasPlan = Boolean(plan.value && planTime.value && (task.planDate || dueEdited || manualPlan.size));
    const hasDue = Boolean(due.value && dueTime.value);
    reminder.disabled = !task.reminderDate && !hasPlan && !hasDue;
    for (const option of reminder.options) {
      if (option.value && option.value !== "legacy") option.disabled = !hasPlan && !hasDue;
    }
    hint.hidden = Boolean(task.reminderDate && reminder.value === "legacy");
    hint.textContent = t(hasPlan ? "todoRemindByPlan" : hasDue ? "todoRemindByDue" : "todoRemindNeedsTime");
    overnight.hidden = !planEnd.value || !planTime.value || planEnd.value >= planTime.value;
  }

  function copyDue() {
    dueEdited = true;
    if (!due.value) dueTime.value = "";
    if (!manualPlan.has("date")) plan.setValue(due.value);
    if (!manualPlan.has("start")) {
      planTime.value = dueTime.value;
      if (!manualPlan.has("end")) planEnd.value = calendarSuggestedEnd(planTime.value).time;
    }
    updateReminder();
  }

  dueTime.element.addEventListener("input", copyDue);
  planTime.element.addEventListener("input", () => {
    manualPlan.add("start");
    if (!manualPlan.has("end")) planEnd.value = calendarSuggestedEnd(planTime.value).time;
    updateReminder();
  });
  planEnd.element.addEventListener("input", () => {
    manualPlan.add("end");
    updateReminder();
  });
  reminder.addEventListener("change", updateReminder);
  updateReminder();
  editor.showModal();
  title.focus();
}

async function createMarketAlert(data) {
  if (!inToolbarPopup) {
    const allowed = await chrome.permissions.request({ permissions: ["notifications"] }).catch(() => false);
    if (!allowed) {
      reportError("marketsNotificationDenied");
      return false;
    }
  }
  return mutate("markets-add-alert", { ...data, requestPermission: inToolbarPopup });
}

function translatorOptions() {
  return {
    preferences: { ...defaultTranslator, ...workspace.translator },
    accountId: translatorAccountId,
    historyEnabled: translationHistory.enabled,
    folders: workspace.folders.map((folder) => ({ ...folder, locked: folderLocked(folder) }))
  };
}

function openTranslationHistory(entryId) {
  switchTo("translate", false, true);
  if (!entryId || !translatorHistoryController?.focus(entryId)) document.getElementById("translator-history-button")?.focus();
}

async function updateTranslationHistory(action, data) {
  try {
    const response = await chrome.runtime.sendMessage({ type: translationHistoryMessage, action, data });
    if (response?.history) return true;
  } catch {
    // A failed history write leaves the translation and existing records available.
  }
  if (action === "remove") reportError("translationHistoryFailed");
  return false;
}

function inlineTranslatorEnabled() {
  return workspace.translator?.inlineEnabled === true;
}

async function signInWorkspaceAccount() {
  const account = await signInGoogle({ requestFromPage: !inToolbarPopup && inPanel });
  translatorAccountId = account?.id ?? null;
  translatorController?.update({ accountId: translatorAccountId });
  refreshHome();
  return Boolean(translatorAccountId);
}

async function signInForTranslation() {
  try {
    return await signInWorkspaceAccount();
  } catch {
    switchTo("settings", false);
    document.getElementById("ease-account")?.scrollIntoView({ block: "nearest" });
    return false;
  }
}

function openChromeShortcuts() {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" }).catch(() => reportError("shortcutOpenFailed"));
}

async function copyWorkspaceText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t("copied"));
    return true;
  } catch {
    reportError("copyFailed");
    return false;
  }
}

async function saveTranslation(snippet) {
  if (snippet.text.length > 20_000) {
    showToast(t("translatorTooLong", { limit: new Intl.NumberFormat(workspace.locale).format(20_000) }), undefined, true);
    return false;
  }
  const save = async () => {
    if (!await mutate("save-snippet", snippet)) return false;
    showToast(t("translatorSaved"));
    return true;
  };
  const folder = folderFor(snippet.folderId);
  if (folderLocked(folder)) {
    editVaultCredential(folder, "unlock", save);
    return false;
  }
  return save();
}

async function receiveTranslationSelection() {
  if (!workspaceInitialized || editor.open) return;
  const selectedText = await takeTranslatorSelection();
  if (selectedText === null) return;
  showTranslationSelection(selectedText);
}

function showTranslationSelection(selectedText) {
  if (activePage !== "translate" || query || translatorHistoryOpen) switchTo("translate", false);
  translatorController?.setSelection(selectedText, { auto: Boolean(selectedText.trim()) });
}

function openEditor(title, submitLabel, onSubmit, guardedFolder) {
  protectedDialogFolder = guardedFolder;
  protectedDialogSnippet = undefined;
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
      if (submit.disabled) return;
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

function editFlashcard(card, translation, { draft, onSaved } = {}) {
  if (editor.open) return;
  const studying = workspace.flashcards.language;
  const pair = translation ? [translation.source, translation.target] : [];
  const draftLanguage = selectableLanguage(draft?.language);
  const initialLanguage = card?.language ?? draftLanguage ?? (pair.includes(studying) ? studying : translation?.target ?? studying);
  const labelByField = {
    term: "flashcardTerm", answer: "flashcardAnswer", usage: "flashcardUsage",
    example: "flashcardExample", exampleTranslation: "flashcardExampleTranslation"
  };
  const inputs = {};
  const fields = openEditor(t(card ? "flashcardEdit" : "flashcardAdd"), t("save"), async () => {
    const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
    const saved = await mutate("save-flashcard", {
      ...values, id: card?.id, language: language.value, showModule: Boolean(translation || draft)
    });
    if (saved) {
      showToast(t("flashcardSaved"));
      onSaved?.();
    }
    return saved;
  });

  const languageRow = node("label", "field");
  const language = node("select", "translator-select");
  const names = new Intl.DisplayNames([workspace.locale], { type: "language" });
  const languages = translatorLanguages.map((code) => [code, names.of(code)]);
  languages.sort((a, b) => a[1].localeCompare(b[1], workspace.locale));
  for (const [code, name] of languages) language.add(new Option(name, code));
  language.value = initialLanguage;
  languageRow.append(node("span", "", t("flashcardLanguage")), language);
  fields.append(languageRow);

  const notes = node("details", "snippet-advanced");
  const noteFields = node("div", "snippet-advanced-fields");
  notes.append(node("summary", "", t("translatorLearning")), noteFields);
  let initial = translation ? flashcardTranslationFields(translation, initialLanguage) : card ?? draft ?? {};
  for (const [key, label] of Object.entries(labelByField)) {
    const required = key === "term" || key === "answer";
    const input = field(required ? fields : noteFields, {
      label: t(label), value: initial[key], multiline: true, required, maxLength: flashcardFieldLimits[key]
    });
    input.rows = 2;
    inputs[key] = input;
  }
  fields.append(notes);
  notes.open = Boolean(initial.usage || initial.example || initial.exampleTranslation);
  inputs.term.lang = inputs.example.lang = language.value;
  language.addEventListener("change", () => {
    inputs.term.lang = inputs.example.lang = language.value;
    if (!pair.includes(language.value)) return;
    const updated = flashcardTranslationFields(translation, language.value);
    for (const [key, input] of Object.entries(inputs)) {
      if (input.value === (initial[key] ?? "")) input.value = updated[key] ?? "";
    }
    initial = updated;
  });
  editor.showModal();
  inputs.term.focus();
}

function flashcardTranslationFields({ text, translation, source, target, learning, notesLanguage }, language) {
  const reverse = language === source;
  const exampleLanguage = learning?.exampleLanguage ?? target;
  const exampleMatches = sameLearningLanguage(exampleLanguage, language);
  const glossMatches = sameLearningLanguage(notesLanguage, language) && Boolean(learning?.exampleTranslation);
  return {
    term: reverse ? text : translation,
    answer: reverse ? translation : text,
    usage: learning?.usage,
    example: exampleMatches ? learning?.example : glossMatches ? learning?.exampleTranslation : undefined,
    exampleTranslation: exampleMatches ? learning?.exampleTranslation : glossMatches ? learning?.example : undefined
  };
}

function sameLearningLanguage(left, right) {
  if (!left || !right) return false;
  const first = new Intl.Locale(left);
  const second = new Intl.Locale(right);
  return first.language === second.language && (!first.script || !second.script || first.script === second.script);
}

function confirmFlashcardDeletion(card) {
  if (editor.open) return;
  const fields = openEditor(t("flashcardDelete"), t("remove"), async () => {
    const removed = await mutate("remove-flashcard", { id: card.id });
    if (removed) showToast(t("flashcardRemoved"));
    return removed;
  });
  fields.append(node("p", "", t("flashcardDeleteConfirm", { term: card.term })));
  editor.showModal();
}

function editSnippet(snippet, { draftText, draftTitle, initialFolder = activeFolder, onSaved } = {}) {
  const folder = folderFor(snippet ? snippet.folderId : initialFolder);
  if (folderLocked(folder)) {
    editVaultCredential(folder);
    return;
  }
  const fields = openEditor(t(snippet ? "editSnippet" : "newSnippet"), t("save"), async () => {
    if (!text.value.trim()) {
      text.value = "";
      text.reportValidity();
      return false;
    }
    const folderId = destination.value || null;
    const changeFolder = !snippet || folderId !== (snippet.folderId ?? null);
    const saved = await mutate("save-snippet", {
      id: snippet?.id, title: title.value, text: text.value, ...(changeFolder ? { folderId } : {})
    });
    if (saved) onSaved?.();
    return saved;
  }, folder?.id);
  protectedDialogSnippet = snippet?.id;
  const text = field(fields, { label: t("snippetText"), value: snippet?.text ?? draftText, placeholder: t("snippetTextPlaceholder"), required: true, maxLength: 20000, multiline: true });
  const hint = node("p", "snippet-enter-hint", t("snippetEnterHint"));
  hint.id = "snippet-enter-hint";
  text.setAttribute("aria-describedby", hint.id);
  text.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (!text.form.querySelector('[type="submit"]').disabled) text.form.requestSubmit();
  });
  fields.append(hint);
  const advanced = node("details", "snippet-advanced");
  advanced.open = draftText !== undefined;
  const advancedFields = node("div", "snippet-advanced-fields");
  advanced.append(node("summary", "", t("snippetAdvanced")), advancedFields);
  fields.append(advanced);
  const title = field(advancedFields, { label: `${t("snippetTitle")} (${t("optional")})`, value: snippet?.title ?? draftTitle, placeholder: t("snippetTitlePlaceholder"), maxLength: 100 });
  const destination = node("select");
  const row = node("label", "field folder-select");
  const choices = [{ id: "", name: t("noFolder") }, ...workspace.folders];
  for (const folder of choices) {
    const option = node("option", "", folder.name);
    option.value = folder.id;
    option.dir = "auto";
    option.disabled = folderLocked(folder);
    destination.append(option);
  }
  const selectedId = snippet ? snippet.folderId : initialFolder;
  destination.value = folderFor(selectedId)?.id ?? "";
  row.append(node("span", "", t("folder")), destination);
  advancedFields.append(row);
  advancedFields.append(node("p", "field-hint", t("templateTip")));
  editor.showModal();
  (draftText !== undefined && workspace.folders.length ? destination : text).focus();
}

function editFolder(folder) {
  const id = folder?.id ?? crypto.randomUUID();
  const fields = openEditor(t(folder ? "editFolder" : "newFolder"), t("save"), async () => {
    const chosenIcon = choices.querySelector("input:checked").value;
    const color = colors.querySelector("input:checked").value;
    if (!await mutate(folder ? "update-folder" : "create-folder", { id, name: name.value, icon: chosenIcon, color })) return false;
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
  const colorPicker = node("fieldset", "choice-group folder-color-options");
  const colors = node("div", "choice-options");
  for (const color of ["default", ...Object.keys(palettes)]) {
    const choice = radioOption("folder-color", color, folder?.color ?? "default", "choice-option");
    const label = t(color === "default" ? "folderColorDefault" : color);
    choice.input.setAttribute("aria-label", label);
    choice.label.title = label;
    const swatch = node("span", "folder-color-dot");
    swatch.setAttribute("aria-hidden", "true");
    swatch.style.setProperty("--swatch", palettes[color] ?? "var(--accent)");
    choice.face.append(swatch);
    colors.append(choice.label);
  }
  colorPicker.append(node("legend", "", t("folderColor")), colors);
  fields.append(colorPicker);
  editor.showModal();
  name.focus();
}

function deleteFolder(folder) {
  const wasSelected = activeFolder === folder.id;
  const fields = openEditor(t("deleteFolder"), t("remove"), async () => {
    if (!await mutate("delete-folder", { id: folder.id })) return false;
    if (wasSelected) selectFolder("all");
    showToast(t("folderDeleted"));
    return true;
  }, folder.protected ? folder.id : undefined);
  fields.append(node("p", "", t("deleteFolderConfirm", { name: folder.name })));
  if (folder.protected) fields.append(node("p", "vault-hint", t("vaultDeleteHint")));
  editor.showModal();
}

function moveSnippet(snippet) {
  const from = snippet.folderId ?? null;
  const fields = openEditor(t("moveToFolder"), undefined, undefined, folderFor(from)?.protected ? from : undefined);
  const list = node("div", "folder-picker");
  const choices = [{ id: null, name: t("noFolder"), icon: "folder" }, ...workspace.folders];
  for (const folder of choices) {
    const selected = folder.id === from;
    const item = button(folder.name, selected ? "folder-picker-item folder-picker-active" : "folder-picker-item", {
      symbol: folder.icon,
      onClick: async () => {
        if (!selected) {
          for (const option of list.children) option.disabled = true;
          if (!await completeSnippetMove(snippet, folder)) {
            for (const [index, option] of Array.from(list.children).entries()) {
              option.disabled = folderLocked(folderFor(choices[index].id));
            }
            item.focus();
            return;
          }
        }
        editor.close();
      }
    });
    item.setAttribute("aria-pressed", String(selected));
    item.disabled = folderLocked(folder);
    if (item.disabled) item.title = t("vaultUnlockFirst");
    item.lastElementChild.dir = "auto";
    if (selected) item.append(glyph("check"));
    list.append(item);
  }
  fields.append(list);
  editor.showModal();
  list.querySelector(".folder-picker-active")?.focus();
}

async function completeSnippetMove(snippet, folder) {
  const from = snippet.folderId ?? null;
  if (!await mutate("move-snippet", { id: snippet.id, folderId: folder.id, expectedFolderId: from })) return false;
  showToast(t("snippetMoved", { name: folder.name }), async () => {
    if (await mutate("move-snippet", { id: snippet.id, folderId: from, expectedFolderId: folder.id })) toast.hidden = true;
  });
  return true;
}

async function changeVault(action, data) {
  if (!await mutate(action, data)) return false;
  await refreshWorkspace();
  return true;
}

function renderLockedFolder(folder, container) {
  const state = node("div", "vault-state");
  const actions = node("div", "vault-actions");
  state.append(glyph("lock", "vault-illustration"), node("h2", "", t("vaultLockedFolder")),
    node("p", "", t("vaultUnlockHint")));
  if (folder.vaultMode === "pin") {
    state.append(renderInlinePin(folder));
  } else {
    actions.append(button(t("vaultUnlock"), "primary-button", {
      symbol: "unlock", onClick: () => editVaultCredential(folder)
    }));
  }
  if (folder.device && supportsDeviceUnlock) {
    actions.append(button(t("vaultDevice"), "secondary-button", {
      symbol: "fingerprint", onClick: ({ currentTarget }) => unlockWithDevice(folder, currentTarget)
    }));
  }
  if (actions.childElementCount) state.append(actions);
  container.append(state);
}

function renderInlinePin(folder) {
  if (inlinePinState?.id !== folder.id) inlinePinState = { id: folder.id, value: "", pending: false };
  const attempt = inlinePinState;
  const form = node("form", "vault-inline-pin");
  const pin = pinField(form, "vaultPin");
  pin.id = `vault-inline-pin-${folder.id}`;
  pin.value = attempt.value;
  const feedback = node("p", "vault-inline-feedback");
  feedback.id = "vault-inline-feedback";
  feedback.setAttribute("role", "status");
  pin.setAttribute("aria-describedby", feedback.id);
  form.append(feedback);
  function showRetry() {
    const { wait, label } = pinRetryStatus(folder.pinRetryAt);
    pin.disabled = attempt.pending || wait > 0;
    if (!wait) {
      const key = attempt.error === "vaultPinWait" ? undefined : attempt.error;
      feedback.setAttribute("aria-live", "polite");
      feedback.textContent = t(key ?? "vaultPinHint");
      feedback.dataset.kind = key ? "error" : "info";
      return;
    }
    feedback.setAttribute("aria-live", "off");
    feedback.textContent = label;
    feedback.dataset.kind = "info";
    inlinePinTimer = setTimeout(showRetry, Math.min(1000, folder.pinRetryAt - Date.now()));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pin.disabled || pin.value.length !== 4 || attempt.pending) return;
    attempt.pending = true;
    attempt.error = undefined;
    pin.disabled = true;
    const accepted = await mutate("unlock-folder", { id: folder.id, pin: pin.value }, (code) => {
      attempt.error = code;
    });
    attempt.pending = false;
    attempt.value = "";
    if (accepted && inlinePinState === attempt) inlinePinState = undefined;
    await refreshWorkspace();
    if (!accepted && inlinePinState === attempt) {
      view.querySelector(".vault-inline-pin input:not(:disabled)")?.focus();
    }
  });
  pin.addEventListener("input", () => {
    attempt.value = pin.value;
    attempt.error = undefined;
    if (pin.value.length === 4) form.requestSubmit();
    else showRetry();
  });
  showRetry();
  return form;
}

function pinRetryStatus(retryAt) {
  const wait = Math.max(0, Math.ceil(((retryAt ?? 0) - Date.now()) / 1000));
  if (!wait) return { wait, label: "" };
  const format = new Intl.NumberFormat(workspace.locale, { minimumIntegerDigits: 2, useGrouping: false });
  const time = `${format.format(Math.floor(wait / 60))}:${format.format(wait % 60)}`;
  return { wait, label: t("vaultPinRetry", { time }) };
}

function passwordField(fields, label, autocomplete) {
  const input = field(fields, { label: t(label), maxLength: 256, required: true });
  input.type = "password";
  input.className = "vault-password-field";
  input.dir = "ltr";
  input.autocomplete = autocomplete;
  return input;
}

const vaultPolicyLabels = {
  "after-copy": ["vaultPolicyAfterCopy"],
  "one-minute": ["vaultPolicyOneMinute", 1, "minute"],
  "five-minutes": ["vaultPolicyFiveMinutes", 5, "minute"],
  "fifteen-minutes": ["vaultPolicyFifteenMinutes", 15, "minute"],
  "thirty-minutes": ["vaultPolicyThirtyMinutes", 30, "minute"],
  "one-hour": ["vaultPolicyOneHour", 1, "hour"],
  "three-hours": ["vaultPolicyThreeHours", 3, "hour"],
  "six-hours": ["vaultPolicySixHours", 6, "hour"]
};

function vaultPolicyHint(folder) {
  const policy = vaultPolicyFor(folder.vaultPolicy);
  if (policy === "after-copy") return t("vaultAfterCopyIdle");
  const [, count, unit] = vaultPolicyLabels[policy];
  const duration = new Intl.NumberFormat(workspace.locale, { style: "unit", unit, unitDisplay: "long" }).format(count);
  return t("vaultTimedHint", { duration });
}

function addVaultPolicyField(fields, folder) {
  const row = node("label", "field vault-policy-field");
  const select = node("select");
  const label = node("span", "", t("vaultPolicy"));
  label.id = "vault-policy-label";
  select.setAttribute("aria-labelledby", label.id);
  for (const [value, [key]] of Object.entries(vaultPolicyLabels)) {
    const option = node("option", "", t(key));
    option.value = value;
    select.append(option);
  }
  select.value = vaultPolicyFor(folder.vaultPolicy);
  row.append(label, select);
  fields.append(row);
  return select;
}

function editVaultPolicy(folder) {
  const fields = openEditor(t("vaultPolicySettings"), t("save"), () => (
    changeVault("set-vault-policy", { id: folder.id, policy: policy.value })
  ), folder.id);
  const policy = addVaultPolicyField(fields, folder);
  editor.showModal();
  policy.focus();
}

function pinField(fields, label) {
  const input = field(fields, { label: t(label), maxLength: 4, required: true });
  input.type = "password";
  input.className = "vault-pin-input";
  input.dir = "ltr";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.pattern = "[0-9]{4}";
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^0-9٠-٩۰-۹]/gu, "").replace(/[٠-٩۰-۹]/gu, (digit) => String(digit.codePointAt(0) & 0xf));
  });
  return input;
}

function editVaultCredential(folder, mode = "unlock", onUnlocked) {
  const setting = mode !== "unlock";
  const setup = mode === "setup";
  const usePin = setting || folder.vaultMode === "pin";
  const autoUnlock = !setting && usePin;
  let updatePinWait = () => {};
  const heading = setting ? (folder.vaultMode === "pin" ? "vaultChangePin" : "vaultSetPin") : "vaultUnlock";
  const fields = openEditor(t(heading), t(setting ? "save" : "vaultUnlock"), async () => {
    if (setting && repeat.value !== credential.value) {
      reportError("vaultPinMismatch");
      repeat.select();
      return false;
    }
    const action = setup ? "protect-folder" : setting ? "set-vault-pin" : "unlock-folder";
    const data = { id: folder.id, [usePin ? "pin" : "password"]: credential.value };
    if (setup) data.policy = policy.value;
    if (!await changeVault(action, data)) {
      if (autoUnlock) {
        credential.value = "";
        await refreshWorkspace();
        updatePinWait();
        if (!credential.disabled) credential.focus();
      }
      return false;
    }
    if (setting) showToast(t("vaultPinProtected"));
    if (onUnlocked) await onUnlocked();
    return true;
  }, mode === "change" ? folder.id : undefined);
  fields.append(node("p", "vault-hint", setting ? t("vaultPinSetupHint") : vaultPolicyHint(folder)));
  const credential = usePin ? pinField(fields, "vaultPin") : passwordField(fields, "vaultPassword", "current-password");
  const repeat = setting ? pinField(fields, "vaultRepeatPin") : undefined;
  const policy = setup ? addVaultPolicyField(fields, folder) : undefined;
  if (autoUnlock) {
    const form = credential.form;
    form.classList.add("vault-pin-form");
    const submit = form.querySelector('[type="submit"]');
    submit.hidden = true;
    const retry = node("p", "vault-inline-feedback");
    retry.dataset.kind = "info";
    fields.append(retry);
    let retryTimer;
    updatePinWait = () => {
      clearTimeout(retryTimer);
      const { wait, label } = pinRetryStatus(folderFor(folder.id)?.pinRetryAt);
      credential.disabled = wait > 0;
      retry.textContent = label || t("vaultPinHint");
      if (wait && editor.contains(credential)) retryTimer = setTimeout(updatePinWait, 1000);
    };
    editor.addEventListener("close", () => clearTimeout(retryTimer), { once: true });
    credential.addEventListener("input", () => {
      if (credential.value.length === 4 && !submit.disabled) form.requestSubmit();
    });
  }
  if (!setting && folder.device && supportsDeviceUnlock) {
    fields.append(button(t("vaultDevice"), "secondary-button", {
      symbol: "fingerprint", onClick: ({ currentTarget }) => unlockWithDevice(folder, currentTarget, onUnlocked)
    }));
  }
  editor.showModal();
  updatePinWait();
  credential.focus();
}

function removeVaultPassword(folder) {
  const fields = openEditor(t(folder.vaultMode === "pin" ? "vaultRemovePin" : "vaultRemove"), t("remove"),
    () => changeVault("unprotect-folder", { id: folder.id }), folder.id);
  fields.append(node("p", "vault-hint", t("vaultRemoveHint")));
  editor.showModal();
}

async function unlockWithDevice(folder, trigger, onUnlocked) {
  trigger.disabled = true;
  try {
    const prf = await readDeviceUnlock(folder.device);
    const unlocked = await changeVault("unlock-device", { id: folder.id, prf });
    if (unlocked && onUnlocked) await onUnlocked();
    if (unlocked && editor.contains(trigger)) editor.close();
    else if (!unlocked) trigger.disabled = false;
  } catch {
    reportError("vaultDeviceFailed");
    trigger.disabled = false;
  }
}

function enableDeviceUnlock(folder) {
  const fields = openEditor(t("vaultDeviceEnable"), t("vaultDeviceEnable"), async () => {
    try {
      const credential = await registerDeviceUnlock();
      if (!await changeVault("protect-device", { id: folder.id, ...credential })) return false;
      showToast(t("vaultDeviceReady"));
      return true;
    } catch {
      reportError("vaultDeviceFailed");
      return false;
    }
  }, folder.id);
  fields.append(node("p", "vault-hint", t("vaultDeviceHint")));
  editor.showModal();
}

async function removeDeviceUnlock(folder) {
  if (await changeVault("remove-device", { id: folder.id })) showToast(t("vaultDeviceRemoved"));
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
    .map((item) => [item.slot, snippetReadable(item) ? displayTitle(item) : t("vaultLockedFolder")]));
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
  const current = workspace.snippets.find(({ id }) => id === snippet.id);
  if (!current) return;
  if (!snippetReadable(current)) {
    const folder = folderFor(current.folderId);
    if (folder) editVaultCredential(folder);
    return;
  }
  snippet = current;
  const names = templateFields(snippet.text);
  if (!names.length) {
    copySnippet(snippet, snippet.text);
    return;
  }
  const fields = openEditor(t("templateTitle"), t("copy"), () => {
    const text = snippet.text.replace(templatePattern, (match, name) => values.get(name.trim())?.value ?? match);
    return copySnippet(snippet, text);
  }, snippet.folderId);
  protectedDialogSnippet = snippet.id;
  fields.append(node("p", "field-hint", t("templateHint")));
  const values = new Map(names.map((name) => [name, field(fields, { label: name, required: true })]));
  editor.showModal();
  values.values().next().value.focus();
}

async function copySnippet(snippet, text) {
  if (copyInProgress) return false;
  const current = workspace.snippets.find(({ id }) => id === snippet.id);
  if (!current || !snippetReadable(current)) {
    reportError("vaultLocked");
    return false;
  }
  const folder = folderFor(current.folderId);
  const feedback = folder?.protected && vaultPolicyFor(folder.vaultPolicy) === "after-copy"
    ? { folderId: folder.id, copied: false } : undefined;
  clearTimeout(copyTimer);
  copyInProgress = true;
  copiedId = undefined;
  vaultCopyFeedback = feedback;
  let copied = false;
  try {
    if (folder?.protected && !await mutate("authorize-vault-copy", { id: current.id, text })) return false;
    await navigator.clipboard.writeText(text);
    copied = true;
    if (feedback) feedback.copied = true;
  } catch {
    showToast(t("copyFailed"), undefined, true);
    return false;
  } finally {
    copyInProgress = false;
    if (!copied) {
      vaultCopyFeedback = undefined;
      render();
    }
  }
  copiedId = snippet.id;
  render();
  if (!feedback || activePage !== "clipboard" || query || activeFolder !== feedback.folderId) showToast(t("copied"));
  copyTimer = setTimeout(() => {
    if (inToolbarPopup) {
      window.close();
      return;
    }
    copiedId = undefined;
    if (feedback) {
      vaultCopyFeedback = undefined;
      render();
      return;
    }
    for (const row of view.querySelectorAll(".is-copied")) row.classList.remove("is-copied");
    const rowIcon = document.getElementById(`snippet-${snippet.id}`)?.querySelector(".row-copy-icon");
    if (rowIcon) rowIcon.innerHTML = icon("copy");
  }, inToolbarPopup ? (feedback ? 1000 : 420) : 1800);
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

window.addEventListener("focus", readWorkspaceShortcuts);
window.addEventListener("focus", refreshCalendarDay);
window.addEventListener("focus", () => {
  if (workspace.folders.some(({ protected: enabled }) => enabled)) refreshWorkspace();
});
editor.addEventListener("close", () => {
  if (!editor.open) {
    protectedDialogFolder = undefined;
    protectedDialogSnippet = undefined;
    editor.replaceChildren();
    receiveTranslationSelection();
    if (workspaceInitialized && inPanel) receiveHomeSource();
  }
});
document.querySelector(".search-icon").innerHTML = icon("search");
settingsButton.addEventListener("click", () => {
  const lastTab = savedTabAvailable(lastWorkspaceTab) ? lastWorkspaceTab : home.id;
  switchTo(activePage === "settings" && !query ? lastTab : "settings", false);
});
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
  if (index < 0 || event.defaultPrevented) return;
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (event.repeat) return;
    const id = allTabs[index].dataset.module;
    const [previous, next] = moduleNeighbors(id);
    if (event.key === "ArrowUp" && previous) moveModule(id, previous.id, "before");
    if (event.key === "ArrowDown" && next) moveModule(id, next.id, "after");
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const next = {
    ArrowUp: (index - 1 + allTabs.length) % allTabs.length,
    ArrowDown: (index + 1) % allTabs.length,
    Home: 0,
    End: allTabs.length - 1
  }[event.key];
  event.preventDefault();
  switchTo(allTabs[next].dataset.module);
});

const openMenus = ".snippet-actions[open]";
document.addEventListener("click", (event) => {
  for (const menu of view.querySelectorAll(openMenus)) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (editor.open || workspaceMenu || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[mailUpdateKey]) refreshMailSnapshot();
  if (area === "session" && changes[vaultSessionStorageKey]) refreshWorkspace();
  if (area === "session" && changes[translatorSelectionKey]?.newValue) receiveTranslationSelection();
  if (area === "session" && !inPanel && workspaceInitialized && !editor.open && document.hasFocus()
    && Object.keys(changes).some(key => key.startsWith(quickTaskKey) && changes[key].newValue)) {
    takeQuickTask().then(received => { if (received) focusQuickTask(); });
  }
  if (area !== "local") return;
  for (const section of taskSections) {
    const change = changes[collapsedTaskKey(section)];
    if (!change || collapsedTodo.has(section) === Boolean(change.newValue)) continue;
    if (change.newValue) collapsedTodo.add(section);
    else collapsedTodo.delete(section);
    todoController?.updateCollapsed();
  }
  if (changes[clipboardHistoryKey]) refreshClipboardHistory();
  if (changes[marketAlertStateKey]) {
    marketAlertState = changes[marketAlertStateKey].newValue ?? {};
    marketsController?.update({ state: workspace.markets, alertState: marketAlertState });
  }
  if (changes[translationHistoryKey]) {
    translationHistory = changes[translationHistoryKey].newValue ?? { enabled: false, entries: [] };
    if (query || activePage === "translate") render();
  }
  if (changes[vaultPinAttemptsStorageKey]) refreshWorkspace();
  if (changes[workspaceSyncStorageKey]) workspaceSyncRefresh?.();
  if (changes[storageKey]) refreshWorkspace({ ...defaultWorkspace, ...changes[storageKey].newValue });
  if (calendarConnectionKeys.some((key) => changes[key])) {
    calendarConnectionsRefresh?.().catch(() => reportError("syncFailed"));
    refreshCalendarEvents();
  }
  if (changes[accountStorageKey]) {
    translatorAccountId = changes[accountStorageKey].newValue?.id ?? null;
    translatorController?.update({ accountId: translatorAccountId });
    homeController?.updateAccount(translatorAccountId);
    if (query) render();
    accountRefresh?.().catch(() => reportError("accountFailed"));
    workspaceSyncRefresh?.();
  }
});
watchAssistantHistory(event => {
  if (query && event?.accountId === translatorAccountId && ["add", "finish", "remove", "clear"].includes(event.change)) render();
});
function updateClipboardReadPermission(permissions) {
  if (permissions.permissions?.includes("clipboardRead")) refreshClipboardHistory();
}
chrome.permissions.onAdded?.addListener(updateClipboardReadPermission);
chrome.permissions.onRemoved?.addListener(updateClipboardReadPermission);
if (inPanel) chrome.tabs?.onActivated?.addListener(receiveTranslationSelection);
if (inPanel) chrome.runtime.onMessage?.addListener((message, sender) => {
  if (workspaceInitialized && sender.id === chrome.runtime.id && message?.type === assistantSourceReady
    && message.windowId === currentWindowId) receiveHomeSource();
});
const initialTranslationSelection = await takeTranslatorSelection();
if (initialTranslationSelection !== null) activePage = "translate";
const [initialAccount, initialHistory, initialMarketAlerts, rememberedTab, savedCollapse] = await Promise.all([
  getGoogleAccount().catch(() => null), readTranslationHistory().catch(() => null), readMarketAlertState().catch(() => ({})),
  chrome.storage.local.get(lastWorkspaceTabKey).then(saved => saved[lastWorkspaceTabKey]).catch(() => undefined),
  chrome.storage.local.get(taskSections.map(collapsedTaskKey)).catch(() => ({})),
  refreshClipboardHistory()
]);
for (const section of taskSections) if (savedCollapse[collapsedTaskKey(section)]) collapsedTodo.add(section);
translatorAccountId = initialAccount?.id ?? null;
if (initialHistory) translationHistory = initialHistory;
marketAlertState = initialMarketAlerts;
lastWorkspaceTab = rememberedTab ?? home.id;
await refreshWorkspace(undefined, initialTranslationSelection === null ? lastWorkspaceTab : undefined);
workspaceInitialized = true;
refreshMailSnapshot();
sendWorkspaceSync("wake").catch(() => {});
if (initialTranslationSelection !== null) {
  rememberWorkspaceTab("translate");
  showTranslationSelection(initialTranslationSelection);
} else if (workspaceRoute.get("quickTask") === "1" || (!inPanel && await takeQuickTask())) {
  if (workspaceRoute.has("quickTask")) history.replaceState(null, "", "workspace.html?surface=panel");
  await focusQuickTask();
} else if (workspaceRoute.get("open") === "todo" && savedTabAvailable("todo")) {
  switchTo("todo", false);
} else if (workspaceRoute.get("open") === home.id) {
  switchTo(home.id, false);
} else if (workspaceRoute.get("open") === "spaces") {
  const space = workspace.spaces.find(item => item.id === workspaceRoute.get("spaceId"));
  if (space && savedTabAvailable("spaces")) openSpaceDetail(space.id);
  else switchTo(savedTabAvailable("spaces") ? "spaces" : "library", false);
  const issue = workspaceRoute.get("spaceIssue");
  if (issue === "no-match") reportError("spaceOmniboxNoMatch");
  if (issue === "open-failed") reportError("spaceOpenFailed");
  if (issue === "group-permission") {
    if (space) showToast(t("spaceGroupPermission"), () => restoreSpace(space, "group"), true, t("spaceOpenAsGroup"));
    else reportError("spaceGroupPermission");
  }
} else if (workspaceRoute.get("open") === "account") {
  switchTo("settings", false);
  document.getElementById("ease-account")?.scrollIntoView({ block: "nearest" });
} else if (workspaceRoute.get("open") === "calendar") {
  switchTo("calendar", false);
  document.getElementById("calendar-settings-button")?.click();
  document.querySelector(".calendar-connections")?.scrollIntoView({ block: "start" });
} else if (workspaceRoute.get("open") === "flashcards" && savedTabAvailable("flashcards")) {
  switchTo("flashcards", false);
} else if (workspaceRoute.get("open") === "mail" && savedTabAvailable("mail")) {
  switchTo("mail", false);
}
deviceUnlockAvailable().then((available) => {
  supportsDeviceUnlock = available;
  if (available && !editor.open && activePage === "clipboard") render();
}).catch(() => {});
refreshCalendarDay();
refreshCalendarEvents();
receiveTranslationSelection();
if (inPanel) receiveHomeSource();
