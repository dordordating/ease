import { handleEaseTranslationMessage, maxOnlineTranslationLength, onlineTranslationErrorCodes } from "./ease-api.js";
import { isRtl, translate } from "./locales.js";
import { maxTranslationLength, translatorLanguages } from "./translator-engine.js";
import { readTranslationHistory, recordTranslationHistory } from "./translation-history-store.js";
import { defaultTranslator, readWorkspace, translatorEngines } from "./workspace-data.js";

const legacyScriptPrefix = "ease-translator-site-";
const scriptId = "ease-translator-inline-global";
const scriptPath = "translator-inline.js";
const httpsPattern = "https://*/*";
const httpsPermission = { origins: [httpsPattern] };
const inlineSettingsMessage = "ease-translator-inline-settings";
const inlineOnlineMessage = "ease-translator-inline-online";
const inlineHistoryMessage = "ease-translator-inline-history";
const requestIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const inlineLabels = [
  "translatorRun", "translatorChrome", "translatorEconomy", "translatorStandard", "translatorPremium",
  "translatorOutput", "translatorUnavailable", "translatorPairUnavailable", "translatorDetectionUnavailable",
  "translatorNeedsDownload", "translatorDownloading", "translatorWorking", ...onlineTranslationErrorCodes, "close"
];
const onlineErrorKeys = new Set(onlineTranslationErrorCodes);
const activeOnlineRequests = new Map();

function eligiblePage(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname === "chromewebstore.google.com"
      || (url.hostname === "chrome.google.com" && /^\/webstore(?:\/|$)/u.test(url.pathname))) return null;
    return url;
  } catch {
    return null;
  }
}

function hostPermission(url) {
  return { origins: [`https://${url.hostname}/*`] };
}

export async function requestInlineTranslatorPermission() {
  try {
    const granted = await chrome.permissions.request(httpsPermission);
    return granted ? null : "translatorInlineDenied";
  } catch {
    return "translatorInlineFailed";
  }
}

export async function configureInlineTranslator(enabled) {
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const ids = registered.map(({ id }) => id);
  if (enabled) {
    if (!await chrome.permissions.contains(httpsPermission)) throw new Error("Inline permission is missing");
    const definition = {
      id: scriptId, js: [scriptPath], matches: [httpsPattern], persistAcrossSessions: true, runAt: "document_start"
    };
    const existing = registered.find(({ id }) => id === scriptId);
    if (!existing) await chrome.scripting.registerContentScripts([definition]);
    else if (existing.runAt !== definition.runAt) await chrome.scripting.updateContentScripts([definition]);
  }
  const stale = ids.filter((id) => id.startsWith(legacyScriptPrefix) || (!enabled && id === scriptId));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
}

export async function injectInlineTranslatorOnOpenTabs() {
  try {
    // Registration prepares future navigations. Inject into existing pages
    // too, including tabs that survived an extension update or browser restore.
    const tabs = await chrome.tabs.query({ url: [httpsPattern], discarded: false });
    await Promise.allSettled(tabs.map(async ({ id, url }) => {
      const page = eligiblePage(url);
      if (Number.isInteger(id) && page && await chrome.permissions.contains(hostPermission(page))) {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: [scriptPath] });
      }
    }));
  } catch {
    // Persistent registration also covers the next navigation to an eligible site.
  }
}

async function restoreLegacySites(sites, registered) {
  const existing = new Set(registered.map(({ id }) => id));
  const scripts = await Promise.all([...new Set(sites)].map(async (site) => {
    const page = eligiblePage(site);
    if (!page || page.origin !== site || !await chrome.permissions.contains(hostPermission(page))) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(site));
    const id = legacyScriptPrefix + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return existing.has(id) ? null : {
      id, js: [scriptPath], matches: hostPermission(page).origins, persistAcrossSessions: true, runAt: "document_idle"
    };
  }));
  const missing = scripts.filter(Boolean);
  if (missing.length) await chrome.scripting.registerContentScripts(missing);
}

