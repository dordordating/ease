import { isRtl, translate } from "./locales.js";
import { defaultTranslator, readWorkspace } from "./workspace-data.js";

const prefix = "ease-translator-site-";
const scriptPath = "translator-inline.js";
const inlineMessage = "ease-translator-inline-settings";
const inlineLabels = [
  "translatorRun", "translatorChrome", "translatorOutput", "translatorUnavailable",
  "translatorPairUnavailable", "translatorDetectionUnavailable", "translatorNeedsDownload",
  "translatorDownloading", "translatorWorking", "translatorFailed", "translatorTooLong", "close"
];

export function normalizeTranslatorSite(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.trim();
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    if (url.protocol !== "https:" || !url.hostname || url.hostname.includes("*")
      || url.username || url.password || url.port) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const translatorSitePattern = (site) => `${site}/*`;

export async function requestTranslatorSitePermission(site) {
  if (!site) return "translatorInlineInvalid";
  try {
    const granted = await chrome.permissions.request({ origins: [translatorSitePattern(site)] });
    return granted ? null : "translatorInlineDenied";
  } catch {
    return "translatorInlineFailed";
  }
}

async function siteScriptId(site) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(site));
  return prefix + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function registeredScript(site, id) {
  return { id, js: [scriptPath], matches: [translatorSitePattern(site)], persistAcrossSessions: true, runAt: "document_idle" };
}

export async function configureTranslatorSite(site, enabled) {
  const id = await siteScriptId(site);
  const [current] = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!enabled) {
    if (current) await chrome.scripting.unregisterContentScripts({ ids: [id] });
    return;
  }
  if (!await chrome.permissions.contains({ origins: [translatorSitePattern(site)] })) {
    throw new Error("Site permission is missing");
  }
  if (!current) await chrome.scripting.registerContentScripts([registeredScript(site, id)]);
}

export async function injectTranslatorOnActiveSite(site) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id) || normalizeTranslatorSite(tab.url) !== site) return;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [scriptPath] });
  } catch {
    // The persistent registration also runs on the next navigation to this site.
  }
}

async function activeSiteSettings(sender) {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)
    || typeof sender.url !== "string" || !sender.url.startsWith("https://")) return null;
  const site = normalizeTranslatorSite(sender.url);
  if (!site) return null;
  const workspace = await readWorkspace();
  const preferences = { ...defaultTranslator, ...workspace.translator };
  if (!preferences.inlineSites.includes(site)
    || !await chrome.permissions.contains({ origins: [translatorSitePattern(site)] })) return null;

  return {
    source: preferences.source,
    target: preferences.target,
    locale: workspace.locale,
    dir: isRtl(workspace.locale) ? "rtl" : "ltr",
    strings: Object.fromEntries(inlineLabels.map((label) => [label, translate(workspace.locale, label)]))
  };
}

export function registerTranslatorSiteHandlers() {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== inlineMessage || sender.id !== chrome.runtime.id) return;
    activeSiteSettings(sender).then((settings) => respond({ settings }), () => respond({ settings: null }));
    return true;
  });
}
