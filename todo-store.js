export const defaultTodo = { items: [], dailyTime: "" };
export const taskLimits = { title: 160, notes: 2000 };

const iso = /^\d{4}-\d{2}-\d{2}$/u;
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const uid = /^[1-9]\d{0,9}$/u;
const taskId = /^[a-f0-9-]{36}$/u;
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
    reminderDate: data.reminderDate || "", reminderTime: data.reminderTime || ""
  };
}

function validFields(task) {
  return [task.dueDate, task.planDate, task.reminderDate].every(date => date === "" || taskDateValid(date))
    && [task.dueTime, task.planTime, task.planEnd, task.reminderTime].every(time => time === "" || isTime(time))
    && (!task.dueTime || task.dueDate) && Boolean(task.planDate) === Boolean(task.planTime)
    && (!task.planEnd || (task.planTime && task.planEnd > task.planTime))
    && Boolean(task.reminderDate) === Boolean(task.reminderTime);
}

export function restoreTodo(value) {
  if (value === undefined) return defaultTodo;
  if (!Array.isArray(value?.items) || (value.dailyTime !== "" && !isTime(value.dailyTime))) return null;
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
    items.push({ id: task.id, ...fields, createdAt: task.createdAt, done: task.done, focusDay: task.focusDay || "", source });
  }
  return { dailyTime: value.dailyTime, items };
}

export function taskAction(workspace, action, data) {
  const todo = workspace.todo ?? defaultTodo;
  const items = todo.items;
  const existing = items.find(task => task.id === data.id);
  if (action === "todo-preferences") {
    if (data.dailyTime !== "" && !isTime(data.dailyTime)) return "todoInvalidSchedule";
    workspace.todo = { ...todo, dailyTime: data.dailyTime };
    return;
  }
  if (data.id && !existing) return "todoMissing";
  if (action === "save-task") {
    const fields = taskFields(data);
    if (!fields.title) return "todoTitleRequired";
    if (!validFields(fields) || (fields.reminderDate && taskTimestamp(fields.reminderDate, fields.reminderTime) === null)) {
      return "todoInvalidSchedule";
    }
    const source = existing?.source ?? taskSource(data.source);
    const duplicate = source?.kind === "mail" && !existing && items.find(task => !task.done && task.source?.kind === "mail"
      && task.source.accountId === source.accountId && task.source.messageId === source.messageId
      && task.source.folder === source.folder && task.source.uidValidity === source.uidValidity);
    const record = existing || duplicate;
    const task = record ? { ...record, ...(duplicate ? { dueDate: fields.dueDate, dueTime: fields.dueTime } : fields) }
      : { id: crypto.randomUUID(), ...fields, createdAt: Date.now(), done: false, focusDay: "", source };
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

export function taskCalendarEntries(tasks) {
  return tasks.flatMap(task => {
    const common = { taskId: task.id, completed: task.done, title: task.title, notes: task.notes, readOnly: true };
    const entries = [];
    if (task.dueDate && task.dueDate !== task.planDate) entries.push({
      ...common, id: `todo-due:${task.id}`, date: task.dueDate, start: task.dueTime, display: "due"
    });
    if (task.planDate) entries.push({
      ...common, id: `todo-plan:${task.id}`, date: task.planDate, start: task.planTime, end: task.planEnd, display: "plan"
    });
    return entries;
  });
}