async function restoreInlineRegistration() {
  const { translator } = await readWorkspace();
  if (translator?.inlineEnabled) {
    if (await chrome.permissions.contains(httpsPermission)) {
      await configureInlineTranslator(true);
      await injectInlineTranslatorOnOpenTabs();
    }
    return;
  }
  // Retain previously granted individual sites until the user changes the global setting.
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (registered.some(({ id }) => id === scriptId)) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
  if (Array.isArray(translator?.inlineSites) && translator.inlineSites.length) {
    await restoreLegacySites(translator.inlineSites, registered);
  }
}

function contentSenderPage(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)
    || (sender.documentLifecycle && sender.documentLifecycle !== "active")) return null;
  const page = eligiblePage(sender.url);
  if (!page || (sender.origin && sender.origin !== page.origin)) return null;
  return page;
}

async function activeSitePreferences(sender, page) {
  const [tab, workspace, permitted] = await Promise.all([
    chrome.tabs.get(sender.tab.id), readWorkspace(), chrome.permissions.contains(hostPermission(page))
  ]);
  if (!tab.active || eligiblePage(tab.url)?.origin !== page.origin || !permitted) return null;
  const preferences = { ...defaultTranslator, ...workspace.translator };
  const globallyEnabled = preferences.inlineEnabled === true;
  const legacyEnabled = Array.isArray(preferences.inlineSites) && preferences.inlineSites.includes(page.origin);
  if (!globallyEnabled && !legacyEnabled) return null;
  return {
    source: translatorLanguages.includes(preferences.source) ? preferences.source : defaultTranslator.source,
    target: translatorLanguages.includes(preferences.target) ? preferences.target : defaultTranslator.target,
    // Previously enabled sites were granted for on-device translation.
    engine: globallyEnabled && translatorEngines.includes(preferences.engine) ? preferences.engine : defaultTranslator.engine,
    locale: workspace.locale
  };
}

async function activeSiteSettings(sender, page) {
  const settings = await activeSitePreferences(sender, page);
  if (!settings) return null;
  const { engine, locale } = settings;
  const limit = new Intl.NumberFormat(locale).format(engine === "chrome" ? maxTranslationLength : maxOnlineTranslationLength);
  return {
    ...settings,
    historyEnabled: engine === "chrome" && await historyEnabled(),
    dir: isRtl(locale) ? "rtl" : "ltr",
    strings: Object.fromEntries(inlineLabels.map((label) => [label, translate(locale, label, { limit })]))
  };
}

async function historyEnabled() {
  try {
    return (await readTranslationHistory()).enabled;
  } catch {
    return false;
  }
}

function sameSettings(latest, expected) {
  return latest?.engine === expected.engine && latest.source === expected.source
    && latest.target === expected.target && latest.locale === expected.locale;
}

function recordResult(text, translated, settings, isCurrent) {
  const source = settings.source === "auto" ? translated.source : settings.source;
  if (typeof source === "string" && source.toLowerCase() === settings.target.toLowerCase()) return;
  return recordTranslationHistory({
    text, translation: translated.text, source, target: settings.target, engine: settings.engine,
    learning: translated.learning, notesLanguage: settings.locale
  }, { isCurrent });
}

async function handleInlineHistory(message, sender, page) {
  if (typeof sender.documentId !== "string" || !sender.documentId) return;
  const settings = await activeSitePreferences(sender, page);
  const expected = message.settings;
  if (settings?.engine !== "chrome" || !expected
    || settings.source !== expected.source || settings.target !== expected.target || settings.locale !== expected.locale) return;
  await recordResult(message.text, { text: message.translation, source: message.source }, settings, async () => (
    sameSettings(await activeSitePreferences(sender, page), settings)
  ));
}

