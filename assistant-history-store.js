import { assistantLimits } from "./home-store.js";
import { normalizeSearchText } from "./workspace-search.js";

const databaseName = "ease-assistant-history";
const records = "requests";
const texts = "content";
const preferences = "preferences";
const chronological = "byAccountTime";
const pageSize = 10;
const sourceKinds = ["selection", "page", "mail", "tab"];
const actionKinds = ["task", "event", "snippet", "reply", "flashcard"];
const categories = [...sourceKinds, ...actionKinds, "general", "market", "weather"];
const lookupKinds = ["market", "weather", "workflow"];
const feedbackValues = ["helpful", "unhelpful"];
const errorCodes = [
  "assistantBusy", "assistantLimit", "assistantUnavailable", "assistantInterrupted", "assistantInputError", "assistantSignIn"
];
const stores = [records, texts, preferences];
const listeners = new Set();
let opening;
let channel;

function database() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const requests = db.createObjectStore(records, { keyPath: ["accountId", "id"] });
      requests.createIndex(chronological, ["accountId", "createdAt", "id"]);
      db.createObjectStore(texts, { keyPath: ["accountId", "id"] });
      db.createObjectStore(preferences, { keyPath: "accountId" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = db.onclose = () => {
        db.close();
        opening = undefined;
      };
      resolve(db);
    };
  }).catch(error => {
    opening = undefined;
    throw error;
  });
  return opening;
}

function resultOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(names, mode, work) {
  const db = await database();
  const tx = db.transaction(names, mode);
  const completion = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error("Assistant history transaction aborted"));
  });
  completion.catch(() => {});
  try {
    const value = await work(tx);
    await completion;
    return value;
  } catch (error) {
    try { tx.abort(); } catch { /* The browser may have already rolled back the transaction. */ }
    await completion.catch(() => {});
    throw error;
  }
}

function accountRange(accountId) {
  return IDBKeyRange.bound([accountId], [accountId, []]);
}

function readInOrder(index, range, offset, visit) {
  return new Promise((resolve, reject) => {
    const request = index.openCursor(range, "prev");
    request.onerror = () => reject(request.error);
    request.onsuccess = async () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      try {
        if (offset) {
          cursor.advance(offset);
          offset = 0;
        } else if (await visit(cursor.value)) cursor.continue();
        else resolve();
      } catch (error) {
        reject(error);
      }
    };
  });
}

function broadcasting() {
  if (!channel) {
    channel = new BroadcastChannel(databaseName);
    channel.onmessage = ({ data }) => { for (const listener of listeners) listener(data); };
  }
  return channel;
}

function announce(accountId, change, id) {
  const event = { accountId, change, id };
  for (const listener of listeners) listener(event);
  broadcasting().postMessage(event);
}

export function watchAssistantHistory(listener) {
  listeners.add(listener);
  broadcasting();
  return () => listeners.delete(listener);
}

function executionMetadata(execution) {
  if (!execution || typeof execution.model !== "string" || !/^[\w.-]+\/[\w.:-]+$/u.test(execution.model)) return null;
  const { guide } = execution;
  if (!guide || typeof guide.id !== "string" || !/^[a-z0-9-]{1,64}$/u.test(guide.id)
    || !Number.isSafeInteger(guide.version) || guide.version < 1) return null;
  return { guideId: guide.id, guideVersion: guide.version, model: execution.model, fallback: execution.fallback === true };
}

export async function beginAssistantHistory(accountId, { id, createdAt, prompt, locale, sources = [], example }) {
  const written = await transaction(stores, "readwrite", async tx => {
    const settings = await resultOf(tx.objectStore(preferences).get(accountId));
    if (settings?.enabled === false || (settings?.clearedAt ?? 0) >= createdAt) return false;
    const types = sourceKinds.filter(kind => sources.some(source => source.kind === kind));
    const category = categories.includes(example?.kind) ? example.kind : types[0] ?? "general";
    tx.objectStore(records).add({
      accountId, id, createdAt, locale, category, sources: types, sourceCount: sources.length,
      exampleId: example?.id ?? null, status: "submitted", actionKinds: [], execution: null, feedback: null,
    });
    tx.objectStore(texts).add({ accountId, id, prompt: prompt.slice(0, assistantLimits.prompt).toWellFormed(), answer: "" });
    return true;
  });
  if (written) announce(accountId, "add", id);
  return written;
}

