import { defaultCalendar } from "./workspace-data.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
export const calendarReminderOffsets = Object.freeze([0, 5, 10, 15, 30, 60, 1440]);

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

export function calendarReminderSchedule(event) {
  if (event?.readOnly || !datePattern.test(event?.date) || !timePattern.test(event.start)
    || !calendarReminderOffsets.includes(event.reminderMinutes)) return null;
  const start = new Date(`${event.date}T${event.start}:00`);
  const [year, month, day] = event.date.split("-").map(Number);
  const [hours, minutes] = event.start.split(":").map(Number);
  // Reject normalized dates and times that do not exist on a daylight-saving transition.
  if (start.getFullYear() !== year || start.getMonth() + 1 !== month || start.getDate() !== day
    || start.getHours() !== hours || start.getMinutes() !== minutes) return null;
  return { startAt: start.getTime(), reminderAt: start.getTime() - event.reminderMinutes * 60_000 };
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
  const stored = {
    id: event.id ?? crypto.randomUUID(),
    date: event.date,
    title,
    start,
    end,
    ...(nextDay ? { endNextDay: true } : {}),
    reminderMinutes: start ? reminderMinutes : null,
    location: clean(event.location, 240),
    notes: clean(event.notes, 2000)
  };
  if (existing) {
    workspace.events = workspace.events.map((item) => item.id === event.id ? stored : item);
  } else {
    workspace.events = [...workspace.events, stored];
  }
}
