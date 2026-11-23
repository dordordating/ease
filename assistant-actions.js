import { calendarReminderLabel } from "./calendar-timing.js";
import { taskDateValid, taskLink, taskTimestamp } from "./todo-store.js";

const actions = {
  task: ["assistantTaskAction", "todo"],
  event: ["assistantEventAction", "calendar"],
  snippet: ["assistantSnippetAction", "clipboard"],
  reply: ["assistantReplyAction", "reply"],
  flashcard: ["assistantFlashcardAction", "flashcards"]
};
const quickActions = new Set(["task", "snippet", "flashcard"]);

export function prepareAssistantDrafts(suggestions, sources, labels) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.slice(0, 4).flatMap(action => {
    if (!action || !Object.hasOwn(actions, action.kind)) return [];
    const source = sources.find(source => source.id === action.source);
    if (action.kind === "reply" && source?.kind !== "mail") return [];
    const label = action.kind === "task" ? labels.get(action.label) ?? labels.values().next().value : undefined;
    return [{ action, source, labelId: label?.id }];
  });
}

export function archiveAssistantDrafts(drafts) {
  return drafts.map(({ action, source, labelId }) => {
    if (!source) return { action, labelId };
    const { label, spaceId, message, reply } = source;
    const reference = { label, url: taskLink(source.url), spaceId };
    if (message) {
      const { id, accountId, subject, sender, senderAddress, folder, uidValidity, url } = message;
      reference.message = { id, accountId, subject, sender, senderAddress, folder, uidValidity, url: taskLink(url) };
    }
    if (reply && action.kind === "reply") {
      const { replyAddress, messageId, references, threadId } = reply;
      reference.reply = { replyAddress, messageId, references, threadId };
    }
    return { action, labelId, source: reference };
  });
}

export function renderAssistantDrafts(drafts, { node, button, glyph, t, locale, dateLocale, taskLabelFor, onAction, reportError }, saved) {
  if (!drafts?.length) return undefined;
  const group = node("div", "assistant-actions");
  group.append(node("h4", "assistant-actions-heading", t("assistantActions")));
  const days = new Intl.DateTimeFormat(dateLocale, { weekday: "short", month: "short", day: "numeric" });
  const clock = new Intl.DateTimeFormat(dateLocale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const numbers = new Intl.NumberFormat(locale);

  function describeTime(action) {
    if (!taskDateValid(action.date)) return "";
    const times = [action.start ?? action.time, action.end].map(time => taskTimestamp(action.date, time));
    const timing = times.filter(time => time !== null).map(time => clock.format(time)).join("–");
    const reminder = action.reminder == null ? "" : calendarReminderLabel(t, numbers, action.reminder);
    return [days.format(new Date(`${action.date}T12:00`)), timing, reminder].filter(Boolean).join(" · ");
  }

  drafts.forEach(({ action, source, labelId }, index) => {
    const [label, symbol] = actions[action.kind];
    const row = node("div", "assistant-action");
    const title = node("bdi", "assistant-action-title", action.title ?? action.front ?? source?.label ?? t(label));
    const taskLabel = action.kind === "task" ? taskLabelFor(labelId) : undefined;
    const excerpt = action.body || action.text || action.back || action.notes;
    const info = node("div", "assistant-action-copy");
    const timing = describeTime(action);
    info.append(title);
    if (timing) info.append(node("small", "", timing));
    if (taskLabel) {
      const chip = node("bdi", "todo-label assistant-task-label", taskLabel.name);
      chip.style.setProperty("--label-color", taskLabel.color);
      info.append(chip);
    }
    if (action.checklist?.length) {
      const list = node("ul", "assistant-action-checklist");
      for (const text of action.checklist.slice(0, 3)) {
        const item = node("li", "", text);
        item.dir = "auto";
        list.append(item);
      }
      info.append(list);
      if (action.checklist.length > 3) info.append(node("small", "", t("todoChecklistProgress", {
        done: numbers.format(0), total: numbers.format(action.checklist.length)
      })));
    } else if (excerpt) {
      const detail = node("p", "", excerpt);
      detail.dir = "auto";
      info.append(detail);
    }
    const alreadySaved = Boolean(saved?.has(index));
    const status = action.kind === "reply" ? "mailSent" : "assistantSaved";
    const controls = node("div", "assistant-action-buttons");
    const review = button(t(alreadySaved ? status : label), "assistant-action-review", {
      symbol: alreadySaved ? "check" : "arrow", onClick: () => apply(false)
    });
    const quick = saved && !alreadySaved && quickActions.has(action.kind) ? button(t("assistantSaveNow"), "assistant-action-quick", {
      symbol: "check", onClick: () => apply(true)
    }) : undefined;
    review.disabled = alreadySaved;
    controls.append(review);
    if (quick) controls.append(quick);
    row.append(glyph(symbol, "assistant-action-icon"), info, controls);
    group.append(row);

    async function apply(immediately) {
      if (review.disabled) return;
      review.disabled = true;
      if (quick) quick.disabled = true;
      try {
        await onAction(action, source, {
          immediately, labelId: taskLabel?.id, onSaved() {
            if (!saved) return;
            saved.add(index);
            review.replaceChildren(glyph("check"), node("span", "", t(status)));
            review.disabled = true;
            quick?.remove();
          }
        });
      } catch {
        reportError("saveFailed");
      } finally {
        review.disabled = Boolean(saved?.has(index));
        if (quick) quick.disabled = false;
      }
    }
  });
  return group;
}
