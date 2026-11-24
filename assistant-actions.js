import { calendarReminderLabel } from "./calendar-timing.js";
import { assistantShoppingQuickSave, prepareShoppingDraft } from "./assistant-shopping.js";
import { taskDateValid, taskLink, taskTimestamp } from "./todo-store.js";

const actions = {
  task: ["assistantTaskAction", "todo"],
  event: ["assistantEventAction", "calendar"],
  snippet: ["assistantSnippetAction", "clipboard"],
  reply: ["assistantReplyAction", "reply"],
  flashcard: ["assistantFlashcardAction", "flashcards"],
  shopping: ["assistantShoppingReview", "shopping"]
};
const quickActions = new Set(["task", "snippet", "flashcard"]);

export function prepareAssistantDrafts(suggestions, sources, labels, shopping) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.slice(0, 4).flatMap(action => {
    if (!action || !Object.hasOwn(actions, action.kind)) return [];
    if (action.kind === "shopping") return prepareShoppingDraft(action, shopping) ?? [];
    const source = sources.find(source => source.id === action.source);
    if (action.kind === "reply" && source?.kind !== "mail") return [];
    const label = action.kind === "task" ? labels.get(action.label) ?? labels.values().next().value : undefined;
    return [{ action, source, labelId: label?.id }];
  });
}

