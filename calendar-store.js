import { defaultCalendar } from "./workspace-data.js";
import { mailMessageLink } from "./mail-api.js";
import { calendarReminderOffsets } from "./calendar-timing.js";
export { calendarReminderOffsets, calendarReminderSchedule } from "./calendar-timing.js";

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
  if (["dots", "count", "titles", "cards"].includes(patch.eventDisplay)) preferences.eventDisplay = patch.eventDisplay;
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
  const existing = event.id ? workspace.events.find(item => item.id === event.id) : undefined;
  if (event.id && !existing) throw new Error("Event no longer exists");
  const nextDay = Boolean(start && end && (event.endNextDay ?? existing?.endNextDay) === true);
  if ((start && !timePattern.test(start)) || (end && !timePattern.test(end)) || (start && end && !nextDay && end <= start)) {
    return "calendarTimeOrder";
  }
  const reminderMinutes = Object.hasOwn(event, "reminderMinutes") ? event.reminderMinutes : existing?.reminderMinutes ?? null;
  if (reminderMinutes !== null && !calendarReminderOffsets.includes(reminderMinutes)) throw new Error("Invalid reminder offset");
  const mailUrl = mailMessageLink(null, event.mailUrl ?? existing?.mailUrl);
  const stored = {
    id: event.id ?? crypto.randomUUID(),
    date: event.date,
    title,
    start,
    end,
    ...(nextDay ? { endNextDay: true } : {}),
    reminderMinutes: start ? reminderMinutes : null,
    location: clean(event.location, 240),
    notes: clean(event.notes, 2000),
    ...(mailUrl ? { mailUrl } : {})
  };
  if (existing) {
    workspace.events = workspace.events.map((item) => item.id === event.id ? stored : item);
  } else {
    workspace.events = [...workspace.events, stored];
  }
}
