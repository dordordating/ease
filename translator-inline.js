(() => {
  const installed = Symbol.for("ease.translator.inline.installed");
  if (globalThis[installed] || !(document instanceof HTMLDocument)) return;
  globalThis[installed] = true;

  const editableSelector = "input, textarea, select, [role='textbox'], [role='searchbox'], [contenteditable]:not([contenteditable='false' i])";
  const onlineMessage = "ease-translator-inline-online";
  const historyMessage = "ease-translator-inline-history";
  const engineLabels = {
    chrome: "translatorChrome", economy: "translatorEconomy", standard: "translatorStandard", premium: "translatorPremium"
  };
  const popoverStyle = `
    :host {
      all: initial !important;
      position: fixed !important;
      z-index: 2147483647 !important;
      display: block !important;
      margin: 0 !important;
      left: var(--ease-inline-left, 0px) !important;
      top: var(--ease-inline-top, 0px) !important;
      width: var(--ease-inline-width, 340px) !important;
      visibility: var(--ease-inline-visibility, hidden) !important;
      color-scheme: light dark !important;
      font: 14px/1.45 system-ui, sans-serif !important;
      color: #221b2c !important;
    }
    .card {
      --edge: #e6e0ed;
      --muted: #625a70;
      --accent: #6130ae;
      --surface: #fff;
      --well: #f8f6fc;
      --button: #f1eafa;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      max-height: 100%;
      overflow: auto;
      padding: 11px 12px;
      background: var(--surface);
      border: 1px solid var(--edge);
      border-radius: 14px;
      box-shadow: 0 12px 34px #18102532, 0 2px 6px #1810251c;
    }
    @media (prefers-color-scheme: dark) {
      :host { color: #f1eafa !important; }
      .card {
        --edge: #413449;
        --muted: #b9adc4;
        --accent: #d8baff;
        --surface: #211a28;
        --well: #2b2334;
        --button: #3c2951;
      }
    }
    header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    strong { display: block; font-size: 13px; font-weight: 700; line-height: 1.3; }
    small { display: block; margin-block-start: 2px; color: var(--muted); font-size: 11px; }
    button {
      font: inherit;
      color: var(--accent);
      border: 0;
      background: var(--button);
      border-radius: 8px;
      cursor: pointer;
    }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .close { padding: 0; flex: 0 0 26px; font-size: 19px; min-height: 26px; line-height: 1; }
    .run { align-self: start; margin-block-start: 9px; padding: 5px 10px; font-size: 13px; font-weight: 650; }
    .status { margin: 8px 0 0; color: var(--muted); overflow-wrap: anywhere; }
    .result {
      margin: 8px 0 0;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--well);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    progress { width: 100%; height: 5px; margin-block-start: 8px; accent-color: var(--accent); }
    [hidden] { display: none !important; }
  `;

  let current;
  let pointerStart;
  let positionFrame;
  let engine;
  let stylesheet;

  function isEditable(node) {
    let element = node instanceof Element ? node : node?.parentElement;
    while (element) {
      if (element.isContentEditable || element.matches(editableSelector)) return true;
      const root = element.getRootNode();
      element = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return false;
  }

  function selectionSnapshot() {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || document.designMode === "on") return null;
    const range = selection.getRangeAt(0);
    for (const endpoint of [range.startContainer, range.endContainer]) {
      const root = endpoint.getRootNode();
      if (isEditable(endpoint) || (root instanceof ShadowRoot && root.mode === "closed")) return null;
    }

    const selected = selection.toString();
    // A retargeted range may conceal an editable selection inside a shadow tree.
    if (range.toString() !== selected || !selected.trim()) return null;
    const ancestor = range.commonAncestorContainer;
    if (ancestor.querySelectorAll && Array.from(ancestor.querySelectorAll(editableSelector)).some((element) => range.intersectsNode(element))) {
      return null;
    }
    return { range: range.cloneRange(), text: selected.trim() };
  }

  function sameSelection(sample) {
    const latest = selectionSnapshot();
    if (!latest || latest.text !== sample.text) return false;
    const left = sample.range;
    const right = latest.range;
    return left.startContainer === right.startContainer && left.startOffset === right.startOffset
      && left.endContainer === right.endContainer && left.endOffset === right.endOffset;
  }

  function insidePopover(event) {
    return current?.host && event.composedPath().includes(current.host);
  }

  function closePopover() {
    current?.controller?.abort();
    current?.host?.remove();
    current = null;
    if (positionFrame) cancelAnimationFrame(positionFrame);
    positionFrame = undefined;
  }

  async function readSettings() {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "ease-translator-inline-settings" });
      return reply?.settings;
    } catch {
      return null;
    }
  }

  function loadEngine() {
    engine ??= import(chrome.runtime.getURL("translator-engine.js"));
    return engine;
  }

  function recordHistory(job, translated) {
    const { source, target, locale } = job.settings;
    if (job.settings.historyEnabled !== true || typeof translated.text !== "string" || !translated.text.trim()) return;
    Promise.resolve().then(() => chrome.runtime.sendMessage({
      type: historyMessage,
      text: job.sample.text,
      translation: translated.text,
      source: translated.source,
      settings: { source, target, locale }
    })).catch(() => {});
  }

  async function translateOnline(text, signal) {
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    let abort;
    try {
      const pending = chrome.runtime.sendMessage({ type: onlineMessage, requestId, text });
      const reply = await Promise.race([
        pending,
        new Promise((_, reject) => {
          abort = () => {
            Promise.resolve().then(() => chrome.runtime.sendMessage({
              type: onlineMessage, requestId, cancel: true
            })).catch(() => {});
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        })
      ]);
      signal.throwIfAborted();
      if (reply?.ok && typeof reply.text === "string") return { text: reply.text };
      throw Object.assign(new Error("Inline translation failed"), { code: reply?.code ?? "translatorOnlineUnavailable" });
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  function positionPopover(job) {
    if (!job.host || !job.sample.range.startContainer.isConnected) {
      closePopover();
      return;
    }
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft ?? 0;
    const topEdge = viewport?.offsetTop ?? 0;
    const viewWidth = viewport?.width ?? document.documentElement.clientWidth;
    const viewHeight = viewport?.height ?? document.documentElement.clientHeight;
    const margin = 8;
    const gap = 7;
    const width = Math.max(1, Math.min(340, viewWidth - margin * 2));
    const maxHeight = Math.max(1, Math.min(270, viewHeight - margin * 2));
    const { style } = job.host;
    style.setProperty("--ease-inline-width", `${width}px`, "important");
    job.card.style.maxHeight = `${maxHeight}px`;
    const anchor = job.sample.range.getBoundingClientRect();
    if ((!anchor.width && !anchor.height) || anchor.bottom < topEdge || anchor.top > topEdge + viewHeight) {
      style.setProperty("--ease-inline-visibility", "hidden", "important");
      return;
    }
    const height = job.host.getBoundingClientRect().height;
    const atLeastLeft = leftEdge + margin;
    const atMostLeft = leftEdge + viewWidth - width - margin;
    const center = (anchor.left + anchor.right) / 2;
    const left = Math.max(atLeastLeft, Math.min(center - width / 2, atMostLeft));
    const above = anchor.top - height - gap;
    const below = anchor.bottom + gap;
    const atLeastTop = topEdge + margin;
    const atMostTop = topEdge + viewHeight - height - margin;
    const top = above >= atLeastTop ? above : Math.max(atLeastTop, Math.min(below, atMostTop));
    style.setProperty("--ease-inline-left", `${Math.round(left)}px`, "important");
    style.setProperty("--ease-inline-top", `${Math.round(top)}px`, "important");
    style.setProperty("--ease-inline-visibility", "visible", "important");
  }

  function schedulePosition() {
    if (positionFrame || !current?.host) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = undefined;
      if (current?.host) positionPopover(current);
    });
  }

  function localized(job, key, fallback = "") {
    const value = job.settings.strings?.[key];
    return typeof value === "string" && value ? value : fallback;
  }

  function stylePopover(shadow) {
    try {
      if (!stylesheet) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(popoverStyle);
        stylesheet = sheet;
      }
      shadow.adoptedStyleSheets = [stylesheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = popoverStyle;
      shadow.append(style);
    }
  }

  function createPopover(job) {
    const label = localized(job, "translatorOutput", "Translation");
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "closed" });
    stylePopover(shadow);
    const card = document.createElement("section");
    card.className = "card";
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", label);
    card.lang = job.settings.locale ?? "";
    card.dir = job.settings.dir === "rtl" ? "rtl" : "ltr";

    const header = document.createElement("header");
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = label;
    const subtitle = document.createElement("small");
    subtitle.textContent = localized(job, engineLabels[job.settings.engine] ?? "translatorChrome", "On-device");
    heading.append(title, subtitle);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "×";
    close.setAttribute("aria-label", localized(job, "close", "Close"));
    close.addEventListener("click", closePopover);
    header.append(heading, close);

    const status = document.createElement("p");
    status.className = "status";
    status.setAttribute("role", "status");
    const progress = document.createElement("progress");
    progress.setAttribute("aria-label", label);
    progress.max = 1;
    progress.hidden = true;
    const result = document.createElement("p");
    result.className = "result";
    result.dir = "auto";
    result.hidden = true;
    const run = document.createElement("button");
    run.type = "button";
    run.className = "run";
    run.textContent = localized(job, "translatorRun", "Translate");
    run.hidden = true;
    run.addEventListener("click", async (event) => {
      if (!event.isTrusted) return;
      run.disabled = true;
      const settings = await readSettings();
      if (current !== job) return;
      if (!settings) {
        closePopover();
        return;
      }
      if (settings.source !== job.settings.source) job.detectedSource = undefined;
      job.settings = settings;
      subtitle.textContent = localized(job, engineLabels[settings.engine] ?? "translatorChrome", "On-device");
      await translate(job);
      run.disabled = false;
    });
    card.append(header, status, progress, result, run);
    shadow.append(card);
    document.documentElement.append(host);
    Object.assign(job, { host, card, status, progress, result, run });
    schedulePosition();
  }

  async function translate(job) {
    const controller = new AbortController();
    job.controller?.abort();
    job.controller = controller;
    job.run.hidden = true;
    job.result.hidden = true;
    job.status.hidden = false;
    job.status.textContent = localized(job, "translatorWorking", "Translating…");
    job.progress.hidden = true;
    schedulePosition();

    const updateProgress = (fraction) => {
      if (current !== job || controller.signal.aborted) return;
      const percent = new Intl.NumberFormat(job.settings.locale, { style: "percent", maximumFractionDigits: 0 }).format(fraction);
      job.status.textContent = localized(job, "translatorDownloading", "Preparing language model… {progress}").replace("{progress}", percent);
      job.progress.value = fraction;
      job.progress.hidden = false;
      schedulePosition();
    };
    try {
      let translated;
      const online = job.settings.engine && job.settings.engine !== "chrome";
      if (online) {
        translated = await translateOnline(job.sample.text, controller.signal);
      } else {
        const { chromeTranslate } = await loadEngine();
        controller.signal.throwIfAborted();
        translated = await chromeTranslate(job.sample.text, {
          source: job.settings.source,
          target: job.settings.target,
          signal: controller.signal,
          detectedSource: job.detectedSource,
          onDetected: (language) => { job.detectedSource = language; },
          onProgress: updateProgress
        });
      }
      if (current !== job || controller.signal.aborted) return;
      job.status.hidden = true;
      job.result.textContent = translated.text;
      job.result.hidden = false;
      if (!online) recordHistory(job, translated);
    } catch (error) {
      if (current !== job || controller.signal.aborted || error?.name === "AbortError") return;
      const code = error?.code ?? "translatorFailed";
      job.status.textContent = localized(job, code, localized(job, "translatorFailed", "Couldn’t translate this text."));
      job.run.hidden = code !== "translatorNeedsDownload";
    } finally {
      if (current === job && !controller.signal.aborted) {
        job.progress.hidden = true;
        schedulePosition();
      }
    }
  }

  document.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted) return;
    if (insidePopover(event)) {
      current.interacting = true;
      return;
    }
    closePopover();
    pointerStart = event.button === 0 ? {
      x: event.clientX, y: event.clientY, editable: event.composedPath().some(isEditable)
    } : null;
  }, true);

  document.addEventListener("mouseup", async (event) => {
    if (!event.isTrusted || insidePopover(event)) return;
    const start = pointerStart;
    pointerStart = null;
    if (!start || start.editable || event.button !== 0 || !event.ctrlKey
      || event.composedPath().some(isEditable)) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 2 && event.detail < 2) return;

    const sample = selectionSnapshot();
    if (!sample) return;
    const job = { sample };
    current = job;
    const settings = await readSettings();
    if (current !== job) return;
    if (!settings || !sameSelection(sample)) {
      closePopover();
      return;
    }
    job.settings = settings;
    createPopover(job);
    await translate(job);
  }, true);

  document.addEventListener("pointercancel", () => { pointerStart = null; }, true);
  document.addEventListener("selectionchange", () => {
    if (current && !current.interacting && !sameSelection(current.sample)) closePopover();
  });
  document.addEventListener("focusin", (event) => {
    if (!current) return;
    current.interacting = insidePopover(event);
    if (!current.interacting && !sameSelection(current.sample)) closePopover();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !current) return;
    event.preventDefault();
    closePopover();
  }, true);
  window.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
  window.addEventListener("pagehide", closePopover);
  window.addEventListener("resize", schedulePosition, { passive: true });
  window.visualViewport?.addEventListener("scroll", schedulePosition, { passive: true });
  window.visualViewport?.addEventListener("resize", schedulePosition, { passive: true });
})();
