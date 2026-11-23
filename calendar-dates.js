export const dayLength = 86_400_000;

export function localToday(now = new Date()) {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / dayLength;
}

export function dayKey(day) {
  return new Date(day * dayLength).toISOString().slice(0, 10);
}

export function localeWeekStart(locale) {
  const info = new Intl.Locale(locale);
  return ((info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 1) % 7;
}

export function weekOffsetFor(day, firstDay) {
  return (new Date(day * dayLength).getUTCDay() - firstDay + 7) % 7;
}

export function calendarMonthStart(dayFormat, day) {
  const part = dayFormat.formatToParts(day * dayLength).find(part => part.type === "day");
  return day - Number(part.value) + 1;
}
