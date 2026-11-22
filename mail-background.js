import {
  authorizeMailbox, mailConfig, mailPermission, mailboxMessages, mailboxProfile, mailProviders, MailError, refreshMailToken
} from "./mail-api.js";
import { readWorkspace } from "./workspace-data.js";

export const mailMessage = "ease-mail";
export const mailUpdateKey = "easeMailUpdate";
const alarmName = "ease-mail-refresh";
const store = "accounts";
const maxAccounts = 6;
const staleAfter = 5 * 60_000;
let database;
let pendingWrite = Promise.resolve();
let refreshing;
let connecting;

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

function queue(operation) {
  const applied = pendingWrite.then(operation);
  pendingWrite = applied.catch(() => {});
  return applied;
}

function changed() {
  // The workspace reloads its view without putting either tokens or headers into chrome.storage.
  return chrome.storage.session.set({ [mailUpdateKey]: crypto.randomUUID() }).catch(() => {});
}

async function snapshot() {
  const saved = await accounts();
  return saved.map(({ id, provider, email, messages = [], unread = 0, updatedAt = null, issue = null }) => (
    { id, provider, email, messages, unread, updatedAt, issue }
  ));
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

async function refreshAccount(record) {
  let account = record;
  try {
    if (!await chrome.permissions.contains(mailPermission(account.provider))) throw new MailError("mailPermission");
    if (account.expiresAt - Date.now() < 60_000) account = await renew(account);
    let inbox;
    try {
      inbox = await mailboxMessages(account, account.accessToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      account = await renew(account);
      inbox = await mailboxMessages(account, account.accessToken);
    }
    await save({ ...account, ...inbox, issue: null, updatedAt: Date.now() });
  } catch (error) {
    const issue = ["mailPermission", "mailReconnect"].includes(error?.code) ? error.code : "mailUnavailable";
    await save({ ...account, issue });
  }
}

function refreshInbox(force = false) {
  if (refreshing) return refreshing;
  refreshing = queue(async () => {
    const now = Date.now();
    const ready = (await accounts()).filter(account => force || now - (account.updatedAt ?? 0) >= staleAfter);
    // Limit providers and partial failures to small batches, retaining other accounts' snapshots.
    for (let start = 0; start < ready.length; start += 3) {
      await Promise.all(ready.slice(start, start + 3).map(refreshAccount));
    }
    if (ready.length) await changed();
    return snapshot();
  }).finally(() => { refreshing = undefined; });
  return refreshing;
}

async function connect(provider, permission) {
  if (!await permission) throw new MailError("mailPermission");
  if (!(await mailConfig())[provider]) throw new MailError("mailNotConfigured");
  const credentials = await authorizeMailbox(provider);
  const identity = await mailboxProfile(provider, credentials.accessToken);
  const id = provider + ":" + identity.externalId;
  await queue(async () => {
    const linked = await accounts();
    const previous = linked.find(account => account.id === id);
    if (!previous && linked.length >= maxAccounts) throw new MailError("mailAccountLimit");
    await save({ ...previous, id, provider, email: identity.email, ...credentials, issue: null, updatedAt: null });
    await maintainAlarm();
    await changed();
  });
  // This check is queued after the previous batch if an inbox refresh was already running.
  if (refreshing) await refreshing.catch(() => {});
  return refreshInbox();
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
    else if (message.action === "connect" && Object.hasOwn(mailProviders, message.provider)) {
      if (connecting) {
        respond({ ok: false, error: "mailConnecting" });
        return;
      }
      // Keep the click's gesture in the popup or the worker for the Chrome permission prompt.
      const permission = (message.requestPermission === true
        ? chrome.permissions.request(mailPermission(message.provider))
        : chrome.permissions.contains(mailPermission(message.provider))).catch(() => false);
      connecting = connect(message.provider, permission).finally(() => { connecting = undefined; });
      result = connecting;
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
