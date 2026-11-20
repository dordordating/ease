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
const googleProviderMessage = "ease-google-provider";
const googleAuthenticatedActions = new Set(["sign-in", "connect-calendar", "sync-calendar"]);
const dayLength = 86_400_000;

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

async function providerAction(action) {
  if (googleAuthenticatedActions.has(action) && !googleConfigured()) {
    throw new Error("Google has no OAuth client configuration");
  }
  const response = await chrome.runtime.sendMessage({ type: googleProviderMessage, action });
  if (!response?.ok) throw new Error("Google provider action failed");
  return response.value;
}

export const signInGoogle = () => providerAction("sign-in");
export const signOutGoogle = () => providerAction("sign-out");
export const connectGoogleCalendar = () => providerAction("connect-calendar");
export const syncGoogleCalendar = () => providerAction("sync-calendar");
export const disconnectGoogleCalendar = () => providerAction("disconnect-calendar");

async function getToken(scopes, interactive) {
  const result = await chrome.identity.getAuthToken({ scopes, interactive, enableGranularPermissions: true });
  const granted = result?.grantedScopes;
  if (!result?.token || (granted && !scopes.every((scope) => granted.includes(scope)))) {
    throw new Error("Required Google authorization was not granted");
  }
  return result.token;
}

class AuthorizationExpired extends Error {}

async function googleJson(url, token) {
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 401) throw new AuthorizationExpired();
  if (!response.ok) throw new Error("Google API request failed");
  return response.json();
}

async function authorized(scopes, interactive, operation) {
  const token = await getToken(scopes, interactive);
  try {
    return await operation(token);
  } catch (error) {
    if (!(error instanceof AuthorizationExpired)) throw error;
    await chrome.identity.removeCachedAuthToken({ token });
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
  if (!interactive && !prior?.connected) throw new Error("Google Calendar is disconnected");
  return authorized(calendarScopes, interactive, async (token) => {
    const identity = await googleJson(profileUrl, token);
    if (typeof identity.sub !== "string" || !identity.sub) throw new Error("Missing Google Calendar identity");
    if (prior?.owner && identity.sub !== prior.owner) throw new Error("Google Calendar account changed");

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
      const page = await googleJson(url, token);
      if (!(page.items === undefined || Array.isArray(page.items))) throw new Error("Invalid Calendar result");
      for (const item of page.items ?? []) {
        events.push(...googleEventSegments(item, firstDay, lastDay));
      }
      if (!page.nextPageToken) break;
      if (pageTokens.has(page.nextPageToken)) throw new Error("Repeated Calendar cursor");
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
    const identity = await googleJson(profileUrl, token);
    if (typeof identity.sub !== "string" || !identity.sub || typeof identity.email !== "string" || !identity.email
      || identity.email_verified !== true) {
      throw new Error("Google account details unavailable");
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
  if (googleAuthenticatedActions.has(action) && !googleConfigured()) {
    throw new Error("Google has no OAuth client configuration");
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
    return refreshCalendar(false);
  });
}

export function registerGoogleProviderHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== googleProviderMessage) return;
    queueProviderAction(() => workerAction(message.action))
      .then((value) => respond({ ok: true, value }), () => respond({ ok: false }));
    return true;
  });
}
