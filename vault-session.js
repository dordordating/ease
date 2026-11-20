export const vaultSessionStorageKey = "easeVaultSessions";
export const vaultExpiryAlarm = "ease-vault-expiry";
const sessionDuration = 5 * 60_000;

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

export async function unlockVaultSession(sessions, folderId, key) {
  const next = new Map(sessions);
  next.set(folderId, { key, expiresAt: Date.now() + sessionDuration });
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
