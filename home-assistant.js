import { assistantPort } from "./ease-api.js";
import { assistantExamples } from "./home-locales.js";
import { assistantLimits } from "./home-store.js";
import { calendarReminderLabel } from "./calendar-timing.js";
import { localTaskDay, taskDateValid, taskTimestamp } from "./todo-store.js";

const sourceInfo = {
  page: ["assistantSourcePage", "open-window"],
  selection: ["assistantSourceSelection", "edit"],
  mail: ["assistantSourceMail", "mail"],
  tab: ["assistantSourceTabs", "spaces"]
};
const actionInfo = {
  task: ["assistantTaskAction", "todo"],
  event: ["assistantEventAction", "calendar"],
  snippet: ["assistantSnippetAction", "clipboard"],
  reply: ["assistantReplyAction", "reply"],
  flashcard: ["assistantFlashcardAction", "flashcards"]
};
const exampleModules = { task: "todo", event: "calendar", mail: "mail", tab: "spaces", flashcard: "flashcards" };
const errors = new Set([
  "assistantBusy", "assistantLimit", "assistantUnavailable", "assistantInterrupted", "assistantInputError", "assistantSignIn"
]);
const maxTurns = 8;
const textLimit = (value, limit) => value.slice(0, limit).toWellFormed().trim();

