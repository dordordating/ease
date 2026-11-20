import { maxOnlineTranslationLength } from "./ease-api.js";
import { maxTranslationLength } from "./translator-engine.js";
import { translatorEngines } from "./workspace-data.js";

export const translationHistoryKey = "easeTranslationHistory";
export const translationHistoryMessage = "ease-translation-history";

const maxEntries = 100;
const maxResultLength = 48_000;
const historyError = "translationHistoryFailed";
const languageCode = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const entryId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
let pendingWrite = Promise.resolve();

function queueHistory(operation) {
  const queued = pendingWrite.then(operation);
  pendingWrite = queued.catch(() => {});
  return queued;
}

function language(value) {
  if (typeof value !== "string" || !languageCode.test(value)) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (languageCode.test(canonical) && !["und", "mul", "zxx"].includes(canonical.split("-")[0])) return canonical;
  } catch {
    // Invalid language metadata is never persisted.
  }
  return undefined;
}

function requiredText(value, maxLength) {
  if (typeof value !== "string" || value.length > maxLength || !value.trim() || !value.isWellFormed()) {
    throw new Error(historyError);
  }
  return value;
}

function historyLearning(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(historyError);
  const result = {};
  const limits = { usage: 360, example: 280, exampleTranslation: 280 };
  for (const [field, limit] of Object.entries(limits)) {
    const text = value[field];
    if (text === undefined) continue;
    if (typeof text !== "string" || text.length > limit * 2 || Array.from(text).length > limit || !text.isWellFormed()) {
      throw new Error(historyError);
    }
    result[field] = text;
  }
  for (const field of ["sourceLanguage", "exampleLanguage"]) {
    if (value[field] === undefined) continue;
    const code = language(value[field]);
    if (!code) throw new Error(historyError);
    result[field] = code;
  }
  return Object.keys(result).length ? result : undefined;
}

function createEntry(data) {
  if (!data || !translatorEngines.includes(data.engine)) throw new Error(historyError);
  const { engine } = data;
  const local = engine === "chrome";
  const text = requiredText(data.text, local ? maxTranslationLength : maxOnlineTranslationLength * 2);
  if (!local && Array.from(text).length > maxOnlineTranslationLength) throw new Error(historyError);
  const translation = requiredText(data.translation, maxResultLength);
  const target = language(data.target);
  const notesLanguage = data.notesLanguage === undefined ? "en" : language(data.notesLanguage);
  if (!target || !notesLanguage) throw new Error(historyError);
  const source = language(data.source);
  const learning = historyLearning(data.learning);
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    text,
    translation,
    ...(source ? { source } : {}),
    target,
    engine,
    ...(learning ? { learning } : {}),
    notesLanguage
  };
}

export async function readTranslationHistory() {
  const { [translationHistoryKey]: saved } = await chrome.storage.local.get(translationHistoryKey);
  return {
    enabled: saved?.enabled === true,
    entries: Array.isArray(saved?.entries) ? saved.entries.slice(0, maxEntries) : []
  };
}

async function writeHistory(history) {
  await chrome.storage.local.set({ [translationHistoryKey]: history });
  return history;
}

export function recordTranslationHistory(data, { isCurrent = () => true } = {}) {
  return queueHistory(async () => {
    const history = await readTranslationHistory();
    if (!history.enabled || !await isCurrent()) return history;
    const entry = createEntry(data);
    return writeHistory({ enabled: true, entries: [entry, ...history.entries].slice(0, maxEntries) });
  });
}

function mutateHistory(action, data) {
  if (action === "record") return recordTranslationHistory(data);
  return queueHistory(async () => {
    const history = await readTranslationHistory();
    if (action === "read") return history;
    if (action === "set-enabled" && typeof data?.enabled === "boolean") {
      return data.enabled === history.enabled ? history : writeHistory({ ...history, enabled: data.enabled });
    }
    if (action === "remove" && typeof data?.id === "string" && entryId.test(data.id)) {
      const entries = history.entries.filter(({ id }) => id !== data.id);
      return entries.length === history.entries.length ? history : writeHistory({ ...history, entries });
    }
    throw new Error(historyError);
  });
}

function fromWorkspace(sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string"
    || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  try {
    const page = new URL(sender.url);
    return page.protocol === "chrome-extension:" && page.hostname === chrome.runtime.id && page.pathname === "/workspace.html";
  } catch {
    return false;
  }
}

export function registerTranslationHistoryHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== translationHistoryMessage || !fromWorkspace(sender)) return;
    mutateHistory(message.action, message.data).then(
      (history) => respond({ history }),
      () => respond({ error: historyError })
    );
    return true;
  });
}
