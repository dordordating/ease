function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function previewText(text) {
  const prefix = text.match(/^.{0,160}/su)[0];
  const lines = prefix.split(/\r?\n/, 4);
  return prefix.length === text.length && lines.length <= 3
    ? text : `${lines.slice(0, 3).join("\n").trimEnd()}…`;
}

export function initClipboardHistoryView(container, {
  locale, dateLocale = locale, t, icon, state: initialState, onAllow, onStart, onCopy, onSave, onDelete
}) {
  const dates = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" });
  const panel = element("section", "clipboard-history");
  const controls = element("div", "clipboard-history-controls");
  const captureStatus = element("p", "clipboard-history-status");
  captureStatus.setAttribute("role", "status");
  const note = element("p", "clipboard-history-note", t("clipboardHistoryNote"));
  const issue = element("p", "clipboard-history-issue");
  issue.setAttribute("role", "status");
  issue.hidden = true;
  const list = element("ol", "clipboard-history-list");
  const empty = element("div", "clipboard-history-empty");
  const emptyIcon = element("span", "clipboard-history-empty-icon");
  emptyIcon.innerHTML = icon("history");
  const emptyHeading = element("h2", "", t("clipboardHistoryEmpty"));
  emptyHeading.tabIndex = -1;
  empty.append(emptyIcon, emptyHeading, element("p", "", t("clipboardHistoryEmptyHint")));
  let current;
  let entries = new Map();
  let hasStarted = false;
  let localIssue;

  function button(label, className, action, symbol, iconOnly = false) {
    const control = element("button", className);
    control.type = "button";
    if (symbol) control.innerHTML = icon(symbol);
    if (iconOnly) {
      control.title = t(label);
      control.setAttribute("aria-label", control.title);
    } else if (label) {
      control.append(element("span", "", t(label)));
    }
    control.addEventListener("click", action);
    return control;
  }

  function showIssue() {
    const key = current?.issue || localIssue;
    const text = key ? t(key) : "";
    if (issue.textContent !== text) issue.textContent = text;
    issue.hidden = !text;
  }

  async function run(control, operation, onSuccess) {
    if (control.getAttribute("aria-disabled") === "true") return;
    control.setAttribute("aria-disabled", "true");
    localIssue = undefined;
    showIssue();
    try {
      if (await operation() === true) onSuccess?.();
    } catch {
      localIssue = "clipboardHistoryFailed";
      showIssue();
    } finally {
      control.removeAttribute("aria-disabled");
    }
  }

  const toggle = button("", "primary-button clipboard-history-toggle", () => {
    run(toggle, current.allowed ? onStart : onAllow);
  });
  const toggleIcon = element("span", "clipboard-history-toggle-icon");
  const toggleLabel = element("span");
  toggle.append(toggleIcon, toggleLabel);
  controls.append(captureStatus, toggle, note);
  panel.append(controls, issue, list, empty);
  container.append(panel);

  function entryRow(entry) {
    const item = element("li", "clipboard-history-entry");
    item.id = `clipboard-history-entry-${entry.id}`;
    item.tabIndex = -1;
    item.dataset.entryId = entry.id;
    const row = { item, entry, expanded: false };
    const header = element("div", "clipboard-history-entry-header");
    const time = element("time", "clipboard-history-time");
    time.id = `${item.id}-time`;
    const actions = element("div", "clipboard-history-entry-actions");
    const text = element("p", "clipboard-history-text");
    text.dir = "auto";
    text.id = `${item.id}-content`;
    let feedbackTimer;
    function entryButton(action, label, symbol, operation, onSuccess) {
      const control = button(label, "icon-button clipboard-history-entry-action", () => {
        run(control, () => operation(row.entry), onSuccess);
      }, symbol, true);
      control.dataset.clipboardHistoryAction = action;
      control.setAttribute("aria-describedby", time.id);
      return control;
    }
    const copy = entryButton("copy", "copy", "copy", onCopy, () => {
      if (!copy.isConnected) return;
      clearTimeout(feedbackTimer);
      copy.innerHTML = icon("check");
      copy.dataset.copied = "true";
      feedbackTimer = setTimeout(() => {
        copy.innerHTML = icon("copy");
        delete copy.dataset.copied;
      }, 1400);
    });
    actions.append(copy,
      entryButton("save", "clipboardHistorySave", "folder-plus", onSave),
      entryButton("delete", "clipboardHistoryRemove", "trash", ({ id }) => onDelete(id)));
    header.append(time, actions);
    const expand = button("clipboardHistoryExpand", "clipboard-history-expand", () => {
      row.setExpanded(!row.expanded);
    });
    expand.dataset.clipboardHistoryAction = "expand";
    expand.setAttribute("aria-controls", text.id);
    row.setExpanded = (expanded) => {
      row.expanded = expanded;
      text.textContent = expanded ? row.entry.text : row.preview;
      expand.setAttribute("aria-expanded", String(expanded));
      expand.firstElementChild.textContent = t(expanded ? "clipboardHistoryCollapse" : "clipboardHistoryExpand");
    };
    row.update = (next) => {
      if (row.entry.text !== next.text || row.preview === undefined) {
        row.preview = previewText(next.text);
        row.entry = next;
        item.setAttribute("aria-label", row.preview);
        expand.hidden = row.preview === next.text;
        row.setExpanded(row.expanded && !expand.hidden);
      } else {
        row.entry = next;
      }
      const timestamp = next.createdAt == null ? null : new Date(next.createdAt);
      time.hidden = !timestamp || !Number.isFinite(timestamp.getTime());
      if (!time.hidden) {
        const value = timestamp.toISOString();
        if (value !== time.dateTime) {
          time.dateTime = value;
          time.textContent = dates.format(timestamp);
        }
      }
    };
    item.append(header, text, expand);
    row.update(entry);
    return row;
  }

  function update(next) {
    if (next === current) return;
    const active = document.activeElement;
    const previousItem = list.contains(active) ? active.closest(".clipboard-history-entry") : null;
    const previousIndex = previousItem ? Array.from(list.children).indexOf(previousItem) : -1;
    current = next;
    const capturing = next.allowed && next.active;
    hasStarted ||= capturing || Boolean(next.entries.length);
    toggle.hidden = capturing;
    if (!capturing) {
      toggleLabel.textContent = t(!next.allowed ? "clipboardHistoryAllow" : hasStarted ? "clipboardHistoryResume" : "clipboardHistoryStart");
      toggleIcon.innerHTML = icon(next.allowed ? "play" : "lock");
    } else if (active === toggle) {
      document.getElementById("clipboard-history-nav")?.focus({ preventScroll: true });
    }
    const status = t(capturing ? "clipboardHistoryActive" : "clipboardHistoryInactive");
    if (captureStatus.textContent !== status) captureStatus.textContent = status;
    captureStatus.dataset.active = String(capturing);
    showIssue();
    const nextEntries = new Map(next.entries.map(entry => {
      const existing = entries.get(entry.id);
      if (existing) existing.update(entry);
      return [entry.id, existing ?? entryRow(entry)];
    }));
    for (const [id, row] of entries) if (!nextEntries.has(id)) row.item.remove();
    // Insert new items without replacing existing controls, so background capture keeps focus.
    let cursor = list.firstElementChild;
    for (const { item } of nextEntries.values()) {
      if (item === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(item, cursor);
    }
    entries = nextEntries;
    list.hidden = !entries.size;
    empty.hidden = Boolean(entries.size);
    if (previousItem && document.activeElement !== active) {
      const row = entries.get(previousItem.dataset.entryId);
      const fallback = list.children[Math.min(previousIndex, entries.size - 1)] ?? emptyHeading;
      (row && active.isConnected ? active : fallback).focus({ preventScroll: true });
    }
  }

  update(initialState);
  return {
    update,
    focus(id) {
      const row = entries.get(id);
      if (!row) return false;
      row.setExpanded(row.preview !== row.entry.text);
      row.item.focus({ preventScroll: true });
      row.item.scrollIntoView({ block: "start" });
      return true;
    }
  };
}
