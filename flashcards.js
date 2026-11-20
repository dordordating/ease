import { flashcardQueue } from "./flashcard-store.js";
import { translatorLanguages } from "./translator-engine.js";

const directionLabels = {
  recognition: "flashcardsRecognition",
  recall: "flashcardsRecall",
  both: "flashcardsBothDirections"
};
const ratingLabels = {
  again: "flashcardsAgain",
  hard: "flashcardsHard",
  good: "flashcardsGood",
  easy: "flashcardsEasy"
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function textInLanguage(node, language) {
  node.dir = "auto";
  if (language) node.lang = language;
  return node;
}

function reviewIdentity(item) {
  return item ? `${item.card.id}:${item.direction}:${item.version}` : undefined;
}

function matchingVoice(voices, language) {
  const requested = new Intl.Locale(language);
  const compatible = voices.filter(voice => {
    if (!voice.localService) return false;
    try {
      const available = new Intl.Locale(voice.lang);
      return available.language === requested.language
        && (!requested.script || available.maximize().script === requested.script);
    } catch {
      return false;
    }
  });
  return compatible.find(voice => voice.lang.toLowerCase() === language.toLowerCase())
    ?? compatible.find(voice => voice.default)
    ?? compatible[0];
}

export function renderFlashcards(container, {
  locale, t, icon, state: initialState, onPreferences, onAdd, onEdit, onDelete, onReview
}) {
  const names = new Intl.DisplayNames([locale], { type: "language" });
  const numbers = new Intl.NumberFormat(locale);
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const synthesis = globalThis.speechSynthesis;
  let state = initialState;
  let view = "study";
  let query = "";
  let currentReview;
  let revealed = false;
  let busy = false;
  let disposed = false;
  let dueTimer;
  let pronunciation;
  let utterance;

  function button(label, className, listener, symbol, iconOnly = false) {
    const control = element("button", className);
    control.type = "button";
    if (symbol) control.innerHTML = icon(symbol);
    if (iconOnly) {
      control.title = label;
      control.setAttribute("aria-label", label);
    } else {
      control.append(element("span", undefined, label));
    }
    control.addEventListener("click", listener);
    return control;
  }

  function field(label, control, className = "flashcards-field") {
    const wrapper = element("label", className);
    wrapper.append(element("span", undefined, label), control);
    return wrapper;
  }

  const module = element("section", "flashcards");
  const navigation = element("div", "flashcards-nav");
  navigation.setAttribute("role", "group");
  navigation.setAttribute("aria-label", t("flashcards"));
  const nav = Object.fromEntries(["study", "browse", "settings"].map((name, index) => {
    const label = t(["flashcardsStudy", "flashcardsBrowse", "flashcardsSettings"][index]);
    const control = button(label, "flashcards-nav-button", () => switchView(name),
      name === "settings" ? "settings" : undefined, name === "settings");
    navigation.append(control);
    return [name, control];
  }));
  const language = element("select", "flashcards-select");
  const languageOptions = translatorLanguages.map(code => [code, names.of(code)])
    .sort((a, b) => a[1].localeCompare(b[1], locale));
  for (const [code, name] of languageOptions) language.add(new Option(name, code));
  language.addEventListener("change", () => savePreferences({ language: language.value }));
  const languageField = field(t("flashcardLanguage"), language, "flashcards-field flashcards-language");
  const pane = element("div", "flashcards-pane");
  const status = element("p", "flashcards-feedback");
  status.setAttribute("role", "status");
  status.hidden = true;
  module.append(navigation, languageField, pane, status);
  container.append(module);

  function feedback(key) {
    status.textContent = key ? t(key) : "";
    status.hidden = !key;
  }

  function stopSpeaking() {
    if (!utterance) return;
    utterance = undefined;
    synthesis.cancel();
  }

  function switchView(nextView) {
    if (nextView === view) return;
    stopSpeaking();
    view = nextView;
    feedback();
    render();
  }

  async function savePreferences(patch) {
    if (busy) return;
    feedback();
    setBusy(true);
    let accepted = false;
    try {
      accepted = await onPreferences(patch) === true;
    } catch {
      // Restore the last saved settings when the write fails.
    }
    if (disposed) return;
    setBusy(false);
    if (!accepted) {
      render();
      feedback("flashcardsSettingsError");
    }
  }

  function setBusy(value) {
    busy = value;
    language.disabled = busy;
    module.setAttribute("aria-busy", String(busy));
    pane.querySelectorAll("[data-flashcards-write]").forEach(control => { control.disabled = busy; });
  }

  function summary(queue) {
    const stats = element("dl", "flashcards-stats");
    for (const [label, count] of [
      ["flashcardsDue", queue.dueCount], ["flashcardsNew", queue.newCount], ["flashcardsReviewed", queue.reviewedToday]
    ]) {
      const metric = element("div", "flashcards-stat");
      metric.append(element("dt", undefined, t(label)), element("dd", undefined, numbers.format(count)));
      stats.append(metric);
    }
    return stats;
  }

  function emptyState(title, description, action) {
    const panel = element("div", "flashcards-empty");
    const glyph = element("span", "flashcards-empty-icon");
    glyph.innerHTML = icon(action ? "flashcards" : "check");
    panel.append(glyph, element("h2", undefined, t(title)), element("p", undefined, t(description)));
    if (action) panel.append(button(t("flashcardAdd"), "primary-button", () => onAdd(), "plus"));
    return panel;
  }

  function updatePronunciation() {
    if (!pronunciation) return;
    pronunciation.voice = matchingVoice(synthesis.getVoices(), pronunciation.language);
    pronunciation.control.hidden = !pronunciation.voice;
  }

  function speak() {
    if (!pronunciation?.voice) return;
    if (utterance) {
      stopSpeaking();
      return;
    }
    const current = new SpeechSynthesisUtterance(pronunciation.text);
    current.lang = pronunciation.voice.lang;
    current.voice = pronunciation.voice;
    current.rate = .9;
    const finish = () => { if (utterance === current) utterance = undefined; };
    current.addEventListener("end", finish);
    current.addEventListener("error", finish);
    utterance = current;
    try {
      synthesis.speak(current);
    } catch {
      finish();
    }
  }

  function reviewFace(label, text, { language, speakable = false, answer = false } = {}) {
    const face = element("div", answer ? "flashcards-answer" : "flashcards-prompt");
    const caption = element("div", "flashcards-caption");
    caption.append(element("span", undefined, t(label)));
    if (speakable && typeof synthesis?.getVoices === "function" && typeof SpeechSynthesisUtterance === "function") {
      const control = button(t("flashcardsPronounce"), "icon-button flashcards-pronounce", speak, "volume", true);
      pronunciation = { control, text, language };
      updatePronunciation();
      caption.append(control);
    }
    const value = textInLanguage(element(answer ? "p" : "h2", "flashcards-card-text", text), language);
    face.append(caption, value);
    return face;
  }

  function studyDetails(card) {
    const details = element("dl", "flashcards-card-details");
    for (const [label, text, lang] of [
      ["flashcardUsage", card.usage],
      ["flashcardExample", card.example, card.language],
      ["flashcardExampleTranslation", card.exampleTranslation]
    ]) {
      if (!text) continue;
      details.append(element("dt", undefined, t(label)), textInLanguage(element("dd", undefined, text), lang));
    }
    return details.childElementCount ? details : null;
  }

  async function rate(item, rating) {
    if (busy || !revealed || currentReview !== reviewIdentity(item)) return;
    feedback();
    setBusy(true);
    let accepted = false;
    try {
      accepted = await onReview({ id: item.card.id, direction: item.direction, rating, version: item.version }) === true;
    } catch {
      // A stale or failed review should leave a reviewable card on screen.
    }
    if (disposed) return;
    setBusy(false);
    if (!accepted) feedback("flashcardReviewChanged");
    if (view === "study") {
      if (accepted) render();
      pane.querySelector(accepted ? ".flashcards-reveal, .flashcards-empty h2" : `.flashcards-rating[data-rating="${rating}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  function studyCard(item) {
    const { card, direction } = item;
    const recognition = direction === "recognition";
    const stack = element("article", "flashcards-study-card");
    stack.dataset.revealed = String(revealed);
    const kind = element("p", "flashcards-direction", t(directionLabels[direction]));
    stack.append(kind, recognition
      ? reviewFace("flashcardTerm", card.term, { language: card.language, speakable: true })
      : reviewFace("flashcardAnswer", card.answer));
    if (!revealed) {
      const reveal = button(t("flashcardsReveal"), "primary-button flashcards-reveal", () => {
        revealed = true;
        render();
        pane.querySelector(".flashcards-answer")?.focus({ preventScroll: true });
      });
      stack.append(reveal);
      return stack;
    }
    const answer = recognition
      ? reviewFace("flashcardAnswer", card.answer, { answer: true })
      : reviewFace("flashcardTerm", card.term, { language: card.language, speakable: true, answer: true });
    answer.tabIndex = -1;
    stack.append(answer);
    const details = studyDetails(card);
    if (details) stack.append(details);
    const ratings = element("div", "flashcards-ratings");
    for (const [name, label] of Object.entries(ratingLabels)) {
      const control = button(t(label), "secondary-button flashcards-rating", () => rate(item, name));
      control.dataset.rating = name;
      control.dataset.flashcardsWrite = "";
      ratings.append(control);
    }
    stack.append(ratings);
    return stack;
  }

  function showStudy(cards) {
    const queue = flashcardQueue(state);
    const next = queue.items[0];
    const identity = reviewIdentity(next);
    if (currentReview !== identity) {
      stopSpeaking();
      currentReview = identity;
      revealed = false;
    }
    if (!cards.length) {
      pane.append(emptyState("flashcardsEmpty", "flashcardsEmptyHint", true));
      return;
    }
    pane.append(summary(queue));
    if (next) {
      pane.append(studyCard(next));
      return;
    }
    const caughtUp = emptyState("flashcardsCaughtUp", "flashcardsCaughtUpHint", false);
    caughtUp.querySelector("h2").tabIndex = -1;
    if (queue.nextDueAt && queue.nextDueAt > Date.now()) {
      const date = dateFormat.format(queue.nextDueAt);
      caughtUp.append(element("p", "flashcards-next", t("flashcardsNextDue", { date })));
      dueTimer = setTimeout(render, Math.min(2_147_483_647, queue.nextDueAt - Date.now() + 50));
    }
    pane.append(caughtUp);
  }

  function showBrowse(cards) {
    if (!cards.length) {
      pane.append(emptyState("flashcardsEmpty", "flashcardsEmptyHint", true));
      return;
    }
    const filter = element("input", "flashcards-filter");
    filter.type = "search";
    filter.placeholder = t("flashcardsSearch");
    filter.setAttribute("aria-label", t("flashcardsSearch"));
    filter.autocomplete = "off";
    filter.value = query;
    const list = element("ul", "flashcards-list");
    const noResults = element("p", "flashcards-no-results", t("flashcardsBrowseEmpty"));
    const normalize = value => value.normalize("NFKC").toLocaleLowerCase(locale);
    function renderList() {
      const needle = normalize(filter.value.trim());
      const matches = cards.filter(card => !needle || [card.term, card.answer, card.usage, card.example, card.exampleTranslation]
        .some(text => text && normalize(text).includes(needle)));
      list.replaceChildren(...matches.map(card => {
        const row = element("li", "flashcards-list-row");
        const copy = element("div", "flashcards-list-text");
        const term = textInLanguage(element("strong", undefined, card.term), card.language);
        term.id = `flashcard-term-${card.id}`;
        copy.append(term, textInLanguage(element("span", undefined, card.answer)));
        const edit = button(t("flashcardEdit"), "icon-button", () => onEdit(card), "edit", true);
        const remove = button(t("flashcardDelete"), "icon-button flashcards-delete", () => onDelete(card), "trash", true);
        edit.setAttribute("aria-describedby", term.id);
        remove.setAttribute("aria-describedby", term.id);
        row.append(copy, edit, remove);
        return row;
      }));
      noResults.hidden = Boolean(matches.length);
    }
    filter.addEventListener("input", () => {
      query = filter.value;
      renderList();
    });
    renderList();
    pane.append(filter, list, noResults);
  }

  function showSettings() {
    const form = element("form", "flashcards-preferences");
    const direction = element("select", "flashcards-select");
    for (const [value, label] of Object.entries(directionLabels)) direction.add(new Option(t(label), value));
    direction.value = state.direction;
    const limits = element("div", "flashcards-limits");
    function limitInput(label, value, max) {
      const input = element("input", "flashcards-limit");
      input.type = "number";
      input.required = true;
      input.min = "0";
      input.max = String(max);
      input.value = String(value);
      limits.append(field(t(label), input));
      return input;
    }
    const newLimit = limitInput("flashcardsNewLimit", state.newPerDay, 100);
    const reviewLimit = limitInput("flashcardsReviewLimit", state.reviewsPerDay, 500);
    const save = element("button", "primary-button", t("save"));
    save.type = "submit";
    save.dataset.flashcardsWrite = "";
    form.append(field(t("flashcardsDirection"), direction), limits, save);
    form.addEventListener("submit", event => {
      event.preventDefault();
      savePreferences({ direction: direction.value, newPerDay: newLimit.valueAsNumber, reviewsPerDay: reviewLimit.valueAsNumber });
    });
    pane.append(form);
  }

  function render() {
    clearTimeout(dueTimer);
    pronunciation = undefined;
    const focusedFilter = pane.querySelector(".flashcards-filter:focus");
    const selection = focusedFilter && [focusedFilter.selectionStart, focusedFilter.selectionEnd];
    language.value = state.language;
    for (const [name, control] of Object.entries(nav)) control.setAttribute("aria-pressed", String(name === view));
    const cards = state.cards.filter(card => card.language === state.language);
    languageField.hidden = view === "settings";
    pane.replaceChildren();
    if (view === "browse") showBrowse(cards);
    else if (view === "settings") showSettings();
    else showStudy(cards);
    setBusy(busy);
    const nextFilter = selection && pane.querySelector(".flashcards-filter");
    if (nextFilter) {
      nextFilter.focus({ preventScroll: true });
      nextFilter.setSelectionRange(...selection);
    }
  }

  synthesis?.addEventListener("voiceschanged", updatePronunciation);
  render();
  return {
    update({ state: nextState }) {
      if (disposed || nextState === state) return;
      if (nextState.language !== state.language) {
        query = "";
        stopSpeaking();
      }
      state = nextState;
      render();
    },
    dispose() {
      disposed = true;
      clearTimeout(dueTimer);
      stopSpeaking();
      synthesis?.removeEventListener("voiceschanged", updatePronunciation);
    }
  };
}
