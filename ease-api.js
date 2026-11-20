import { getGoogleAccount, getSilentGoogleProfileToken, googleAccountStorageKey } from "./providers.js";
import { validateWorkspaceSyncEnvelope } from "./workspace-sync-crypto.js";

export const easeTranslationMessage = "ease-translate-online";
export const maxOnlineTranslationLength = 4_000;

const baseUrl = "https://ease-api.144.76.164.115.sslip.io";
const engines = new Set(["economy", "standard", "premium"]);
const errorCodes = new Set([
  "translatorOnlineSignIn", "translatorOnlineUnavailable", "translatorOnlineLimit",
  "translatorOnlineBusy", "translatorTooLong", "translatorFailed"
]);
const syncErrorCodes = new Set(["syncUnavailable", "syncSignInRequired", "syncConflict", "syncTooLarge", "syncInvalidData"]);
const languageCode = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const maxUsageLength = 360;
const maxExampleLength = 280;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const sessionFormat = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const maxResultLength = maxOnlineTranslationLength * 12;

let cachedSession;
let pendingSession;
let accountVersion = 0;
let watchingAccount = false;
const activeRequests = new Map();
const activeSyncRequests = new Set();

class EaseTranslationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function safeErrorCode(error) {
  return errorCodes.has(error?.code) ? error.code : "translatorFailed";
}

function observeAccount() {
  if (watchingAccount) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.hasOwn(changes, googleAccountStorageKey)) return;
    accountVersion++;
    cachedSession = undefined;
    pendingSession = undefined;
    for (const request of activeRequests.values()) {
      request.abort(new EaseTranslationError("translatorOnlineSignIn"));
    }
    for (const request of activeSyncRequests) request.abort(new EaseTranslationError("syncSignInRequired"));
  });
  watchingAccount = true;
}

function validateInput(text, source, target, engine) {
  if (typeof text !== "string" || !text.trim()) throw new EaseTranslationError("translatorFailed");
  if (text.length > maxOnlineTranslationLength * 2 || Array.from(text).length > maxOnlineTranslationLength) {
    throw new EaseTranslationError("translatorTooLong");
  }
  if (!engines.has(engine) || typeof target !== "string" || !languageCode.test(target)
    || typeof source !== "string" || (source !== "auto" && !languageCode.test(source))) {
    throw new EaseTranslationError("translatorFailed");
  }
}

async function accountSnapshot() {
  const version = accountVersion;
  const account = await getGoogleAccount();
  if (version !== accountVersion || typeof account?.id !== "string" || !account.id
    || typeof account.email !== "string" || !account.email) {
    throw new EaseTranslationError("translatorOnlineSignIn");
  }
  return { id: account.id, email: account.email, version };
}

function matchesAccount(first, second) {
  return first?.version === second.version && first.id === second.id && first.email === second.email;
}

async function requireAccount(expected) {
  if (!matchesAccount(await accountSnapshot(), expected)) throw new EaseTranslationError("translatorOnlineSignIn");
}

async function apiRequest(path, { method, body, token, signal, milliseconds = 27_000 }) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(milliseconds);
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    return await fetch(`${baseUrl}${path}`, {
      method,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
  } catch {
    signal?.throwIfAborted();
    throw new EaseTranslationError("translatorOnlineUnavailable");
  }
}

function apiPost(path, body, options) {
  return apiRequest(path, { ...options, method: "POST", body });
}

async function decodeResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function supportedLanguage(value) {
  if (typeof value !== "string" || !languageCode.test(value)) return undefined;
  try {
    const [language] = Intl.getCanonicalLocales(value);
    if (languageCode.test(language) && !["und", "mul", "zxx"].includes(language.split("-")[0])) return language;
  } catch {
    // Ignore malformed optional language metadata.
  }
  return undefined;
}

function learningText(value, limit, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > limit * 2 || !value.isWellFormed()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  const trimmed = value.trim();
  if ((!trimmed && !allowEmpty) || Array.from(trimmed).length > limit) return undefined;
  return trimmed;
}

function readLearning(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = learningText(value.usage, maxUsageLength);
  const example = learningText(value.example, maxExampleLength);
  const exampleTranslation = learningText(value.example_translation, maxExampleLength, { allowEmpty: true });
  const exampleLanguage = supportedLanguage(value.example_language);
  const sourceLanguage = supportedLanguage(value.source_language);
  const learning = {};
  if (usage !== undefined) learning.usage = usage;
  if (example !== undefined) learning.example = example;
  if (exampleTranslation !== undefined) learning.exampleTranslation = exampleTranslation;
  if (exampleLanguage !== undefined) learning.exampleLanguage = exampleLanguage;
  if (sourceLanguage !== undefined) learning.sourceLanguage = sourceLanguage;
  return Object.keys(learning).length ? learning : undefined;
}

