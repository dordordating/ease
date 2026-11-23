import {
  authorizeMailbox, composeMail, deliverMail, downloadMailAttachment, imapAccount, imapMessages, mailCapabilities, mailConfig, mailDomains,
  mailPermission, mailboxMessages, mailboxProfile, mailProviders, MailError, readMailMessage, refreshMailToken, senderDomain, trashMailMessage
} from "./mail-api.js";
import { readWorkspace } from "./workspace-data.js";
import { translate } from "./locales.js";

export const mailMessage = "ease-mail";
export const mailUpdateKey = "easeMailUpdate";
const alarmName = "ease-mail-refresh";
const store = "accounts";
const maxAccounts = 6;
const staleAfter = 5 * 60_000;
const alertPrefix = "ease-mail-alert:";
const notificationPermission = { permissions: ["notifications"] };
let database;
let pendingWrite = Promise.resolve();
let refreshing;
let connecting;
let listeningForAlerts = false;

function mailDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("ease-mail", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store, { keyPath: "id" });
    request.onsuccess = () => {
      const opened = request.result;
      opened.onversionchange = () => { opened.close(); database = undefined; };
      resolve(opened);
    };
    request.onerror = () => reject(request.error);
  }).catch(error => { database = undefined; throw error; });
  return database;
}