export async function finishAssistantHistory(accountId, id, { answer, actions = [], execution, error, duration }) {
  const written = await transaction([records, texts], "readwrite", async tx => {
    const key = [accountId, id];
    const requests = tx.objectStore(records);
    const record = await resultOf(requests.get(key));
    if (record?.status !== "submitted") return false;
    const content = tx.objectStore(texts);
    const text = await resultOf(content.get(key));
    if (!text) return false;
    const kinds = actionKinds.filter(kind => actions.some(action => action.kind === kind));
    requests.put({
      ...record, status: error === "assistantStopped" ? "stopped" : error ? "failed" : "complete",
      error: errorCodes.includes(error) ? error : null, actionKinds: kinds,
      category: lookupKinds.includes(execution?.lookup) ? execution.lookup
        : kinds.length === 1 ? kinds[0] : kinds.length > 1 ? "workflow" : record.category,
      execution: executionMetadata(execution), duration: Math.max(0, Math.round(duration)),
    });
    content.put({ ...text, answer: answer.slice(0, assistantLimits.answer * 2).toWellFormed() });
    return true;
  });
  if (written) announce(accountId, "finish", id);
}

export function readAssistantHistory(accountId, page = 1, { latest = false } = {}) {
  return transaction(stores, "readonly", async tx => {
    const index = tx.objectStore(records).index(chronological);
    const range = accountRange(accountId);
    const enabled = (await resultOf(tx.objectStore(preferences).get(accountId)))?.enabled !== false;
    const total = await resultOf(index.count(range));
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.max(1, Math.min(pageCount, page));
    const entries = [];
    await readInOrder(index, range, (current - 1) * pageSize, async record => {
      const text = await resultOf(tx.objectStore(texts).get([accountId, record.id]));
      if (text) entries.push({ ...record, prompt: text.prompt, answer: text.answer });
      return entries.length < (latest ? 1 : pageSize);
    });
    return { enabled, total, page: current, pageCount, entries };
  });
}

export function readAssistantHistoryEntry(accountId, id) {
  return transaction(stores, "readonly", async tx => {
    const key = [accountId, id];
    const record = await resultOf(tx.objectStore(records).get(key));
    const text = await resultOf(tx.objectStore(texts).get(key));
    const enabled = (await resultOf(tx.objectStore(preferences).get(accountId)))?.enabled !== false;
    return { enabled, entry: text && record ? { ...record, prompt: text.prompt, answer: text.answer } : undefined };
  });
}

export async function setAssistantHistoryEnabled(accountId, enabled) {
  await transaction([preferences], "readwrite", async tx => {
    const store = tx.objectStore(preferences);
    const previous = await resultOf(store.get(accountId));
    store.put({ ...previous, accountId, enabled });
  });
  announce(accountId, "preferences");
}

export async function rateAssistantHistory(accountId, id, value) {
  if (!feedbackValues.includes(value)) return;
  const found = await transaction([records], "readwrite", async tx => {
    const store = tx.objectStore(records);
    const record = await resultOf(store.get([accountId, id]));
    if (!record) return false;
    store.put({ ...record, feedback: record.feedback === value ? null : value });
    return true;
  });
  if (found) announce(accountId, "feedback", id);
}

export async function removeAssistantHistory(accountId, id) {
  const clearing = id === undefined;
  await transaction(stores, "readwrite", async tx => {
    const key = clearing ? accountRange(accountId) : [accountId, id];
    tx.objectStore(records).delete(key);
    tx.objectStore(texts).delete(key);
    if (clearing) {
      const store = tx.objectStore(preferences);
      const previous = await resultOf(store.get(accountId));
      store.put({ ...previous, accountId, clearedAt: Date.now() });
    }
  });
  announce(accountId, clearing ? "clear" : "remove", id);
}

export function findAssistantHistory(accountId, query, locale, signal) {
  const terms = normalizeSearchText(query, locale).split(/\s+/u).filter(Boolean);
  if (!terms.length || signal?.aborted) return Promise.resolve([]);
  return transaction([records, texts], "readonly", async tx => {
    const matches = [];
    await readInOrder(tx.objectStore(records).index(chronological), accountRange(accountId), 0, async record => {
      if (signal?.aborted) return false;
      const text = await resultOf(tx.objectStore(texts).get([accountId, record.id]));
      if (!text) return true;
      const content = normalizeSearchText(`${text.prompt}\n${text.answer}`, locale);
      if (terms.every(term => content.includes(term))) matches.push({ id: record.id, prompt: text.prompt, answer: text.answer });
      return matches.length < pageSize;
    });
    return matches;
  });
}