function cancelInlineRequest(pending) {
  if (!pending || pending.cancelled) return;
  pending.cancelled = true;
  if (pending.started) handleEaseTranslationMessage({ requestId: pending.id, cancel: true }, () => {});
}

function cancelInlineTab(tabId) {
  for (const pending of activeOnlineRequests.values()) {
    if (pending.tabId === tabId) cancelInlineRequest(pending);
  }
}

function handleInlineOnline(message, sender, page, respond) {
  const { requestId, text } = message;
  if (!sender.documentId || typeof requestId !== "string" || !requestIdPattern.test(requestId)) {
    respond({ ok: false, code: "translatorFailed" });
    return false;
  }
  const key = `${sender.tab.id}:${sender.documentId}:${requestId}`;
  if (message.cancel === true) {
    cancelInlineRequest(activeOnlineRequests.get(key));
    respond({ ok: true });
    return false;
  }
  if (activeOnlineRequests.has(key) || typeof text !== "string" || !text.trim()) {
    respond({ ok: false, code: "translatorFailed" });
    return false;
  }
  if (text.length > maxOnlineTranslationLength * 2 || Array.from(text).length > maxOnlineTranslationLength) {
    respond({ ok: false, code: "translatorTooLong" });
    return false;
  }

  const pending = { id: crypto.randomUUID(), tabId: sender.tab.id, cancelled: false, started: false };
  activeOnlineRequests.set(key, pending);
  async function run() {
    const settings = await activeSitePreferences(sender, page);
    if (!settings || settings.engine === "chrome" || pending.cancelled) {
      return { ok: false, code: "translatorOnlineUnavailable" };
    }
    const saveHistory = await historyEnabled();
    if (pending.cancelled) return { ok: false, code: "translatorOnlineUnavailable" };
    pending.started = true;
    const answer = await new Promise((resolve) => handleEaseTranslationMessage({
      requestId: pending.id, text, source: settings.source, target: settings.target, engine: settings.engine
    }, resolve));
    const latest = await activeSitePreferences(sender, page);
    if (pending.cancelled || !sameSettings(latest, settings)) {
      return { ok: false, code: "translatorOnlineUnavailable" };
    }
    if (answer?.ok && typeof answer.result?.text === "string") {
      if (saveHistory) {
        await Promise.resolve(recordResult(text, answer.result, settings, async () => {
          const current = await activeSitePreferences(sender, page);
          return !pending.cancelled && sameSettings(current, settings);
        })).catch(() => {});
      }
      if (pending.cancelled) return { ok: false, code: "translatorOnlineUnavailable" };
      return { ok: true, text: answer.result.text };
    }
    const code = onlineErrorKeys.has(answer?.code) ? answer.code : "translatorFailed";
    return { ok: false, code };
  }

  run().then(respond, () => respond({ ok: false, code: "translatorOnlineUnavailable" }))
    .finally(() => activeOnlineRequests.delete(key));
  return true;
}

export function registerTranslatorSiteHandlers() {
  const restore = () => restoreInlineRegistration().catch(() => {});
  chrome.runtime.onInstalled?.addListener(restore);
  chrome.runtime.onStartup?.addListener(restore);
  chrome.tabs?.onRemoved?.addListener(cancelInlineTab);
  chrome.tabs?.onUpdated?.addListener((tabId, change) => {
    if (change.status === "loading") cancelInlineTab(tabId);
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== inlineSettingsMessage && message?.type !== inlineOnlineMessage && message?.type !== inlineHistoryMessage) return;
    const page = contentSenderPage(sender);
    if (!page) return;
    if (message.type === inlineOnlineMessage) return handleInlineOnline(message, sender, page, respond);
    if (message.type === inlineHistoryMessage) {
      handleInlineHistory(message, sender, page).then(() => respond({ ok: true }), () => respond({ ok: false }));
      return true;
    }
    activeSiteSettings(sender, page).then((settings) => respond({ settings }), () => respond({ settings: null }));
    return true;
  });
}
