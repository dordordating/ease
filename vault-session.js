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
export const vaultPinAttemptsStorageKey = "easeVaultPinAttempts";
const pinAttemptsBeforeWait = 3;
const maxPinBackoffStep = 4;
const maxPinWait = 15 * minute;

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

export async function readVaultPinAttempts() {
  const result = await chrome.storage.local.get(vaultPinAttemptsStorageKey);
  return new Map(Object.entries(result[vaultPinAttemptsStorageKey] ?? {}).filter(([, attempt]) =>
    Number.isInteger(attempt?.count) && attempt.count > 0 && Number.isFinite(attempt.retryAt)
  ));
}

export function vaultPinRetryAt(attempts, folderId, now = Date.now()) {
  const attempt = attempts.get(folderId);
  return attempt?.retryAt > now ? attempt.retryAt : null;
}

async function persistPinAttempts(attempts) {
  await chrome.storage.local.set({ [vaultPinAttemptsStorageKey]: Object.fromEntries(attempts) });
}

export async function reserveVaultPinAttempt(folderId) {
  const now = Date.now();
  const attempts = await readVaultPinAttempts();
  if (vaultPinRetryAt(attempts, folderId, now)) return false;
  const count = Math.min(pinAttemptsBeforeWait + maxPinBackoffStep, (attempts.get(folderId)?.count ?? 0) + 1);
  const step = count - pinAttemptsBeforeWait;
  const retryAt = step < 0 ? 0 : now + Math.min(2 ** step * minute, maxPinWait);
  attempts.set(folderId, { count, retryAt });
  // Reserve before testing the PIN so an unavailable store cannot allow uncounted guesses.
  await persistPinAttempts(attempts);
  return true;
}

export async function clearVaultPinAttempts(folderId) {
  const attempts = await readVaultPinAttempts();
  if (attempts.delete(folderId)) await persistPinAttempts(attempts);
}
