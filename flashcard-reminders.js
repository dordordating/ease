import { flashcardLocalDay, flashcardQueue, flashcardReminderPreferences } from "./flashcard-store.js";
import { translate } from "./locales.js";
import { readWorkspace, storageKey } from "./workspace-data.js";

const alarmName = "ease-flashcards-review";
const notificationId = "ease-flashcards-daily";
const deliveredKey = "easeFlashcardsLastReminderDay";
const notificationPermission = { permissions: ["notifications"] };
const alarmTimeTolerance = 60_000;

function dailyAlarmTime(timestamp, time, nextDay = false) {
  const date = new Date(timestamp);
  if (nextDay) date.setDate(date.getDate() + 1);
  const [hour, minute] = time.split(":").map(Number);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

async function canNotify() {
  if (typeof chrome.notifications?.create !== "function") return false;
  if (!await chrome.permissions.contains(notificationPermission)) return false;
  return !chrome.notifications.getPermissionLevel || await chrome.notifications.getPermissionLevel() === "granted";
}

async function notify(workspace, day, now) {
  const storage = chrome.storage.local;
  const { [deliveredKey]: delivered } = await storage.get(deliveredKey);
  if (day === delivered) return;
  const queue = flashcardQueue(workspace.flashcards, now);
  const ready = new Set(queue.items.slice(0, queue.dueCount).map(({ card }) => card.id));
  if (!ready.size) return;

  // Persist the daily marker before delivery so restarts cannot repeat the digest.
  await storage.set({ [deliveredKey]: day });
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: translate(workspace.locale, "flashcardsReminders"),
    message: translate(workspace.locale, ready.size === 1 ? "flashcardsReminderOne" : "flashcardsReminderMany", {
      count: new Intl.NumberFormat(workspace.locale).format(ready.size)
    })
  });
}

async function reconcile(fired) {
  const [workspace, alarm, permitted] = await Promise.all([
    readWorkspace(), chrome.alarms.get(alarmName), canNotify()
  ]);
  const reminder = flashcardReminderPreferences(workspace.flashcards);
  if (!reminder.enabled || !permitted || !workspace.tabs.includes("flashcards")) {
    if (alarm) await chrome.alarms.clear(alarmName);
    return;
  }

  const now = Date.now();
  const today = flashcardLocalDay(now);
  const scheduled = dailyAlarmTime(now, reminder.time);
  // An alarm from an earlier day or previous reminder time must not send today’s digest.
  const isCurrent = (time) => Number.isFinite(time) && time >= scheduled && time - scheduled < alarmTimeTolerance;
  if (fired && now >= scheduled && isCurrent(fired.scheduledTime) && flashcardLocalDay(fired.scheduledTime) === today) {
    await notify(workspace, today, now).catch(() => {});
  }

  // Preserve a just-due alarm when applying an unrelated runtime event before it can fire.
  if (!fired && alarm && isCurrent(alarm.scheduledTime) && flashcardLocalDay(alarm.scheduledTime) === today) return;
  const next = scheduled > now ? scheduled : dailyAlarmTime(now, reminder.time, true);
  if (alarm?.scheduledTime !== next) await chrome.alarms.create(alarmName, { when: next });
}

export function registerFlashcardReminderHandlers() {
  if (!chrome.alarms?.get || !chrome.alarms?.onAlarm) return;
  let queue = Promise.resolve();
  const sync = (alarm) => {
    queue = queue.then(() => reconcile(alarm)).catch(() => {});
    return queue;
  };

  chrome.runtime.onInstalled?.addListener(() => sync());
  chrome.runtime.onStartup?.addListener(() => sync());
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === alarmName) return sync(alarm);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[storageKey];
    if (area !== "local" || !change) return;
    const oldState = change.oldValue;
    const newState = change.newValue;
    const oldReminder = flashcardReminderPreferences(oldState?.flashcards);
    const newReminder = flashcardReminderPreferences(newState?.flashcards);
    if (oldReminder.enabled !== newReminder.enabled || oldReminder.time !== newReminder.time
      || oldState?.tabs?.includes("flashcards") !== newState?.tabs?.includes("flashcards")) return sync();
  });
  const permissionChanged = ({ permissions }) => {
    if (permissions?.includes("notifications")) return sync();
  };
  chrome.permissions?.onAdded?.addListener(permissionChanged);
  chrome.permissions?.onRemoved?.addListener(permissionChanged);
  chrome.notifications?.onPermissionLevelChanged?.addListener(() => sync());
  chrome.notifications?.onClicked?.addListener((id) => {
    if (id === notificationId) {
      chrome.tabs.create({ url: chrome.runtime.getURL("workspace.html?surface=panel&open=flashcards") }).catch(() => {});
    }
  });
  return sync();
}
