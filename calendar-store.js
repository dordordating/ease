import { defaultCalendar } from "./workspace-data.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function validateDate(date) {
  if (typeof date !== "string" || !datePattern.test(date)) throw new Error("Invalid date");
  const timestamp = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error("Invalid date");
  }
}

export function changeCalendarPreferences(workspace, patch) {
  const preferences = { ...defaultCalendar, ...workspace.calendar };
  if ([null, "gregory", "persian", "islamic-civil"].includes(patch.system)) preferences.system = patch.system;
  if (["week", "month"].includes(patch.view)) preferences.view = patch.view;
  if (["dots", "count", "titles"].includes(patch.eventDisplay)) preferences.eventDisplay = patch.eventDisplay;
  if (patch.firstDay === null || (Number.isInteger(patch.firstDay) && patch.firstDay >= 0 && patch.firstDay <= 6)) {
    preferences.firstDay = patch.firstDay;
  }
  workspace.calendar = preferences;
}

export function setCalendarHoliday(workspace, { date, enabled }) {
  validateDate(date);
  if (typeof enabled !== "boolean") throw new Error("Invalid holiday setting");
  const holidays = new Set(workspace.holidays);
  if (enabled) holidays.add(date);
  else holidays.delete(date);
  workspace.holidays = [...holidays];
}

export function saveCalendarEvent(workspace, event) {
  validateDate(event.date);
  const title = clean(event.title, 160);
  if (!title) return "calendarTitleRequired";
  const start = typeof event.start === "string" ? event.start.trim() : "";
  const end = typeof event.end === "string" ? event.end.trim() : "";
  if ((start && !timePattern.test(start)) || (end && (!timePattern.test(end) || !start || end <= start))) {
    return "calendarTimeOrder";
  }
  const stored = {
    id: event.id ?? crypto.randomUUID(),
    date: event.date,
    title,
    start,
    end,
    location: clean(event.location, 240),
    notes: clean(event.notes, 2000)
  };
  if (event.id) {
    if (!workspace.events.some(({ id }) => id === event.id)) throw new Error("Event no longer exists");
    workspace.events = workspace.events.map((item) => item.id === event.id ? stored : item);
  } else {
    workspace.events = [...workspace.events, stored];
  }
}
