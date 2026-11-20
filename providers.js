export const googleAccountStorageKey = "easeGoogleAccount";
export const googleCalendarStorageKey = "easeGoogleCalendar";

const profileScopes = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];
const calendarScopes = [
  "openid",
  "https://www.googleapis.com/auth/calendar.events.owned.readonly"
];
const profileUrl = "https://openidconnect.googleapis.com/v1/userinfo";
const calendarUrl = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const profileHosts = { origins: ["https://openidconnect.googleapis.com/*"] };
const calendarHosts = { origins: [...profileHosts.origins, "https://www.googleapis.com/*"] };
const googleProviderMessage = "ease-google-provider";
const googleActionHosts = new Map([
  ["sign-in", profileHosts],
  ["connect-calendar", calendarHosts],
  ["sync-calendar", calendarHosts]
]);
const interactiveGoogleActions = new Set(["sign-in", "connect-calendar"]);
const googleErrorKeys = new Set([
  "accountSetup", "accountFailed", "providerUnavailable", "syncFailed", "googleHostDenied", "googleHostPromptFailed",
  "googleChromeAccountRequired", "googleOAuthClientMismatch", "googleOAuthAccessDenied",
  "googleConsentCanceled", "googleOAuthUnavailable", "googleRequestFailed", "googleProfileFailed",
  "googleCalendarFailed", "googleCalendarAccountChanged", "googleWorkerUnavailable", "googleSignOutFailed"
]);
const googleIssueKeys = {
  account: "easeGoogleAccountIssue",
  calendar: "easeGoogleCalendarIssue"
};
const dayLength = 86_400_000;

class GoogleProviderError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function googleProviderErrorKey(error, fallback) {
  return googleErrorKeys.has(error?.code) ? error.code : fallback;
}

export async function getGoogleProviderIssue(kind) {
  if (!Object.hasOwn(googleIssueKeys, kind) || !chrome.storage.session) return null;
  const key = googleIssueKeys[kind];
  const issue = (await chrome.storage.session.get(key))[key];
  return issue?.expiresAt > Date.now() && googleErrorKeys.has(issue.code) ? issue.code : null;
}

async function rememberGoogleIssue(action, code) {
  const key = googleIssueKeys[action === "sign-in" || action === "sign-out" ? "account" : "calendar"];
  const issue = googleErrorKeys.has(code) ? { code, expiresAt: Date.now() + 5 * 60_000 } : null;
  try {
    await chrome.storage.session?.set({ [key]: issue });
  } catch {
    // The attempt can still report its result when session storage is unavailable.
  }
}

export function googleConfigured() {
  const clientId = chrome.runtime.getManifest().oauth2?.client_id;
  return typeof clientId === "string" && /\.apps\.googleusercontent\.com$/u.test(clientId);
}

async function readStorage(key) {
  return (await chrome.storage.local.get(key))[key];
}

export async function getGoogleAccount() {
  return (await readStorage(googleAccountStorageKey)) ?? null;
}

export async function getGoogleCalendarState() {
  const calendar = await readStorage(googleCalendarStorageKey);
  if (!calendar) return { connected: false, lastSynced: null, events: [] };
  const { connected, lastSynced, events } = calendar;
  return { connected, lastSynced, events };
}

async function requestGoogleHosts(hosts) {
  try {
    return await chrome.permissions.request(hosts) ? null : "googleHostDenied";
  } catch {
    return "googleHostPromptFailed";
  }
}

function missingConfiguration(action) {
  return new GoogleProviderError(action === "sign-in" ? "accountSetup" : "providerUnavailable");
}

async function providerAction(action, { requestFromPage = false } = {}) {
  const hosts = googleActionHosts.get(action);
  const interactive = interactiveGoogleActions.has(action);
  if (hosts) {
    if (!googleConfigured()) throw missingConfiguration(action);
    if (interactive && requestFromPage) {
      const permissionError = await requestGoogleHosts(hosts);
      if (permissionError) {
        await rememberGoogleIssue(action, permissionError);
        throw new GoogleProviderError(permissionError);
      }
    }
  }
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: googleProviderMessage, action, requestHosts: interactive && !requestFromPage
    });
  } catch {
    throw new GoogleProviderError("googleWorkerUnavailable");
  }
  if (!response?.ok) {
    const fallback = action === "sign-out" ? "googleSignOutFailed" : "googleWorkerUnavailable";
    throw new GoogleProviderError(googleProviderErrorKey(response, fallback));
  }
  return response.value;
}

