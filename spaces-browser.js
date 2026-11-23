import { appendSpaceBundle, chromeGroupColors, spaceIdValid, spaceLimits, spaceTabsTaken, spaceUrl, updateSpaces } from "./spaces-store.js";
import { readWorkspace, storageKey } from "./workspace-data.js";

export const spacesMessage = "ease-tab-spaces";
const savedWindowKey = id => `easeSpaceWindow:${id}`;
const savedGroupsKey = id => `easeSpaceGroups:${id}`;
const tabsAccess = { permissions: ["tabs"] };
const groupsAccess = { permissions: ["tabGroups"] };
const spaceGroupColors = { violet: "purple", blue: "blue", mint: "green", amber: "orange" };
let opening = Promise.resolve();

export async function forgetSpaceWindow(id) {
  await chrome.storage.session.remove([savedWindowKey(id), savedGroupsKey(id)]).catch(() => {});
}

class SpaceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function normalWindow(window) {
  return Number.isInteger(window?.id) && window.id >= 0 && !window.incognito && window.type === "normal";
}

async function browserWindow(windowId) {
  const window = Number.isInteger(windowId) && windowId >= 0
    ? await chrome.windows.get(windowId)
    : await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  if (!normalWindow(window)) throw new SpaceError("spaceWindowUnavailable");
  return window;
}

async function captureBundle(windowId, activeOnly) {
  const window = await browserWindow(windowId);
  const listed = await chrome.tabs.query({ windowId: window.id, ...(activeOnly ? { active: true } : {}) });
  const candidates = listed.sort((a, b) => a.index - b.index).flatMap(tab => {
    const url = !tab.incognito && (spaceUrl(tab.pendingUrl) || spaceUrl(tab.url));
    return url ? [{ tab, url }] : [];
  });
  if (!candidates.length) throw new SpaceError(activeOnly ? "spaceNoActiveTab" : "spaceNoTabs");
  if (candidates.length > spaceLimits.tabs) throw new SpaceError("spaceTabLimit");

  const groups = [];
  const groupIds = new Map();
  if (!activeOnly && candidates.some(({ tab }) => tab.groupId >= 0 && !tab.pinned) && chrome.tabGroups?.query) {
    const savedGroups = await chrome.tabGroups.query({ windowId: window.id }).catch(() => []);
    for (const group of savedGroups) {
      if (!candidates.some(({ tab }) => !tab.pinned && tab.groupId === group.id)) continue;
      const id = crypto.randomUUID();
      groupIds.set(group.id, id);
      groups.push({
        id, title: (group.title ?? "").trim().slice(0, spaceLimits.name),
        color: chromeGroupColors.includes(group.color) ? group.color : "grey", collapsed: group.collapsed === true
      });
    }
  }
  let activeTabId;
  const tabs = candidates.map(({ tab, url }) => {
    const id = crypto.randomUUID();
    if (tab.active) activeTabId = id;
    return { id, url, title: (tab.title ?? "").trim().slice(0, 200), pinned: tab.pinned === true, groupId: groupIds.get(tab.groupId) ?? "" };
  });
  return { bundle: { tabs, groups, activeTabId: activeTabId ?? tabs[0].id }, skipped: listed.length - tabs.length };
}

async function saveCapture(message, windowId, queueWorkspace) {
  const captured = await captureBundle(windowId, message.mode === "active");
  return queueWorkspace(async () => {
    const workspace = await readWorkspace();
    const spaces = workspace.spaces ?? [];
    let space;
    if (message.mode === "create") {
      const error = updateSpaces(workspace, "save-space", {
        name: message.name, notes: message.notes, color: message.color
      });
      if (error) throw new SpaceError(error);
      [space] = workspace.spaces;
    } else {
      space = spaces.find(item => item.id === message.id);
      if (!space) throw new SpaceError("spaceMissing");
      if (message.mode === "replace" && message.expectedUpdatedAt !== space.updatedAt) throw new SpaceError("spaceChanged");
    }

    const replacing = message.mode === "create" || message.mode === "replace";
    const { bundle, added } = replacing ? { bundle: captured.bundle, added: captured.bundle.tabs.length }
      : appendSpaceBundle(space, captured.bundle);
    if (!added) throw new SpaceError("spaceAlreadySaved");
    if (bundle.tabs.length > spaceLimits.tabs) throw new SpaceError("spaceTabLimit");
    if (spaceTabsTaken(spaces, bundle.tabs, space.id)) throw new SpaceError("spaceDuplicateTabs");
    Object.assign(space, bundle, { updatedAt: Date.now() });
    await chrome.storage.local.set({ [storageKey]: workspace });
    return { id: space.id, count: added, skipped: captured.skipped };
  });
}

