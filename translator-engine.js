// Chrome computes availability for each pair, including model downloads.
export const translatorLanguages = Object.freeze([
  "ar", "bg", "bn", "cs", "da", "de", "el", "en", "es", "fa", "fi", "fr",
  "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt", "mr", "nl",
  "no", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "ta", "te", "th", "tr",
  "uk", "vi", "zh", "zh-Hant"
]);
export const maxTranslationLength = 6_000;

export function selectableLanguage(code) {
  if (!code || translatorLanguages.includes(code)) return code;
  try {
    const { language, script } = new Intl.Locale(code).maximize();
    const scripted = `${language}-${script}`;
    if (translatorLanguages.includes(scripted)) return scripted;
    if (translatorLanguages.includes(language)) return language;
  } catch {
    // Browser language preferences may include unsupported tags.
  }
}

function languagePreference(value, fallback) {
  return value === "auto" || translatorLanguages.includes(value) ? value : fallback;
}

export function translationLanguagePreferences(preferences, patch = {}) {
  const source = languagePreference(patch.source, languagePreference(preferences?.source, "auto"));
  const savedTarget = translatorLanguages.includes(preferences?.target) ? preferences.target : "en";
  const changingTarget = translatorLanguages.includes(patch.target);
  const target = changingTarget ? patch.target : savedTarget;
  if (source !== target) return { source, target };
  if (source !== "en" && patch.source === source && !changingTarget) {
    return { source, target: "en" };
  }
  return { source: "auto", target };
}

class TranslationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function canonicalLanguage(language, errorCode) {
  if (typeof language === "string") {
    try {
      return Intl.getCanonicalLocales(language)[0];
    } catch {
      // Both a manually selected language and a model result can be invalid.
    }
  }
  throw new TranslationError(errorCode);
}

function supported(api) {
  return typeof api?.availability === "function" && typeof api.create === "function";
}

async function runModel(api, options, { signal, onProgress, unavailable }, run) {
  let availability;
  let model;
  try {
    availability = await api.availability(options);
    signal?.throwIfAborted();
    if (!["available", "downloadable", "downloading"].includes(availability)) {
      throw new TranslationError(unavailable);
    }
    if (availability === "downloadable" && globalThis.navigator?.userActivation?.isActive === false) {
      throw new TranslationError("translatorNeedsDownload");
    }
    if (availability === "downloadable" || availability === "downloading") onProgress?.(0);
    model = await api.create({
      ...options,
      signal,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          if (signal?.aborted || !Number.isFinite(event.loaded)) return;
          const ratio = event.total > 0 ? event.loaded / event.total : event.loaded;
          onProgress?.(Math.max(0, Math.min(1, ratio)));
        });
      }
    });
    signal?.throwIfAborted();
    const result = await run(model);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TranslationError || error?.name === "AbortError") throw error;
    if (error?.name === "NotAllowedError" && availability === "downloadable") {
      throw new TranslationError("translatorNeedsDownload");
    }
    if (error?.name === "NotSupportedError") throw new TranslationError(unavailable);
    throw new TranslationError("translatorFailed");
  } finally {
    model?.destroy?.();
  }
}

async function detectWithModel(text, signal, onProgress) {
  const detector = globalThis.LanguageDetector;
  if (!supported(detector)) throw new TranslationError("translatorDetectionUnavailable");
  const results = await runModel(
    detector,
    {},
    { signal, onProgress, unavailable: "translatorDetectionUnavailable" },
    (model) => model.detect(text, { signal })
  );
  const detected = canonicalLanguage(results?.[0]?.detectedLanguage, "translatorDetectionUnavailable");
  if (["und", "mul", "zxx"].includes(detected)) throw new TranslationError("translatorDetectionUnavailable");
  return detected;
}

async function detectWithExtension(text, signal) {
  const unavailable = "translatorDetectionUnavailable";
  const i18n = globalThis.chrome?.i18n;
  if (typeof i18n?.detectLanguage !== "function") throw new TranslationError(unavailable);

  signal?.throwIfAborted();
  let abort;
  try {
    // Chrome runs this extension API on-device. Its promise has no signal option.
    const detection = i18n.detectLanguage(text);
    const result = signal ? await Promise.race([
      detection,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })
    ]) : await detection;
    signal?.throwIfAborted();
    if (result?.isReliable !== true) throw new TranslationError(unavailable);

    const detected = canonicalLanguage(result.languages?.[0]?.language, unavailable);
    if (translatorLanguages.includes(detected)) return detected;
    const locale = new Intl.Locale(detected);
    const language = locale.language === "zh" && locale.maximize().script === "Hant"
      ? "zh-Hant" : locale.language;
    if (translatorLanguages.includes(language)) return language;
    throw new TranslationError(unavailable);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TranslationError || error?.name === "AbortError") throw error;
    throw new TranslationError(unavailable);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function detectLanguage(text, signal, onProgress) {
  try {
    return await detectWithModel(text, signal, onProgress);
  } catch (error) {
    if (error?.code !== "translatorDetectionUnavailable" && error?.code !== "translatorNeedsDownload") throw error;
    try {
      return await detectWithExtension(text, signal);
    } catch (fallbackError) {
      if (fallbackError?.code !== "translatorDetectionUnavailable") throw fallbackError;
      throw error;
    }
  }
}

export async function chromeTranslate(text, { source = "auto", target, signal, onProgress, onDetected, detectedSource } = {}) {
  signal?.throwIfAborted();
  if (typeof text !== "string" || !text.trim()) throw new TranslationError("translatorFailed");
  if (text.length > maxTranslationLength) throw new TranslationError("translatorTooLong");

  const targetLanguage = canonicalLanguage(target, "translatorPairUnavailable");
  let sourceLanguage = source === "auto" ? undefined : canonicalLanguage(source, "translatorPairUnavailable");
  if (sourceLanguage === targetLanguage) return { text, source: sourceLanguage };

  const translator = globalThis.Translator;
  if (!supported(translator)) throw new TranslationError("translatorUnavailable");
  if (source === "auto") {
    sourceLanguage = detectedSource
      ? canonicalLanguage(detectedSource, "translatorDetectionUnavailable")
      : await detectLanguage(text, signal, onProgress);
    onDetected?.(sourceLanguage);
    signal?.throwIfAborted();
    if (sourceLanguage === targetLanguage) return { text, source: sourceLanguage };
  }

  const translated = await runModel(
    translator,
    { sourceLanguage, targetLanguage },
    { signal, onProgress, unavailable: "translatorPairUnavailable" },
    (model) => model.translate(text, { signal })
  );
  return { text: translated, source: sourceLanguage };
}
