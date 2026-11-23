import { defaultTodo, localTaskDay, taskLimits, taskRetentionOptions, taskToday } from "./todo-store.js";
import { parseQuickTask } from "./todo-quick-add.js";
import { calendarReminderLabel, calendarReminderOffsets } from "./calendar-timing.js";
import { createTimePicker } from "./time-picker.js";

const views = { today: "todoToday", inbox: "todoInbox", upcoming: "todoUpcoming" };
const timeValue = value => new Date("2000-01-01T" + value + "Z");

export function renderTodo(container, {
  t, icon, locale, dateLocale, settingsButton, change, complete, openSource, openEvent, edit, editLabel, shortcuts,
  collapsed, onCollapse, state = defaultTodo, events = []
}) {
  const formatDate = new Intl.DateTimeFormat(dateLocale, { month: "short", day: "numeric", weekday: "short", timeZone: "UTC" });
  const formatTime = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" });
  const formatNumber = new Intl.NumberFormat(locale);
  let current = "today";
  let detailId;
  let showingSettings = false;
  let ignoreDate = false;
  let pending = false;
  let agendaOpen = false;
  const completedOpen = new Set();
  let labelFilter = "";

  function node(tag, className, label) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (label !== undefined) element.textContent = label;
    return element;
  }

  function button(label, run, { glyph, compact, style = "secondary-button" } = {}) {
    const item = node("button", compact ? "icon-button todo-icon" : style);
    item.type = "button";
    if (glyph) item.innerHTML = icon(glyph);
    if (compact) {
      item.title = label;
      item.setAttribute("aria-label", label);
    } else item.append(node("span", "", label));
    if (run) item.addEventListener("click", run);
    return item;
  }

  function dateText(date, time, end, nextDay) {
    const day = date ? formatDate.format(new Date(date + "T00:00:00Z")) : "";
    const hours = time && (nextDay
      ? `${formatTime.format(timeValue(time))} – ${formatTime.format(timeValue(end))} · ${t("calendarEndNextDay")}`
      : end ? formatTime.formatRange(timeValue(time), timeValue(end)) : formatTime.format(timeValue(time)));
    return [day, hours].filter(Boolean).join(" · ");
  }

  const form = node("form", "todo-quick");
  const input = node("input", "translator-select");
  input.type = "text";
  input.id = "todo-quick-input";
  input.dir = "auto";
  input.required = true;
  input.maxLength = taskLimits.title + 48;
  input.placeholder = t("todoQuickPlaceholder");
  input.setAttribute("aria-label", t("todoAdd"));
  const add = button(t("todoAdd"), null, { glyph: "plus", compact: true });
  add.type = "submit";
  add.classList.add("todo-add");
  const interpreted = button("", () => { ignoreDate = true; updateQuick(); input.focus(); }, { glyph: "close" });
  interpreted.className = "todo-interpret secondary-button";
  interpreted.setAttribute("aria-label", t("todoKeepAsTitle"));
  interpreted.title = t("todoKeepAsTitle");
  form.append(input, add, interpreted);
  const tabs = node("nav", "todo-tabs");
  tabs.setAttribute("aria-label", t("todo"));
  const filters = node("div", "todo-filters");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", t("todoFilterLabels"));
  const body = node("div", "todo-display");
  container.append(form, tabs, filters, body);

  function parsed() {
    return ignoreDate ? { title: input.value.trim() } : parseQuickTask(input.value, locale);
  }

  function updateQuick() {
    const { title, dueDate, dueTime } = parsed();
    interpreted.hidden = !dueDate;
    interpreted.lastElementChild.textContent = dateText(dueDate, dueTime);
    add.disabled = pending || !title;
  }

  input.addEventListener("input", () => {
    ignoreDate = false;
    updateQuick();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (pending || !input.value.trim()) return;
    const draft = input.value;
    const task = parsed();
    if (labelFilter) task.labelIds = [labelFilter];
    pending = true;
    updateQuick();
    const added = await change("save-task", task);
    pending = false;
    if (added && input.value === draft) {
      input.value = "";
      ignoreDate = false;
      if (!task.dueDate) setView("inbox", titleFocus);
      else if (task.dueDate > localTaskDay()) setView("upcoming", titleFocus);
      else setView("today", titleFocus);
    }
    updateQuick();
  });

  function titleFocus() { input.focus(); }

  function setView(view, focus) {
    current = view;
    detailId = undefined;
    showingSettings = false;
    render();
    focus?.();
  }

  function toggleSettings() {
    showingSettings = !showingSettings;
    detailId = undefined;
    render();
    if (showingSettings) body.querySelector(".todo-back")?.focus();
  }

  settingsButton.addEventListener("click", toggleSettings);

  function back() {
    const control = button(t("calendarBack"), () => {
      detailId = undefined;
      showingSettings = false;
      render();
      settingsButton.focus();
    });
    control.classList.add("todo-back");
    return control;
  }

  function renderSettings() {
    const layout = node("section", "todo-panel");
    const choices = node("div", "todo-layout-choices");
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", t("todoLayout"));
    for (const [mode, label, symbol] of [["tabs", "todoLayoutTabs", "grid"], ["stacked", "todoLayoutStacked", "list"]]) {
      const choice = button(t(label), () => {
        if ((state.layout ?? "tabs") !== mode) change("todo-preferences", { layout: mode });
      }, { glyph: symbol });
      choice.id = `todo-layout-${mode}`;
      choice.setAttribute("aria-pressed", String((state.layout ?? "tabs") === mode));
      choices.append(choice);
    }
    layout.append(node("h3", "", t("todoLayout")), choices);

    const labels = node("section", "todo-panel");
    const labelTitle = node("div", "todo-toolbar todo-label-heading");
    labelTitle.append(node("h3", "", t("todoLabels")), button(t("todoNewLabel"), () => editLabel(), { glyph: "plus" }));
    labels.append(labelTitle);
    for (const label of state.labels ?? []) {
      const row = node("div", "todo-toolbar todo-label-heading");
      row.append(labelChip(label), button(t("edit"), () => editLabel(label), { glyph: "edit", compact: true }));
      labels.append(row);
    }

    const settings = node("form", "todo-panel");
    const field = node("label", "todo-field", t("todoMorning"));
    const on = node("input");
    on.type = "checkbox";
    on.checked = Boolean(state.dailyTime);
    field.prepend(on);
    const time = createTimePicker({ locale, t, label: t("todoMorningTime"), value: state.dailyTime || "09:00", required: true });
    const retention = node("label", "field");
    const duration = node("select", "calendar-select");
    duration.add(new Option(t("todoRetentionForever"), ""));
    for (const days of taskRetentionOptions) duration.add(new Option(t("todoRetentionDays", { count: formatNumber.format(days) }), String(days)));
    duration.value = String(state.retentionDays ?? "");
    retention.append(node("span", "", t("todoRetention")), duration, node("small", "todo-reminder-hint", t("todoRetentionHint")));
    const save = button(t("save"), null, { style: "primary-button" });
    save.type = "submit";
    const toggleTime = () => { time.element.hidden = !on.checked; time.disabled = !on.checked; };
    toggleTime();
    on.addEventListener("change", toggleTime);
    settings.addEventListener("submit", async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        const dailyTime = on.checked ? time.value : "";
        const retentionDays = duration.value ? Number(duration.value) : null;
        const patch = { retentionDays };
        if (dailyTime !== state.dailyTime) patch.dailyTime = dailyTime;
        if (await change("todo-preferences", patch)) {
          showingSettings = false;
          render();
          settingsButton.focus();
        }
      } finally {
        save.disabled = false;
      }
    });
    settings.append(field, time.element, retention, save);
    const keys = node("div", "todo-panel");
    keys.append(node("h3", "", t("todoShortcut")), ...shortcuts());
    const actions = node("div", "todo-toolbar");
    actions.append(back());
    body.append(actions, layout, labels, settings, keys);
  }

  function labelChip(label) {
    const chip = node("span", "todo-label", label.name);
    chip.dir = "auto";
    chip.style.setProperty("--label-color", label.color);
    return chip;
  }

  function taskLabels(task) {
    if (!task.labelIds?.length) return null;
    const tags = node("span", "todo-labels");
    for (const label of state.labels ?? []) {
      if (task.labelIds.includes(label.id)) tags.append(labelChip(label));
    }
    return tags.childElementCount ? tags : null;
  }

  function check(task) {
    const item = button(t(task.done ? "todoReopen" : "todoComplete"), () => complete(task.id, !task.done), {
      glyph: task.done ? "check" : undefined, compact: true
    });
    item.classList.add("todo-check");
    item.dataset.done = String(task.done);
    return item;
  }

  function sourceButton(task, compact = false) {
    const [label, glyph] = {
      mail: ["todoOpenMail", "mail"], web: ["todoOpenWeb", "link"], snippet: ["todoOpenSnippet", "clipboard"]
    }[task.source.kind];
    return button(t(label), () => openSource(task), {
      glyph, compact
    });
  }

  const upcomingDay = (task, today) => [task.dueDate, task.planDate].filter(day => day > today).sort()[0] || "";

  function row(task, section) {
    const item = node("li", "todo-item");
    item.dataset.taskId = task.id;
    item.dataset.done = String(task.done);
    const title = node("strong", "todo-item-title", task.title);
    title.dir = "auto";
    const content = button("", () => openTask(task.id));
    content.className = "todo-item-open";
    content.replaceChildren(title);
    const today = localTaskDay();
    const date = section === "upcoming" ? upcomingDay(task, today) : task.dueDate || task.planDate;
    if (date) {
      const summary = node("small", "todo-item-date", dateText(date, date === task.dueDate ? task.dueTime : task.planTime));
      summary.dataset.overdue = String(!task.done && date === task.dueDate && date < today);
      content.append(summary);
    }
    const tags = taskLabels(task);
    if (tags) content.append(tags);
    item.append(check(task), content);
    if (task.source) item.append(sourceButton(task, true));
    if (!task.done && task.dueDate && task.dueDate < today && section === "today") {
      item.append(button(t("todoMoveToday"), () => change("reschedule-task", { id: task.id, date: today }), {
        glyph: "calendar", compact: true
      }));
    }
    if (!task.done) {
      const focused = task.focusDay === localTaskDay();
      const pin = button(t(focused ? "todoUnpin" : "todoPin"), () => change("focus-task", { id: task.id }), {
        glyph: "pin", compact: true
      });
      pin.classList.add("todo-pin");
      pin.setAttribute("aria-pressed", String(focused));
      item.append(pin);
    }
    return item;
  }

  function rows(items, section) {
    const list = node("ul", "todo-list");
    list.append(...items.map(task => row(task, section)));
    return list;
  }

  function renderDetail(task) {
    const controls = node("div", "todo-toolbar");
    controls.append(back(), check(task), button(t("edit"), () => edit(task), { glyph: "edit", compact: true }));
    const title = node("h3", "todo-detail-title", task.title);
    title.dir = "auto";
    const details = node("section", "todo-panel");
    details.append(title);
    if (task.notes) {
      const notes = node("p", "todo-notes", task.notes);
      notes.dir = "auto";
      details.append(notes);
    }
    const tags = taskLabels(task);
    if (tags) details.append(tags);
    const dates = node("dl", "todo-details");
    const deadline = task.dueDate && dateText(task.dueDate, task.dueTime);
    const plan = task.planDate && dateText(task.planDate, task.planTime, task.planEnd, task.planEndNextDay);
    const reminder = calendarReminderOffsets.includes(task.reminderMinutes)
      ? calendarReminderLabel(t, formatNumber, task.reminderMinutes) : dateText(task.reminderDate, task.reminderTime);
    for (const [key, text] of [["todoDue", deadline], ["todoPlan", plan], ["todoReminder", reminder]]) {
      if (text) dates.append(node("dt", "", t(key)), node("dd", "", text));
    }
    if (dates.childElementCount) details.append(dates);
    const actions = node("div", "todo-toolbar");
    if (task.source) actions.append(sourceButton(task));
    if (!task.done) {
      actions.append(button(t("todoToday"), () => change("reschedule-task", { id: task.id, date: localTaskDay() })),
        button(t("todoTomorrow"), () => change("reschedule-task", { id: task.id, date: localTaskDay(1) })));
    }
    const remove = button(t("remove"), () => edit(task, "remove"), { glyph: "trash", compact: true });
    actions.append(remove);
    body.append(controls, details, actions);
  }

  function renderTodayAgenda(parent, today) {
    const items = events.filter(event => event.date === today).sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    if (!items.length) return;
    const agenda = node("details", "todo-agenda");
    agenda.open = agendaOpen;
    agenda.addEventListener("toggle", () => { agendaOpen = agenda.open; });
    agenda.append(node("summary", "", `${t("calendarEvents")} · ${formatNumber.format(items.length)}`));
    for (const event of items) {
      const entry = button(event.title || t("calendarUntitledEvent"), () => openEvent(event.id), { glyph: "calendar" });
      if (event.start) entry.append(node("small", "", formatTime.format(timeValue(event.start))));
      agenda.append(entry);
    }
    parent.append(agenda);
  }

  function renderList(parent, section, stacked) {
    const today = localTaskDay();
    const nextDate = task => upcomingDay(task, today);
    const filter = {
      today: task => taskToday(task, today),
      inbox: task => !task.dueDate && !task.planDate,
      upcoming: nextDate
    };
    const matching = state.items.filter(task => (!labelFilter || task.labelIds?.includes(labelFilter))
      && filter[section](task) && (!stacked || section === "today" || !taskToday(task, today)));
    const open = matching.filter(task => !task.done);
    if (section === "today") {
      if (!labelFilter) renderTodayAgenda(parent, today);
      open.sort((a, b) => Number(b.focusDay === today) - Number(a.focusDay === today)
        || (a.dueDate || a.planDate || today).localeCompare(b.dueDate || b.planDate || today)
        || (a.dueTime || a.planTime).localeCompare(b.dueTime || b.planTime));
    } else if (section === "upcoming") {
      open.sort((a, b) => nextDate(a).localeCompare(nextDate(b)));
    }
    if (open.length) parent.append(rows(open, section));
    else parent.append(node("p", "todo-empty", t(labelFilter ? "todoEmptyFilter" : `todoEmpty${section[0].toUpperCase()}${section.slice(1)}`)));
    const done = matching.filter(task => task.done);
    if (done.length) {
      const completed = node("details", "todo-agenda");
      completed.open = completedOpen.has(section);
      completed.addEventListener("toggle", () => {
        if (completed.open) completedOpen.add(section);
        else completedOpen.delete(section);
      });
      completed.append(node("summary", "", `${t("todoCompleted")} · ${formatNumber.format(done.length)}`), rows(done, section));
      parent.append(completed);
    }
  }

  function renderStack() {
    for (const [section, label] of Object.entries(views)) {
      const group = node("details", "todo-section snippet-advanced");
      group.dataset.todoSection = section;
      group.open = !collapsed.has(section);
      const summary = node("summary", "", t(label));
      summary.id = `todo-section-${section}`;
      summary.addEventListener("click", event => {
        event.preventDefault();
        const closing = group.open;
        group.open = !closing;
        onCollapse(section, closing);
      });
      const content = node("div", "todo-section-content");
      renderList(content, section, true);
      group.append(summary, content);
      body.append(group);
    }
  }

  function renderFilters() {
    if (!state.labels?.some(label => label.id === labelFilter)) labelFilter = "";
    filters.hidden = !state.labels?.length;
    const choices = [{ id: "", name: t("todoAllLabels") }, ...(state.labels ?? [])];
    filters.replaceChildren(...choices.map(label => {
      const choice = button(label.name, () => { labelFilter = label.id; render(); });
      choice.id = `todo-filter-${label.id || "all"}`;
      if (label.color) choice.replaceChildren(labelChip(label));
      choice.setAttribute("aria-pressed", String(label.id === labelFilter));
      return choice;
    }));
  }

  function render() {
    const task = state.items.find(item => item.id === detailId);
    const inList = !task && !showingSettings;
    const focusedTab = document.activeElement?.dataset.todoView;
    const focusId = document.activeElement?.id;
    const stacked = state.layout === "stacked";
    form.hidden = !inList;
    tabs.hidden = !inList || stacked;
    if (inList) renderFilters();
    else filters.hidden = true;
    settingsButton.setAttribute("aria-expanded", String(showingSettings));
    tabs.replaceChildren(...Object.entries(views).map(([view, key]) => {
      const choice = button(t(key), () => setView(view, () => tabs.querySelector(`[data-todo-view="${view}"]`).focus()));
      choice.dataset.todoView = view;
      choice.setAttribute("aria-pressed", String(view === current));
      return choice;
    }));
    body.replaceChildren();
    if (showingSettings) renderSettings();
    else if (task) renderDetail(task);
    else if (stacked) renderStack();
    else renderList(body, current, false);
    if (focusedTab && inList) tabs.querySelector(`[data-todo-view="${focusedTab}"]`)?.focus({ preventScroll: true });
    else if (focusId && focusId !== input.id && ["todo-layout-", "todo-filter-", "todo-section-"].some(prefix => focusId.startsWith(prefix))) {
      document.getElementById(focusId)?.focus({ preventScroll: true });
    }
    updateQuick();
  }

  function openTask(id) {
    detailId = id;
    showingSettings = false;
    render();
    body.querySelector(".todo-back")?.focus();
  }

  render();
  return {
    update(next, nextEvents) { state = next; events = nextEvents; render(); },
    updateCollapsed() { if (state.layout === "stacked" && !detailId && !showingSettings) render(); },
    openTask,
    quickAdd() { setView("inbox", titleFocus); },
    dispose() { settingsButton.removeEventListener("click", toggleSettings); }
  };
}
