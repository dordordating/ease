import { flashcardIntervalLimits, flashcardQueue, flashcardReminderPreferences, flashcardReviewIntervals } from "./flashcard-store.js";
import { translatorLanguages } from "./translator-engine.js";
import { createTimePicker } from "./time-picker.js";

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
const intervalLabels = {
  again: "flashcardsAgainInterval",
  hard: "flashcardsHardInterval",
  good: "flashcardsGoodInterval",
  easy: "flashcardsEasyInterval"
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
  locale, dateLocale = locale, t, icon, state: initialState, settingsButton, addButton, onPreferences, onAdd, onEdit, onDelete, onReview
}) {
  const names = new Intl.DisplayNames([locale], { type: "language" });
  const numbers = new Intl.NumberFormat(locale);
  const dateFormat = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" });
  const synthesis = globalThis.speechSynthesis;
  let state = initialState;
  let view = "study";
  let showingSettings = false;
  let query = "";
  let browseLanguage;
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
  const nav = Object.fromEntries([["study", "flashcardsStudy"], ["browse", "flashcardsBrowse"]].map(([name, label]) => {
    const control = button(t(label), "flashcards-nav-button", () => switchView(name));
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
  const settingsView = element("section", "flashcards-settings-view");
  settingsView.id = "flashcards-settings";
  const settingsHeading = element("h2", undefined, t("flashcardsSettings"));
  settingsHeading.id = "flashcards-settings-heading";
  settingsView.setAttribute("aria-labelledby", settingsHeading.id);
  const settingsPane = element("div", "flashcards-settings-pane");
  settingsView.append(settingsHeading, settingsPane);
  const status = element("p", "flashcards-feedback");
  status.setAttribute("role", "status");
  status.hidden = true;
  module.append(navigation, languageField, pane, status);
  container.append(module, settingsView);
  settingsButton?.setAttribute("aria-controls", settingsView.id);
  settingsButton?.addEventListener("click", toggleSettings);

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
    if (nextView === view && !browseLanguage) return;
    stopSpeaking();
    view = nextView;
    if (browseLanguage) query = "";
    browseLanguage = undefined;
    feedback();
    render();
  }

  function browseRow(id) {
    return Array.from(pane.querySelectorAll(".flashcards-list-row")).find((row) => row.dataset.flashcardId === id);
  }

  function openCard(id) {
    if (disposed) return false;
    const card = state.cards.find((item) => item.id === id);
    if (!card) return false;
    stopSpeaking();
    showingSettings = false;
    view = "browse";
    query = "";
    browseLanguage = card.language === state.language ? undefined : card.language;
    feedback();
    render();
    const row = browseRow(id);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
    return Boolean(row);
  }

  function reflectSettings() {
    if (!settingsButton) return;
    const label = t(showingSettings ? "close" : "flashcardsSettings");
    settingsButton.title = label;
    settingsButton.setAttribute("aria-label", label);
    settingsButton.setAttribute("aria-expanded", String(showingSettings));
  }

  function toggleSettings() {
    stopSpeaking();
    showingSettings = !showingSettings;
    settingsPane.replaceChildren();
    feedback();
    render();
    const workspace = container.closest(".workspace");
    if (workspace) workspace.scrollTop = 0;
  }

  async function savePreferences(patch) {
    if (busy) return;
    feedback();
    setBusy(true);
    let accepted = false;
    try {
      accepted = await onPreferences(patch) === true;
    } catch {
      // Leave the draft fields available for a retry.
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
    settingsView.setAttribute("aria-busy", String(busy));
    container.querySelectorAll("[data-flashcards-write]").forEach(control => { control.disabled = busy; });
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
    if (view === "study" && !showingSettings) {
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
    if (browseLanguage) pane.append(element("p", "flashcards-direction", names.of(browseLanguage)));
    if (!cards.length) {
      if (browseLanguage) pane.append(element("p", "flashcards-no-results", t("flashcardsBrowseEmpty")));
      else pane.append(emptyState("flashcardsEmpty", "flashcardsEmptyHint", true));
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
        row.dataset.flashcardId = card.id;
        row.tabIndex = -1;
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

  function renderSettingsForm() {
    const form = element("form", "flashcards-preferences");
    const direction = element("select", "flashcards-select");
    for (const [value, label] of Object.entries(directionLabels)) direction.add(new Option(t(label), value));
    direction.value = state.direction;
    direction.dataset.flashcardsWrite = "";
    const limits = element("div", "flashcards-limits");
    function numberInput(group, label, value, min, max) {
      const input = element("input", "flashcards-limit");
      input.type = "number";
      input.required = true;
      input.min = String(min);
      input.max = String(max);
      input.value = String(value);
      input.dataset.flashcardsWrite = "";
      group.append(field(t(label), input));
      return input;
    }
    const newLimit = numberInput(limits, "flashcardsNewLimit", state.newPerDay, 0, 100);
    const reviewLimit = numberInput(limits, "flashcardsReviewLimit", state.reviewsPerDay, 0, 500);
    const intervals = element("fieldset", "flashcards-intervals");
    const intervalFields = element("div", "flashcards-limits");
    intervals.append(element("legend", undefined, t("flashcardsIntervals")), intervalFields);
    const savedIntervals = flashcardReviewIntervals(state);
    const reviewIntervals = Object.fromEntries(Object.entries(intervalLabels).map(([rating, label]) => [
      rating, numberInput(intervalFields, label, savedIntervals[rating], 1, flashcardIntervalLimits[rating])
    ]));
    const reminders = element("fieldset", "flashcards-intervals flashcards-reminder-settings");
    const reminder = flashcardReminderPreferences(state);
    let reminderEnabled = reminder.enabled;
    const time = createTimePicker({ locale, t, label: t("flashcardsReminderTime"), value: reminder.time });
    for (const control of time.element.querySelectorAll(":scope > input, :scope > button")) control.dataset.flashcardsWrite = "";
    const timeField = element("div", "field");
    timeField.append(element("span", "", t("flashcardsReminderTime")), time.element);
    const reminderToggle = button(t("flashcardsReminderEnable"), "secondary-button translator-inline-switch", () => {
      reminderEnabled = !reminderEnabled;
      updateReminderFields();
      feedback();
    });
    reminderToggle.setAttribute("role", "switch");
    reminderToggle.dataset.flashcardsWrite = "";
    const indicator = element("span", "translator-inline-switch-indicator");
    indicator.setAttribute("aria-hidden", "true");
    reminderToggle.append(indicator);
    const hint = element("p", "flashcards-reminder-hint", t("flashcardsReminderHint"));
    reminderToggle.setAttribute("aria-describedby", "flashcards-reminder-hint");
    hint.id = "flashcards-reminder-hint";
    reminders.append(element("legend", undefined, t("flashcardsReminders")), reminderToggle, timeField, hint);

    function updateReminderFields() {
      reminderToggle.setAttribute("aria-checked", String(reminderEnabled));
      timeField.hidden = !reminderEnabled;
      time.required = reminderEnabled;
      time.disabled = !reminderEnabled || busy;
    }
    updateReminderFields();

    const save = element("button", "primary-button", t("save"));
    save.type = "submit";
    save.dataset.flashcardsWrite = "";
    form.append(field(t("flashcardsDirection"), direction), limits, intervals, reminders, save);
    form.addEventListener("input", () => feedback());
    form.addEventListener("submit", event => {
      event.preventDefault();
      const values = Object.fromEntries(Object.entries(reviewIntervals).map(([rating, input]) => [rating, input.valueAsNumber]));
      if (values.hard > values.good || values.good > values.easy) {
        feedback("flashcardsIntervalOrder");
        (values.hard > values.good ? reviewIntervals.good : reviewIntervals.easy).focus();
        return;
      }
      const patch = {
        direction: direction.value, newPerDay: newLimit.valueAsNumber, reviewsPerDay: reviewLimit.valueAsNumber,
        reviewIntervals: values
      };
      const savedReminder = flashcardReminderPreferences(state);
      const reminderTime = time.value || savedReminder.time;
      if (reminderEnabled || savedReminder.enabled || reminderTime !== savedReminder.time) {
        patch.reviewReminder = { enabled: reminderEnabled, time: reminderTime };
      }
      savePreferences(patch);
    });
    settingsPane.append(form);
  }

  function render() {
    clearTimeout(dueTimer);
    pronunciation = undefined;
    module.hidden = showingSettings;
    settingsView.hidden = !showingSettings;
    languageField.hidden = Boolean(browseLanguage);
    if (addButton) addButton.hidden = showingSettings || Boolean(browseLanguage);
    reflectSettings();
    if (showingSettings) {
      if (!settingsPane.childElementCount) renderSettingsForm();
      settingsView.append(status);
      setBusy(busy);
      return;
    }
    module.append(status);
    const focusedFilter = pane.querySelector(".flashcards-filter:focus");
    const focusedCard = pane.querySelector(".flashcards-list-row:focus")?.dataset.flashcardId;
    const selection = focusedFilter && [focusedFilter.selectionStart, focusedFilter.selectionEnd];
    language.value = state.language;
    for (const [name, control] of Object.entries(nav)) control.setAttribute("aria-pressed", String(name === view));
    const cards = state.cards.filter(card => card.language === (browseLanguage ?? state.language));
    pane.replaceChildren();
    if (view === "browse") showBrowse(cards);
    else showStudy(cards);
    setBusy(busy);
    const nextFilter = selection && pane.querySelector(".flashcards-filter");
    if (nextFilter) {
      nextFilter.focus({ preventScroll: true });
      nextFilter.setSelectionRange(...selection);
    }
    if (focusedCard) browseRow(focusedCard)?.focus({ preventScroll: true });
  }

  synthesis?.addEventListener("voiceschanged", updatePronunciation);
  render();
  return {
    openCard,
    update({ state: nextState }) {
      if (disposed || nextState === state) return;
      if (nextState.language !== state.language) {
        query = "";
        browseLanguage = undefined;
        stopSpeaking();
      }
      state = nextState;
      render();
    },
    dispose() {
      disposed = true;
      clearTimeout(dueTimer);
      stopSpeaking();
      settingsButton?.removeEventListener("click", toggleSettings);
      settingsButton?.removeAttribute("aria-controls");
      showingSettings = false;
      reflectSettings();
      if (addButton) addButton.hidden = false;
      synthesis?.removeEventListener("voiceschanged", updatePronunciation);
    }
  };
}