async function restoreGroups(space, windowId, created, active, canGroup, matchedGroups) {
  let degraded = false;
  for (const group of space.groups) {
    const tabIds = space.tabs.filter(tab => tab.groupId === group.id && created.has(tab.id)).map(tab => created.get(tab.id));
    if (!tabIds.length) continue;
    if (!canGroup) {
      degraded = true;
      continue;
    }
    try {
      const existing = matchedGroups.get(group.id);
      if (existing !== undefined) await chrome.tabs.group({ tabIds, groupId: existing });
      else {
        const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, {
          title: group.title, color: group.color, collapsed: group.collapsed && !tabIds.includes(active)
        });
      }
    } catch {
      degraded = true;
    }
  }
  return degraded;
}

async function restoreSpaceGroup(space, windowId, groupId, tabIds, savedGroups) {
  if (groupId === undefined && !tabIds.length) return false;
  const saveGroup = entry => chrome.storage.session.set({ [savedGroupsKey(space.id)]: { ...savedGroups, [windowId]: entry } }).catch(() => {});
  try {
    if (tabIds.length) {
      // A retry can reuse these tabs if Chrome opens them but rejects the grouping operation.
      await saveGroup({ groupId, pending: tabIds });
      groupId = await chrome.tabs.group(groupId === undefined
        ? { tabIds, createProperties: { windowId } }
        : { tabIds, groupId });
      if (!Number.isInteger(groupId)) return true;
      await saveGroup({ groupId });
    }
    await chrome.tabGroups.update(groupId, { title: space.name, color: spaceGroupColors[space.color] ?? "purple" });
    return false;
  } catch {
    return true;
  }
}

async function openSpace(space, { mode, windowId, canReadTabs, canGroup, focused }) {
  if (!space.tabs.length) throw new SpaceError("spaceEmpty");
  const key = savedWindowKey(space.id);
  const grouped = mode === "group";
  if (grouped && (!canReadTabs || (!canGroup && space.tabs.some(tab => !tab.pinned)))) {
    throw new SpaceError("spaceGroupPermission");
  }
  let target;
  let createdWindow = false;
  let starter;
  const tabs = [...space.tabs.filter(tab => tab.pinned), ...space.tabs.filter(tab => !tab.pinned)];
  if (mode !== "window") target = await browserWindow(windowId);
  else {
    const entry = (await chrome.storage.session.get(key).catch(() => ({})))[key];
    if (entry) {
      target = await chrome.windows.get(entry.windowId).catch(() => undefined);
      if (!normalWindow(target)) target = undefined;
      if (target && !canReadTabs && entry.updatedAt === space.updatedAt) {
        if (focused) await chrome.windows.update(target.id, { focused: true });
        return { focused: true, count: 0 };
      }
      if (!canReadTabs) target = undefined;
    }
    if (!target) {
      target = await chrome.windows.create({ url: tabs[0].url, focused, type: "normal" });
      if (!normalWindow(target)) throw new SpaceError("spaceOpenFailed");
      starter = target.tabs?.[0] ?? (await chrome.tabs.query({ windowId: target.id }))[0];
      if (!Number.isInteger(starter?.id)) throw new SpaceError("spaceOpenFailed");
      createdWindow = true;
    }
  }

  const matched = new Map();
  const created = new Map();
  const matchedGroups = new Map();
  const pendingGroupTabs = new Set();
  const pendingGroupMembers = new Set();
  let savedGroups;
  let spaceGroupId;
  let missed = 0;
  let degraded = false;
  if (createdWindow) {
    const first = tabs[0];
    matched.set(first.id, starter.id);
    created.set(first.id, starter.id);
    if (first.pinned) {
      try { await chrome.tabs.update(starter.id, { pinned: true }); }
      catch { degraded = true; }
    }
  } else {
    const openTabs = await chrome.tabs.query({ windowId: target.id });
    if (grouped) {
      const groupKey = savedGroupsKey(space.id);
      savedGroups = (await chrome.storage.session.get(groupKey).catch(() => ({})))[groupKey] ?? {};
      const entry = savedGroups[target.id];
      const candidate = entry?.groupId;
      if (Number.isInteger(candidate) && openTabs.some(tab => tab.groupId === candidate)) spaceGroupId = candidate;
      for (const id of entry?.pending ?? []) pendingGroupTabs.add(id);
    }
    const matchKey = (tab, url) => grouped ? `${tab.pinned === true}:${url}` : url;
    const available = new Map();
    for (const tab of openTabs) {
      const url = spaceUrl(tab.pendingUrl) || spaceUrl(tab.url);
      if (!url || !Number.isInteger(tab.id) || tab.incognito) continue;
      // Only reuse pinned tabs or links in the group already opened by Ease.
      if (grouped && !tab.pinned) {
        const inGroup = spaceGroupId !== undefined && tab.groupId === spaceGroupId;
        const pending = !(tab.groupId >= 0) && pendingGroupTabs.has(tab.id);
        if (!inGroup && !pending) continue;
      }
      const key = matchKey(tab, url);
      if (!available.has(key)) available.set(key, []);
      available.get(key).push(tab);
    }
    for (const tab of tabs) {
      const sibling = available.get(matchKey(tab, tab.url))?.shift();
      if (!sibling) continue;
      matched.set(tab.id, sibling.id);
      if (grouped && !tab.pinned && !(sibling.groupId >= 0)) pendingGroupMembers.add(sibling.id);
      if (mode === "window" && tab.groupId && sibling.groupId >= 0 && !matchedGroups.has(tab.groupId)) {
        matchedGroups.set(tab.groupId, sibling.groupId);
      }
    }
  }

  for (const tab of tabs) {
    if (matched.has(tab.id)) continue;
    try {
      const opened = await chrome.tabs.create({ windowId: target.id, url: tab.url, pinned: tab.pinned, active: false });
      if (!Number.isInteger(opened?.id)) throw new Error("Tab unavailable");
      matched.set(tab.id, opened.id);
      created.set(tab.id, opened.id);
    } catch {
      missed += 1;
    }
  }

  if (!matched.size) throw new SpaceError("spaceOpenFailed");
  const active = matched.get(space.activeTabId);
  if (active !== undefined && (mode === "window" ? createdWindow || created.size > 0 : focused)) {
    await chrome.tabs.update(active, { active: true }).catch(() => { degraded = true; });
  }
  if (grouped) {
    const tabIds = tabs.flatMap(tab => {
      const id = matched.get(tab.id);
      return !tab.pinned && (created.has(tab.id) || pendingGroupMembers.has(id)) ? [id] : [];
    });
    const groupFailed = await restoreSpaceGroup(space, target.id, spaceGroupId, tabIds, savedGroups);
    degraded ||= groupFailed;
  } else if (created.size) {
    const groupsFailed = await restoreGroups(space, target.id, created, active, canGroup, matchedGroups);
    degraded ||= groupsFailed;
  }
  if (mode === "window") {
    if (!createdWindow && focused) await chrome.windows.update(target.id, { focused: true }).catch(() => { degraded = true; });
    await chrome.storage.session.set({ [key]: { windowId: target.id, updatedAt: space.updatedAt } }).catch(() => {});
  }
  return { count: created.size, missed, degraded, focused: mode === "window" && !created.size };
}

