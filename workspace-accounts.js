import { googleAccountStorageKey, getGoogleAccount } from "./providers.js";
import { defaultWorkspace, storageKey } from "./workspace-data.js";
import { vaultSessionStorageKey } from "./vault-session.js";

export const legacyWorkspaceSyncStorageKey = "easeWorkspaceSync";
export const workspaceOwnerKey = "easeWorkspaceOwner";
const guestImportKey = "easeGuestWorkspaceImported";

const workspaceCache = (mode, operation) => workspaceStore("ease-workspace-accounts", "workspaces", mode, operation);

export function workspaceStore(databaseName, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      try {
        const transaction = database.transaction(storeName, mode);
        const result = operation(transaction.objectStore(storeName));
        transaction.oncomplete = () => { database.close(); resolve(result.result); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      } catch (error) {
        database.close();
        reject(error);
      }
    };
  });
}

export async function activateWorkspaceAccount(profile) {
  const stored = await chrome.storage.local.get([workspaceOwnerKey, googleAccountStorageKey, legacyWorkspaceSyncStorageKey, guestImportKey]);
  const current = stored[googleAccountStorageKey]?.id ?? null;
  const owner = stored[workspaceOwnerKey] !== undefined
    ? stored[workspaceOwnerKey] : stored[legacyWorkspaceSyncStorageKey]?.accountId ?? current;
  const next = profile === undefined ? current : profile?.id ?? null;
  if (owner === next && stored[workspaceOwnerKey] === next && profile === undefined) return;

  const patch = { [workspaceOwnerKey]: next };
  if (profile !== undefined) patch[googleAccountStorageKey] = profile;
  if (owner !== next) {
    const previous = (await chrome.storage.local.get(storageKey))[storageKey];
    if (previous) await workspaceCache("readwrite", store => store.put(previous, owner ?? "guest"));
    const saved = await workspaceCache("readonly", store => store.get(next ?? "guest"));
    const importGuest = !saved && next && !owner && previous && !stored[guestImportKey];
    if (importGuest) patch[guestImportKey] = next;
    patch[storageKey] = saved ?? (importGuest ? previous : defaultWorkspace);
    await chrome.storage.session.remove(vaultSessionStorageKey);
  }
  if (profile === undefined && ((await getGoogleAccount())?.id ?? null) !== current) return activateWorkspaceAccount();
  await chrome.storage.local.set(patch);
}

export async function importedGuestWorkspace(accountId) {
  const stored = await chrome.storage.local.get(guestImportKey);
  if (stored[guestImportKey] !== accountId) return undefined;
  return workspaceCache("readonly", store => store.get("guest"));
}