function sessionExpiration(data, email) {
  if (data?.token_type !== "bearer" || typeof data.access_token !== "string"
    || data.access_token.length > 8192 || !sessionFormat.test(data.access_token)
    || !Number.isInteger(data.expires_in) || data.expires_in <= 30 || data.expires_in > 7_200
    || typeof data.user?.id !== "string" || !uuid.test(data.user.id) || data.user.email !== email) {
    throw new EaseTranslationError("translatorOnlineUnavailable");
  }
  let claims;
  try {
    const payload = data.access_token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    claims = JSON.parse(atob(payload));
  } catch {
    throw new EaseTranslationError("translatorOnlineUnavailable");
  }
  // Check the server's response fields agree. The backend verifies the actual JWT signature.
  const now = Date.now();
  if (claims?.iss !== "ease-api" || claims.aud !== "ease-extension" || claims.sub !== data.user.id
    || !Number.isSafeInteger(claims.exp) || claims.exp <= now / 1_000 + 30) {
    throw new EaseTranslationError("translatorOnlineUnavailable");
  }
  return Math.min(claims.exp * 1_000, now + data.expires_in * 1_000) - 30_000;
}

async function establishSession(account) {
  let google;
  try {
    google = await getSilentGoogleProfileToken(account.id);
  } catch (error) {
    throw new EaseTranslationError(error?.code === "googleRequestFailed"
      ? "translatorOnlineUnavailable" : "translatorOnlineSignIn");
  }
  await requireAccount(account);

  const response = await apiPost("/v1/auth/google", { access_token: google.token }, { milliseconds: 22_000 });
  if (response.status === 401) throw new EaseTranslationError("translatorOnlineSignIn");
  if (!response.ok) throw new EaseTranslationError("translatorOnlineUnavailable");
  const data = await decodeResponse(response);
  const expiresAt = sessionExpiration(data, google.email);
  await requireAccount(account);
  return { account, token: data.access_token, expiresAt };
}

function sessionFor(account) {
  if (matchesAccount(cachedSession?.account, account) && cachedSession.expiresAt > Date.now()) {
    return Promise.resolve(cachedSession);
  }
  if (matchesAccount(pendingSession?.account, account)) return pendingSession.promise;

  const pending = { account };
  pending.promise = establishSession(account).then((session) => {
    if (accountVersion !== account.version) throw new EaseTranslationError("translatorOnlineSignIn");
    cachedSession = session;
    return session;
  }).finally(() => {
    if (pendingSession === pending) pendingSession = undefined;
  });
  pendingSession = pending;
  return pending.promise;
}

function invalidateSession(session) {
  if (cachedSession === session) cachedSession = undefined;
}

async function requestTranslation(text, { source = "auto", target, engine, signal, notesLanguage }) {
  validateInput(text, source, target, engine);
  const account = await accountSnapshot();
  signal.throwIfAborted();
  if (source.toLowerCase() === target.toLowerCase()) return { text, source: target };

  const payload = { text, source, target, tier: engine };
  let learningLanguage = supportedLanguage(notesLanguage);
  let session = await sessionFor(account);
  let refreshedSession = false;
  let response;
  let data;
  while (true) {
    await requireAccount(account);
    const body = learningLanguage ? { ...payload, notes_language: learningLanguage } : payload;
    response = await apiPost("/v1/translate", body, { token: session.token, signal });
    if (response.status === 401) {
      invalidateSession(session);
      if (refreshedSession) throw new EaseTranslationError("translatorOnlineSignIn");
      signal.throwIfAborted();
      await requireAccount(account);
      session = await sessionFor(account);
      refreshedSession = true;
      continue;
    }
    data = await decodeResponse(response);
    signal.throwIfAborted();
    await requireAccount(account);
    // Older servers reject unknown fields during input validation, before reserving quota.
    if (learningLanguage && response.status === 422 && data?.detail === "invalid_request") {
      learningLanguage = undefined;
      continue;
    }
    break;
  }

  if (response.status === 429) throw new EaseTranslationError("translatorOnlineLimit");
  if (response.status === 503 && data?.detail === "translation_busy") throw new EaseTranslationError("translatorOnlineBusy");
  if (response.status === 413 || (response.status === 422 && data?.detail === "invalid_translation_text")) {
    throw new EaseTranslationError("translatorTooLong");
  }
  if (response.status >= 500 && data?.detail !== "translation_invalid_response") {
    throw new EaseTranslationError("translatorOnlineUnavailable");
  }
  if (!response.ok || typeof data?.text !== "string" || !data.text.trim()
    || data.text.length > maxResultLength || data.tier !== engine) {
    throw new EaseTranslationError("translatorFailed");
  }

  const learning = readLearning(data.learning);
  const result = { text: data.text, source: source === "auto" ? learning?.sourceLanguage : source };
  if (learning) result.learning = learning;
  return result;
}

