import { chromeTranslate, maxTranslationLength, translatorLanguages } from "./translator-engine.js";
import { maxOnlineTranslationLength, onlineTranslationErrorCodes, translateOnline } from "./ease-api.js";
import { defaultTranslator, translatorEngines } from "./workspace-data.js";

const languages = new Set(translatorLanguages);
const engineLabels = {
  chrome: "translatorChrome", economy: "translatorEconomy", standard: "translatorStandard", premium: "translatorPremium"
};
const translationErrors = new Set([
  "translatorUnavailable", "translatorPairUnavailable", "translatorDetectionUnavailable",
  "translatorNeedsDownload", ...onlineTranslationErrorCodes
]);

function selectableLanguage(code) {
  if (!code || languages.has(code)) return code;
  const locale = new Intl.Locale(code).maximize();
  const scripted = `${locale.language}-${locale.script}`;
  if (languages.has(scripted)) return scripted;
  return languages.has(locale.language) ? locale.language : undefined;
}

const enginePicker = `
  <fieldset class="translator-engines">
    <legend data-label="translatorEngine"></legend>
    <div class="translator-engine-options">
      ${translatorEngines.map((engine) => `
        <label class="translator-engine-option">
          <input type="radio" name="engine" value="${engine}">
          <span class="translator-engine-face">
            <span class="translator-engine-name" data-label="${engineLabels[engine]}"></span>
          </span>
          ${engine === defaultTranslator.engine ? "" : '<span class="translator-ai-badge" lang="en">AI</span>'}
        </label>`).join("")}
    </div>
  </fieldset>
  <div class="translator-cloud-details" hidden>
    <button type="button" class="secondary-button translator-cloud-sign-in" data-label="translatorOnlineSignInAction" hidden></button>
  </div>`;

