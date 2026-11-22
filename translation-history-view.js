function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function previewText(text) {
  const prefix = text.match(/^.{0,140}/su)[0];
  const lines = prefix.split(/\r?\n/, 4);
  return prefix.length === text.length && lines.length <= 3
    ? text : `${lines.slice(0, 3).join("\n").trimEnd()}…`;
}

export function renderTranslationHistory(container, { locale, dateLocale = locale, t, icon, state, onCopy, onDelete, onFlashcard }) {
  const languageNames = new Intl.DisplayNames([locale], { type: "language" });
  const dates = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" });
  const section = element("section", "translation-history");
  const list = element("ol", "translation-history-list");
  const empty = element("div", "translation-history-empty");
  const emptyIcon = element("span", "translation-history-empty-icon");
  emptyIcon.innerHTML = icon("history");
  const emptyTitle = element("h2");
  emptyTitle.tabIndex = -1;
  const emptyHint = element("p");
  empty.append(emptyIcon, emptyTitle, emptyHint);
  section.append(list, empty);
  container.append(section);
  let current;
  let entries = new Map();

  function languageName(code) {
    if (!code || code === "auto") return "";
    try {
      return languageNames.of(code);
    } catch {
      return code;
    }
  }

  function actionButton(action, label, symbol, listener) {
    const button = element("button", "icon-button translation-history-action");
    button.type = "button";
    button.dataset.historyAction = action;
    button.title = t(label);
    button.setAttribute("aria-label", button.title);
    button.innerHTML = icon(symbol);
    button.addEventListener("click", async () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      button.setAttribute("aria-disabled", "true");
      try {
        await listener(button);
      } finally {
        button.removeAttribute("aria-disabled");
      }
    });
    return button;
  }

  function entryHeader(entry, nodeId) {
    const header = element("div", "translation-history-header");
    const meta = element("div", "translation-history-meta");
    meta.id = `${nodeId}-meta`;
    const pair = element("div", "translation-history-languages");
    const sourceName = languageName(entry.source);
    if (sourceName) {
      const arrow = element("span", "translation-history-arrow");
      arrow.innerHTML = icon("arrow");
      pair.append(element("bdi", "", sourceName), arrow);
    }
    pair.append(element("bdi", "", languageName(entry.target)));
    meta.append(pair);
    const timestamp = entry.createdAt == null ? null : new Date(entry.createdAt);
    if (timestamp && Number.isFinite(timestamp.getTime())) {
      const time = element("time", "translation-history-time", dates.format(timestamp));
      time.dateTime = timestamp.toISOString();
      meta.append(time);
    }
    const actions = element("div", "translation-history-actions");
    let copyFeedbackTimer;
    const copy = actionButton("copy", "translatorCopy", "copy", async (button) => {
      if (await onCopy(entry) !== true || !button.isConnected) return;
      button.innerHTML = icon("check");
      button.dataset.copied = "true";
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(() => {
        button.innerHTML = icon("copy");
        delete button.dataset.copied;
      }, 1400);
    });
    const flashcard = actionButton("flashcard", "translatorAddFlashcard", "flashcards", () => onFlashcard(entry));
    const remove = actionButton("delete", "translationHistoryRemove", "trash", () => onDelete(entry));
    actions.append(copy, flashcard, remove);
    header.append(meta, actions);
    return header;
  }

  function entryContent(entry, nodeId, startExpanded) {
    const content = element("dl", "translation-history-content");
    content.id = `${nodeId}-content`;
    const parts = [
      ["translatorInput", entry.text, entry.source, "original"],
      ["translatorOutput", entry.translation, entry.target, "translated"]
    ].map(([label, text, language, kind]) => {
      const block = element("div", "translation-history-block");
      block.dataset.kind = kind;
      const body = element("dd", "translation-history-text");
      body.dir = "auto";
      if (language && language !== "auto") body.lang = language;
      block.append(element("dt", "", t(label)), body);
      content.append(block);
      return { body, text, preview: previewText(text) };
    });
    const expandable = parts.some(({ text, preview }) => text !== preview);
    const toggle = expandable ? element("button", "translation-history-expand") : undefined;
    if (toggle) {
      toggle.type = "button";
      toggle.dataset.historyAction = "expand";
      toggle.setAttribute("aria-controls", content.id);
      toggle.addEventListener("click", () => setExpanded(toggle.getAttribute("aria-expanded") !== "true"));
    }
    function setExpanded(expanded) {
      for (const { body, text, preview } of parts) body.textContent = expanded ? text : preview;
      if (toggle) {
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.textContent = t(expanded ? "translationHistoryCollapse" : "translationHistoryExpand");
      }
    }
    setExpanded(startExpanded);
    return { content, toggle, setExpanded };
  }

  function renderEntry(entry, startExpanded) {
    const item = element("li", "translation-history-entry");
    item.id = `translation-history-entry-${entry.id}`;
    item.dataset.entryId = entry.id;
    item.tabIndex = -1;
    item.setAttribute("aria-labelledby", `${item.id}-meta`);
    const { content, toggle, setExpanded } = entryContent(entry, item.id, startExpanded);
    item.append(entryHeader(entry, item.id), content);
    if (toggle) item.append(toggle);
    return { item, toggle, setExpanded };
  }

  function update(nextState) {
    if (nextState === current) return;
    const active = document.activeElement;
    const focusedItem = list.contains(active) ? active.closest(".translation-history-entry") : null;
    const focusedId = focusedItem?.dataset.entryId;
    const focusIndex = focusedItem ? Array.from(list.children).indexOf(focusedItem) : -1;
    const action = active?.dataset.historyAction;
    const next = new Map(nextState.entries.map(entry => [entry.id,
      renderEntry(entry, entries.get(entry.id)?.toggle?.getAttribute("aria-expanded") === "true")
    ]));
    list.replaceChildren(...Array.from(next.values(), ({ item }) => item));
    current = nextState;
    entries = next;
    list.hidden = !entries.size;
    empty.hidden = Boolean(entries.size);
    if (!empty.hidden) {
      emptyTitle.textContent = t(current.enabled ? "translationHistoryEmpty" : "translationHistoryDisabled");
      emptyHint.textContent = t(current.enabled ? "translationHistoryEmptyHint" : "translationHistoryDisabledHint");
    }
    if (focusedItem) {
      const item = entries.get(focusedId)?.item ?? list.children[Math.min(focusIndex, entries.size - 1)];
      const control = action && item?.querySelector(`[data-history-action="${action}"]`);
      (control ?? item ?? emptyTitle).focus({ preventScroll: true });
    }
  }

  update(state);
  return {
    update,
    focus(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      if (entry.toggle) entry.setExpanded(true);
      entry.item.focus({ preventScroll: true });
      entry.item.scrollIntoView({ block: "start" });
      return true;
    }
  };
}
