import { translate } from "./locales.js";
import { defaultTodo, localTaskDay, taskAction, taskLink, taskReminderSchedule, taskTimestamp, taskToday } from "./todo-store.js";
import { readWorkspace, storageKey } from "./workspace-data.js";

export const quickTaskKey = "easeQuickTask";
const menuId = "ease-add-task";
const shortcutId = "quick-task";
const reminderAlarm = "ease-todo-reminders";
const clockAlarm = "ease-todo-clock";
const logKey = "easeTodoDelivered";
const notificationId = "ease-todo-notification";
const permission = { permissions: ["notifications"] };
const grace = 2 * 60_000;

async function notify(workspace, due) {
  const count = new Intl.NumberFormat(workspace.locale).format(due.length);
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: translate(workspace.locale, "todo"),
    message: due.length === 1 ? due[0].title : translate(workspace.locale, "todoReminderCount", { count })
  });
}

async function reconcile(fired) {
  const [workspace, alarm, clock, allowed] = await Promise.all([
    readWorkspace(), chrome.alarms.get(reminderAlarm), chrome.alarms.get(clockAlarm), chrome.permissions.contains(permission)
  ]);
  const { items, dailyTime } = workspace.todo ?? defaultTodo;
  const entries = items.filter(task => !task.done).flatMap(task => {
    const schedule = taskReminderSchedule(task);
    return schedule ? [{ key: task.id, ...schedule, tasks: [task] }] : [];
  });
  if (!allowed || !chrome.notifications?.create || !workspace.tabs.includes("todo")
    || (!dailyTime && !entries.length)
    || (chrome.notifications.getPermissionLevel && await chrome.notifications.getPermissionLevel() !== "granted")) {
    if (alarm) await chrome.alarms.clear(reminderAlarm);
    if (clock) await chrome.alarms.clear(clockAlarm);
    return;
  }

  if (!clock) await chrome.alarms.create(clockAlarm, { periodInMinutes: 5 });
  const now = Date.now();
  const today = localTaskDay();
  if (dailyTime) {
    for (const offset of [0, 1, 2]) {
      const date = localTaskDay(offset);
      const when = taskTimestamp(date, dailyTime);
      if (when !== null) {
        entries.push({ key: "daily", signature: date, when, tasks: !offset ? items.filter(task => !task.done && taskToday(task, today)) : [] });
      }
    }
  }
  const { [logKey]: previous = {} } = await chrome.storage.local.get(logKey);
  const history = Object.fromEntries(entries.filter(entry => previous[entry.key] === entry.signature)
    .map(entry => [entry.key, entry.signature]));
  const pending = entries.filter(entry => entry.signature !== history[entry.key]);
  const due = fired && now >= fired.scheduledTime && now - fired.scheduledTime <= grace
    ? pending.filter(entry => entry.when >= fired.scheduledTime && entry.when <= now) : [];
  for (const entry of due) history[entry.key] = entry.signature;
  if (due.length || Object.keys(previous).length !== Object.keys(history).length) {
    await chrome.storage.local.set({ [logKey]: history });
  }
  const tasks = [...new Map(due.flatMap(entry => entry.tasks).map(task => [task.id, task])).values()];
  if (tasks.length) await notify(workspace, tasks).catch(() => {});
  const next = Math.min(...pending
    .filter(entry => history[entry.key] !== entry.signature
      && (entry.when > now || (!fired && entry.when === alarm?.scheduledTime && now - entry.when <= grace)))
    .map(entry => entry.when));
  if (Number.isFinite(next) && alarm?.scheduledTime !== next) await chrome.alarms.create(reminderAlarm, { when: next });
  if (!Number.isFinite(next) && alarm) await chrome.alarms.clear(reminderAlarm);
}

export async function takeQuickTask() {
  try {
    const { id } = await chrome.windows.getCurrent();
    const key = quickTaskKey + id;
    const found = (await chrome.storage.session.get(key))[key];
    if (!found) return false;
    await chrome.storage.session.remove(key);
    return found > Date.now();
  } catch {
    return false;
  }
}

