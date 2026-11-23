import { assistantPort } from "./ease-api.js";
import { streamAnswerText } from "./assistant-answer-stream.js";
import { renderAssistantExamples } from "./assistant-examples.js";
import { prepareAssistantDrafts, renderAssistantDrafts } from "./assistant-actions.js";
import { beginAssistantHistory, finishAssistantHistory, readAssistantHistory, watchAssistantHistory } from "./assistant-history-store.js";
import { assistantExamples } from "./home-locales.js";
import { assistantLimits } from "./home-store.js";
import { localTaskDay } from "./todo-store.js";

const sourceInfo = {
  page: ["assistantSourcePage", "open-window"],
  selection: ["assistantSourceSelection", "edit"],
  mail: ["assistantSourceMail", "mail"],
  tab: ["assistantSourceTabs", "spaces"]
};
const errors = new Set([
  "assistantBusy", "assistantLimit", "assistantUnavailable", "assistantInterrupted", "assistantInputError", "assistantSignIn"
]);
const maxTurns = 8;
const textLimit = (value, limit) => value.slice(0, limit).toWellFormed().trim();

export function renderHomeAssistant({
  node, glyph, button, t, locale, dateLocale, calendar, navigation, capture, chooseTabs, previewSource, openSource,
  onAction, onCopy, onSignIn, taskLabelFor, reportError
}) {
  const root = node("section", "home-assistant");
  root.setAttribute("aria-label", t("assistantAsk"));

  const form = node("form", "assistant-form");
  const input = node("textarea", "assistant-input");
  input.id = "assistant-prompt";
  input.rows = 2;
  input.maxLength = assistantLimits.prompt;
  input.placeholder = t("assistantPrompt");
  input.setAttribute("aria-label", t("assistantPrompt"));
  input.dir = "auto";
  const sourceList = node("div", "assistant-attachments");
  const attach = node("details", "assistant-attach");
  const attachButton = node("summary", "assistant-attach-button");
  attachButton.id = "assistant-attach-button";
  attachButton.setAttribute("aria-label", t("assistantAttach"));
  attachButton.title = t("assistantAttach");
  attachButton.append(glyph("plus"));
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

  const send = button(t("assistantSend"), "assistant-send", { symbol: "sparkles", iconOnly: true });
  send.id = "assistant-send";
  send.type = "submit";
  const hint = node("p", "assistant-context-hint", t("assistantContextHint"));
  hint.id = "assistant-context-hint";
  const tools = node("div", "assistant-compose-controls");
  tools.append(attach, send);
  form.append(input, tools, sourceList, hint);
  const status = node("p", "assistant-status");
  status.setAttribute("role", "status");
  const signIn = button(t("signInGoogle"), "secondary-button assistant-signin", { symbol: "user", onClick: signIntoAssistant });
  const access = node("div", "assistant-access");
  access.append(status, signIn);

  const examples = renderAssistantExamples({ node, button, t, locale, onSelect(prompt) {
    input.value = prompt;
    reflect();
    input.focus();
  } });
  const subbar = node("div", "assistant-subbar");
  const controls = node("div", "assistant-controls");
  controls.append(navigation);
  subbar.append(examples.root, controls);
  const transcript = node("div", "assistant-transcript");
  root.append(form, subbar, access, transcript);

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const catalog = assistantExamples(locale);
  let visible = false;
  let account;
  let signingIn = false;
  let active;
  let readingPage = false;
  let sourceNumber = 0;
  let sources = [];
  let turns = [];
  let recent;
  let recentRevision = 0;
  let taskLabels = [];
  let languages = {};
  let assistantStatus;

  function reflect() {
    const key = active ? "assistantStop" : "assistantSend";
    send.replaceChildren(glyph(active ? "stop" : "sparkles"));
    send.title = t(key);
    send.setAttribute("aria-label", t(key));
    send.disabled = !active && (!input.value.trim() || signingIn);
    form.dataset.running = String(Boolean(active));
    signIn.hidden = Boolean(account) && assistantStatus !== "assistantSignIn";
    signIn.disabled = signingIn;
    status.textContent = assistantStatus ? t(assistantStatus) : "";
    status.hidden = !assistantStatus;
    status.dataset.issue = String(Boolean(assistantStatus && assistantStatus !== "assistantWorking"));
    access.hidden = status.hidden && signIn.hidden;
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
        label: textLimit(item.label ?? "", 180) || t(sourceInfo[item.kind][0]),
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
    const drafts = renderAssistantDrafts(turn.drafts, { node, button, glyph, t, locale, dateLocale, taskLabelFor, onAction, reportError }, turn.saved);
    if (drafts) content.push(drafts);
    target.replaceChildren(...content);
    target.hidden = !content.length;
  }

  function makeTurn(turn, archived = false) {
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
    const writer = streamAnswerText(text, locale, reducedMotion);
    const working = node("div", "assistant-shimmer");
    working.setAttribute("aria-hidden", "true");
    for (let line = 0; line < 3; line += 1) working.append(node("span"));
    const feedback = node("div", "assistant-turn-feedback");
    feedback.hidden = true;
    const notice = node("p");
    notice.setAttribute("role", "status");
    const retry = button(t(archived ? "assistantHistoryReuse" : "assistantRetry"), "secondary-button", { symbol: "refresh", onClick: () => {
      if (active) return;
      const sameSources = sources.length === turn.sources.length && sources.every((source, index) => source.id === turn.sources[index].id);
      const retryNow = !archived && sameSources && !input.value.trim();
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
    transcript.replaceChildren(card);
    return {
      delta(value) {
        working.hidden = true;
        writer.write(value);
      },
      finish(error) {
        writer.finish(() => {
          working.hidden = true;
          copy.hidden = !turn.answer.trim();
          feedback.hidden = !error;
          notice.textContent = error ? t(error) : "";
          renderResult(turn, result);
        }, archived || Boolean(error));
      }
    };
  }

  async function restoreRecent() {
    const revision = ++recentRevision;
    const id = account;
    if (!id) return;
    try {
      const { enabled, entries: [entry] } = await readAssistantHistory(id, 1, { latest: true });
      if (revision !== recentRevision || id !== account || recent || !enabled || !entry) return;
      recent = { ...entry, sources: [] };
      const layer = makeTurn(recent, true);
      if (entry.answer) layer.delta(entry.answer);
      layer.finish(entry.status === "stopped" ? "assistantStopped"
        : entry.status === "failed" ? entry.error ?? "assistantHistoryFailedRequest"
          : entry.status === "submitted" ? "assistantHistoryNoAnswer" : undefined);
      reflect();
    } catch {
      // A history read issue remains visible in the history pane when opened.
    }
  }

  function sendPayload(turn, port, recording) {
    const now = new Date();
    const localTime = [now.getHours(), now.getMinutes()].map(value => String(value).padStart(2, "0")).join(":");
    const contextIds = new Set(turn.sources.map(source => source.id));
    const history = turns.filter(item => item.complete && item.sources.every(source => contextIds.has(source.id)))
      .slice(-assistantLimits.history).map(item => ({ prompt: textLimit(item.prompt, 700), answer: textLimit(item.answer, 1300) }));
    port.postMessage({
      prompt: turn.prompt, locale, calendar, local_date: localTaskDay(0, now), local_time: localTime, history,
      learning_language: languages.learning, translation_language: languages.translation,
      ...(recording && { request_id: turn.id }),
      ...(turn.labels.size && { task_labels: Array.from(turn.labels, ([id, label]) => ({ id, name: label.name.toWellFormed() })) }),
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

    const normalizeLabel = value => ` ${value.normalize("NFKC").toLocaleLowerCase(locale)
      .replace(/ي/gu, "ی").replace(/ك/gu, "ک").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
    const normalized = normalizeLabel(prompt);
    const labels = taskLabels.toSorted((a, b) => Number(normalized.includes(normalizeLabel(b.name)))
      - Number(normalized.includes(normalizeLabel(a.name)))).slice(0, assistantLimits.taskLabels);
    const turn = {
      id: crypto.randomUUID(), createdAt: Date.now(), prompt, answer: "", sources: [...sources], saved: new Set(),
      labels: new Map(labels.map((label, index) => [`l${index + 1}`, label]))
    };
    const owner = account;
    const started = performance.now();
    const history = beginAssistantHistory(owner, { ...turn, locale, example: catalog.find(entry => entry.prompt === prompt) })
      .catch(() => { if (owner === account) reportError("assistantHistoryFailed"); return false; });
    recent = turn;
    turns.push(turn);
    const layer = makeTurn(turn);
    if (turns.length > maxTurns) turns.shift();
    const operation = { finish };
    active = operation;
    input.value = "";
    assistantStatus = "assistantWorking";
    attach.open = false;
    reflect();

    let port;
    try {
      port = chrome.runtime.connect({ name: assistantPort });
      port.onMessage.addListener(packet => {
        if (active !== operation) return;
        if (packet.type === "delta" && typeof packet.text === "string") {
          turn.answer += packet.text;
          layer.delta(packet.text);
        } else if (packet.type === "done") {
          const references = Array.isArray(packet.citations) ? packet.citations : [];
          turn.citations = turn.sources.filter(source => references.includes(source.id));
          turn.drafts = prepareAssistantDrafts(packet.actions, turn.sources, turn.labels);
          turn.complete = true;
          turn.execution = packet.execution;
          finish();
        } else if (packet.type === "error") finish(errors.has(packet.code) ? packet.code : "assistantUnavailable");
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        finish("assistantInterrupted");
      });
      history.then(recording => {
        if (active === operation) sendPayload(turn, port, recording);
      }).catch(() => finish("assistantUnavailable"));
    } catch {
      finish("assistantUnavailable");
    }

    function finish(error) {
      if (active !== operation) return;
      active = undefined;
      port?.disconnect();
      assistantStatus = error === "assistantSignIn" ? error : undefined;
      layer.finish(error);
      const duration = performance.now() - started;
      history.then(written => {
        if (written) return finishAssistantHistory(owner, turn.id, {
          answer: turn.answer, drafts: turn.drafts, execution: turn.execution, error, duration,
        });
      }).catch(() => { if (owner === account) reportError("assistantHistoryFailed"); });
      reflect();
    }
  }

  function clearConversation() {
    active?.finish("assistantStopped");
    recentRevision += 1;
    recent = undefined;
    turns = [];
    sources = [];
    input.value = "";
    assistantStatus = undefined;
    transcript.replaceChildren();
    renderSources();
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

  input.addEventListener("input", reflect);
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
  const closeAttach = event => { if (!attach.contains(event.target)) attach.open = false; };
  attach.addEventListener("keydown", event => {
    if (event.key === "Escape" && attach.open) {
      event.preventDefault();
      attach.open = false;
      attachButton.focus();
    }
  });
  renderSources();
  const unsubscribeHistory = watchAssistantHistory(event => {
    if (event?.accountId !== account || !["remove", "clear"].includes(event.change)) return;
    recentRevision += 1;
    const matches = turn => event.change === "clear" || turn.id === event.id;
    turns = turns.filter(turn => !matches(turn));
    if (recent && matches(recent)) {
      active?.finish("assistantStopped");
      recent = undefined;
      transcript.replaceChildren();
      reflect();
    }
  });

  return {
    root,
    controls,
    focus: () => input.focus(),
    reuse(prompt) {
      input.value = prompt;
      sources = [];
      renderSources();
      input.focus();
    },
    addSource: source => addSources([source]),
    updateExampleAnimation: enabled => examples.setAnimated(enabled),
    updateLabels(next) { taskLabels = next; },
    updateLanguages(next) { languages = next; },
    updateAccount(next) {
      if (account !== next) {
        if (account) clearConversation();
        account = next;
        if (account) restoreRecent();
      }
      if (account && assistantStatus === "assistantSignIn") assistantStatus = undefined;
      reflect();
    },
    show() {
      if (visible) return;
      visible = true;
      document.addEventListener("pointerdown", closeAttach);
      examples.show();
    },
    hide() {
      visible = false;
      attach.open = false;
      examples.hide();
      document.removeEventListener("pointerdown", closeAttach);
    },
    dispose() {
      unsubscribeHistory();
      this.hide();
      clearConversation();
    }
  };
}
