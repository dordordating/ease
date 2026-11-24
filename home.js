import { renderHomeAssistant } from "./home-assistant.js";
import { renderAssistantHistory } from "./assistant-history.js";
import { normalizeHome } from "./home-store.js";
import { flashcardQueue } from "./flashcard-store.js";
import { localTaskDay, taskTimestamp, taskToday } from "./todo-store.js";

const widgetDetails = {
  today: { label: "today", icon: "todo", module: "todo" },
  spaces: { label: "homeWidgetSpaces", icon: "spaces", module: "spaces" },
  calendar: { label: "homeWidgetCalendar", icon: "calendar", module: "calendar" },
  flashcards: { label: "homeWidgetFlashcards", icon: "flashcards", module: "flashcards" },
  mail: { label: "homeWidgetMail", icon: "mail", module: "mail" }
};

export function renderHome(options) {
  const {
    node, glyph, button, t, dateLocale, locale, onPreferences, openTools, dismissToolsWelcome, openModule, openTask,
    completeTask, addTask, restoreSpace, openEvent, openMail
  } = options;
  const root = node("div", "home-screen");
  const title = node("h1");
  const header = node("div", "home-header");
  header.hidden = true;
  header.append(title);
  const layout = button(t("homeLayout"), "icon-button home-layout-button", { symbol: "sliders", iconOnly: true, onClick: toggleSettings });
  layout.id = "home-layout-button";
  layout.setAttribute("aria-controls", "home-settings");
  const historyButton = button(t("assistantHistory"), "icon-button home-history-button", {
    symbol: "history", iconOnly: true, onClick: () => setMode(mode === "history" ? "dashboard" : "history")
  });
  historyButton.id = "home-history-button";
  historyButton.setAttribute("aria-controls", "assistant-history");
  historyButton.setAttribute("aria-expanded", "false");
  const headerActions = node("div", "module-title-actions");
  headerActions.append(historyButton, layout);
  const dashboard = node("div", "home-dashboard");
  const assistant = renderHomeAssistant({ ...options, navigation: headerActions });
  const welcome = node("section", "home-welcome");
  welcome.hidden = true;
  const welcomeTitle = node("h1", "", t("homeWelcomeTitle"));
  welcomeTitle.id = "home-welcome-title";
  welcome.setAttribute("aria-labelledby", welcomeTitle.id);
  const welcomeCopy = node("div", "home-welcome-copy");
  const browse = button(t("homeWelcomeBrowse"), "primary-button home-welcome-action", { symbol: "arrow", onClick: openTools });
  welcomeCopy.append(welcomeTitle, node("p", "", t("homeWelcomeHint")), browse);
  const toolIcons = node("div", "home-welcome-tools");
  toolIcons.setAttribute("aria-hidden", "true");
  toolIcons.append(...["todo", "mail", "translate", "spaces"].map(symbol => glyph(symbol, "home-welcome-tool")));
  const dismiss = button(t("homeWelcomeDismiss"), "icon-button home-welcome-dismiss", {
    symbol: "close", iconOnly: true, onClick() {
      dismissToolsWelcome();
      assistant.focus();
    }
  });
  welcome.append(welcomeCopy, toolIcons, dismiss);
  const history = renderAssistantHistory({
    ...options,
    onReuse(prompt) {
      setMode("dashboard");
      assistant.reuse(prompt);
    }
  });
  const grid = node("div", "home-widgets");
  dashboard.append(welcome, assistant.root, grid);
  const settings = node("section", "home-settings");
  settings.id = "home-settings";
  settings.setAttribute("aria-label", t("homeLayout"));
  const launch = node("fieldset", "choice-group");
  launch.append(node("legend", "", t("homeStart")));
  const startup = node("div", "choice-options");
  for (const [value, label, symbol] of [["home", "home", "home"], ["last", "homeStartLast", "history"]]) {
    const input = node("input");
    input.type = "radio";
    input.name = "home-launch";
    input.id = `home-launch-${value}`;
    input.value = value;
    const face = node("span");
    face.append(glyph(symbol), node("span", "", t(label)));
    const option = node("label", "choice-option");
    option.append(input, face);
    startup.append(option);
  }
  startup.addEventListener("change", event => change({ start: event.target.value }));
  launch.append(startup);
  const motionRow = node("label", "home-widget-toggle home-example-motion");
  const motion = node("input", "home-widget-switch");
  motion.type = "checkbox";
  motion.id = "home-example-motion";
  motion.setAttribute("role", "switch");
  motion.addEventListener("change", () => change({ animateExamples: motion.checked }));
  motionRow.append(glyph("sparkles", "home-widget-icon"), node("span", "", t("homeAnimateExamples")), motion);
  const roster = node("div", "home-widget-roster");
  const saving = node("p", "home-layout-status", t("homeSaving"));
  saving.setAttribute("role", "status");
  saving.hidden = true;
  const widgetTitle = node("h2", "", t("homeWidgets"));
  widgetTitle.id = "home-widgets-title";
  roster.setAttribute("role", "list");
  roster.setAttribute("aria-labelledby", widgetTitle.id);
  settings.append(launch, motionRow, widgetTitle, roster, saving);
  settings.hidden = true;
  layout.setAttribute("aria-expanded", "false");
  history.root.hidden = true;
  root.append(header, dashboard, settings, history.root);

  const clock = new Intl.DateTimeFormat(dateLocale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const numbers = new Intl.NumberFormat(locale);
  let state;
  let prefs;
  let prefsKey;
  let widgetKey;
  let changing = false;
  let dragged;
  let visible = false;
  let mode = "dashboard";
  let reviewTimer;

  function toggleSettings() {
    setMode(mode === "settings" ? "dashboard" : "settings");
  }

  function setMode(next, id) {
    mode = next;
    const openingHistory = mode === "history";
    const dock = mode === "dashboard" ? assistant.controls : header;
    const focused = headerActions.contains(document.activeElement) ? document.activeElement : undefined;
    if (headerActions.parentElement !== dock) dock.append(headerActions);
    title.textContent = t(openingHistory ? "assistantHistory" : "homeLayout");
    header.hidden = mode === "dashboard";
    settings.hidden = mode !== "settings";
    dashboard.hidden = mode !== "dashboard";
    layout.setAttribute("aria-expanded", String(mode === "settings"));
    historyButton.setAttribute("aria-expanded", String(openingHistory));
    const historyLabel = t(openingHistory ? "home" : "assistantHistory");
    historyButton.setAttribute("aria-label", historyLabel);
    historyButton.title = historyLabel;
    historyButton.replaceChildren(glyph(openingHistory ? "chevron-left" : "history"));
    focused?.focus({ preventScroll: true });
    if (openingHistory && visible) history.show(id);
    else history.hide();
    if (visible && mode === "dashboard") assistant.show();
    else assistant.hide();
    if (mode === "settings" && prefs) renderSettings();
  }

  function clearDrag() {
    dragged = undefined;
    for (const item of roster.children) {
      delete item.dataset.drop;
      delete item.dataset.dragging;
    }
  }

  function dropPosition(target, event) {
    const rect = target.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  async function change(patch) {
    if (changing) return;
    changing = true;
    saving.hidden = false;
    settings.setAttribute("aria-busy", "true");
    try {
      await onPreferences(patch);
    } finally {
      changing = false;
      saving.hidden = true;
      settings.removeAttribute("aria-busy");
      if (prefs && !settings.hidden) renderSettings();
    }
  }

  function renderSettings() {
    const focused = settings.contains(document.activeElement) ? document.activeElement.id : null;
    startup.querySelector(`[value="${prefs.start}"]`).checked = true;
    motion.checked = prefs.animateExamples !== false;
    roster.replaceChildren(...prefs.order.map((id, index) => {
      const { label, icon } = widgetDetails[id];
      const row = node("div", "home-widget-option");
      row.setAttribute("role", "listitem");
      row.dataset.widget = id;
      const handle = glyph("grip", "home-widget-grip");
      handle.draggable = true;
      handle.title = t("moduleOrderHint");
      handle.addEventListener("dragstart", event => {
        if (changing || !event.dataTransfer) { event.preventDefault(); return; }
        dragged = id;
        event.dataTransfer.setData("text/plain", id);
        event.dataTransfer.effectAllowed = "move";
        row.dataset.dragging = "true";
      });
      handle.addEventListener("dragend", clearDrag);
      row.addEventListener("dragover", event => {
        if (!dragged || dragged === id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.dataset.drop = dropPosition(row, event);
      });
      row.addEventListener("dragleave", event => {
        if (!row.contains(event.relatedTarget)) delete row.dataset.drop;
      });
      row.addEventListener("drop", event => {
        if (!dragged || dragged === id) return;
        event.preventDefault();
        const patch = { id: dragged, target: id, position: dropPosition(row, event) };
        clearDrag();
        change(patch);
      });
      const toggle = node("label", "home-widget-toggle");
      const control = node("input", "home-widget-switch");
      control.type = "checkbox";
      control.id = `home-widget-${id}`;
      control.setAttribute("role", "switch");
      control.checked = prefs.widgets.includes(id);
      control.addEventListener("change", () => change({ id, enabled: control.checked }));
      toggle.append(glyph(icon, "home-widget-icon"), node("span", "", t(label)), control);
      const move = node("div", "home-widget-move");
      for (const [direction, target, position] of [["up", prefs.order[index - 1], "before"], ["down", prefs.order[index + 1], "after"]]) {
        const adjustment = button(t(direction === "up" ? "moduleMoveUp" : "moduleMoveDown"), "icon-button", {
          symbol: `chevron-${direction}`, iconOnly: true,
          onClick: () => change({ id, target, position })
        });
        adjustment.id = `home-widget-${id}-${direction}`;
        adjustment.disabled = !target;
        move.append(adjustment);
      }
      row.append(handle, toggle, move);
      return row;
    }));
    if (focused) {
      const control = document.getElementById(focused);
      (control?.disabled ? control.closest(".home-widget-option")?.querySelector("input") : control)?.focus({ preventScroll: true });
    }
  }

  function widgetItem(label, detail, onClick) {
    const open = button(label, "home-widget-item", { onClick });
    open.lastElementChild.dir = "auto";
    open.title = label;
    if (detail) open.append(node("small", "", detail));
    return open;
  }

  function formatTime(day, time) {
    const timestamp = taskTimestamp(day, time);
    return timestamp !== null ? clock.format(timestamp) : "";
  }

  function buildToday(items) {
    if (!items.length) return [node("p", "home-widget-empty", t("homeNoTasks"))];
    return items.map(task => {
      const row = node("div", "home-task-row");
      const check = button(t("todoComplete"), "icon-button home-task-check", {
        symbol: "check", iconOnly: true, async onClick() {
          check.disabled = true;
          try { await completeTask(task.id, true); }
          finally { check.disabled = false; }
        }
      });
      row.append(check, widgetItem(task.title, formatTime(task.dueDate, task.dueTime) || formatTime(task.planDate, task.planTime),
        () => openTask(task.id)));
      return row;
    });
  }

  function buildSpaces(items) {
    if (!items.length) return [node("p", "home-widget-empty", t("homeNoSpaces"))];
    return items.map(space => {
      const open = widgetItem(space.name, "", () => restoreSpace(space, "group"));
      open.classList.add("home-space-row");
      open.dataset.spaceColor = space.color;
      open.prepend(glyph("spaces", "home-space-icon"));
      open.setAttribute("aria-label", `${t("spaceOpenAsGroup")} · ${space.name}`);
      return open;
    });
  }

  function buildCalendar(items) {
    if (!items.length) return [node("p", "home-widget-empty", t("calendarNoEvents"))];
    return items.map(event => widgetItem(event.title || t("calendarUntitledEvent"),
      formatTime(event.date, event.start) || t("calendarAllDay"), () => openEvent(event.id)));
  }

  function buildFlashcards(queue) {
    if (!state.flashcards.cards.length) return [node("p", "home-widget-empty", t("flashcardsEmpty"))];
    if (!queue.items.length) return [node("p", "home-widget-empty", t("flashcardsCaughtUp"))];
    return [
      node("p", "home-study-count", t("homeReadyCards", { count: numbers.format(queue.items.length) })),
      button(t("homeStudy"), "home-widget-link", { symbol: "play", onClick: () => openModule("flashcards") })
    ];
  }

  function buildMail(items) {
    if (!items.length) return [node("p", "home-widget-empty", t("mailEmpty"))];
    return items.map(message => {
      const open = widgetItem(message.subject || t("mailNoSubject"), "", () => openMail(message));
      open.dataset.unread = String(message.unread);
      return open;
    });
  }

  function renderWidgets() {
    clearTimeout(reviewTimer);
    const now = new Date();
    const day = localTaskDay(0, now);
    const taskOrder = task => task.focusDay === day ? "" : `${task.dueDate || task.planDate}${task.dueTime || task.planTime}`;
    const tasks = state.tasks.filter(task => !task.done && taskToday(task, day))
      .toSorted((a, b) => taskOrder(a).localeCompare(taskOrder(b))).slice(0, 2);
    const spaces = state.spaces.filter(space => space.tabs.length).toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, 2);
    const events = state.events.filter(event => event.date === day).toSorted((a, b) => (a.start ?? "").localeCompare(b.start ?? "")).slice(0, 2);
    const messages = state.mail.slice(0, 2);
    const queue = prefs.widgets.includes("flashcards") ? flashcardQueue(state.flashcards) : null;
    if (visible && queue?.nextDueAt > Date.now()) {
      reviewTimer = setTimeout(renderWidgets, Math.min(2_147_483_647, queue.nextDueAt - Date.now() + 50));
    }
    const dataKey = JSON.stringify([prefs.widgets, tasks, spaces, events, messages, queue?.items.length, state.flashcards.cards.length]);
    if (widgetKey === dataKey) return;
    widgetKey = dataKey;
    const widgets = prefs.widgets.map(id => {
      const { label, icon, module } = widgetDetails[id];
      const card = node("section", "home-widget");
      card.dataset.widget = id;
      const heading = node("header", "home-widget-heading");
      const caption = node("h2");
      const shortcut = id === "today"
        ? button(t("todoAdd"), "icon-button", { symbol: "plus", iconOnly: true, onClick: addTask })
        : button(t(module), "icon-button home-widget-forward", { symbol: "arrow", iconOnly: true, onClick: () => openModule(module) });
      const captionContent = id === "today"
        ? button(t(label), "home-widget-title", { symbol: icon, onClick: () => openModule(module) })
        : node("span", "home-widget-title");
      if (id !== "today") captionContent.append(glyph(icon), node("span", "", t(label)));
      (id === "today" ? captionContent : shortcut).id = `home-open-${id}`;
      caption.append(captionContent);
      heading.append(caption, shortcut);
      const body = node("div", "home-widget-body");
      const rows = {
        today: () => buildToday(tasks), spaces: () => buildSpaces(spaces),
        calendar: () => buildCalendar(events), flashcards: () => buildFlashcards(queue), mail: () => buildMail(messages)
      };
      body.append(...rows[id]());
      card.append(heading, body);
      return card;
    });
    const focused = grid.contains(document.activeElement) ? document.activeElement.id : null;
    grid.replaceChildren(...widgets);
    grid.hidden = !widgets.length;
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  }

  return {
    root,
    focusPrompt() {
      if (mode !== "dashboard") setMode("dashboard");
      assistant.focus();
    },
    attach(source) {
      if (mode !== "dashboard") setMode("dashboard");
      return assistant.addSource(source);
    },
    openHistory: id => setMode("history", id),
    updateAccount(id) {
      assistant.updateAccount(id);
      history.updateAccount(id);
    },
    update(next) {
      state = next;
      welcome.hidden = next.toolsWelcomePending !== true;
      prefs = normalizeHome(next.home);
      const key = JSON.stringify(prefs);
      if (prefsKey !== key) {
        prefsKey = key;
        assistant.updateExampleAnimation(prefs.animateExamples !== false);
        if (!settings.hidden) renderSettings();
      }
      this.updateAccount(next.accountId);
      assistant.updateLabels(next.taskLabels);
      assistant.updateLanguages({ learning: next.flashcards.language, translation: next.translationTarget });
      renderWidgets();
    },
    show() {
      visible = true;
      if (mode === "dashboard") assistant.show();
      if (mode === "history") history.show();
    },
    hide() {
      visible = false;
      clearTimeout(reviewTimer);
      assistant.hide();
      history.hide();
    },
    dispose() {
      this.hide();
      assistant.dispose();
      history.dispose();
    }
  };
}
