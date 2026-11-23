const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
export const calendarReminderOffsets = Object.freeze([0, 5, 10, 15, 30, 60, 1440]);

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

export function calendarReminderLabel(t, numbers, minutes) {
  if (minutes === 0) return t("calendarReminderAtStart");
  if (minutes === 60) return t("calendarReminderHour");
  if (minutes === 1440) return t("calendarReminderDay");
  return t("calendarReminderMinutes", { count: numbers.format(minutes) });
}

export function calendarSuggestedEnd(start) {
  if (!timePattern.test(start)) return { time: "", nextDay: false };
  const [hour, minute] = start.split(":").map(Number);
  return { time: `${String((hour + 1) % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, nextDay: hour === 23 };
}
