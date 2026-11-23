import { assistantLimits } from "./home-store.js";
import { translate } from "./locales.js";
import { readWorkspace, storageKey } from "./workspace-data.js";
import { taskLink } from "./todo-store.js";

export const assistantSourceReady = "ease-assistant-source-ready";
const takeSource = "ease-assistant-source-take";
const contextMenu = "ease-assistant-selection";
const deliveries = new Map();

// Chrome runs this function in the page's isolated world.
function capturePage(kind, limit) {
  if (!["http:", "https:"].includes(location.protocol)) return null;
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  const skip = "form, input, select, textarea, [contenteditable], script, style, noscript, template, svg, nav, footer, [hidden], [aria-hidden='true']";
  let text = "";
  if (kind === "selection") {
    const selection = document.getSelection();
    if (focused?.closest(skip) || selection?.anchorNode?.parentElement?.closest(skip)
      || selection?.focusNode?.parentElement?.closest(skip)) return null;
    text = selection?.toString().trim().slice(0, limit + 1) ?? "";
  } else {
    const root = document.querySelector("main, [role='main']") ?? document.querySelector("article") ?? document.body;
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const pieces = [];
    let count = 0, length = 0;
    let lastBlock;
    for (let current = walker.nextNode(); current && count++ < 4500; current = walker.nextNode()) {
      const owner = current.parentElement;
      const value = current.textContent.trim();
      if (!value || !owner || owner.closest(skip) || !owner.getClientRects().length
        || getComputedStyle(owner).visibility !== "visible") continue;
      const block = owner.closest("article, blockquote, div, h1, h2, h3, h4, h5, h6, li, p, pre, td");
      const separator = !length ? "" : block === lastBlock ? " " : "\n";
      const piece = (separator + value).slice(0, limit + 1 - length);
      pieces.push(piece);
      length += piece.length;
      lastBlock = block;
      if (length > limit) break;
    }
    text = pieces.join("");
  }
  return text ? { text, label: document.title, url: location.href, kind } : null;
}

export async function captureAssistantSource(kind, windowId) {
  if (!["page", "selection"].includes(kind)) return null;
  const activeTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, ...(windowId === undefined ? { currentWindow: true } : { windowId }) });
    return tab;
  };
  try {
    const tab = await activeTab();
    if (!Number.isInteger(tab?.id)) return null;
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: capturePage, args: [kind, assistantLimits.source]
    });
    const source = injection?.result;
    const current = await activeTab();
    if (!source || current?.id !== tab.id || (current.url && source.url !== current.url) || !taskLink(source.url)) return null;
    return source;
  } catch {
    return null;
  }
}

export async function receiveAssistantSource(windowId, token) {
  if (!Number.isInteger(windowId)) return null;
  return chrome.runtime.sendMessage({ type: takeSource, windowId, token }).catch(() => null);
}

export function registerAssistantSourceHandlers() {
  if (!chrome.contextMenus) return;
  const updateMenu = async () => {
    const { locale } = await readWorkspace();
    const item = {
      title: translate(locale, "assistantAsk"), contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    };
    chrome.contextMenus.update(contextMenu, item, () => {
      if (chrome.runtime.lastError) chrome.contextMenus.create({ id: contextMenu, ...item }, () => { void chrome.runtime.lastError; });
    });
  };
  const refreshMenu = () => { updateMenu().catch(() => {}); };
  chrome.runtime.onInstalled?.addListener(refreshMenu);
  chrome.runtime.onStartup?.addListener(refreshMenu);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[storageKey]?.oldValue?.locale !== changes[storageKey]?.newValue?.locale) refreshMenu();
  });

  chrome.contextMenus.onClicked?.addListener((info, tab) => {
    if (info.menuItemId !== contextMenu || info.editable || !info.selectionText?.trim()
      || !Number.isInteger(tab?.id) || !Number.isInteger(tab.windowId)) return;
    const url = taskLink(info.frameUrl || info.pageUrl);
    if (!url) return;
    const token = crypto.randomUUID();
    const source = { kind: "selection", label: tab.title, text: info.selectionText.trim().slice(0, assistantLimits.source + 1), url };
    const delivery = { token, source, tabId: tab.id, routed: false, expires: Date.now() + 25_000 };
    deliveries.set(tab.windowId, delivery);
    setTimeout(() => { if (deliveries.get(tab.windowId) === delivery) deliveries.delete(tab.windowId); }, 25_000);

    // Open the side panel from the context menu gesture, before any asynchronous lookups.
    (chrome.sidePanel?.open?.({ tabId: tab.id }) ?? Promise.reject()).then(
      () => chrome.runtime.sendMessage({ type: assistantSourceReady, windowId: tab.windowId }).catch(() => {}),
      () => {
        if (deliveries.get(tab.windowId) !== delivery) return;
        delivery.routed = true;
        const url = chrome.runtime.getURL(`workspace.html?surface=panel&open=home&assistantSource=${token}`);
        return chrome.tabs.create({ windowId: tab.windowId, url });
      }
    ).catch(() => {});
  });

  async function consume(sender, { windowId, token }) {
    const delivery = deliveries.get(windowId);
    if (!delivery || delivery.expires <= Date.now()) return null;
    if (delivery.routed) {
      if (sender.tab?.windowId !== windowId || token !== delivery.token
        || new URL(sender.url).searchParams.get("assistantSource") !== token) return null;
    } else {
      if (sender.tab || token || new URL(sender.url).searchParams.get("surface") !== "panel") return null;
      const [active] = await chrome.tabs.query({ windowId, active: true });
      if (active?.id !== delivery.tabId || deliveries.get(windowId) !== delivery || delivery.routed) return null;
    }
    deliveries.delete(windowId);
    return delivery.source;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== takeSource || sender.id !== chrome.runtime.id
      || !sender.url?.startsWith(chrome.runtime.getURL("workspace.html?"))) return;
    consume(sender, message).then(respond, () => respond(null));
    return true;
  });
}