export function renderTranslator(container, {
  locale, t, icon, settingsButton, preferences: initialPreferences, folders: initialFolders = [],
  accountId: initialAccountId = null, historyEnabled: initialHistoryEnabled = false,
  draft = {}, onPreferences, onCopy, onSave, onFlashcard, onShortcut, onSignIn, onHistory, onHistoryToggle
}) {
  const names = new Intl.DisplayNames([locale], { type: "language" });
  const numbers = new Intl.NumberFormat(locale);
  const percentages = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const languageOptions = translatorLanguages
    .map(code => [code, names.of(code)])
    .sort((a, b) => a[1].localeCompare(b[1], locale));
  const preferences = { ...defaultTranslator, ...initialPreferences };
  if (!translatorEngines.includes(preferences.engine)) preferences.engine = defaultTranslator.engine;
  let folders = initialFolders;
  let accountId = initialAccountId;
  let historyEnabled = initialHistoryEnabled;
  let writingHistory = false;
  let needsCloudSignIn = false;
  let signingIn = false;
  let showSettings = false;
  let showOriginal = !draft.result;
  let writingPreferences = false;
  let actionInProgress = false;
  let request;
  let disposed = false;

  container.innerHTML = `
    <form class="translator translator-main">
      ${enginePicker}
      <div class="translator-language-row">
        <label class="translator-field">
          <span data-label="translatorSource"></span>
          <select name="source" class="translator-select"></select>
        </label>
        <button type="button" class="icon-button translator-swap">${icon("swap")}</button>
        <label class="translator-field">
          <span data-label="translatorTarget"></span>
          <select name="target" class="translator-select"></select>
        </label>
      </div>
      <button type="button" class="secondary-button translator-show-original" aria-controls="translator-original" hidden></button>
      <div class="translator-panels">
        <div id="translator-original" class="translator-original">
          <div class="translator-input-header">
            <label for="translator-text" data-label="translatorInput"></label>
            <button type="submit" class="primary-button translator-submit">${icon("translate")}<span data-label="translatorRun"></span></button>
          </div>
          <textarea id="translator-text" class="translator-textarea" dir="auto" rows="4"></textarea>
          <p class="translator-detected" hidden></p>
        </div>
        <section class="translator-result" aria-labelledby="translator-output-label">
          <div class="translator-result-header">
            <h3 id="translator-output-label" data-label="translatorOutput"></h3>
            <button type="button" class="icon-button translator-copy">${icon("copy")}</button>
          </div>
          <div class="translator-output" dir="auto"></div>
          <details class="translator-learning" hidden>
            <summary data-label="translatorLearning"></summary>
            <dl>
              <div data-learning="usage"><dt data-label="flashcardUsage"></dt><dd dir="auto"></dd></div>
              <div data-learning="example"><dt data-label="flashcardExample"></dt><dd dir="auto"></dd></div>
              <div data-learning="exampleTranslation"><dt data-label="flashcardExampleTranslation"></dt><dd dir="auto"></dd></div>
            </dl>
          </details>
        </section>
      </div>
      <div class="translator-loading" role="status" hidden>
        <span class="translator-loading-orbit" aria-hidden="true"></span>
        <span data-label="translatorWorking"></span>
      </div>
      <div class="translator-actions" hidden>
        <button type="button" class="secondary-button translator-save">${icon("folder")}<span data-label="translatorSave"></span></button>
        <button type="button" id="translator-flashcard" class="secondary-button translator-flashcard" hidden>${icon("flashcards")}<span data-label="translatorAddFlashcard"></span></button>
      </div>
      <progress class="translator-progress" max="1" aria-describedby="translator-feedback" hidden></progress>
      <p class="translator-feedback" id="translator-feedback" role="status" hidden></p>
    </form>
    <section class="translator-settings-view" id="translator-settings" aria-labelledby="translator-settings-heading" hidden>
      <h2 id="translator-settings-heading" data-label="translatorConfig"></h2>
      ${enginePicker}
      <label class="translator-field">
        <span data-label="translatorLayout"></span>
        <select class="translator-select" data-translator-layout>
          <option value="both" data-label="translatorLayoutBoth"></option>
          <option value="result" data-label="translatorLayoutResult"></option>
        </select>
      </label>
      <label class="translator-field">
        <span data-label="translatorFolder"></span>
        <select class="translator-select" data-translator-folder></select>
      </label>
      <div class="translator-inline-sites translator-history-setting" hidden>
        <button type="button" class="secondary-button translator-inline-switch" role="switch" aria-describedby="translation-history-hint">
          <span data-label="translationHistoryEnabled"></span><span class="translator-inline-switch-indicator" aria-hidden="true"></span>
        </button>
        <p id="translation-history-hint" data-label="translationHistoryHint"></p>
      </div>
      <div class="translator-shortcut-controls" hidden>
        <p data-label="translatorShortcutHint"></p>
        <kbd class="keycap" id="translation-shortcut"></kbd>
        <button type="button" class="secondary-button translator-shortcut">${icon("keyboard")}<span data-label="manageActivationShortcut"></span></button>
      </div>
      <p class="translator-feedback" data-translator-settings-feedback role="status" hidden></p>
    </section>
  `;

  const form = container.querySelector(".translator-main");
  const settingsView = container.querySelector(".translator-settings-view");
  const sourceSelect = form.elements.namedItem("source");
  const targetSelect = form.elements.namedItem("target");
  const input = form.querySelector(".translator-textarea");
  const original = form.querySelector(".translator-original");
  const result = form.querySelector(".translator-result");
  const output = form.querySelector(".translator-output");
  const detected = form.querySelector(".translator-detected");
  const originalToggle = form.querySelector(".translator-show-original");
  const swapButton = form.querySelector(".translator-swap");
  const translateButton = form.querySelector(".translator-submit");
  const copyButton = form.querySelector(".translator-copy");
  const saveButton = form.querySelector(".translator-save");
  const flashcardButton = form.querySelector(".translator-flashcard");
  const resultActions = form.querySelector(".translator-actions");
  const learningDetails = form.querySelector(".translator-learning");
  const learningRows = Array.from(learningDetails.querySelectorAll("[data-learning]"));
  const feedback = form.querySelector(".translator-feedback");
  const loading = form.querySelector(".translator-loading");
  const progress = form.querySelector(".translator-progress");
  const layoutSelect = settingsView.querySelector("[data-translator-layout]");
  const folderSelect = settingsView.querySelector("[data-translator-folder]");
  const settingsFeedback = settingsView.querySelector("[data-translator-settings-feedback]");
  const historySetting = settingsView.querySelector(".translator-history-setting");
  const historySwitch = historySetting.querySelector("[role=switch]");
  const engineControls = Array.from(container.querySelectorAll("input[name=engine]"));
  const cloudDetails = Array.from(container.querySelectorAll(".translator-cloud-details"));
  const cloudSignInButtons = Array.from(container.querySelectorAll(".translator-cloud-sign-in"));

  for (const label of container.querySelectorAll("[data-label]")) label.textContent = t(label.dataset.label);
  sourceSelect.add(new Option(t("translatorAuto"), "auto"));
  for (const [code, name] of languageOptions) {
    sourceSelect.add(new Option(name, code));
    targetSelect.add(new Option(name, code));
  }
  input.placeholder = t("translatorInputPlaceholder");
  input.value = typeof draft.text === "string" ? draft.text : "";
  translateButton.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
  copyButton.title = t("translatorCopy");
  copyButton.setAttribute("aria-label", copyButton.title);
  swapButton.setAttribute("aria-label", t("translatorSwap"));
  swapButton.title = t("translatorSwap");
  progress.setAttribute("aria-label", t("translatorPreparing"));
  settingsButton?.setAttribute("aria-controls", settingsView.id);
  historySetting.hidden = !onHistoryToggle;
  if (onShortcut) {
    settingsView.querySelector(".translator-shortcut-controls").hidden = false;
    settingsView.querySelector(".translator-shortcut").addEventListener("click", onShortcut);
  }

  function sourceLanguage() {
    return preferences.source === "auto" ? draft.detectedSource : preferences.source;
  }

  function setFeedback(key, kind = "info", values = {}, element = feedback) {
    const message = key ? t(key, values) : "";
    if (element.textContent !== message) element.textContent = message;
    element.hidden = !message;
    element.dataset.kind = kind;
  }

  function nativeSupported() {
    const api = globalThis.Translator;
    return typeof api?.availability === "function" && typeof api.create === "function";
  }

  function online() {
    return preferences.engine !== defaultTranslator.engine;
  }

  function showSignIn() {
    return !accountId || needsCloudSignIn;
  }

  function inputLimit() {
    return online() ? maxOnlineTranslationLength : maxTranslationLength;
  }

  function setProgress(value) {
    progress.hidden = value === undefined;
    if (value !== undefined) progress.value = value;
  }

  function resetResult(clearDetection = true) {
    request?.abort();
    request = undefined;
    draft.result = "";
    draft.learning = undefined;
    learningDetails.open = false;
    if (clearDetection) draft.detectedSource = undefined;
    draft.engine = preferences.engine;
    draft.source = preferences.source;
    draft.target = preferences.target;
    setProgress(undefined);
    setFeedback(online() || nativeSupported() ? undefined : "translatorUnavailable");
  }

  function render() {
    form.hidden = showSettings;
    settingsView.hidden = !showSettings;
    if (settingsButton) {
      const label = t(showSettings ? "close" : "translatorConfig");
      settingsButton.title = label;
      settingsButton.setAttribute("aria-label", label);
      settingsButton.setAttribute("aria-expanded", String(showSettings));
    }

    const resultOnly = preferences.layout === "result";
    form.classList.toggle("is-result-only", resultOnly);
    original.hidden = resultOnly && !showOriginal;
    originalToggle.hidden = !resultOnly;
    originalToggle.textContent = t(showOriginal ? "translatorHideOriginal" : "translatorShowOriginal");
    originalToggle.setAttribute("aria-expanded", String(!original.hidden));
    sourceSelect.value = preferences.source;
    targetSelect.value = preferences.target;
    layoutSelect.value = preferences.layout;
    folderSelect.value = folders.some(folder => folder.id === preferences.folderId) ? preferences.folderId : "";
    historySwitch.setAttribute("aria-checked", String(historyEnabled));
    historySwitch.disabled = writingHistory;

    for (const control of engineControls) {
      control.checked = control.value === preferences.engine;
      control.disabled = writingPreferences;
    }
    for (const details of cloudDetails) details.hidden = !online() || !showSignIn() || !onSignIn;
    for (const signIn of cloudSignInButtons) {
      signIn.hidden = !showSignIn() || !onSignIn;
      signIn.disabled = signingIn;
    }
    for (const select of [sourceSelect, targetSelect, layoutSelect, folderSelect]) {
      select.disabled = writingPreferences;
    }
    const source = sourceLanguage();
    swapButton.disabled = writingPreferences || !languages.has(source) || source === preferences.target;
    translateButton.disabled = (online() ? showSignIn() : !nativeSupported()) || !input.value.trim() || !!request || writingPreferences;
    const canUseResult = Boolean(draft.result) && !actionInProgress && !request && !writingPreferences;
    resultActions.hidden = !draft.result;
    copyButton.disabled = !canUseResult;
    saveButton.disabled = !canUseResult;
    flashcardButton.hidden = !onFlashcard || !draft.result;
    flashcardButton.disabled = !canUseResult;
    result.hidden = !draft.result;
    loading.hidden = !request || !online();
    if (output.textContent !== (draft.result ?? "")) output.textContent = draft.result ?? "";
    output.tabIndex = draft.result ? 0 : -1;
    output.lang = preferences.target;
    for (const row of learningRows) {
      const value = draft.learning?.[row.dataset.learning] ?? "";
      const definition = row.querySelector("dd");
      if (definition.textContent !== value) definition.textContent = value;
      row.hidden = !value;
      definition.lang = row.dataset.learning === "example" ? draft.learning?.exampleLanguage ?? preferences.target : locale;
    }
    learningDetails.hidden = !draft.result || learningRows.every((row) => row.hidden);
    input.lang = source ?? locale;
    detected.hidden = preferences.source !== "auto" || !source;
    if (!detected.hidden) detected.textContent = t("translatorCurrentSource", { language: names.of(source) });
  }

  function renderFolderOptions() {
    folderSelect.replaceChildren(new Option(t("noFolder"), ""));
    for (const folder of folders) folderSelect.add(new Option(folder.name, folder.id));
  }

  function update({ preferences: nextPreferences, folders: nextFolders, accountId: nextAccountId,
    historyEnabled: nextHistoryEnabled } = {}) {
    if (disposed) return;
    if (typeof nextHistoryEnabled === "boolean") historyEnabled = nextHistoryEnabled;
    if (nextPreferences) {
      const priorSource = preferences.source;
      const priorTarget = preferences.target;
      const priorEngine = preferences.engine;
      Object.assign(preferences, nextPreferences);
      if (!translatorEngines.includes(preferences.engine)) preferences.engine = defaultTranslator.engine;
      if (preferences.engine !== priorEngine || preferences.source !== priorSource || preferences.target !== priorTarget) {
        resetResult(preferences.engine !== priorEngine || preferences.source !== priorSource);
        showOriginal = true;
      }
    }
    if (nextAccountId !== undefined && accountId !== nextAccountId) {
      accountId = nextAccountId;
      needsCloudSignIn = false;
      if (online()) {
        resetResult();
        showOriginal = true;
      }
    }
    if (nextFolders) {
      folders = nextFolders;
      renderFolderOptions();
    }
    render();
  }

  async function changePreferences(patch) {
    if (writingPreferences || disposed) return false;
    const active = document.activeElement;
    writingPreferences = true;
    const message = showSettings ? settingsFeedback : feedback;
    setFeedback(undefined, "info", {}, message);
    render();
    let accepted = false;
    try {
      accepted = await onPreferences?.(patch) === true;
    } catch {
      // A failed write leaves the current settings in place.
    }
    writingPreferences = false;
    if (disposed) return false;
    if (accepted) update({ preferences: patch });
    else {
      setFeedback("saveFailed", "error", {}, message);
      render();
    }
    if (document.activeElement === document.body) active?.focus();
    return accepted;
  }

  function setText(text) {
    if (input.value !== text) input.value = text;
    draft.text = text;
    showOriginal = true;
    resetResult();
    render();
  }

  function validText(text) {
    if (!text.trim()) {
      setFeedback("translatorNoSelection");
      return false;
    }
    const limit = inputLimit();
    if (text.length > (online() ? limit * 2 : limit) || (online() && Array.from(text).length > limit)) {
      setFeedback("translatorTooLong", "error", { limit: numbers.format(limit) });
      return false;
    }
    return true;
  }

  async function translate() {
    if (disposed || request || writingPreferences) return false;
    const text = input.value;
    if (!validText(text)) return false;
    if (sourceLanguage() === preferences.target) {
      setFeedback("translatorSameLanguage");
      return false;
    }
    if (online() && showSignIn()) {
      setFeedback("translatorOnlineSignIn", "info");
      return false;
    }
    if (!online() && !nativeSupported()) {
      setFeedback("translatorUnavailable", "error");
      return false;
    }

    resetResult(false);
    const opener = document.activeElement;
    const pending = new AbortController();
    const record = historyEnabled && onHistory;
    request = pending;
    const current = () => !disposed && request === pending && !pending.signal.aborted;
    setFeedback(online() ? undefined : "translatorWorking");
    render();
    try {
      const options = {
        source: preferences.source,
        target: preferences.target,
        engine: preferences.engine,
        notesLanguage: locale,
        signal: pending.signal,
        detectedSource: draft.detectedSource,
        onDetected: (language) => {
          if (!current()) return;
          draft.detectedSource = language;
          render();
        },
        onProgress: (value) => {
          if (!current() || !Number.isFinite(value)) return;
          setFeedback("translatorDownloading", "info", { progress: percentages.format(value) });
          setProgress(value);
        }
      };
      const translated = await (online() ? translateOnline(text, options) : chromeTranslate(text, options));
      if (!current()) return false;
      if (translated.source === preferences.target) {
        setFeedback("translatorSameLanguage");
        return false;
      }
      draft.result = translated.text;
      draft.learning = translated.learning;
      if (preferences.source === "auto" && translated.source) draft.detectedSource = selectableLanguage(translated.source);
      if (record) {
        const entry = translationEntry(text);
        Promise.resolve().then(() => record(entry)).catch(() => {});
      }
      showOriginal = false;
      setFeedback();
      return true;
    } catch (error) {
      if (current() && error?.name !== "AbortError") {
        const code = translationErrors.has(error?.code) ? error.code : "translatorFailed";
        if (code === "translatorOnlineSignIn") needsCloudSignIn = true;
        setFeedback(code, code === "translatorNeedsDownload" ? "info" : "error", { limit: numbers.format(inputLimit()) });
      }
      return false;
    } finally {
      if (request === pending) {
        request = undefined;
        setProgress(undefined);
        render();
        if (draft.result && !showSettings && document.activeElement === document.body
          && (opener === translateButton || opener === input)) {
          output.focus({ preventScroll: true });
        }
      }
    }
  }

  function setSelection(text, { auto = false } = {}) {
    if (disposed) return false;
    showSettings = false;
    setText(typeof text === "string" ? text : "");
    if (auto) return translate();
    return validText(input.value);
  }

  function translationEntry(text = input.value) {
    return {
      text, translation: draft.result, source: sourceLanguage(), target: preferences.target,
      engine: preferences.engine, learning: draft.learning, notesLanguage: locale
    };
  }

  async function useResult(action) {
    if (!draft.result || actionInProgress) return;
    const opener = document.activeElement;
    const translation = draft.result;
    actionInProgress = true;
    render();
    let accepted = false;
    try {
      const folderId = folders.some(folder => folder.id === preferences.folderId) ? preferences.folderId : null;
      accepted = action === "save"
        ? await onSave?.({ title: t("translatorOutput"), text: translation, folderId }) === true
        : await onCopy?.(translation) === true;
    } catch {
      // Keep the translation available so the user can retry.
    }
    actionInProgress = false;
    if (disposed) return;
    if (draft.result === translation) {
      setFeedback(accepted ? (action === "save" ? "translatorSaved" : "copied") : (action === "save" ? "saveFailed" : "copyFailed"),
        accepted ? "info" : "error");
    }
    render();
    if (document.activeElement === document.body) opener?.focus({ preventScroll: true });
  }

  function toggleSettings() {
    showSettings = !showSettings;
    setFeedback(undefined, "info", {}, settingsFeedback);
    render();
    const workspace = container.closest(".workspace");
    if (workspace) workspace.scrollTop = 0;
  }

  async function signIn() {
    if (signingIn || disposed || !onSignIn) return;
    signingIn = true;
    render();
    try {
      if (await onSignIn()) {
        needsCloudSignIn = false;
        setFeedback();
      }
    } finally {
      signingIn = false;
      if (!disposed) render();
    }
  }

  settingsButton?.addEventListener("click", toggleSettings);
  input.addEventListener("input", () => setText(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    translate();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    translate();
  });
  sourceSelect.addEventListener("change", () => changePreferences({ source: sourceSelect.value }));
  targetSelect.addEventListener("change", () => changePreferences({ target: targetSelect.value }));
  for (const control of engineControls) {
    control.addEventListener("change", () => changePreferences({ engine: control.value }));
  }
  for (const button of cloudSignInButtons) button.addEventListener("click", signIn);
  layoutSelect.addEventListener("change", () => changePreferences({ layout: layoutSelect.value }));
  folderSelect.addEventListener("change", () => changePreferences({ folderId: folderSelect.value || null }));
  historySwitch.addEventListener("click", async () => {
    if (writingHistory || !onHistoryToggle) return;
    const enabled = !historyEnabled;
    writingHistory = true;
    setFeedback(undefined, "info", {}, settingsFeedback);
    render();
    try {
      if (await onHistoryToggle(enabled)) historyEnabled = enabled;
      else setFeedback("translationHistoryFailed", "error", {}, settingsFeedback);
    } catch {
      setFeedback("translationHistoryFailed", "error", {}, settingsFeedback);
    } finally {
      writingHistory = false;
      if (!disposed) render();
    }
  });
  originalToggle.addEventListener("click", () => {
    showOriginal = !showOriginal;
    render();
    if (showOriginal) input.focus();
  });
  swapButton.addEventListener("click", async () => {
    const target = sourceLanguage();
    if (!languages.has(target) || target === preferences.target) return;
    const originalText = input.value;
    const translatedText = draft.result;
    if (await changePreferences({ source: preferences.target, target }) && translatedText && input.value === originalText) {
      setText(translatedText);
    }
  });
  copyButton.addEventListener("click", () => useResult("copy"));
  saveButton.addEventListener("click", () => useResult("save"));
  flashcardButton.addEventListener("click", () => {
    if (!draft.result || request || writingPreferences) return;
    onFlashcard?.(translationEntry());
  });

  if (draft.engine !== preferences.engine || draft.source !== preferences.source || draft.target !== preferences.target) resetResult();
  else if (!online() && !nativeSupported()) setFeedback("translatorUnavailable");
  showOriginal ||= !draft.result;
  renderFolderOptions();
  render();

  return {
    update, setSelection, translate,
    dispose() {
      disposed = true;
      request?.abort();
      request = undefined;
      settingsButton?.removeEventListener("click", toggleSettings);
    }
  };
}