export const signInGoogle = (options) => providerAction("sign-in", options);
export const signOutGoogle = () => providerAction("sign-out");
export const connectGoogleCalendar = (options) => providerAction("connect-calendar", options);
export const syncGoogleCalendar = () => providerAction("sync-calendar");
export const disconnectGoogleCalendar = () => providerAction("disconnect-calendar");

function identityError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  if (/(?:invalid|bad|unknown) (?:oauth2 )?client id|invalid_client|unauthorized_client|deleted_client|redirect_uri_mismatch|origin_mismatch/u.test(message)) {
    return new GoogleProviderError("googleOAuthClientMismatch");
  }
  if (/user is not signed in|only the primary user account|turned off browser sign.?in|no account (?:found|available)/u.test(message)) {
    return new GoogleProviderError("googleChromeAccountRequired");
  }
  if (/user did not approve access|user cancel|user closed|access request was canceled/u.test(message)) {
    return new GoogleProviderError("googleConsentCanceled");
  }
  if (/access_denied|invalid_scope|invalid oauth2 scopes|oauth2 not granted or revoked|admin_policy_enforced/u.test(message)) {
    return new GoogleProviderError("googleOAuthAccessDenied");
  }
  return new GoogleProviderError("googleOAuthUnavailable");
}

async function getToken(scopes, interactive) {
  let result;
  try {
    result = await chrome.identity.getAuthToken({ scopes, interactive, enableGranularPermissions: true });
  } catch (error) {
    throw identityError(error);
  }
  // Google can return equivalent scope names or a grant without the optional profile-name scope.
  // The verified UserInfo claims and Calendar API response determine whether access is sufficient.
  if (typeof result?.token !== "string" || !result.token || result.grantedScopes?.length === 0) {
    throw new GoogleProviderError("googleOAuthAccessDenied");
  }
  return result.token;
}

class AuthorizationExpired extends GoogleProviderError {}

async function googleJson(url, token, failure) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw new GoogleProviderError("googleRequestFailed");
  }
  if (response.status === 401) throw new AuthorizationExpired(failure);
  if (!response.ok) throw new GoogleProviderError(failure);
  try {
    return await response.json();
  } catch {
    throw new GoogleProviderError(failure);
  }
}

async function authorized(scopes, interactive, operation) {
  const token = await getToken(scopes, interactive);
  try {
    return await operation(token);
  } catch (error) {
    if (!(error instanceof AuthorizationExpired)) throw error;
    try {
      await chrome.identity.removeCachedAuthToken({ token });
    } catch (cacheError) {
      throw identityError(cacheError);
    }
    return operation(await getToken(scopes, false));
  }
}

function localDateKey(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localClock(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function utcDay(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(key)) return NaN;
  return Date.parse(`${key}T00:00:00Z`) / dayLength;
}

function googleEventSegments(item, firstDay, lastDay) {
  if (item.status === "cancelled" || typeof item.id !== "string") return [];
  const isAllDay = typeof item.start?.date === "string";
  const startTime = new Date(item.start?.dateTime);
  const endTime = new Date(item.end?.dateTime);
  let startDay, endDay;
  if (isAllDay) {
    startDay = utcDay(item.start.date);
    endDay = Math.max(startDay, utcDay(item.end?.date) - 1);
  } else {
    startDay = utcDay(localDateKey(startTime));
    const inclusiveEnd = new Date(Math.max(startTime.getTime(), endTime.getTime() - 1));
    endDay = utcDay(localDateKey(inclusiveEnd));
  }
  if (!Number.isFinite(startDay) || !Number.isFinite(endDay)) return [];

  const segments = [];
  const last = Math.min(endDay, lastDay);
  for (let day = Math.max(startDay, firstDay); day <= last; day++) {
    const date = new Date(day * dayLength).toISOString().slice(0, 10);
    segments.push({
      id: `google:${item.id}:${date}`,
      date,
      title: typeof item.summary === "string" ? item.summary.slice(0, 200) : "",
      start: !isAllDay && day === startDay ? localClock(startTime) : "",
      end: !isAllDay && localDateKey(endTime) === date ? localClock(endTime) : "",
      location: typeof item.location === "string" ? item.location.slice(0, 500) : "",
      notes: typeof item.description === "string" ? item.description.slice(0, 2000) : "",
      source: "google",
      provider: "google",
      readOnly: true
    });
  }
  return segments;
}

async function refreshCalendar(interactive) {
  const prior = await readStorage(googleCalendarStorageKey);
  if (!interactive && !prior?.connected) throw new GoogleProviderError("googleCalendarFailed");
  return authorized(calendarScopes, interactive, async (token) => {
    const identity = await googleJson(profileUrl, token, "googleProfileFailed");
    if (typeof identity?.sub !== "string" || !identity.sub) throw new GoogleProviderError("googleProfileFailed");
    if (prior?.owner && identity.sub !== prior.owner) throw new GoogleProviderError("googleCalendarAccountChanged");

    const timeMin = new Date();
    timeMin.setHours(0, 0, 0, 0);
    timeMin.setDate(timeMin.getDate() - 183);
    const timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + 367);
    const firstDay = utcDay(localDateKey(timeMin));
    const lastDay = utcDay(localDateKey(timeMax)) - 1;
    const url = new URL(calendarUrl);
    url.search = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      fields: "nextPageToken,items(id,status,summary,description,location,start,end)"
    });
    const events = [];
    const pageTokens = new Set();
    while (true) {
      const page = await googleJson(url, token, "googleCalendarFailed");
      if (!page || !(page.items === undefined || Array.isArray(page.items))) throw new GoogleProviderError("googleCalendarFailed");
      for (const item of page.items ?? []) {
        events.push(...googleEventSegments(item, firstDay, lastDay));
      }
      if (!page.nextPageToken) break;
      if (typeof page.nextPageToken !== "string" || pageTokens.has(page.nextPageToken)) {
        throw new GoogleProviderError("googleCalendarFailed");
      }
      pageTokens.add(page.nextPageToken);
      url.searchParams.set("pageToken", page.nextPageToken);
    }

    const calendar = { connected: true, lastSynced: new Date().toISOString(), events };
    await chrome.storage.local.set({ [googleCalendarStorageKey]: { ...calendar, owner: identity.sub } });
    return calendar;
  });
}