export function openSavedSpace(id, { mode = "window", windowId, focused = true } = {}) {
  const open = opening.then(async () => {
    const workspace = await readWorkspace();
    const space = workspace.spaces?.find(space => space.id === id);
    if (!space) throw new SpaceError("spaceMissing");
    const [canReadTabs, canGroup] = await Promise.all([
      chrome.permissions.contains(tabsAccess), chrome.permissions.contains(groupsAccess)
    ]);
    return openSpace(space, { mode, windowId, canReadTabs, canGroup, focused });
  });
  opening = open.catch(() => {});
  return open;
}

export function registerSpaceHandlers(queueWorkspace) {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const workspaceUrl = chrome.runtime.getURL("workspace.html");
    if (message?.type !== spacesMessage || sender.id !== chrome.runtime.id || sender.tab?.incognito
      || !(sender.url === workspaceUrl || sender.url?.startsWith(workspaceUrl + "?"))) return;

    const capture = message.action === "capture" && ["create", "append", "active", "replace"].includes(message.mode);
    const restore = message.action === "open" && ["here", "window", "group"].includes(message.mode);
    if ((!capture && !restore) || (message.mode === "create" ? typeof message.name !== "string" || !message.name.trim()
      : !spaceIdValid(message.id))) {
      respond({ error: "saveFailed" });
      return;
    }

    const grants = [];
    if (capture || message.mode === "here" || message.mode === "group") grants.push("tabs");
    if ((capture && message.mode !== "active") || (restore && (message.groups === true || message.mode === "group"))) {
      grants.push("tabGroups");
    }
    // Invoke the prompt on this message hop so it can outlive the toolbar popup.
    const allowed = grants.length ? chrome.permissions.request({ permissions: grants }).catch(() => false) : Promise.resolve(true);
    const windowId = Number.isInteger(message.windowId) && message.windowId >= 0 ? message.windowId : sender.tab?.windowId;
    const result = allowed.then(async granted => {
      if (!granted && message.mode === "group") throw new SpaceError("spaceGroupPermission");
      if (!granted && (capture || message.mode === "here")) throw new SpaceError("spaceTabPermission");
      if (capture) return saveCapture(message, windowId, queueWorkspace);
      return openSavedSpace(message.id, { mode: message.mode, windowId });
    });
    result.then(respond, error => respond({ error: error instanceof SpaceError ? error.code : capture ? "spaceSaveFailed" : "spaceOpenFailed" }));
    return true;
  });
}
