import { calendarReminderOffsets, calendarReminderSchedule } from "./calendar-timing.js";

export const defaultTodo = { items: [], dailyTime: "" };
export const taskLimits = { title: 160, notes: 2000 };
export const taskSections = ["today", "inbox", "upcoming"];
export const collapsedTaskKey = section => `easeTodoCollapsed:${section}`;

const iso = /^\d{4}-\d{2}-\d{2}$/u;
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const uid = /^[1-9]\d{0,9}$/u;
const taskId = /^[a-f0-9-]{36}$/u;
const labelColor = /^#[0-9a-f]{6}$/iu;
const isTime = value => typeof value === "string" && clock.test(value);

export function taskDateValid(value) {
  if (typeof value !== "string" || !iso.test(value)) return false;
  const day = new Date(value + "T00:00:00Z");
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

export function localTaskDay(offset = 0, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return [String(date.getFullYear()).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}

export function taskTimestamp(date, time) {
  if (!taskDateValid(date) || !isTime(time)) return null;
  const local = new Date(date + "T" + time);
  const localTime = [local.getHours(), local.getMinutes()].map(unit => String(unit).padStart(2, "0")).join(":");
  return localTaskDay(0, local) === date && localTime === time ? local.getTime() : null;
}

function bounded(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function taskLink(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function taskSource(source) {
  if (!source) return null;
  const url = taskLink(source.url);
  if (source.kind === "web") return url ? { kind: "web", url } : null;
  if (source.kind !== "mail" || !bounded(source.accountId, 540) || !bounded(source.messageId, 1024)) return null;
  return {
    kind: "mail", accountId: bounded(source.accountId, 540), messageId: bounded(source.messageId, 1024),
    folder: source.folder === "sent" ? "sent" : "inbox",
    uidValidity: typeof source.uidValidity === "string" && uid.test(source.uidValidity) ? source.uidValidity : "",
    senderAddress: bounded(source.senderAddress, 254), url
  };
}

function taskFields(data) {
  return {
    title: bounded(data.title, taskLimits.title), notes: bounded(data.notes, taskLimits.notes),
    dueDate: data.dueDate || "", dueTime: data.dueTime || "",
    planDate: data.planDate || "", planTime: data.planTime || "", planEnd: data.planEnd || "",
    reminderDate: data.reminderDate || "", reminderTime: data.reminderTime || "",
    ...(data.planEndNextDay === true ? { planEndNextDay: true } : {}),
    ...(data.reminderMinutes != null ? { reminderMinutes: data.reminderMinutes } : {})
  };
}

function validFields(task) {
  return [task.dueDate, task.planDate, task.reminderDate].every(date => date === "" || taskDateValid(date))
    && [task.dueTime, task.planTime, task.planEnd, task.reminderTime].every(time => time === "" || isTime(time))
    && (!task.dueTime || task.dueDate) && Boolean(task.planDate) === Boolean(task.planTime)
    && (!task.planEnd || (task.planTime && (task.planEndNextDay || task.planEnd > task.planTime)))
    && (!task.planEndNextDay || Boolean(task.planEnd))
    && Boolean(task.reminderDate) === Boolean(task.reminderTime)
    && (task.reminderMinutes === undefined || (calendarReminderOffsets.includes(task.reminderMinutes)
      && (task.planTime || task.dueTime) && !task.reminderDate));
}

function readLabels(labels = []) {
  if (!Array.isArray(labels)) return null;
  const ids = new Set();
  const names = new Set();
  const result = [];
  for (const label of labels) {
    const name = bounded(label?.name, 32);
    if (typeof label?.id !== "string" || !taskId.test(label.id) || ids.has(label.id)
      || !name || names.has(name.toLowerCase()) || typeof label.color !== "string" || !labelColor.test(label.color)) return null;
    result.push({ id: label.id, name, color: label.color.toLowerCase() });
    ids.add(label.id);
    names.add(name.toLowerCase());
  }
  return result;
}

function assignedLabels(ids, allowed) {
  return Array.isArray(ids) ? [...new Set(ids.filter(id => allowed.has(id)))] : [];
}

export function restoreTodo(value) {
  if (value === undefined) return defaultTodo;
  if (!Array.isArray(value?.items) || (value.dailyTime !== "" && !isTime(value.dailyTime))) return null;
  const labels = readLabels(value.labels);
  if (!labels || (value.layout !== undefined && !["tabs", "stacked"].includes(value.layout))) return null;
  const allowed = new Set(labels.map(label => label.id));
  const ids = new Set();
  const items = [];
  for (const task of value.items) {
    if (typeof task?.id !== "string" || !taskId.test(task.id) || ids.has(task.id) || typeof task.done !== "boolean"
      || !Number.isSafeInteger(task.createdAt) || task.createdAt < 0) return null;
    const fields = taskFields(task);
    const source = taskSource(task.source);
    if (!fields.title || !validFields(fields) || (task.source && !source)
      || (task.focusDay && !taskDateValid(task.focusDay))) return null;
    ids.add(task.id);
    const labelIds = assignedLabels(task.labelIds, allowed);
    items.push({ id: task.id, ...fields, createdAt: task.createdAt, done: task.done, focusDay: task.focusDay || "", source,
      ...(labelIds.length ? { labelIds } : {}) });
  }
  return { dailyTime: value.dailyTime, items,
    ...(labels.length ? { labels } : {}), ...(value.layout === "stacked" ? { layout: "stacked" } : {}) };
}

function updateLabels(workspace, todo, action, data) {
  const labels = todo.labels ?? [];
  const existing = labels.find(label => label.id === data.id);
  if (data.id && !existing) return "todoLabelMissing";
  if (action === "remove-todo-label") {
    if (!existing) return "todoLabelMissing";
    workspace.todo = { ...todo, labels: labels.filter(label => label !== existing), items: todo.items.map(task => {
      if (!task.labelIds?.includes(data.id)) return task;
      const { labelIds, ...rest } = task;
      const remaining = labelIds.filter(id => id !== data.id);
      return remaining.length ? { ...rest, labelIds: remaining } : rest;
    }) };
    return;
  }
  const name = bounded(data.name, 32);
  if (!name || typeof data.color !== "string" || !labelColor.test(data.color)) return "todoLabelInvalid";
  if (labels.some(label => label !== existing && label.name.toLowerCase() === name.toLowerCase())) return "todoLabelDuplicate";
  const label = { id: existing?.id ?? crypto.randomUUID(), name, color: data.color.toLowerCase() };
  workspace.todo = { ...todo, labels: existing ? labels.map(item => item === existing ? label : item) : [...labels, label] };
}

export function taskAction(workspace, action, data) {
  const todo = workspace.todo ?? defaultTodo;
  const items = todo.items;
  const existing = items.find(task => task.id === data.id);
  if (action === "save-todo-label" || action === "remove-todo-label") return updateLabels(workspace, todo, action, data);
  if (action === "todo-preferences") {
    const next = { ...todo };
    if (Object.hasOwn(data, "dailyTime")) {
      if (data.dailyTime !== "" && !isTime(data.dailyTime)) return "todoInvalidSchedule";
      next.dailyTime = data.dailyTime;
    }
    if (data.layout === "stacked") next.layout = "stacked";
    else if (data.layout === "tabs") delete next.layout;
    workspace.todo = next;
    return;
  }
  if (data.id && !existing) return "todoMissing";
  if (action === "save-task") {
    const fields = taskFields(data);
    if (!fields.title) return "todoTitleRequired";
    if (!validFields(fields) || ((fields.reminderDate || fields.reminderMinutes !== undefined) && !taskReminderSchedule(fields))) {
      return "todoInvalidSchedule";
    }
    const source = existing?.source ?? taskSource(data.source);
    const duplicate = source?.kind === "mail" && !existing && items.find(task => !task.done && task.source?.kind === "mail"
      && task.source.accountId === source.accountId && task.source.messageId === source.messageId
      && task.source.folder === source.folder && task.source.uidValidity === source.uidValidity);
    const record = existing || duplicate;
    const task = record ? { ...record, ...(duplicate ? { dueDate: fields.dueDate, dueTime: fields.dueTime } : fields) }
      : { id: crypto.randomUUID(), ...fields, createdAt: Date.now(), done: false, focusDay: "", source };
    if (!duplicate) {
      for (const key of ["reminderMinutes", "planEndNextDay"]) {
        if (!Object.hasOwn(fields, key)) delete task[key];
      }
      if (Array.isArray(data.labelIds)) {
        const labelIds = assignedLabels(data.labelIds, new Set(todo.labels?.map(label => label.id)));
        if (labelIds.length) task.labelIds = labelIds;
        else delete task.labelIds;
      }
    }
    workspace.todo = { ...todo, items: record ? items.map(item => item.id === record.id ? task : item) : [task, ...items] };
    if (data.showModule === true && !workspace.tabs.includes("todo")) workspace.tabs.push("todo");
    return;
  }
  if (!existing) return "todoMissing";
  let next;
  switch (action) {
    case "remove-task":
      workspace.todo = { ...todo, items: items.filter(task => task !== existing) };
      return;
    case "complete-task":
      next = { ...existing, done: data.done === true };
      break;
    case "reschedule-task": {
      if (!taskDateValid(data.date)) return "todoInvalidSchedule";
      next = { ...existing, dueDate: data.date };
      break;
    }
    case "focus-task": {
      const today = localTaskDay();
      const focusDay = existing.focusDay === today ? "" : today;
      if (focusDay && items.filter(task => task.focusDay === today && !task.done).length >= 3) return "todoFocusLimit";
      next = { ...existing, focusDay };
      break;
    }
    default:
      return "todoMissing";
  }
  workspace.todo = { ...todo, items: items.map(task => task === existing ? next : task) };
}

export function taskToday(task, today = localTaskDay()) {
  return Boolean(task.focusDay === today || (task.dueDate && task.dueDate <= today) || task.planDate === today);
}

export function taskReminderSchedule(task) {
  if (task.reminderMinutes === undefined) {
    const when = taskTimestamp(task.reminderDate, task.reminderTime);
    return when === null ? null : { when, signature: `${task.reminderDate}:${task.reminderTime}` };
  }
  const date = task.planDate || task.dueDate;
  const start = task.planTime || task.dueTime;
  const schedule = calendarReminderSchedule({ date, start, reminderMinutes: task.reminderMinutes });
  return schedule ? { when: schedule.reminderAt, signature: `${date}T${start}/${task.reminderMinutes}` } : null;
}

export function taskCalendarEntries(tasks) {
  return tasks.flatMap(task => {
    const common = { taskId: task.id, completed: task.done, title: task.title, notes: task.notes, readOnly: true };
    const entries = [];
    if (task.dueDate && task.dueDate !== task.planDate) entries.push({
      ...common, id: `todo-due:${task.id}`, date: task.dueDate, start: task.dueTime, display: "due"
    });
    if (task.planDate) entries.push({
      ...common, id: `todo-plan:${task.id}`, date: task.planDate, start: task.planTime, end: task.planEnd,
      endNextDay: task.planEndNextDay, display: "plan"
    });
    return entries;
  });
}
