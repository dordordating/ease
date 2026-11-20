import { chromeTranslate, maxTranslationLength, translatorLanguages } from "./translator-engine.js";
import { defaultTranslator } from "./workspace-data.js";

const languages = new Set(translatorLanguages);
const translationErrors = new Set([
  "translatorUnavailable", "translatorPairUnavailable", "translatorDetectionUnavailable",
  "translatorNeedsDownload", "translatorTooLong", "translatorFailed"
]);

export function renderTranslator(container, {
  locale, t, icon, settingsButton, preferences: initialPreferences, folders: initialFolders = [],
  draft = {}, onPreferences, onCopy, onSave, onShortcut
}) {
  const names = new Intl.DisplayNames([locale], { type: "language" });
  const numbers = new Intl.NumberFormat(locale);
  const percentages = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const languageOptions = translatorLanguages
    .map(code => [code, names.of(code)])
    .sort((a, b) => a[1].localeCompare(b[1], locale));
  const preferences = { ...defaultTranslator, ...initialPreferences };
  let folders = initialFolders;
  let showSettings = false;
  let showOriginal = !draft.result;
  let writingPreferences = false;
  let actionInProgress = false;
  let request;
  let disposed = false;

  container.innerHTML = `
    <form class="translator translator-main">
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
          <label for="translator-text" data-label="translatorInput"></label>
          <textarea id="translator-text" class="translator-textarea" dir="auto" rows="4"></textarea>
          <p class="translator-detected" hidden></p>
        </div>
        <section class="translator-result" aria-labelledby="translator-output-label">
          <h3 id="translator-output-label" data-label="translatorOutput"></h3>
          <div class="translator-output" dir="auto"></div>
        </section>
      </div>
      <div class="translator-toolbar">
        <button type="submit" class="primary-button translator-submit">${icon("translate")}<span data-label="translatorRun"></span></button>
        <div class="translator-actions">
          <button type="button" class="secondary-button translator-copy">${icon("copy")}<span data-label="translatorCopy"></span></button>
          <button type="button" class="secondary-button translator-save">${icon("folder")}<span data-label="translatorSave"></span></button>
        </div>
      </div>
      <progress class="translator-progress" max="1" aria-describedby="translator-feedback" hidden></progress>
      <p class="translator-feedback" id="translator-feedback" role="status" hidden></p>
    </form>
    <section class="translator-settings-view" id="translator-settings" aria-labelledby="translator-settings-heading" hidden>
      <h2 id="translator-settings-heading" data-label="translatorConfig"></h2>
      <div class="translator-field">
        <span data-label="translatorEngine"></span>
        <strong data-label="translatorChrome"></strong>
      </div>
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
      <div class="translator-shortcut-controls" hidden>
        <p data-label="translatorShortcutHint"></p>
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
  const feedback = form.querySelector(".translator-feedback");
  const progress = form.querySelector(".translator-progress");
  const layoutSelect = settingsView.querySelector("[data-translator-layout]");
  const folderSelect = settingsView.querySelector("[data-translator-folder]");
  const settingsFeedback = settingsView.querySelector("[data-translator-settings-feedback]");

  for (const label of container.querySelectorAll("[data-label]")) label.textContent = t(label.dataset.label);
  sourceSelect.add(new Option(t("translatorAuto"), "auto"));
  for (const [code, name] of languageOptions) {
    sourceSelect.add(new Option(name, code));
    targetSelect.add(new Option(name, code));
  }
  input.placeholder = t("translatorInputPlaceholder");
  input.value = typeof draft.text === "string" ? draft.text : "";
  translateButton.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
  swapButton.setAttribute("aria-label", t("translatorSwap"));
  swapButton.title = t("translatorSwap");
  progress.setAttribute("aria-label", t("translatorPreparing"));
  settingsButton?.setAttribute("aria-controls", settingsView.id);
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

  function setProgress(value) {
    progress.hidden = value === undefined;
    if (value !== undefined) progress.value = value;
  }

  function resetResult(clearDetection = true) {
    request?.abort();
    request = undefined;
    draft.result = "";
    if (clearDetection) draft.detectedSource = undefined;
    draft.source = preferences.source;
    draft.target = preferences.target;
    setProgress(undefined);
    setFeedback(nativeSupported() ? undefined : "translatorUnavailable");
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

    for (const select of [sourceSelect, targetSelect, layoutSelect, folderSelect]) {
      select.disabled = writingPreferences;
    }
    const source = sourceLanguage();
    swapButton.disabled = writingPreferences || !languages.has(source) || source === preferences.target;
    translateButton.hidden = resultOnly && !showOriginal;
    translateButton.disabled = !nativeSupported() || !input.value.trim() || !!request || writingPreferences;
    const canUseResult = Boolean(draft.result) && !actionInProgress && !request && !writingPreferences;
    copyButton.disabled = !canUseResult;
    saveButton.disabled = !canUseResult;
    result.hidden = !draft.result && !request;
    result.setAttribute("aria-busy", String(Boolean(request)));
    if (output.textContent !== (draft.result ?? "")) output.textContent = draft.result ?? "";
    output.tabIndex = draft.result ? 0 : -1;
    output.lang = preferences.target;
    input.lang = source ?? locale;
    detected.hidden = preferences.source !== "auto" || !source;
    if (!detected.hidden) detected.textContent = t("translatorCurrentSource", { language: names.of(source) });
  }

  function renderFolderOptions() {
    folderSelect.replaceChildren(new Option(t("noFolder"), ""));
    for (const folder of folders) folderSelect.add(new Option(folder.name, folder.id));
  }

  function update({ preferences: nextPreferences, folders: nextFolders } = {}) {
    if (disposed) return;
    if (nextPreferences) {
      const priorSource = preferences.source;
      const priorTarget = preferences.target;
      Object.assign(preferences, nextPreferences);
      if (preferences.source !== priorSource || preferences.target !== priorTarget) {
        resetResult(preferences.source !== priorSource);
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
    if (text.length > maxTranslationLength) {
      setFeedback("translatorTooLong", "error", { limit: numbers.format(maxTranslationLength) });
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
    if (!nativeSupported()) {
      setFeedback("translatorUnavailable", "error");
      return false;
    }

    resetResult(false);
    const opener = document.activeElement;
    const pending = new AbortController();
    request = pending;
    const current = () => !disposed && request === pending && !pending.signal.aborted;
    setFeedback("translatorWorking");
    render();
    try {
      const translated = await chromeTranslate(text, {
        source: preferences.source,
        target: preferences.target,
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
      });
      if (!current()) return false;
      if (translated.source === preferences.target) {
        setFeedback("translatorSameLanguage");
        return false;
      }
      draft.result = translated.text;
      showOriginal = false;
      setFeedback();
      return true;
    } catch (error) {
      if (current() && error?.name !== "AbortError") {
        const code = translationErrors.has(error?.code) ? error.code : "translatorFailed";
        setFeedback(code, code === "translatorNeedsDownload" ? "info" : "error", { limit: numbers.format(maxTranslationLength) });
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

  settingsButton?.addEventListener("click", toggleSettings);
  input.addEventListener("input", () => setText(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    translate();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    translate();
  });
  sourceSelect.addEventListener("change", () => changePreferences({ source: sourceSelect.value }));
  targetSelect.addEventListener("change", () => changePreferences({ target: targetSelect.value }));
  layoutSelect.addEventListener("change", () => changePreferences({ layout: layoutSelect.value }));
  folderSelect.addEventListener("change", () => changePreferences({ folderId: folderSelect.value || null }));
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

  if (draft.source !== preferences.source || draft.target !== preferences.target) resetResult();
  else if (!nativeSupported()) setFeedback("translatorUnavailable");
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