async function access(mode, operation) {
  const opened = await mailDatabase();
  return new Promise((resolve, reject) => {
    const transaction = opened.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

const accounts = () => access("readonly", target => target.getAll());
const save = (account) => access("readwrite", target => target.put(account));
const remove = (id) => access("readwrite", target => target.delete(id));
const find = (id) => access("readonly", target => target.get(id));

function queue(operation) {
  const applied = pendingWrite.then(operation);
  pendingWrite = applied.catch(() => {});
  return applied;
}

function changed() {
  // The workspace reloads its view without putting either tokens or headers into chrome.storage.
  return chrome.storage.session.set({ [mailUpdateKey]: crypto.randomUUID() }).catch(() => {});
}

function mergeMessages(current = [], older = []) {
  const ids = new Set(current.map(message => message.id));
  return [...current, ...older.filter(message => !ids.has(message.id))];
}

async function snapshot() {
  const saved = await accounts();
  return saved.map(record => {
    const { id, provider, email, preset, connection, smtp, messages = [], unread = 0, updatedAt = null, issue = null, notifications,
      sentMessages = [], sentIssue = null } = record;
    const account = { id, provider, email, messages: mergeMessages(messages, record.inboxOlder), unread, updatedAt, issue,
      sentMessages: mergeMessages(sentMessages, record.sentOlder), sentIssue,
      hasMore: { inbox: Boolean(record.inboxCursor), sent: Boolean(record.sentCursor) },
      capabilities: mailCapabilities(record), notifications: { mode: notifications?.mode ?? "off", domains: notifications?.domains ?? [] } };
    if (provider === "imap") {
      const { host, security, username } = connection;
      account.imap = { preset, host, security, username };
      if (smtp) account.imap.smtp = { host: smtp.host, security: smtp.security, username: smtp.username };
    }
    return account;
  });
}

async function maintainAlarm() {
  if ((await accounts()).length) await chrome.alarms.create(alarmName, { periodInMinutes: 5 });
  else await chrome.alarms.clear(alarmName);
}

async function renew(account) {
  const token = await refreshMailToken(account.provider, account.refreshToken);
  const updated = { ...account, ...token };
  await save(updated); // Persist rotated refresh tokens before using the new access token.
  return updated;
}

function mailAlert(account, messages, now) {
  const config = account.notifications;
  if (!config || config.mode === "off") return { count: 0 };
  const seen = new Set(config.seen);
  const fresh = messages.filter(message => message.received >= config.since && message.received <= now + 60_000
    && !seen.has(message.id) && message.unread);
  const count = fresh.filter(message => config.mode === "all" || config.domains.includes(senderDomain(message))).length;
  const next = { ...config, since: Math.max(config.since, now - 5 * 60_000),
    seen: [...new Set([...messages.map(message => message.id), ...(config.seen ?? [])])].slice(0, 128) };
  return { count, notifications: next };
}

async function notifyNewMail(count) {
  if (!count || !chrome.notifications || !await chrome.permissions.contains(notificationPermission)) return;
  registerAlertClicks();
  const { locale } = await readWorkspace();
  await chrome.notifications.create(alertPrefix + crypto.randomUUID(), {
    type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"), title: translate(locale, "mail"),
    message: translate(locale, "mailAlertNew", { count: new Intl.NumberFormat(locale).format(count) })
  });
}

function registerAlertClicks() {
  if (listeningForAlerts || !chrome.notifications?.onClicked) return;
  listeningForAlerts = true;
  chrome.notifications.onClicked.addListener(id => {
    if (id.startsWith(alertPrefix)) chrome.tabs.create({ url: chrome.runtime.getURL("workspace.html?surface=panel&open=mail") }).catch(() => {});
  });
}

async function refreshAccount(record, force) {
  let account = record;
  try {
    let inbox;
    if (account.provider === "imap") inbox = await imapMessages(account.connection);
    else {
      if (!await chrome.permissions.contains(mailPermission(account.provider))) throw new MailError("mailPermission");
      if (account.expiresAt - Date.now() < 60_000) account = await renew(account);
      try {
        inbox = await mailboxMessages(account, account.accessToken);
      } catch (error) {
        if (error.status !== 401) throw error;
        account = await renew(account);
        inbox = await mailboxMessages(account, account.accessToken);
      }
    }
    const now = Date.now();
    const { next, ...listing } = inbox;
    const older = force ? [] : account.inboxOlder ?? [];
    const { notifications, count } = mailAlert(account, listing.messages, now);
    await save({ ...account, ...listing, inboxOlder: older, inboxCursor: older.length ? account.inboxCursor : next ?? null,
      ...(notifications ? { notifications } : {}), issue: null, updatedAt: now });
    await notifyNewMail(count).catch(() => {});
  } catch (error) {
    const issue = ["mailPermission", "mailReconnect", "mailImapBusy", "mailImapUnavailable"].includes(error?.code)
      ? error.code : "mailUnavailable";
    await save({ ...account, issue });
  }
}

function refreshInbox(force = false) {
  if (refreshing) return refreshing;
  refreshing = queue(async () => {
    const now = Date.now();
    const ready = (await accounts()).filter(account => (account.provider !== "imap" || account.issue !== "mailReconnect")
      && (force || account.inboxCursor === undefined || now - (account.updatedAt ?? 0) >= staleAfter));
    // Limit providers and partial failures to small batches, retaining other accounts' snapshots.
    for (let start = 0; start < ready.length; start += 3) {
      await Promise.all(ready.slice(start, start + 3).map(account => refreshAccount(account, force)));
    }
    if (ready.length) await changed();
    return snapshot();
  }).finally(() => { refreshing = undefined; });
  return refreshing;
}

function saveLinked(account, replaceId) {
  return queue(async () => {
    const linked = await accounts();
    const previous = linked.find(item => item.id === account.id);
    const replacing = linked.find(item => item.id === replaceId && item.provider === "imap");
    if (replaceId && !replacing) throw new MailError("mailReconnect");
    if (!previous && !replacing && linked.length >= maxAccounts) throw new MailError("mailAccountLimit");
    await access("readwrite", (target) => {
      if (replacing && replacing.id !== account.id) target.delete(replacing.id);
      const notifications = previous?.notifications ?? replacing?.notifications;
      const updated = { ...previous, ...account, issue: null };
      if (notifications && account.provider === "imap") updated.notifications = {
        ...notifications, since: Date.now(), seen: account.messages.map(message => message.id)
      };
      return target.put(updated);
    });
    await maintainAlarm();
    await changed();
  });
}

async function connectImap(data, replaceId) {
  const account = imapAccount(data);
  if (replaceId && account.smtp && !data.smtpPassword) {
    const previous = await find(replaceId);
    const saved = previous?.smtp;
    if (saved && saved.password !== previous.connection.password
      && saved.host === account.smtp.host && saved.username === account.smtp.username) {
      account.smtp.password = saved.password;
    }
  }
  const { host, username, security } = account.connection;
  const key = new TextEncoder().encode(JSON.stringify([host, username, security]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", key));
  account.id = "imap:" + Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
  const { next, ...inbox } = await imapMessages(account.connection);
  await saveLinked({ ...account, ...inbox, inboxOlder: [], inboxCursor: next ?? null, updatedAt: Date.now(), sentAt: null }, replaceId);
  return snapshot();
}

async function connect(provider, permission, expectedId, send = false, mark = false) {
  if (!await permission) throw new MailError("mailPermission");
  if (!(await mailConfig())[provider]) throw new MailError("mailNotConfigured");
  const credentials = await authorizeMailbox(provider, send, mark);
  const identity = await mailboxProfile(provider, credentials.accessToken);
  const id = provider + ":" + identity.externalId;
  if (expectedId && id !== expectedId) throw new MailError("mailWrongAccount");
  await saveLinked({ id, provider, email: identity.email, ...credentials, updatedAt: null, sentAt: null });
  // This check is queued after the previous batch if an inbox refresh was already running.
  if (refreshing) await refreshing.catch(() => {});
  return refreshInbox();
}

async function readyAccount(record) {
  if (record.provider === "imap") return record;
  if (!await chrome.permissions.contains(mailPermission(record.provider))) throw new MailError("mailPermission");
  return record.expiresAt - Date.now() < 60_000 ? renew(record) : record;
}

async function sentInbox(id, force) {
  const now = Date.now();
  const selected = (await accounts()).filter(item => (!id || item.id === id)
    && (force || item.sentCursor === undefined || now - (item.sentAt ?? 0) >= staleAfter));
  for (let index = 0; index < selected.length; index += 3) {
    await Promise.all(selected.slice(index, index + 3).map(async record => {
      let account = record;
      try {
        account = await readyAccount(record);
        const result = account.provider === "imap" ? await imapMessages(account.connection, "sent")
          : await mailboxMessages(account, account.accessToken, "sent");
        const older = force ? [] : account.sentOlder ?? [];
        await save({ ...account, sentMessages: result.messages, sentOlder: older, sentCursor: older.length ? account.sentCursor : result.next ?? null,
          sentAt: Date.now(), sentIssue: result.available === false ? "mailSentUnavailable" : null });
      } catch {
        await save({ ...account, sentIssue: "mailSentUnavailable" });
      }
    }));
  }
  if (selected.length) await changed();
  return snapshot();
}

async function loadMore(id, folder) {
  const cursorKey = folder === "sent" ? "sentCursor" : "inboxCursor";
  const olderKey = folder === "sent" ? "sentOlder" : "inboxOlder";
  const selected = (await accounts()).filter(account => (!id || id === account.id) && account[cursorKey]);
  let error;
  for (let index = 0; index < selected.length; index += 3) {
    await Promise.all(selected.slice(index, index + 3).map(async record => {
      try {
        const account = await readyAccount(record);
        const cursor = account[cursorKey];
        const result = account.provider === "imap" ? await imapMessages(account.connection, folder, cursor)
          : await mailboxMessages(account, account.accessToken, folder, cursor);
        const next = JSON.stringify(result.next) === JSON.stringify(cursor) ? null : result.next ?? null;
        await save({ ...account, [olderKey]: mergeMessages(account[olderKey], result.messages), [cursorKey]: next });
      } catch (issue) {
        error = issue;
      }
    }));
  }
  if (selected.length) await changed();
  if (error) throw error;
  return snapshot();
}

async function accountAction(id, action, data, folder) {
  const record = await find(id);
  if (!record) throw new MailError("mailReconnect");
  if (action === "send" && !mailCapabilities(record).send) {
    throw new MailError(record.provider === "imap" ? "mailSmtpSetup" : "mailSendPermission");
  }
  if (action === "message" && !mailCapabilities(record).read) throw new MailError("mailReadPermission");
  const account = await readyAccount(record);
  if (action === "send") {
    const result = await deliverMail(account, composeMail(data), account.accessToken);
    // A local storage error must not induce another email submission.
    await save({ ...account, sentAt: null }).catch(() => {});
    return result;
  }
  const key = folder === "sent" ? "sentMessages" : "messages";
  const older = folder === "sent" ? "sentOlder" : "inboxOlder";
  const messageId = action === "attachment" ? data?.id : data;
  const message = mergeMessages(account[key], account[older]).find(item => item.id === messageId);
  if (!message) throw new MailError("mailReadFailed");
  if (action === "attachment") return downloadMailAttachment(account, message, data.attachment, account.accessToken, folder);
  if (action === "trash") {
    await trashMailMessage(account, message, account.accessToken, folder);
    await save({ ...account, [key]: (account[key] ?? []).filter(item => item.id !== messageId),
      [older]: (account[older] ?? []).filter(item => item.id !== messageId),
      ...(folder === "inbox" && message.unread ? { unread: Math.max(0, (account.unread ?? 0) - 1) } : {}) }).then(changed).catch(() => {});
    return snapshot();
  }
  const result = await readMailMessage(account, message, account.accessToken, folder);
  if (folder === "inbox" && message.unread && result.marked) {
    const seen = item => item.id === messageId ? { ...item, unread: false } : item;
    await save({ ...account, messages: (account.messages ?? []).map(seen), inboxOlder: (account.inboxOlder ?? []).map(seen),
      unread: Math.max(0, (account.unread ?? 0) - 1) }).then(changed).catch(() => {});
  }
  return result;
}

async function updateNotifications(id, mode, domainText, allowed) {
  if (!["off", "all", "domains"].includes(mode)) throw new MailError("mailUnavailable");
  const domains = mode === "domains" ? mailDomains(domainText) : [];
  if (mode !== "off" && !await allowed) throw new MailError("mailAlertPermission");
  return queue(async () => {
    const account = await find(id);
    if (!account) throw new MailError("mailReconnect");
    const notifications = { mode, domains, since: Date.now(), seen: (account.messages ?? []).map(message => message.id) };
    await save({ ...account, notifications });
    await changed();
    return snapshot();
  });
}

function fromWorkspace(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  const url = chrome.runtime.getURL("workspace.html");
  return sender.url === url || sender.url?.startsWith(url + "?");
}

export function registerMailHandlers() {
  const initialize = () => maintainAlarm().catch(() => {});
  chrome.runtime.onInstalled?.addListener(initialize);
  chrome.runtime.onStartup?.addListener(initialize);
  registerAlertClicks();
  chrome.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name === alarmName) {
      readWorkspace().then(workspace => workspace.tabs.includes("mail") && refreshInbox()).catch(() => {});
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== mailMessage || !fromWorkspace(sender)) return;
    let result;
    if (message.action === "read") result = snapshot();
    else if (message.action === "config") result = mailConfig();
    else if (message.action === "refresh") result = refreshInbox(message.force === true);
    else if (message.action === "sent" && typeof message.id === "string" && message.id.length <= 540) {
      result = queue(() => sentInbox(message.id, message.force === true));
    } else if (message.action === "older" && typeof message.id === "string" && message.id.length <= 540) {
      result = queue(() => loadMore(message.id, message.folder === "sent" ? "sent" : "inbox"));
    }
    else if (["connect", "upgrade"].includes(message.action) && Object.hasOwn(mailProviders, message.provider)) {
      if (connecting) {
        respond({ ok: false, error: "mailConnecting" });
        return;
      }
      // Keep the click's gesture in the popup or the worker for the Chrome permission prompt.
      const permission = (message.requestPermission === true
        ? chrome.permissions.request(mailPermission(message.provider))
        : chrome.permissions.contains(mailPermission(message.provider))).catch(() => false);
      if (message.action === "upgrade" && typeof message.id !== "string") return;
      connecting = connect(message.provider, permission, message.action === "upgrade" ? message.id : undefined,
        message.action === "upgrade" && message.send === true, message.action === "upgrade" && message.mark === true)
        .finally(() => { connecting = undefined; });
      result = connecting;
    } else if (message.action === "connect-imap") {
      if (connecting) {
        respond({ ok: false, error: "mailConnecting" });
        return;
      }
      connecting = connectImap(message.data, message.replaceId).finally(() => { connecting = undefined; });
      result = connecting;
    } else if (message.action === "notifications" && typeof message.id === "string") {
      const allowed = message.mode === "off" || (message.requestPermission
        ? chrome.permissions.request(notificationPermission) : chrome.permissions.contains(notificationPermission)).catch(() => false);
      result = updateNotifications(message.id, message.mode, message.domains, allowed);
    } else if (["message", "send", "attachment", "trash"].includes(message.action) && typeof message.id === "string" && message.id.length <= 540) {
      result = queue(() => accountAction(message.id, message.action, message.data, message.folder === "sent" ? "sent" : "inbox"));
    } else if (message.action === "disconnect" && typeof message.id === "string" && message.id.length <= 540) {
      result = queue(async () => {
        await remove(message.id);
        await maintainAlarm();
        await changed();
        return snapshot();
      });
    } else return;
    result.then(value => respond({ ok: true, value }), (error) => {
      respond({ ok: false, error: error instanceof MailError ? error.code : "mailUnavailable" });
    });
    return true;
  });
}
