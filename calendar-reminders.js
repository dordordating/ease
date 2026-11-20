import { calendarReminderSchedule } from "./calendar-store.js";
import { translate } from "./locales.js";
import { readWorkspace, storageKey } from "./workspace-data.js";

const reminderPrefix = "ease-calendar-reminder:";
const reconcileAlarm = "ease-calendar-reminder-reconcile";
const deliveryKey = "easeCalendarReminderDeliveries";
const lateGrace = 2 * 60_000;
const timezoneWindow = 2 * 86_400_000;
const permission = { permissions: ["notifications"] };

function reminderTime(name) {
  if (!name.startsWith(reminderPrefix)) return null;
  const when = Number(name.slice(reminderPrefix.length));
  return Number.isSafeInteger(when) && when > 0 ? when : null;
}

async function canNotify() {
  if (typeof chrome.notifications?.create !== "function") return false;
  if (chrome.permissions?.contains && !await chrome.permissions.contains(permission)) return false;
  return !chrome.notifications.getPermissionLevel || await chrome.notifications.getPermissionLevel() === "granted";
}

function scheduledReminders(events) {
  return events.flatMap(event => {
    const schedule = calendarReminderSchedule(event);
    if (!schedule || typeof event.id !== "string" || typeof event.title !== "string" || !event.title) return [];
    const signature = `${event.date}T${event.start}/${event.reminderMinutes}`;
    return [{ ...schedule, event, signature }];
  }).sort((first, second) => first.reminderAt - second.reminderAt);
}

async function reconcile(firedAt) {
  const [{ events, locale }, alarms, enabled] = await Promise.all([
    readWorkspace(), chrome.alarms.getAll(), canNotify()
  ]);
  const reminderAlarms = alarms.filter(({ name }) => reminderTime(name) !== null);
  const periodic = alarms.some(({ name }) => name === reconcileAlarm);
  if (!enabled) {
    const names = reminderAlarms.map(({ name }) => name);
    if (periodic) names.push(reconcileAlarm);
    await Promise.all(names.map(name => chrome.alarms.clear(name)));
    return;
  }

  const now = Date.now();
  const rows = scheduledReminders(events);
  const old = (await chrome.storage.local.get(deliveryKey))[deliveryKey] ?? {};
  const deliveries = new Map();
  const pending = rows.filter(row => {
    if (Object.hasOwn(old, row.event.id) && old[row.event.id] === row.signature) {
      deliveries.set(row.event.id, row.signature);
      return false;
    }
    return true;
  });
  // A scheduled alarm may run slightly late. A normal reconcile never plays past alerts.
  const due = firedAt !== null && firedAt <= now && now - firedAt <= lateGrace
    ? pending.filter(({ reminderAt }) => reminderAt >= firedAt && reminderAt <= now)
    : [];
  for (const { event, signature } of due) deliveries.set(event.id, signature);
  if (due.length || Object.keys(old).length !== deliveries.size) {
    // Write first so a restart or concurrent trigger cannot display the same reminder again.
    await chrome.storage.local.set({ [deliveryKey]: Object.fromEntries(deliveries) });
  }
  if (due.length) {
    const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
    await Promise.allSettled(due.map(({ event, startAt }) => chrome.notifications.create(
      `ease-calendar-${event.id}`,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/128.png"),
        title: event.title,
        message: translate(locale, "calendarReminderNotify", { time: time.format(startAt) })
      }
    )));
  }

  const remaining = pending.filter(({ event }) => !deliveries.has(event.id));
  const pendingTimes = new Set(reminderAlarms.map(({ name }) => reminderTime(name)));
  const next = remaining.find(({ reminderAt }) => reminderAt > now || (
    reminderAt !== firedAt && pendingTimes.has(reminderAt) && now - reminderAt <= lateGrace
  ));
  const nextName = next ? `${reminderPrefix}${next.reminderAt}` : undefined;
  await Promise.all(reminderAlarms.filter(({ name }) => name !== nextName).map(({ name }) => chrome.alarms.clear(name)));
  if (nextName && !pendingTimes.has(next.reminderAt)) {
    await chrome.alarms.create(nextName, { when: next.reminderAt });
  }

  // Re-read local time periodically for time-zone changes while Chrome stays open.
  const needsReconcile = remaining.some(({ reminderAt }) => reminderAt >= now - timezoneWindow);
  if (needsReconcile && !periodic) await chrome.alarms.create(reconcileAlarm, { periodInMinutes: 5 });
  else if (!needsReconcile && periodic) await chrome.alarms.clear(reconcileAlarm);
}

export function registerCalendarReminderHandlers() {
  if (!chrome.alarms?.getAll || !chrome.alarms?.onAlarm) return;
  let queue = Promise.resolve();
  const sync = (firedAt = null) => {
    queue = queue.then(() => reconcile(firedAt)).catch(() => {});
    return queue;
  };

  chrome.alarms.onAlarm.addListener(({ name }) => {
    const when = reminderTime(name);
    if (name === reconcileAlarm || when !== null) return sync(when);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, storageKey)) return sync();
  });
  chrome.runtime.onInstalled?.addListener(() => sync());
  chrome.runtime.onStartup?.addListener(() => sync());
  const syncPermission = ({ permissions }) => {
    if (permissions?.includes("notifications")) return sync();
  };
  chrome.permissions?.onAdded?.addListener(syncPermission);
  chrome.permissions?.onRemoved?.addListener(syncPermission);
  chrome.notifications?.onPermissionLevelChanged?.addListener(() => sync());
  return sync();
}