export function registerTodoHandlers(queueWorkspace) {
  let pendingReminder = Promise.resolve();
  let pendingMenu = Promise.resolve();
  const sync = (alarm) => {
    if (!chrome.alarms?.get) return;
    pendingReminder = pendingReminder.then(() => reconcile(alarm)).catch(() => {});
    return pendingReminder;
  };
  const updateMenu = () => {
    if (!chrome.contextMenus?.update) return;
    pendingMenu = pendingMenu.then(async () => {
      const { tabs, locale } = await readWorkspace();
      const menu = {
        title: translate(locale, "todoSelection"), contexts: ["selection"],
        documentUrlPatterns: ["https://*/*", "http://*/*"], visible: tabs.includes("todo")
      };
      await new Promise(resolve => chrome.contextMenus.update(menuId, menu, () => {
        if (!chrome.runtime.lastError) resolve();
        else chrome.contextMenus.create({ id: menuId, ...menu }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      }));
    }).catch(() => {});
  };

  const initialize = () => { updateMenu(); sync(); };
  chrome.runtime.onInstalled?.addListener(initialize);
  chrome.runtime.onStartup?.addListener(initialize);
  chrome.storage.onChanged.addListener(({ [storageKey]: change }, area) => {
    if (area !== "local" || !change) return;
    const before = change.oldValue;
    const after = change.newValue;
    const visibilityChanged = before?.tabs?.includes("todo") !== after?.tabs?.includes("todo");
    if (visibilityChanged || before?.locale !== after?.locale) updateMenu();
    if (visibilityChanged || JSON.stringify(before?.todo) !== JSON.stringify(after?.todo)) sync();
  });
  chrome.alarms?.onAlarm?.addListener(alarm => {
    if (alarm.name === reminderAlarm || alarm.name === clockAlarm) return sync(alarm.name === reminderAlarm ? alarm : undefined);
  });
  const permissionChanged = ({ permissions }) => {
    if (permissions?.includes("notifications")) sync();
  };
  chrome.permissions?.onAdded?.addListener(permissionChanged);
  chrome.permissions?.onRemoved?.addListener(permissionChanged);
  chrome.notifications?.onPermissionLevelChanged?.addListener(() => sync());
  chrome.notifications?.onClicked?.addListener(id => {
    if (id === notificationId) chrome.tabs.create({ url: chrome.runtime.getURL("workspace.html?surface=panel&open=todo") }).catch(() => {});
  });
  chrome.contextMenus?.onClicked?.addListener(info => {
    if (info.menuItemId !== menuId || info.editable || !info.selectionText?.trim()) return;
    queueWorkspace(async () => {
      const workspace = structuredClone(await readWorkspace());
      if (!workspace.tabs.includes("todo")) return;
      const url = taskLink(info.frameUrl || info.pageUrl);
      const error = taskAction(workspace, "save-task", {
        title: info.selectionText, source: url ? { kind: "web", url } : null
      });
      if (!error) await chrome.storage.local.set({ [storageKey]: workspace });
    }).catch(() => {});
  });
  chrome.commands?.onCommand?.addListener((command, tab) => {
    if (command !== shortcutId) return;
    (async () => {
      const windowId = tab?.windowId ?? (await chrome.windows.getCurrent()).id;
      if (!Number.isInteger(windowId) || windowId < 0) return;
      const key = quickTaskKey + windowId;
      await chrome.storage.session.set({ [key]: Date.now() + 30_000 });
      try {
        await chrome.action.openPopup({ windowId });
      } catch {
        await chrome.storage.session.remove(key);
        await chrome.tabs.create({ windowId, url: chrome.runtime.getURL("workspace.html?surface=panel&quickTask=1") });
      }
    })().catch(() => {});
  });
  sync();
}
