export const vaultSessionStorageKey = "easeVaultSessions";
export const vaultExpiryAlarm = "ease-vault-expiry";
export const defaultVaultPolicy = "five-minutes";
const minute = 60_000;
const policyDurations = {
  "after-copy": 5 * minute,
  "one-minute": minute,
  "five-minutes": 5 * minute,
  "fifteen-minutes": 15 * minute,
  "thirty-minutes": 30 * minute,
  "one-hour": 60 * minute,
  "three-hours": 3 * 60 * minute,
  "six-hours": 6 * 60 * minute
};
const pinAttemptsKey = "easeVaultPinAttempts";
const pinAttemptLimit = 5;
const pinRetryWindow = minute;

export function vaultPolicyFor(policy) {
  return typeof policy === "string" && Object.hasOwn(policyDurations, policy) ? policy : defaultVaultPolicy;
}

export function activeVaultSession(sessions, folderId) {
  const session = sessions.get(folderId);
  return session?.expiresAt > Date.now() ? session : undefined;
}

async function scheduleExpiry(sessions) {
  if (!chrome.alarms) return;
  const nextExpiry = Math.min(...Array.from(sessions.values(), ({ expiresAt }) => expiresAt));
  if (Number.isFinite(nextExpiry)) await chrome.alarms.create(vaultExpiryAlarm, { when: nextExpiry });
  else await chrome.alarms.clear(vaultExpiryAlarm);
}

async function persistSessions(sessions) {
  await chrome.storage.session.set({ [vaultSessionStorageKey]: Object.fromEntries(sessions) });
  // Each privileged action checks expiration even if alarms are unavailable.
  await scheduleExpiry(sessions).catch(() => {});
}

export async function readVaultSessions() {
  const storage = chrome.storage.session;
  if (!storage) return new Map();
  const result = await storage.get(vaultSessionStorageKey);
  const entries = Object.entries(result[vaultSessionStorageKey] ?? {});
  const sessions = new Map(entries.filter(([, session]) =>
    typeof session?.key === "string" && Number.isFinite(session.expiresAt) && session.expiresAt > Date.now()
  ));
  if (sessions.size !== entries.length) await persistSessions(sessions).catch(() => {});
  return sessions;
}

export async function unlockVaultSession(sessions, folderId, key, policy) {
  const next = new Map(sessions);
  next.set(folderId, { key, expiresAt: Date.now() + policyDurations[vaultPolicyFor(policy)] });
  await persistSessions(next);
  sessions.set(folderId, next.get(folderId));
}

export async function lockVaultSession(sessions, folderId) {
  if (!sessions.has(folderId)) return;
  const next = new Map(sessions);
  next.delete(folderId);
  await persistSessions(next);
  sessions.delete(folderId);
}

async function readPinAttempts(now = Date.now()) {
  const result = await chrome.storage.session.get(pinAttemptsKey);
  return new Map(Object.entries(result[pinAttemptsKey] ?? {}).filter(([, attempt]) => attempt?.expiresAt > now));
}

async function persistPinAttempts(attempts) {
  await chrome.storage.session.set({ [pinAttemptsKey]: Object.fromEntries(attempts) });
}

export async function reserveVaultPinAttempt(folderId) {
  const now = Date.now();
  const attempts = await readPinAttempts(now);
  const count = attempts.get(folderId)?.count ?? 0;
  if (count >= pinAttemptLimit) return false;
  attempts.set(folderId, { count: count + 1, expiresAt: now + pinRetryWindow });
  await persistPinAttempts(attempts);
  return true;
}

export async function clearVaultPinAttempts(folderId) {
  const attempts = await readPinAttempts();
  if (attempts.delete(folderId)) await persistPinAttempts(attempts);
}