async function fetchAccount() {
  return authorized(profileScopes, true, async (token) => {
    const identity = await googleJson(profileUrl, token, "googleProfileFailed");
    if (typeof identity?.sub !== "string" || !identity.sub || typeof identity.email !== "string" || !identity.email
      || identity.email_verified !== true) {
      throw new GoogleProviderError("googleProfileFailed");
    }
    const account = {
      id: identity.sub,
      name: typeof identity.name === "string" ? identity.name : identity.email,
      email: identity.email
    };
    await chrome.storage.local.set({ [googleAccountStorageKey]: account });
    return account;
  });
}

async function workerAction(action) {
  const hosts = googleActionHosts.get(action);
  if (hosts) {
    if (!googleConfigured()) throw missingConfiguration(action);
    if (!await chrome.permissions.contains(hosts)) throw new GoogleProviderError("googleHostDenied");
  }
  switch (action) {
    case "sign-in":
      return fetchAccount();
    case "sign-out":
      await chrome.storage.local.remove([googleAccountStorageKey, googleCalendarStorageKey]);
      await chrome.identity.clearAllCachedAuthTokens();
      return;
    case "connect-calendar":
      return refreshCalendar(true);
    case "sync-calendar":
      return refreshCalendar(false);
    case "disconnect-calendar":
      await chrome.storage.local.remove(googleCalendarStorageKey);
      return;
    default:
      throw new Error("Unknown Google provider action");
  }
}

let pendingProviderAction = Promise.resolve();

function queueProviderAction(action) {
  const operation = pendingProviderAction.then(action);
  pendingProviderAction = operation.catch(() => {});
  return operation;
}

export function refreshConnectedGoogleCalendar() {
  return queueProviderAction(async () => {
    if (!googleConfigured() || !(await readStorage(googleCalendarStorageKey))?.connected) return;
    if (!await chrome.permissions.contains(calendarHosts)) return;
    return refreshCalendar(false);
  });
}

export function registerGoogleProviderHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== googleProviderMessage) return;
    const { action } = message;
    // Start Chrome's permission request on the first message hop, while it still carries the click.
    const permission = message.requestHosts === true && interactiveGoogleActions.has(action) && googleConfigured()
      ? requestGoogleHosts(googleActionHosts.get(action)) : null;
    queueProviderAction(async () => {
      const fallback = action === "sign-in" ? "accountFailed" : action === "sign-out" ? "googleSignOutFailed" : "syncFailed";
      try {
        const permissionError = await permission;
        if (permissionError) throw new GoogleProviderError(permissionError);
        const value = await workerAction(action);
        await rememberGoogleIssue(action, null);
        return { ok: true, value };
      } catch (error) {
        const code = googleProviderErrorKey(error, fallback);
        await rememberGoogleIssue(action, code);
        return { ok: false, code };
      }
    }).then(respond);
    return true;
  });
}
