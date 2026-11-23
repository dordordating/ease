export const spaceLimits = Object.freeze({ spaces: 40, tabs: 60, name: 64, notes: 500, url: 2048 });
export const spaceColors = ["violet", "blue", "mint", "amber"];
export const chromeGroupColors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
export const spaceIdValid = value => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);

export function spaceUrl(value) {
  if (typeof value !== "string" || value.length > spaceLimits.url) return "";
  try {
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > spaceLimits.url) return "";
    return url.href;
  } catch {
    return "";
  }
}

const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;

function cleanBundle(bundle) {
  if (!Array.isArray(bundle?.tabs) || !Array.isArray(bundle.groups) || bundle.tabs.length > spaceLimits.tabs
    || bundle.groups.length > bundle.tabs.length) return null;
  const groupIds = new Set();
  const groups = [];
  for (const group of bundle.groups) {
    if (!spaceIdValid(group?.id) || groupIds.has(group.id) || !chromeGroupColors.includes(group.color)) return null;
    groupIds.add(group.id);
    groups.push({ id: group.id, title: text(group.title, spaceLimits.name), color: group.color, collapsed: group.collapsed === true });
  }
  const tabIds = new Set();
  const usedGroups = new Set();
  const tabs = [];
  for (const tab of bundle.tabs) {
    const url = spaceUrl(tab?.url);
    if (!url || !spaceIdValid(tab.id) || tabIds.has(tab.id) || (tab.groupId && !groupIds.has(tab.groupId))) return null;
    const pinned = tab.pinned === true;
    const groupId = pinned ? "" : tab.groupId || "";
    if (groupId) usedGroups.add(groupId);
    tabIds.add(tab.id);
    tabs.push({ id: tab.id, url, title: text(tab.title, 200), pinned, groupId });
  }
  return {
    tabs, groups: groups.filter(group => usedGroups.has(group.id)),
    activeTabId: tabIds.has(bundle.activeTabId) ? bundle.activeTabId : tabs[0]?.id ?? ""
  };
}

export function restoreSpaces(value = []) {
  if (!Array.isArray(value) || value.length > spaceLimits.spaces) return null;
  const ids = new Set();
  const spaces = [];
  for (const item of value) {
    const bundle = cleanBundle(item);
    const name = text(item?.name, spaceLimits.name);
    if (!bundle || !name || !spaceIdValid(item.id) || ids.has(item.id) || !validTime(item.createdAt) || !validTime(item.updatedAt)) return null;
    ids.add(item.id);
    spaces.push({
      id: item.id, name, color: spaceColors.includes(item.color) ? item.color : "violet",
      notes: text(item.notes, spaceLimits.notes), favorite: item.favorite === true,
      createdAt: item.createdAt, updatedAt: item.updatedAt, ...bundle
    });
  }
  return spaces;
}

export function appendSpaceBundle(space, next) {
  const seen = new Set(space.tabs.map(tab => tab.url));
  const tabs = next.tabs.filter(tab => {
    if (seen.has(tab.url)) return false;
    seen.add(tab.url);
    return true;
  });
  const groupIds = new Set(tabs.map(tab => tab.groupId));
  if (!tabs.length) return { bundle: space, added: 0 };
  return {
    bundle: {
      tabs: [...space.tabs, ...tabs],
      groups: [...space.groups, ...next.groups.filter(group => groupIds.has(group.id))],
      activeTabId: space.activeTabId || tabs.find(tab => tab.id === next.activeTabId)?.id || tabs[0].id
    },
    added: tabs.length
  };
}

export function updateSpaces(workspace, action, data) {
  const spaces = workspace.spaces ?? [];
  const existing = spaces.find(item => item.id === data.id);
  if (data.id && !existing) return "spaceMissing";
  if (action === "remove-space") {
    if (!existing) return "spaceMissing";
    workspace.spaces = spaces.filter(item => item !== existing);
    if (workspace.todo?.items.some(task => task.spaceId === data.id)) {
      workspace.todo = { ...workspace.todo, items: workspace.todo.items.map(task => {
        if (task.spaceId !== data.id) return task;
        const { spaceId, ...rest } = task;
        return rest;
      }) };
    }
    return;
  }

  let next;
  if (action === "save-space") {
    const name = text(data.name, spaceLimits.name);
    if (!name) return "spaceNameRequired";
    if (!existing && spaces.length >= spaceLimits.spaces) return "spaceLimit";
    const id = existing?.id ?? (spaceIdValid(data.newId) && !spaces.some(space => space.id === data.newId) ? data.newId : crypto.randomUUID());
    const bundle = existing ?? { id, createdAt: Date.now(), favorite: false, tabs: [], groups: [], activeTabId: "" };
    next = { ...bundle, name, notes: text(data.notes, spaceLimits.notes), color: spaceColors.includes(data.color) ? data.color : bundle.color ?? "violet" };
  } else {
    if (!existing) return "spaceMissing";
    next = { ...existing };
    if (action === "space-favorite") next.favorite = data.favorite === true;
    else if (action === "space-remove-tab") {
      if (!existing.tabs.some(tab => tab.id === data.tabId)) return "spaceTabMissing";
      const tabs = existing.tabs.filter(tab => tab.id !== data.tabId);
      const groups = existing.groups.filter(group => tabs.some(tab => tab.groupId === group.id));
      Object.assign(next, cleanBundle({ ...existing, tabs, groups }));
    } else if (action === "space-add-links") {
      if (typeof data.links !== "string" || data.links.length > (spaceLimits.url + 1) * spaceLimits.tabs) return "spaceTabLimit";
      const urls = data.links.split(/\r?\n/u).map(link => link.trim()).filter(Boolean).map(spaceUrl);
      if (!urls.length || urls.some(url => !url)) return "spaceInvalidLinks";
      const tabs = urls.map(url => ({ id: crypto.randomUUID(), url, title: "", pinned: false, groupId: "" }));
      const { bundle, added } = appendSpaceBundle(existing, { tabs, groups: [] });
      if (!added) return "spaceAlreadySaved";
      if (bundle.tabs.length > spaceLimits.tabs) return "spaceTabLimit";
      Object.assign(next, bundle);
    } else return "saveFailed";
  }
  next.updatedAt = Date.now();
  workspace.spaces = existing ? spaces.map(item => item === existing ? next : item) : [next, ...spaces];
  return undefined;
}