export function archiveAssistantDrafts(drafts) {
  return drafts.map(({ action, source, labelId, shopping }) => {
    if (shopping) return { action, shopping };
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

export function renderAssistantDrafts(drafts, options, saved) {
  if (!drafts?.length) return undefined;
  const { node, button, glyph, t, locale, dateLocale, taskLabelFor, onAction, reportError, shoppingStatusFor, openShoppingWatch } = options;
  const group = node("div", "assistant-actions");
  const statusOnly = drafts.every(({ action }) => action.kind === "shopping" && action.operation === "status");
  group.append(node("h4", "assistant-actions-heading", t(statusOnly ? "shopping" : "assistantActions")));
  const days = new Intl.DateTimeFormat(dateLocale, { weekday: "short", month: "short", day: "numeric" });
  const clock = new Intl.DateTimeFormat(dateLocale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const numbers = new Intl.NumberFormat(locale);
  const dates = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const price = rials => t("shoppingTomanPrice", { amount: numbers.format(rials / 10) });
  const store = value => t(value === "snappshop" ? "shoppingSnappShop" : "shoppingDigikala");

  function openWatch(id) {
    return button(t("assistantShoppingOpenWatch"), "assistant-action-review", {
      symbol: "arrow", onClick: () => openShoppingWatch(id)
    });
  }

  function statusCard(id) {
    const detail = shoppingStatusFor(id);
    const row = node("div", "assistant-action assistant-shopping-status");
    const info = node("div", "assistant-action-copy");
    row.append(glyph("shopping", "assistant-action-icon"), info);
    if (!detail) {
      info.append(node("small", "", t("shoppingRuleMissing")));
      return row;
    }
    const { watch, status, quote, checkout, checkedAt } = detail;
    info.append(node("bdi", "assistant-action-title", watch.title),
      node("small", "", [store(watch.store), watch.optionLabel || watch.variantLabel, quote?.sellerName || watch.sellerName].filter(Boolean).join(" · ")),
      node("span", "shopping-status", t(status)));
    row.dataset.state = status;
    const facts = [];
    if (quote?.price) facts.push(price(quote.price));
    if (watch.priceLimit) facts.push(t("shoppingTarget", { price: price(watch.priceLimit) }));
    if (quote?.discount > 0) facts.push(percent.format(quote.discount / 100));
    if (watch.discount) facts.push(t("shoppingTargetDiscount", { discount: percent.format(watch.discount / 100) }));
    if (status === "shoppingWaitingQuantity") {
      facts.push(t("shoppingQuantityBadge", { count: numbers.format(watch.quantity ?? 1) }));
      if (Number.isSafeInteger(quote?.maxQuantity)) facts.push(t("assistantShoppingStock", { count: numbers.format(quote.maxQuantity) }));
    }
    if (status === "shoppingScheduled" && watch.startAt) facts.push(t("assistantShoppingStarts", { date: dates.format(watch.startAt) }));
    if (status === "shoppingExpired" && watch.endAt) facts.push(t("assistantShoppingEnds", { date: dates.format(watch.endAt) }));
    if (facts.length) info.append(node("small", "", facts.join(" · ")));
    if (checkout && status !== "shoppingPurchased") info.append(node("small", "", t(checkout)));
    if (checkedAt) info.append(node("small", "", t("shoppingCheckedAt", { date: dates.format(checkedAt) })));
    row.append(openWatch(id));
    return row;
  }

  function describeShopping(draft) {
    const { changes, selection, purchase } = draft;
    const parts = [];
    if (draft.store) parts.push(store(draft.store));
    if (selection.option) parts.push(selection.option);
    if (selection.seller) parts.push(selection.seller);
    if (selection.exclude.length) parts.push(t("assistantShoppingExcluded", { sellers: selection.exclude.join("، ") }));
    if (changes.priceLimit) parts.push(t("shoppingTarget", { price: price(changes.priceLimit) }));
    else if (changes.priceLimit === null) parts.push(t("assistantShoppingNoCap"));
    if (changes.discount) parts.push(t("shoppingTargetDiscount", { discount: percent.format(changes.discount / 100) }));
    else if (changes.discount === null) parts.push(t("assistantShoppingNoDiscount"));
    if (changes.quantity) parts.push(t("shoppingQuantityBadge", { count: numbers.format(changes.quantity) }));
    if (changes.startAt) parts.push(t("assistantShoppingStarts", { date: dates.format(changes.startAt) }));
    if (changes.endAt) parts.push(t("assistantShoppingEnds", { date: dates.format(changes.endAt) }));
    if (changes.paused !== undefined) parts.push(t(changes.paused ? "shoppingPause" : "shoppingResume"));
    if (purchase?.mode === "prepare") parts.push(t("assistantShoppingOrderCap", { price: price(purchase.limit) }));
    return parts;
  }

  function describeTime(action) {
    if (!taskDateValid(action.date)) return "";
    const times = [action.start ?? action.time, action.end].map(time => taskTimestamp(action.date, time));
    const timing = times.filter(time => time !== null).map(time => clock.format(time)).join("–");
    const reminder = action.reminder == null ? "" : calendarReminderLabel(t, numbers, action.reminder);
    return [days.format(new Date(`${action.date}T12:00`)), timing, reminder].filter(Boolean).join(" · ");
  }

  drafts.forEach(({ action, source, labelId, shopping }, index) => {
    if (action.kind === "shopping" && action.operation === "status") {
      for (const id of shopping?.watchIds ?? []) group.append(statusCard(id));
      return;
    }
    const [label, symbol] = actions[action.kind];
    const row = node("div", "assistant-action");
    const title = node("bdi", "assistant-action-title", shopping?.title ?? action.title ?? action.front ?? source?.label ?? t(label));
    const taskLabel = action.kind === "task" ? taskLabelFor(labelId) : undefined;
    const excerpt = action.body || action.text || action.back || action.notes;
    const info = node("div", "assistant-action-copy");
    const timing = describeTime(action);
    info.append(title);
    if (shopping) info.append(...describeShopping(shopping).map(part => node("small", "", part)));
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
    let applied = alreadySaved;
    const status = action.kind === "reply" ? "mailSent" : "assistantSaved";
    const controls = node("div", "assistant-action-buttons");
    const review = button(t(alreadySaved ? status : label), "assistant-action-review", {
      symbol: alreadySaved ? "check" : "arrow", onClick: () => apply(false)
    });
    const quick = !alreadySaved && (saved && quickActions.has(action.kind) || action.kind === "shopping" && assistantShoppingQuickSave(shopping))
      ? button(t(action.kind === "shopping" ? "assistantShoppingSave" : "assistantSaveNow"), "assistant-action-quick", {
      symbol: "check", onClick: () => apply(true)
    }) : undefined;
    review.disabled = alreadySaved;
    controls.append(review);
    if (quick) controls.append(quick);
    if (shopping && saved?.get(index)) controls.append(openWatch(saved.get(index)));
    row.append(glyph(symbol, "assistant-action-icon"), info, controls);
    group.append(row);

    async function apply(immediately) {
      if (review.disabled) return;
      review.disabled = true;
      if (quick) quick.disabled = true;
      try {
        await onAction(action, source, {
          immediately, shopping, labelId: taskLabel?.id, onSaved(id) {
            saved?.set(index, id);
            if (!saved && !shopping) return;
            applied = true;
            review.replaceChildren(glyph("check"), node("span", "", t(status)));
            review.disabled = true;
            quick?.remove();
            if (shopping && id) controls.append(openWatch(id));
          }
        });
      } catch {
        reportError("saveFailed");
      } finally {
        review.disabled = applied;
        if (quick) quick.disabled = false;
      }
    }
  });
  return group;
}