export function renderHomeAssistant({
  node, glyph, button, t, locale, dateLocale, calendar, capture, chooseTabs, previewSource, openSource, onAction, onCopy, onSignIn, reportError
}) {
  const dateFormat = new Intl.DateTimeFormat(dateLocale, { weekday: "short", month: "short", day: "numeric" });
  const clockFormat = new Intl.DateTimeFormat(dateLocale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const numbers = new Intl.NumberFormat(locale);
  const root = node("section", "home-assistant");
  const hero = node("div", "assistant-hero");
  const title = node("h2", "", t("assistantAsk"));
  title.id = "assistant-title";
  root.setAttribute("aria-labelledby", title.id);
  const heading = node("div", "assistant-heading");
  const reset = button(t("assistantClear"), "icon-button assistant-reset", { symbol: "plus", iconOnly: true, onClick: clearConversation });
  heading.append(glyph("sparkles", "assistant-orb"), title, reset);

  const form = node("form", "assistant-form");
  const input = node("textarea", "assistant-input");
  input.id = "assistant-prompt";
  input.rows = 2;
  input.maxLength = assistantLimits.prompt;
  input.placeholder = t("assistantPrompt");
  input.setAttribute("aria-label", t("assistantPrompt"));
  input.dir = "auto";
  const sourceList = node("div", "assistant-attachments");
  const toolbar = node("div", "assistant-tools");
  const attach = node("details", "assistant-attach");
  const attachButton = node("summary", "assistant-attach-button");
  attachButton.id = "assistant-attach-button";
  attachButton.setAttribute("aria-label", t("assistantAttach"));
  attachButton.title = t("assistantAttach");
  attachButton.append(glyph("plus"), node("span", "", t("assistantAttach")));
  const attachOptions = node("div", "assistant-attach-options");
  attachOptions.append(
    button(t("assistantSourcePage"), "assistant-attach-option", { symbol: "open-window", onClick: () => attachBrowserSource("page") }),
    button(t("assistantSourceSelection"), "assistant-attach-option", { symbol: "edit", onClick: () => attachBrowserSource("selection") }),
    button(t("assistantSourceTabs"), "assistant-attach-option", { symbol: "spaces", onClick: () => {
      attach.open = false;
      if (!remainingSources()) return reportError("assistantAttachLimit");
      chooseTabs(remainingSources(), addSources);
    } })
  );
  attach.append(attachButton, attachOptions);

  const send = button(t("assistantSend"), "assistant-send", { symbol: "arrow", iconOnly: true });
  send.id = "assistant-send";
  send.type = "submit";
  toolbar.append(attach, send);
  const hint = node("p", "assistant-context-hint", t("assistantContextHint"));
  hint.id = "assistant-context-hint";
  form.append(input, sourceList, toolbar);
  const status = node("p", "assistant-status");
  status.setAttribute("role", "status");
  const signIn = button(t("signInGoogle"), "secondary-button assistant-signin", { symbol: "user", onClick: signIntoAssistant });
  const access = node("div", "assistant-access");
  access.append(status, signIn);

  const exampleArea = node("div", "assistant-examples");
  const exampleButton = node("button", "assistant-example");
  exampleButton.type = "button";
  exampleButton.append(glyph("sparkles"));
  const exampleText = node("span", "assistant-example-text");
  exampleText.dir = "auto";
  exampleText.setAttribute("aria-hidden", "true");
  exampleButton.append(exampleText);
  const next = button(t("assistantNextExample"), "icon-button assistant-example-next", {
    symbol: "refresh", iconOnly: true, onClick: () => displayExample(exampleIndex + 1)
  });
  exampleArea.append(exampleButton, next);
  const transcript = node("div", "assistant-transcript");
  hero.append(heading, form, hint, exampleArea, access);
  root.append(hero, transcript);

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const catalog = assistantExamples(locale);
  let examples = catalog;
  let exampleIndex = 0;
  let exampleTimer;
  let phase = "type", position = 0;
  let visible = false;
  let account;
  let signingIn = false;
  let active;
  let readingPage = false;
  let turnNumber = 0;
  let sourceNumber = 0;
  let sources = [];
  let turns = [];
  let modules = [];
  let languages = {};
  let assistantStatus;

  function animateExample() {
    clearTimeout(exampleTimer);
    const characters = Array.from(examples[exampleIndex].prompt);
    if (reducedMotion.matches || !canAnimate()) {
      exampleText.textContent = characters.join("");
      return;
    }
    const erase = phase === "erase";
    position += erase ? -1 : 1;
    exampleText.textContent = characters.slice(0, position).join("");
    if (erase && position === 0) {
      exampleTimer = setTimeout(() => displayExample(exampleIndex + 1), 230);
    } else if (!erase && position === characters.length) {
      phase = "erase";
      exampleTimer = setTimeout(animateExample, 4400);
    } else {
      exampleTimer = setTimeout(animateExample, erase ? 13 : 27);
    }
  }

  function canAnimate() {
    return visible && !turns.length && !input.value.trim() && !exampleArea.matches(":hover, :focus-within")
      && !document.hidden;
  }

  function displayExample(index) {
    clearTimeout(exampleTimer);
    exampleIndex = index % examples.length;
    const { prompt } = examples[exampleIndex];
    exampleButton.setAttribute("aria-label", t("assistantUseExample", { prompt }));
    exampleButton.title = prompt;
    phase = "type";
    position = 0;
    animateExample();
  }

  function chooseExamples() {
    const activeKinds = new Set(sources.map(source => source.kind));
    const order = entry => activeKinds.has(entry.kind) ? 0
      : entry === catalog[0] || modules.includes(exampleModules[entry.kind]) ? 1 : 2;
    examples = catalog.toSorted((a, b) => order(a) - order(b));
    displayExample(0);
  }

  function reflect() {
    const key = active ? "assistantStop" : "assistantSend";
    send.replaceChildren(glyph(active ? "stop" : "arrow"));
    send.title = t(key);
    send.setAttribute("aria-label", t(key));
    send.disabled = !active && (!input.value.trim() || signingIn);
    send.dataset.running = String(Boolean(active));
    reset.hidden = !turns.length && !sources.length && !input.value;
    signIn.hidden = Boolean(account) && assistantStatus !== "assistantSignIn";
    signIn.disabled = signingIn;
    status.textContent = assistantStatus ? t(assistantStatus) : "";
    status.hidden = !assistantStatus;
    status.dataset.issue = String(Boolean(assistantStatus && assistantStatus !== "assistantWorking"));
    access.hidden = status.hidden && signIn.hidden;
    exampleArea.hidden = Boolean(turns.length);
  }

  function remainingSources() {
    return assistantLimits.sources - sources.length;
  }

  function addSources(items, focus = true) {
    let available = assistantLimits.context - sources.reduce((total, source) => total + source.text.length, 0);
    let added = false, limited = false;
    for (const item of items) {
      if (!Object.hasOwn(sourceInfo, item?.kind) || typeof item.text !== "string") continue;
      const text = item.text.trim();
      if (!text) continue;
      const excerpt = textLimit(text, Math.min(assistantLimits.source, available));
      if (sources.some(source => source.kind === item.kind && source.url === item.url && source.text === excerpt
        && source.message?.accountId === item.message?.accountId && source.message?.id === item.message?.id)) continue;
      if (!remainingSources() || !excerpt) {
        limited = true;
        break;
      }
      sources.push({
        ...item, id: `s${++sourceNumber}`, text: excerpt,
        label: textLimit(item.label || t(sourceInfo[item.kind][0]), 180),
        truncated: Boolean(item.truncated || excerpt.length < text.length)
      });
      available -= excerpt.length;
      added = true;
    }
    if (added) {
      renderSources();
      if (focus && root.isConnected) input.focus({ preventScroll: true });
    }
    if (limited) reportError("assistantAttachLimit");
    return added;
  }

  function renderSources() {
    sourceList.replaceChildren(...sources.map(source => {
      const [label, symbol] = sourceInfo[source.kind];
      const chip = node("div", "assistant-source-chip");
      const name = t(label);
      const preview = button(t("assistantPreviewSource", { name: source.label }), "assistant-source-preview", {
        iconOnly: true, onClick: () => previewSource(source)
      });
      const title = node("bdi", "", source.label);
      preview.append(glyph(symbol), title);
      if (source.truncated) preview.append(node("small", "", t("assistantTruncated")));
      const remove = button(t("assistantRemoveSource", { name: source.label }), "assistant-source-remove", {
        symbol: "close", iconOnly: true, onClick: () => {
          sources = sources.filter(({ id }) => id !== source.id);
          renderSources();
          input.focus({ preventScroll: true });
        }
      });
      chip.append(preview, remove);
      return chip;
    }));
    hint.hidden = !sources.length;
    if (sources.length) input.setAttribute("aria-describedby", hint.id);
    else input.removeAttribute("aria-describedby");
    chooseExamples();
    reflect();
  }

  async function attachBrowserSource(kind) {
    attach.open = false;
    if (readingPage) return;
    if (!remainingSources()) return reportError("assistantAttachLimit");
    readingPage = true;
    attachButton.setAttribute("aria-busy", "true");
    try {
      const source = await capture(kind);
      if (!root.isConnected) return;
      if (source) addSources([source]);
      else reportError(kind === "page" ? "assistantNoPage" : "assistantNoSelection");
    } finally {
      readingPage = false;
      attachButton.removeAttribute("aria-busy");
    }
  }

  function describeTime(action) {
    if (!taskDateValid(action.date)) return "";
    const date = new Date(`${action.date}T12:00`);
    const format = time => {
      const timeAt = taskTimestamp(action.date, time);
      return timeAt === null ? "" : clockFormat.format(timeAt);
    };
    const timing = [format(action.start ?? action.time), format(action.end)].filter(Boolean).join("–");
    const reminder = action.reminder == null ? "" : calendarReminderLabel(t, numbers, action.reminder);
    return [dateFormat.format(date), timing, reminder].filter(Boolean).join(" · ");
  }

  function renderResult(turn, target) {
    const content = [];
    if (turn.citations?.length) {
      const group = node("div", "assistant-citations");
      group.append(node("h4", "", t("assistantSources")));
      const items = node("div", "assistant-citation-items");
      for (const reference of turn.citations) {
        const cite = button(reference.label, "assistant-citation", { symbol: "link", onClick: () => openSource(reference) });
        cite.lastElementChild.dir = "auto";
        items.append(cite);
      }
      group.append(items);
      content.push(group);
    }
    if (turn.actions?.length) {
      const group = node("div", "assistant-actions");
      group.append(node("h4", "", t("assistantActions")));
      turn.actions.forEach((action, index) => {
        const row = node("div", "assistant-action");
        const [label, symbol] = actionInfo[action.kind];
        const original = turn.sources.find(source => source.id === action.source);
        const title = node("bdi", "assistant-action-title", action.title ?? action.front ?? original?.label ?? t(label));
        const timing = describeTime(action);
        const excerpt = action.body || action.text || action.back || action.notes;
        const info = node("div", "assistant-action-copy");
        info.append(title);
        if (timing) info.append(node("small", "", timing));
        if (excerpt) {
          const detail = node("p", "", excerpt);
          detail.dir = "auto";
          info.append(detail);
        }
        const applied = turn.saved.has(index);
        const status = action.kind === "reply" ? "mailSent" : "assistantSaved";
        const review = button(t(applied ? status : label), "assistant-action-review", {
          symbol: applied ? "check" : "arrow", onClick: async () => {
            if (review.disabled) return;
            review.disabled = true;
            try {
              await onAction(action, original, () => {
                if (!turn.saved.has(index)) {
                  turn.saved.add(index);
                  renderResult(turn, target);
                }
              });
            } catch {
              reportError("saveFailed");
            } finally {
              review.disabled = applied;
            }
          }
        });
        review.id = `assistant-review-${turn.id}-${index}`;
        review.disabled = applied;
        row.append(glyph(symbol, "assistant-action-icon"), info, review);
        group.append(row);
      });
      content.push(group);
    }
    target.replaceChildren(...content);
    target.hidden = !content.length;
  }

  function makeTurn(turn) {
    const card = node("article", "assistant-turn");
    const user = node("p", "assistant-user", turn.prompt);
    user.dir = "auto";
    const answer = node("div", "assistant-answer");
    const header = node("div", "assistant-answer-heading");
    const copy = button(t("copy"), "icon-button", { symbol: "copy", iconOnly: true, onClick: () => onCopy(turn.answer) });
    copy.hidden = true;
    header.append(glyph("sparkles", "assistant-answer-icon"), node("h3", "", "Ease"), copy);
    const text = node("div", "assistant-answer-text");
    text.dir = "auto";
    const working = node("div", "assistant-shimmer");
    working.setAttribute("aria-hidden", "true");
    for (let line = 0; line < 3; line += 1) working.append(node("span"));
    const feedback = node("div", "assistant-turn-feedback");
    feedback.hidden = true;
    const notice = node("p");
    notice.setAttribute("role", "status");
    const retry = button(t("assistantRetry"), "secondary-button", { symbol: "refresh", onClick: () => {
      if (active) return;
      const sameSources = sources.length === turn.sources.length && sources.every((source, index) => source.id === turn.sources[index].id);
      const retryNow = sameSources && !input.value.trim();
      input.value = turn.prompt;
      sources = [...turn.sources];
      renderSources();
      input.focus();
      if (retryNow) submit();
    } });
    feedback.append(notice, retry);
    const result = node("div", "assistant-result");
    result.hidden = true;
    answer.append(header, text, working, feedback, result);
    card.append(user, answer);
    transcript.prepend(card);
    return {
      card,
      delta(value) {
        working.hidden = true;
        text.textContent = value;
      },
      finish(error) {
        working.hidden = true;
        copy.hidden = !turn.answer.trim();
        feedback.hidden = !error;
        notice.textContent = error ? t(error) : "";
        renderResult(turn, result);
      }
    };
  }

  function sendPayload(turn, port) {
    const now = new Date();
    const localTime = [now.getHours(), now.getMinutes()].map(value => String(value).padStart(2, "0")).join(":");
    const contextIds = new Set(turn.sources.map(source => source.id));
    const history = turns.filter(item => item.complete && item.sources.every(source => contextIds.has(source.id)))
      .slice(-assistantLimits.history).map(item => ({ prompt: textLimit(item.prompt, 700), answer: textLimit(item.answer, 1300) }));
    port.postMessage({
      prompt: turn.prompt, locale, calendar, local_date: localTaskDay(0, now), local_time: localTime, history,
      learning_language: languages.learning, translation_language: languages.translation,
      sources: turn.sources.map(({ id, kind, label, text }) => ({ id, kind, label, text }))
    });
  }

  function submit() {
    const prompt = input.value.trim();
    if (!prompt || active || signingIn) return;
    if (!account) {
      assistantStatus = "assistantSignIn";
      reflect();
      signIn.focus();
      return;
    }

    const turn = { id: ++turnNumber, prompt, answer: "", sources: [...sources], saved: new Set() };
    turns.push(turn);
    const layer = makeTurn(turn);
    if (turns.length > maxTurns) {
      turns.shift();
      transcript.lastElementChild.remove();
    }
    const operation = { finish };
    active = operation;
    input.value = "";
    assistantStatus = "assistantWorking";
    clearTimeout(exampleTimer);
    attach.open = false;
    reflect();

    let port;
    try {
      port = chrome.runtime.connect({ name: assistantPort });
      port.onMessage.addListener(packet => {
        if (active !== operation) return;
        if (packet.type === "delta" && typeof packet.text === "string") {
          turn.answer += packet.text;
          layer.delta(turn.answer);
        } else if (packet.type === "done") {
          const references = Array.isArray(packet.citations) ? packet.citations : [];
          turn.citations = turn.sources.filter(source => references.includes(source.id));
          turn.actions = (Array.isArray(packet.actions) ? packet.actions : []).filter(action => action
            && Object.hasOwn(actionInfo, action.kind) && (action.kind !== "reply"
              || turn.sources.some(source => source.id === action.source && source.kind === "mail")));
          turn.complete = true;
          finish();
        } else if (packet.type === "error") finish(errors.has(packet.code) ? packet.code : "assistantUnavailable");
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        finish("assistantInterrupted");
      });
      sendPayload(turn, port);
    } catch {
      finish("assistantUnavailable");
    }

    function finish(error) {
      if (active !== operation) return;
      active = undefined;
      port?.disconnect();
      assistantStatus = error === "assistantSignIn" ? error : undefined;
      layer.finish(error);
      reflect();
    }
  }

  function clearConversation(focus = true) {
    active?.finish("assistantStopped");
    turns = [];
    sources = [];
    input.value = "";
    assistantStatus = undefined;
    transcript.replaceChildren();
    renderSources();
    if (focus) input.focus();
  }

  async function signIntoAssistant() {
    if (signingIn) return;
    signingIn = true;
    status.textContent = "";
    reflect();
    try {
      if (await onSignIn()) assistantStatus = undefined;
      else assistantStatus = "assistantSignIn";
    } finally {
      signingIn = false;
      reflect();
      if (root.isConnected && account) input.focus();
    }
  }

  input.addEventListener("input", () => {
    if (!turns.length) displayExample(exampleIndex);
    reflect();
  });
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!active && !event.repeat) submit();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (active) active.finish("assistantStopped");
    else submit();
  });
  exampleButton.addEventListener("click", () => {
    input.value = examples[exampleIndex].prompt;
    displayExample(exampleIndex);
    reflect();
    input.focus();
  });
  exampleArea.addEventListener("pointerenter", () => displayExample(exampleIndex));
  exampleArea.addEventListener("pointerleave", () => displayExample(exampleIndex));
  exampleArea.addEventListener("focusin", () => displayExample(exampleIndex));
  exampleArea.addEventListener("focusout", () => queueMicrotask(() => displayExample(exampleIndex)));
  const refreshMotion = () => displayExample(exampleIndex);
  const closeAttach = event => { if (!attach.contains(event.target)) attach.open = false; };
  attach.addEventListener("keydown", event => {
    if (event.key === "Escape" && attach.open) {
      event.preventDefault();
      attach.open = false;
      attachButton.focus();
    }
  });
  renderSources();

  return {
    root,
    focus: () => input.focus(),
    addSource: source => addSources([source]),
    updateModules(next) {
      if (next.join() === modules.join()) return;
      modules = [...next];
      chooseExamples();
    },
    updateLanguages(next) { languages = next; },
    updateAccount(next) {
      if (account && account !== next) clearConversation(false);
      account = next;
      if (account && assistantStatus === "assistantSignIn") assistantStatus = undefined;
      reflect();
    },
    show() {
      if (visible) return;
      visible = true;
      document.addEventListener("visibilitychange", refreshMotion);
      document.addEventListener("pointerdown", closeAttach);
      reducedMotion.addEventListener("change", refreshMotion);
      displayExample(exampleIndex);
    },
    hide() {
      visible = false;
      attach.open = false;
      clearTimeout(exampleTimer);
      document.removeEventListener("visibilitychange", refreshMotion);
      document.removeEventListener("pointerdown", closeAttach);
      reducedMotion.removeEventListener("change", refreshMotion);
    },
    dispose() {
      this.hide();
      clearConversation(false);
    }
  };
}
