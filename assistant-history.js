import {
  rateAssistantHistory, readAssistantHistory, readAssistantHistoryEntry, removeAssistantHistory,
  setAssistantHistoryEnabled, watchAssistantHistory
} from "./assistant-history-store.js";
import { assistantHistoryMessage } from "./ease-api.js";
import { renderAssistantDrafts } from "./assistant-actions.js";

const statuses = {
  submitted: "assistantHistorySubmitted",
  complete: "assistantHistoryCompleted",
  stopped: "assistantStopped",
  failed: "assistantHistoryFailedRequest",
};
const categoryLabels = {
  task: "todo", event: "calendar", snippet: "clipboard", reply: "mail", mail: "mail", flashcard: "flashcards",
  tab: "spaces", page: "assistantSourcePage", selection: "assistantSourceSelection", workflow: "assistantHistoryWorkflow",
  market: "markets", weather: "assistantWeather", shopping: "shopping",
};

export function renderAssistantHistory(options) {
  const { node, glyph, button, t, locale, dateLocale, onCopy, onReuse, confirmClear, reportError } = options;
  const root = node("section", "assistant-history");
  root.id = "assistant-history";
  root.setAttribute("aria-label", t("assistantHistory"));

  const dateTime = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" });
  const numbers = new Intl.NumberFormat(locale);
  let accountId;
  let entryId;
  let page = 1;
  let revision = 0;
  let visible = false;
  let focusBack = false;
  const unsubscribe = watchAssistantHistory(event => {
    if (visible && event?.accountId === accountId) refresh();
  });

  function dateLabel(createdAt) {
    const date = new Date(createdAt);
    const time = node("time", "", dateTime.format(date));
    time.dateTime = date.toISOString();
    return time;
  }

  function label(entry) {
    return t(categoryLabels[entry.category] ?? "assistant");
  }

  function layout(items) {
    root.replaceChildren(...items);
    root.removeAttribute("aria-busy");
  }

  async function changeServer(accountId, action, requestId, feedback) {
    const result = await chrome.runtime.sendMessage({ type: assistantHistoryMessage, accountId, action, requestId, feedback });
    if (!result?.ok) throw new Error("Assistant history request failed");
  }

  async function change(operation) {
    const currentAccount = accountId;
    if (!currentAccount || !visible) return;
    try {
      await operation(currentAccount);
    } catch {
      if (accountId === currentAccount && visible) {
        reportError("assistantHistoryFailed");
        refresh();
      }
    }
  }

  function listView({ entries, pageCount, enabled }) {
    const settings = node("div", "assistant-history-settings");
    const toggleLabel = node("label", "assistant-history-toggle");
    const toggle = node("input", "home-widget-switch");
    toggle.type = "checkbox";
    toggle.setAttribute("role", "switch");
    toggle.checked = enabled;
    toggle.addEventListener("change", () => {
      toggle.disabled = true;
      change(id => setAssistantHistoryEnabled(id, toggle.checked));
    });
    toggleLabel.append(node("span", "", t("assistantHistorySave")), toggle);
    settings.append(toggleLabel);
    settings.append(button(t("assistantHistoryClear"), "icon-button assistant-history-delete", {
      symbol: "trash", iconOnly: true, onClick: () => {
        const id = accountId;
        confirmClear(async () => {
          if (id !== accountId) return false;
          try {
            await removeAssistantHistory(id);
            await changeServer(id, "clear");
            return true;
          } catch {
            reportError("assistantHistoryFailed");
            return false;
          }
        });
      }
    }));
    if (!entries.length) {
      layout([settings, node("p", "assistant-history-empty", t("assistantHistoryEmpty"))]);
      return;
    }

    const list = node("ul", "assistant-history-list");
    for (const entry of entries) {
      const item = node("li");
      const row = button(entry.prompt, "assistant-history-row");
      row.id = `assistant-history-row-${entry.id}`;
      row.firstChild.className = "assistant-history-prompt";
      row.firstChild.dir = "auto";
      row.addEventListener("click", () => openEntry(entry.id));
      const metadata = node("span", "assistant-history-meta");
      metadata.append(dateLabel(entry.createdAt), node("span", "", label(entry)));
      if (entry.status !== "complete") metadata.append(node("span", "assistant-history-state", t(statuses[entry.status])));
      row.append(metadata, glyph("chevron-right", "assistant-history-row-arrow"));
      item.append(row);
      list.append(item);
    }
    const items = [settings];
    if (pageCount > 1) {
      const controls = node("nav", "assistant-history-pages");
      controls.setAttribute("aria-label", t("assistantHistory"));
      const older = button(t("assistantHistoryOlder"), "secondary-button", { symbol: "chevron-right", onClick: () => go(page + 1) });
      const newer = button(t("assistantHistoryNewer"), "secondary-button", { symbol: "chevron-left", onClick: () => go(page - 1) });
      newer.id = "assistant-history-newer";
      older.id = "assistant-history-older";
      newer.disabled = page === 1;
      older.disabled = page === pageCount;
      const counter = node("span", "", t("assistantHistoryPage", { page: numbers.format(page), count: numbers.format(pageCount) }));
      counter.setAttribute("role", "status");
      controls.append(newer, counter, older);
      items.push(controls);
    }
    items.push(list);
    layout(items);
  }

  function detailView(entry) {
    const actions = node("div", "assistant-history-toolbar");
    const previous = button(t("calendarBack"), "secondary-button", {
      symbol: "chevron-left", onClick: () => {
        const id = entryId;
        entryId = undefined;
        refresh().then(() => document.getElementById(`assistant-history-row-${id}`)?.focus());
      }
    });
    previous.id = "assistant-history-back";
    actions.append(previous, button(t("remove"), "icon-button assistant-history-delete", {
      symbol: "trash", iconOnly: true, onClick: () => change(async id => {
        await changeServer(id, "remove", entry.id);
        await removeAssistantHistory(id, entry.id);
      })
    }));
    const metadata = node("p", "assistant-history-meta");
    metadata.append(dateLabel(entry.createdAt), node("span", "", label(entry)), node("span", "", t(statuses[entry.status])));
    const prompt = node("p", "assistant-history-detail-prompt", entry.prompt);
    prompt.dir = "auto";
    const response = node("div", "assistant-history-detail-answer");
    const text = node("div", "assistant-answer-text", entry.answer || t(entry.error ?? "assistantHistoryNoAnswer"));
    text.dir = "auto";
    response.append(text);
    const footer = node("div", "assistant-history-footer");
    const reuse = button(t("assistantHistoryReuse"), "secondary-button", { symbol: "refresh", onClick: () => onReuse(entry.prompt) });
    footer.append(reuse);
    if (entry.answer) {
      footer.append(button(t("copy"), "icon-button", { symbol: "copy", iconOnly: true, onClick: () => onCopy(entry.answer) }));
    }
    if (entry.status === "complete") {
      const feedback = node("div", "assistant-history-feedback");
      for (const [value, symbol, key] of [
        ["helpful", "thumb-up", "assistantHistoryHelpful"], ["unhelpful", "thumb-down", "assistantHistoryUnhelpful"]
      ]) {
        const control = button(t(key), "icon-button", {
          symbol, iconOnly: true, onClick: () => {
            control.disabled = true;
            change(async id => {
              await rateAssistantHistory(id, entry.id, value);
              await changeServer(id, "rate", entry.id, value);
            });
          }
        });
        control.id = `assistant-history-feedback-${value}`;
        control.setAttribute("aria-pressed", String(entry.feedback === value));
        feedback.append(control);
      }
      footer.append(feedback);
    }
    const focused = root.contains(document.activeElement) ? document.activeElement.id : null;
    const drafts = renderAssistantDrafts(entry.drafts, options);
    layout([actions, metadata, prompt, response, ...(drafts ? [drafts] : []), footer]);
    if (focusBack) {
      focusBack = false;
      previous.focus();
    } else if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  }

  async function refresh() {
    const version = ++revision;
    const id = accountId;
    const isCurrent = () => revision === version && visible && id === accountId;
    if (!id) {
      layout([node("p", "assistant-history-empty", t("assistantSignIn"))]);
      return;
    }
    root.setAttribute("aria-busy", "true");
    try {
      if (entryId) {
        const { entry } = await readAssistantHistoryEntry(id, entryId);
        if (!isCurrent()) return;
        if (entry) {
          detailView(entry);
          return;
        }
        entryId = undefined;
      }
      const response = await readAssistantHistory(id, page);
      if (!isCurrent()) return;
      page = response.page;
      listView(response);
    } catch {
      if (isCurrent()) layout([node("p", "assistant-history-empty", t("assistantHistoryFailed"))]);
    }
  }

  function openEntry(id) {
    entryId = id;
    focusBack = Boolean(id);
    return refresh();
  }

  function go(next) {
    const focused = document.activeElement.id;
    page = next;
    refresh().then(() => {
      if (!visible) return;
      root.scrollIntoView({ block: "nearest" });
      const control = document.getElementById(focused);
      if (control && !control.disabled) control.focus({ preventScroll: true });
      else root.querySelector(".assistant-history-pages button:enabled")?.focus({ preventScroll: true });
    });
  }

  return {
    root,
    show(id) {
      visible = true;
      root.hidden = false;
      if (id) openEntry(id);
      else refresh();
    },
    hide() {
      visible = false;
      revision += 1;
      root.hidden = true;
    },
    updateAccount(id) {
      if (id === accountId) return;
      accountId = id;
      entryId = undefined;
      page = 1;
      root.replaceChildren();
      if (visible) refresh();
    },
    dispose: unsubscribe
  };
}
