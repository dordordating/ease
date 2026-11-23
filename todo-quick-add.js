import { localTaskDay, taskDateValid } from "./todo-store.js";

const offsets = {
  en: ["today", "tomorrow"],
  fa: ["امروز", "فردا"],
  es: ["hoy", "mañana"],
  fr: ["aujourd’hui", "demain"],
  pt: ["hoje", "amanhã"],
  ar: ["اليوم", "غدًا"],
  de: ["heute", "morgen"],
  ja: ["今日", "明日"]
};
const persianMonths = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
const weekdays = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];

function asciiDigits(value) {
  return value.replace(/[۰-۹٠-٩]/gu, digit => String(digit.codePointAt(0) & 15));
}

function sameWord(a, b, locale) {
  const normalized = value => value.toLocaleLowerCase(locale).replace(/[\u200c\u200d]/gu, "").replaceAll("'", "’");
  return normalized(a) === normalized(b);
}

function nextPersianDate(day, month, now) {
  if (day < 1 || day > 31) return "";
  const format = new Intl.DateTimeFormat("en-u-ca-persian", { month: "numeric", day: "numeric" });
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  const date = new Date(start);
  for (let offset = 0; offset <= 366; offset += 1, date.setDate(date.getDate() + 1)) {
    const parts = format.formatToParts(date);
    if (Number(parts.find(part => part.type === "month").value) === month
      && Number(parts.find(part => part.type === "day").value) === day) return localTaskDay(0, date);
  }
  return "";
}

export function parseQuickTask(input, locale, now = new Date()) {
  const lang = new Intl.Locale(locale).language;
  const trimmed = input.trim();
  const token = trimmed.match(/^(.*?\S)\s+(?:(\d{4}-\d{2}-\d{2}|[۰-۹٠-٩]{4}-[۰-۹٠-٩]{2}-[۰-۹٠-٩]{2}|[\d۰-۹٠-٩]{1,2}\s+[\p{L}\u200c]+|[\p{L}\p{M}’'\u200c]+))(?:\s+(?:(?:at|ساعت)\s+)?([\d۰-۹٠-٩]{1,2})(?::([\d۰-۹٠-٩]{2}))?)?$/iu);
  if (!token) return { title: trimmed, dueDate: "", dueTime: "" };
  const [, title, keyword, hour, minutes] = token;
  const word = asciiDigits(keyword);
  let dueDate = taskDateValid(word) ? word : "";
  const offset = (offsets[lang] ?? offsets.en).findIndex(item => sameWord(item, word, locale));
  if (offset !== -1) dueDate = localTaskDay(offset, now);
  if (lang === "fa" && !dueDate) {
    const weekday = weekdays.findIndex(item => sameWord(item, word, locale));
    if (weekday >= 0) dueDate = localTaskDay((weekday - now.getDay() + 7) % 7 || 7, now);
    const named = word.match(/^(\d{1,2})\s+(.+)$/u);
    if (named) {
      const month = persianMonths.indexOf(named[2]);
      if (month >= 0) dueDate = nextPersianDate(Number(named[1]), month + 1, now);
    }
  }
  const dueTime = hour ? `${asciiDigits(hour).padStart(2, "0")}:${asciiDigits(minutes ?? "00")}` : "";
  if (!dueDate || (dueTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(dueTime))) return { title: trimmed, dueDate: "", dueTime: "" };
  return { title, dueDate, dueTime };
}