export function handleEaseTranslationMessage(message, sendResponse) {
  const requestId = message?.requestId;
  if (typeof requestId !== "string" || !uuid.test(requestId)) {
    sendResponse({ ok: false, code: "translatorFailed" });
    return false;
  }
  if (message.cancel === true) {
    activeRequests.get(requestId)?.abort();
    sendResponse({ ok: true });
    return false;
  }
  if (activeRequests.has(requestId)) {
    sendResponse({ ok: false, code: "translatorFailed" });
    return false;
  }

  observeAccount();
  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  const { text, source, target, engine, notesLanguage } = message;
  requestTranslation(text, { source, target, engine, signal: controller.signal, notesLanguage })
    .then((result) => sendResponse({ ok: true, result }), (error) => {
      sendResponse({ ok: false, code: safeErrorCode(error) });
    })
    .finally(() => activeRequests.delete(requestId));
  return true;
}

export async function translateOnline(text, { source = "auto", target, engine, signal, notesLanguage } = {}) {
  signal?.throwIfAborted();
  validateInput(text, source, target, engine);
  const requestId = crypto.randomUUID();
  let abort;
  try {
    const message = { type: easeTranslationMessage, requestId, text, source, target, engine };
    const learningLanguage = supportedLanguage(notesLanguage);
    if (learningLanguage) message.notesLanguage = learningLanguage;
    const pending = chrome.runtime.sendMessage(message);
    const response = signal ? await Promise.race([
      pending,
      new Promise((_, reject) => {
        abort = () => {
          Promise.resolve().then(() => chrome.runtime.sendMessage({
            type: easeTranslationMessage, requestId, cancel: true
          })).catch(() => {});
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })
    ]) : await pending;
    signal?.throwIfAborted();
    if (response?.ok !== true) throw new EaseTranslationError(safeErrorCode(response));
    return response.result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof EaseTranslationError) throw error;
    throw new EaseTranslationError("translatorOnlineUnavailable");
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function validRevision(revision) {
  return Number.isSafeInteger(revision) && revision >= 0;
}

function verifySyncedWorkspace(result, request) {
  if (!result || !validRevision(result.revision)) throw new EaseTranslationError("syncInvalidData");
  if (request && result.revision !== request.revision + 1) throw new EaseTranslationError("syncInvalidData");
  if (result.revision === 0 && result.envelope === null) return { revision: 0, envelope: null };
  if (result.revision === 0) throw new EaseTranslationError("syncInvalidData");
  const envelope = validateWorkspaceSyncEnvelope(result.envelope);
  if (request && Object.keys(envelope).some((field) => envelope[field] !== request.envelope[field])) {
    throw new EaseTranslationError("syncInvalidData");
  }
  return { revision: result.revision, envelope };
}

async function requestWorkspaceSync(accountId, method, body, signal) {
  signal?.throwIfAborted();
  observeAccount();
  const controller = new AbortController();
  activeSyncRequests.add(controller);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const account = await accountSnapshot();
    if (account.id !== accountId) throw new EaseTranslationError("syncSignInRequired");
    requestSignal.throwIfAborted();

    const url = "/v1/workspace-sync";
    let session = await sessionFor(account);
    await requireAccount(account);
    let response = await apiRequest(url, { method, body, token: session.token, signal: requestSignal });
    if (response.status === 401) {
      invalidateSession(session);
      requestSignal.throwIfAborted();
      await requireAccount(account);
      session = await sessionFor(account);
      await requireAccount(account);
      response = await apiRequest(url, { method, body, token: session.token, signal: requestSignal });
    }
    if (response.status === 401) {
      invalidateSession(session);
      throw new EaseTranslationError("syncSignInRequired");
    }

    const result = response.ok ? await decodeResponse(response) : null;
    requestSignal.throwIfAborted();
    await requireAccount(account);
    if (response.status === 409 && method === "PUT") throw new EaseTranslationError("syncConflict");
    if (response.status === 413) throw new EaseTranslationError("syncTooLarge");
    if (response.status === 422) throw new EaseTranslationError("syncInvalidData");
    if (!response.ok) throw new EaseTranslationError("syncUnavailable");
    return verifySyncedWorkspace(result, body);
  } catch (error) {
    signal?.throwIfAborted();
    controller.signal.throwIfAborted();
    if (syncErrorCodes.has(error?.code)) throw error;
    throw new EaseTranslationError(error?.code === "translatorOnlineSignIn" ? "syncSignInRequired" : "syncUnavailable");
  } finally {
    activeSyncRequests.delete(controller);
  }
}

export function readSyncedWorkspace(accountId, signal) {
  return requestWorkspaceSync(accountId, "GET", undefined, signal);
}

export async function writeSyncedWorkspace(accountId, revision, envelope, signal) {
  signal?.throwIfAborted();
  if (!validRevision(revision) || revision === Number.MAX_SAFE_INTEGER) throw new EaseTranslationError("syncInvalidData");
  return requestWorkspaceSync(accountId, "PUT", { revision, envelope: validateWorkspaceSyncEnvelope(envelope) }, signal);
}
