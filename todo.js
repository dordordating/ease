import { defaultTodo, localTaskDay, taskLimits, taskToday } from "./todo-store.js";
import { parseQuickTask } from "./todo-quick-add.js";

const views = { today: "todoToday", inbox: "todoInbox", upcoming: "todoUpcoming" };
const timeValue = value => new Date("2000-01-01T" + value + "Z");

export function renderTodo(container, {
  t, icon, locale, dateLocale, settingsButton, change, complete, openSource, openEvent, edit, shortcuts,
  state = defaultTodo, events = []
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
  let completedOpen = false;

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

  function dateText(date, time, end) {
    const day = date ? formatDate.format(new Date(date + "T00:00:00Z")) : "";
    const hours = time && (end ? formatTime.formatRange(timeValue(time), timeValue(end)) : formatTime.format(timeValue(time)));
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
  const body = node("div", "todo-display");
  container.append(form, tabs, body);

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
    const settings = node("form", "todo-panel");
    const field = node("label", "todo-field", t("todoMorning"));
    const on = node("input");
    on.type = "checkbox";
    on.checked = Boolean(state.dailyTime);
    field.prepend(on);
    const time = node("input", "translator-select");
    time.type = "time";
    time.required = true;
    time.value = state.dailyTime || "09:00";
    time.setAttribute("aria-label", t("todoMorningTime"));
    const save = button(t("save"), null, { style: "primary-button" });
    save.type = "submit";
    const toggleTime = () => { time.hidden = !on.checked; time.disabled = !on.checked; };
    toggleTime();
    on.addEventListener("change", toggleTime);
    settings.addEventListener("submit", async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        if (await change("todo-preferences", { dailyTime: on.checked ? time.value : "" })) {
          showingSettings = false;
          render();
          settingsButton.focus();
        }
      } finally {
        save.disabled = false;
      }
    });
    settings.append(field, time, save);
    const keys = node("div", "todo-panel");
    keys.append(node("h3", "", t("todoShortcut")), ...shortcuts());
    const actions = node("div", "todo-toolbar");
    actions.append(back());
    body.append(actions, settings, keys);
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
    const mail = task.source.kind === "mail";
    return button(t(mail ? "todoOpenMail" : "todoOpenWeb"), () => openSource(task), {
      glyph: mail ? "mail" : "link", compact
    });
  }

  const upcomingDay = (task, today) => [task.dueDate, task.planDate].filter(day => day > today).sort()[0] || "";

  function row(task) {
    const item = node("li", "todo-item");
    item.dataset.taskId = task.id;
    item.dataset.done = String(task.done);
    const title = node("strong", "todo-item-title", task.title);
    title.dir = "auto";
    const content = button("", () => openTask(task.id));
    content.className = "todo-item-open";
    content.replaceChildren(title);
    const today = localTaskDay();
    const date = current === "upcoming" ? upcomingDay(task, today) : task.dueDate || task.planDate;
    if (date) {
      const summary = node("small", "todo-item-date", dateText(date, date === task.dueDate ? task.dueTime : task.planTime));
      summary.dataset.overdue = String(!task.done && date === task.dueDate && date < today);
      content.append(summary);
    }
    item.append(check(task), content);
    if (task.source) item.append(sourceButton(task, true));
    if (!task.done && task.dueDate && task.dueDate < today && current === "today") {
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

  function rows(items) {
    const list = node("ul", "todo-list");
    list.append(...items.map(row));
    return list;
  }

  function renderDetail(task) {
    const controls = node("div", "todo-toolbar");
    controls.append(back(), check(task), button(t("edit"), () => edit(task), { glyph: "edit", compact: true }));
    const title = node("h3", "todo-detail-title", task.title);
    title.dir = "auto";
    const details = node("section", "todo-panel");
    details.append(title);
    const dates = node("dl", "todo-details");
    const deadline = task.dueDate && dateText(task.dueDate, task.dueTime);
    const plan = task.planDate && dateText(task.planDate, task.planTime, task.planEnd);
    const reminder = task.reminderDate && dateText(task.reminderDate, task.reminderTime);
    for (const [key, text] of [["todoDue", deadline], ["todoPlan", plan], ["todoReminder", reminder]]) {
      if (text) dates.append(node("dt", "", t(key)), node("dd", "", text));
    }
    if (dates.childElementCount) details.append(dates);
    if (task.notes) {
      const notes = node("p", "todo-notes", task.notes);
      notes.dir = "auto";
      details.append(notes);
    }
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

  function renderTodayAgenda(today) {
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
    body.append(agenda);
  }

  function renderList() {
    const today = localTaskDay();
    const nextDate = task => upcomingDay(task, today);
    const filter = {
      today: task => taskToday(task, today),
      inbox: task => !task.dueDate && !task.planDate,
      upcoming: nextDate
    };
    const matching = state.items.filter(filter[current]);
    const open = matching.filter(task => !task.done);
    if (current === "today") {
      renderTodayAgenda(today);
      open.sort((a, b) => Number(b.focusDay === today) - Number(a.focusDay === today)
        || (a.dueDate || a.planDate || today).localeCompare(b.dueDate || b.planDate || today)
        || (a.dueTime || a.planTime).localeCompare(b.dueTime || b.planTime));
    } else if (current === "upcoming") {
      open.sort((a, b) => nextDate(a).localeCompare(nextDate(b)));
    }
    if (open.length) body.append(rows(open));
    else body.append(node("p", "todo-empty", t(`todoEmpty${current[0].toUpperCase()}${current.slice(1)}`)));
    const done = matching.filter(task => task.done);
    if (done.length) {
      const completed = node("details", "todo-agenda");
      completed.open = completedOpen;
      completed.addEventListener("toggle", () => { completedOpen = completed.open; });
      completed.append(node("summary", "", `${t("todoCompleted")} · ${formatNumber.format(done.length)}`), rows(done));
      body.append(completed);
    }
  }

  function render() {
    const task = state.items.find(item => item.id === detailId);
    const inList = !task && !showingSettings;
    const focusedTab = document.activeElement?.dataset.todoView;
    form.hidden = !inList;
    tabs.hidden = !inList;
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
    else renderList();
    if (focusedTab && inList) tabs.querySelector(`[data-todo-view="${focusedTab}"]`)?.focus({ preventScroll: true });
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
    openTask,
    quickAdd() { setView("inbox", titleFocus); },
    dispose() { settingsButton.removeEventListener("click", toggleSettings); }
  };
}
