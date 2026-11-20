import ICAL from "./vendor/ical.js/ical.js";

export const appleCalendarStorageKey = "easeAppleCalendar";
const storageKey = appleCalendarStorageKey;
const dayMs = 86_400_000;
const maxFeedBytes = 2 * 1024 * 1024;
const maxEvents = 1000;
const maxOccurrences = 40_000;

function publishedCalendarUrl(input) {
  try {
    const url = new URL(input.trim().replace(/^webcal:/iu, "https:"));
    const allowedHost = /^(?:p\d{1,4}-)?caldav\.icloud\.com$/u.test(url.hostname);
    const publishedPath = /^\/published\/\d+\/[a-z0-9_-]+\/?$/iu.test(url.pathname);
    if (url.protocol === "https:" && allowedHost && publishedPath
      && !url.port && !url.username && !url.password && !url.search && !url.hash) {
      return url;
    }
  } catch {
    // Keep submitted URLs out of error messages, as the path contains the share token.
  }
  throw new Error("appleCalendarLinkInvalid");
}

function dayNumber(year, month, day) {
  return Date.UTC(year, month - 1, day) / dayMs;
}

function dayString(day) {
  return new Date(day * dayMs).toISOString().slice(0, 10);
}

function clockString(hour, minute) {
  return [hour, minute].map((value) => String(value).padStart(2, "0")).join(":");
}

function calendarTime(time) {
  if (time.isDate || time.zone === ICAL.Timezone.localTimezone) {
    return {
      day: dayNumber(time.year, time.month, time.day),
      clock: time.isDate ? "" : clockString(time.hour, time.minute)
    };
  }
  const date = time.toJSDate();
  return {
    day: dayNumber(date.getFullYear(), date.getMonth() + 1, date.getDate()),
    clock: clockString(date.getHours(), date.getMinutes())
  };
}

function appendOccurrence(events, occurrence, eventId, rangeStart, rangeEnd) {
  const { item, startDate, endDate } = occurrence;
  if (!startDate || !endDate || item.component.getFirstPropertyValue("status") === "CANCELLED") return;
  const start = calendarTime(startDate);
  const end = calendarTime(endDate);
  // All-day end dates and timed midnight ends are exclusive.
  const lastDay = Math.max(start.day, end.day - Number(!end.clock || end.clock === "00:00"));
  const title = item.summary?.trim().slice(0, 200) || "";
  const location = item.location?.slice(0, 300) || "";
  const notes = item.description?.slice(0, 1200) || "";

  for (let day = Math.max(start.day, rangeStart); day <= Math.min(lastDay, rangeEnd); day += 1) {
    if (events.length >= maxEvents) return;
    const date = dayString(day);
    events.push({
      id: `apple:${eventId}:${date}`,
      date,
      title,
      start: day === start.day ? start.clock : "",
      end: day === end.day ? end.clock : "",
      location,
      notes,
      readOnly: true,
      provider: "apple"
    });
  }
}

function feedEvents(text) {
  const calendar = new ICAL.Component(ICAL.parse(text));
  if (calendar.name !== "vcalendar") throw new Error("syncFailed");

  const today = new Date();
  const todayNumber = dayNumber(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const rangeStart = todayNumber - 90;
  const rangeEnd = todayNumber + 366;

  const entries = calendar.getAllSubcomponents("vevent");
  const exceptions = new Map();
  const mainUids = new Set();
  for (const entry of entries) {
    const uid = entry.getFirstPropertyValue("uid");
    if (entry.hasProperty("recurrence-id")) {
      if (!exceptions.has(uid)) exceptions.set(uid, []);
      exceptions.get(uid).push(entry);
    } else {
      mainUids.add(uid);
    }
  }

  let remainingOccurrences = maxOccurrences;
  const events = [];
  for (const [index, entry] of entries.entries()) {
    const uid = entry.getFirstPropertyValue("uid");
    if (entry.hasProperty("recurrence-id") && mainUids.has(uid)) continue;
    if (!entry.hasProperty("dtstart")) continue;
    if (entry.getFirstPropertyValue("status") === "CANCELLED") continue;
    const related = entry.hasProperty("recurrence-id") ? [] : exceptions.get(uid) ?? [];
    const item = new ICAL.Event(entry, { exceptions: related });
    const id = String(uid ?? index).slice(0, 400);
    if (!item.isRecurring()) {
      appendOccurrence(events, { item, startDate: item.startDate, endDate: item.endDate }, id, rangeStart, rangeEnd);
      continue;
    }

    const iterator = item.iterator();
    for (let next = iterator.next(); next && remainingOccurrences > 0; next = iterator.next()) {
      remainingOccurrences -= 1;
      if (calendarTime(next).day > rangeEnd || events.length >= maxEvents) break;
      const exception = item.exceptions[next.toString()]
        ?? item.exceptions[next.convertToZone(ICAL.Timezone.utcTimezone).toString()];
      if (exception?.component.getFirstPropertyValue("status") === "CANCELLED") continue;
      const occurrence = item.getOccurrenceDetails(next);
      appendOccurrence(events, occurrence, `${id}:${next.toString()}`, rangeStart, rangeEnd);
    }
    if (remainingOccurrences === 0) throw new Error("syncFailed");
  }

  return events.sort((first, second) => first.date.localeCompare(second.date)
    || first.start.localeCompare(second.start) || first.title.localeCompare(second.title));
}

async function downloadCalendar(url) {
  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok || !response.body) throw new Error("Calendar fetch failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxFeedBytes) {
          await reader.cancel();
          throw new Error("Calendar is too large");
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    return feedEvents(text + decoder.decode());
  } catch {
    throw new Error("syncFailed");
  }
}

async function readCalendar() {
  return (await chrome.storage.local.get(storageKey))[storageKey];
}

function publicState(record) {
  return {
    connected: Boolean(record?.url),
    lastSynced: record?.lastSynced ?? null,
    events: record?.events ?? []
  };
}

export async function getAppleCalendarState() {
  return publicState(await readCalendar());
}

export async function connectAppleCalendar(input) {
  const url = publishedCalendarUrl(input);
  const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
  if (!granted) throw new Error("appleCalendarPermissionDenied");
  const events = await downloadCalendar(url);
  const record = {
    id: crypto.randomUUID(),
    url: url.href,
    lastSynced: Date.now(),
    events
  };
  await navigator.locks.request(storageKey, () => chrome.storage.local.set({ [storageKey]: record }));
  return publicState(record);
}

export async function syncAppleCalendar() {
  const record = await readCalendar();
  if (!record) return publicState();
  const events = await downloadCalendar(publishedCalendarUrl(record.url));
  return navigator.locks.request(storageKey, async () => {
    const current = await readCalendar();
    // Discard the finished request if the user disconnected or changed links during the fetch.
    if (current?.id !== record.id) return publicState(current);
    const updated = { ...current, events, lastSynced: Date.now() };
    await chrome.storage.local.set({ [storageKey]: updated });
    return publicState(updated);
  });
}

export async function disconnectAppleCalendar() {
  await navigator.locks.request(storageKey, () => chrome.storage.local.remove(storageKey));
  return publicState();
}
