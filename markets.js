import { marketInstrument, marketInstruments, marketLabel, validMarketAlert, workspaceMarketInstruments } from "./markets-store.js";
import { getMarketHistory, getMarketQuotes, searchMarkets } from "./markets-api.js";
import { marketIconKey, marketIconMessage, readCachedMarketIcon } from "./markets-icons.js";

const marketKinds = { all: "marketsAll", fx: "marketsFx", crypto: "marketsCrypto", wallex: "marketsWallex" };
const cryptoNames = { BTC: "marketsBitcoin", ETH: "marketsEthereum", SOL: "marketsSolana", XRP: "marketsXrp", USDT: "marketsTether" };
const providers = {
  fx: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html",
  crypto: "https://www.coingecko.com/en",
  wallex: "https://wallex.ir/"
};
const providerLabels = { fx: "marketsFxReference", crypto: "marketsCryptoCredit", wallex: "marketsWallex" };
const quoteRefreshInterval = 10 * 60_000;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function validPrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function drawSeries(canvas, series, detailed) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height || !series.length) return;
  const scale = Math.min(3, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(scale, scale);
  const style = getComputedStyle(canvas);
  const color = style.color;
  const padding = detailed ? 8 : 3;
  const low = Math.min(...series.map(point => point.value));
  const high = Math.max(...series.map(point => point.value));
  const first = series[0].at;
  const duration = series.at(-1).at - first;
  const points = series.map(({ at, value }) => ({
    x: duration ? padding + (at - first) / duration * (width - padding * 2) : width / 2,
    y: high === low ? height / 2 : height - padding - (value - low) / (high - low) * (height - padding * 2)
  }));
  if (detailed) {
    context.strokeStyle = style.getPropertyValue("--stroke");
    context.globalAlpha = .6;
    context.beginPath();
    for (const fraction of [.2, .5, .8]) {
      context.moveTo(padding, height * fraction);
      context.lineTo(width - padding, height * fraction);
    }
    context.stroke();
    context.globalAlpha = 1;
  }
  const trace = () => {
    context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  };
  if (detailed && points.length > 1) {
    context.beginPath();
    trace();
    context.lineTo(points.at(-1).x, height - padding);
    context.lineTo(points[0].x, height - padding);
    context.closePath();
    context.fillStyle = color;
    context.globalAlpha = .1;
    context.fill();
    context.globalAlpha = 1;
  }
  context.beginPath();
  trace();
  context.strokeStyle = color;
  context.lineWidth = detailed ? 2 : 1.5;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.stroke();
  const last = points.at(-1);
  context.beginPath();
  context.arc(last.x, last.y, detailed ? 3 : 1.8, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
}

export function renderMarkets(container, {
  locale, dateLocale = locale, t, icon, state: initialState, alertState: initialAlertState,
  onWatchlist, onWatchlistMenu, onAddAlert, onRemoveAlert
}) {
  const currencyNames = new Intl.DisplayNames([locale], { type: "currency" });
  const percent = new Intl.NumberFormat(locale, { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 2 });
  const prices = new Intl.NumberFormat(locale, { maximumSignificantDigits: 8 });
  const tomans = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const smallPrices = new Intl.NumberFormat(locale, { notation: "scientific", maximumSignificantDigits: 4 });
  const decimal = prices.formatToParts(1.1).find(part => part.type === "decimal")?.value ?? ".";
  const dateOnly = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeZone: "UTC" });
  const dateTime = new Intl.DateTimeFormat(dateLocale, { dateStyle: "medium", timeStyle: "short" });
  const chartData = new WeakMap();
  const iconUrls = new Map();
  const iconLoads = new Map();
  const unavailableIcons = new Set();
  let state = initialState;
  let alertState = initialAlertState;
  let quotes = new Map();
  let screen = "watchlist";
  let kind = "all";
  let quoteRequest;
  let quoteError = false;
  let foundInstruments = [];
  let catalogueRequest;
  let catalogueTimer;
  let catalogueStatus;
  let detail;
  let frame;
  let dragging;
  let disposed = false;

  function control(label, className, handler, symbol, iconOnly = false) {
    const button = element("button", className);
    button.type = "button";
    if (symbol) button.innerHTML = icon(symbol);
    if (iconOnly) {
      button.title = label;
      button.setAttribute("aria-label", label);
    } else {
      button.append(element("span", "", label));
    }
    button.addEventListener("click", handler);
    return button;
  }

  function optionGroup(className, label, options, activate) {
    const group = element("div", className);
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    const buttons = new Map();
    for (const [value, key] of Object.entries(options)) {
      const button = control(t(key), "markets-segment", () => activate(value));
      buttons.set(value, button);
      group.append(button);
    }
    return {
      group,
      select(value) {
        for (const [mode, button] of buttons) button.setAttribute("aria-pressed", String(mode === value));
      },
      focus(value) { buttons.get(value)?.focus({ preventScroll: true }); }
    };
  }

  const module = element("section", "markets");
  const toolbar = element("div", "markets-toolbar");
  const navigation = optionGroup("markets-navigation", t("markets"), {
    watchlist: "marketsWatchlist", browse: "marketsBrowse"
  }, (view) => {
    if (screen === view) return;
    screen = view;
    feedback();
    showList();
    refreshQuotes(true);
  });
  const refresh = control(t("marketsRefresh"), "icon-button markets-refresh", () => refreshQuotes(), "refresh", true);
  toolbar.append(navigation.group, refresh);
  const filters = optionGroup("markets-filters", t("marketsBrowse"), marketKinds, (value) => {
    if (kind === value) return;
    kind = value;
    updateCatalogue();
  });
  const catalogue = element("div", "markets-catalogue");
  const pairSearch = element("input", "markets-input markets-catalogue-search");
  pairSearch.type = "search";
  pairSearch.maxLength = 100;
  pairSearch.dir = "auto";
  pairSearch.placeholder = t("marketsPairSearch");
  pairSearch.setAttribute("aria-label", pairSearch.placeholder);
  const pairHint = element("p", "markets-catalogue-hint", t("marketsPairHint"));
  pairHint.id = "markets-pair-hint";
  pairSearch.setAttribute("aria-describedby", pairHint.id);
  catalogue.append(pairSearch, pairHint);
  pairSearch.addEventListener("input", updateCatalogue);
  const quoteStatus = element("p", "markets-status");
  quoteStatus.setAttribute("role", "status");
  const listPane = element("div", "markets-list-pane");
  const detailPane = element("div", "markets-detail-pane");
  detailPane.hidden = true;
  const actionStatus = element("p", "markets-status markets-action-status");
  actionStatus.setAttribute("role", "status");
  actionStatus.hidden = true;
  module.append(toolbar, filters.group, catalogue, quoteStatus, listPane, detailPane, actionStatus);
  container.append(module);

  function feedback(key) {
    actionStatus.hidden = !key;
    actionStatus.textContent = key ? t(key) : "";
  }

  async function save(button, action) {
    if (button.getAttribute("aria-disabled") === "true") return false;
    button.setAttribute("aria-disabled", "true");
    feedback();
    try {
      return await action() === true;
    } catch (error) {
      if (!disposed) feedback(error?.code ?? "marketsActionFailed");
      return false;
    } finally {
      button.removeAttribute("aria-disabled");
    }
  }

  function formatStamp(value) {
    if (value == null) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? dateOnly : dateTime).format(date);
  }

  function instrumentName(instrument) {
    const base = instrument.kind === "fx" ? currencyNames.of(instrument.base)
      : !instrument.symbol.startsWith("cg:") && cryptoNames[instrument.base]
        ? t(cryptoNames[instrument.base]) : instrument.name;
    const quote = instrument.quoteName || (instrument.quote === "TMN" ? t("marketsToman")
      : cryptoNames[instrument.quote] ? t(cryptoNames[instrument.quote])
        : /^[A-Z]{3}$/u.test(instrument.quote) ? currencyNames.of(instrument.quote) : instrument.quote);
    return `${base} / ${quote}`;
  }

  function quoteUnit(instrument) {
    if (instrument.quote === "TMN") return t("marketsToman");
    if (instrument.quote === "USDT") return t("marketsTether");
    return instrument.quote;
  }

  function priceLabel(instrument, price) {
    if (instrument.quote === "TMN" && price >= 1) return tomans.format(price);
    return (price < 0.0000001 ? smallPrices : prices).format(price);
  }

  function iconUrl(instrument, key, download) {
    if (iconUrls.has(key)) return Promise.resolve(iconUrls.get(key));
    if (unavailableIcons.has(key)) return Promise.resolve(null);
    const requestKey = `${key}:${download}`;
    if (iconLoads.has(requestKey)) return iconLoads.get(requestKey);
    const request = (async () => {
      let blob = await readCachedMarketIcon(key);
      if (!blob && download && !disposed) {
        try {
          const answer = await chrome.runtime.sendMessage({ type: marketIconMessage, symbol: instrument.symbol });
          if (answer?.cached) blob = await readCachedMarketIcon(key);
        } catch {}
      }
      if (disposed) return null;
      if (blob && !iconUrls.has(key)) iconUrls.set(key, URL.createObjectURL(blob));
      if (!blob && download && !iconUrls.has(key)) unavailableIcons.add(key);
      return iconUrls.get(key) ?? null;
    })().finally(() => iconLoads.delete(requestKey));
    iconLoads.set(requestKey, request);
    return request;
  }

  function assetBadge(instrument, download) {
    const badge = element("span", "markets-asset");
    badge.setAttribute("aria-hidden", "true");
    badge.dir = "ltr";
    const fallback = element("span", "markets-asset-code", [...instrument.base].slice(0, 3).join(""));
    badge.append(fallback);
    const key = marketIconKey(instrument.symbol);
    if (key) void iconUrl(instrument, key, download).then(url => {
      if (!url || disposed || !badge.isConnected) return;
      const image = element("img", "markets-asset-image");
      image.alt = "";
      image.decoding = "async";
      image.draggable = false;
      image.addEventListener("load", () => { fallback.hidden = true; }, { once: true });
      image.addEventListener("error", () => { image.remove(); }, { once: true });
      badge.append(image);
      image.src = url;
    }).catch(() => {});
    return badge;
  }

  function availableInstruments() {
    return new Map([...workspaceMarketInstruments(state), ...foundInstruments].map(item => [item.symbol, item]));
  }

  function listInstruments() {
    if (screen === "watchlist") {
      const items = availableInstruments();
      return state.watchlist.map(symbol => items.get(symbol)).filter(Boolean);
    }
    const selected = pairSearch.value.trim() ? foundInstruments : marketInstruments;
    return selected.filter(item => kind === "all" || item.kind === kind);
  }

  function updateCatalogue() {
    catalogueRequest?.abort();
    clearTimeout(catalogueTimer);
    const query = pairSearch.value.trim();
    foundInstruments = [];
    catalogueStatus = query ? "marketsLoading" : undefined;
    if (!detail) showList();
    if (!query) {
      refreshQuotes(true);
      return;
    }
    catalogueTimer = setTimeout(async () => {
      const request = new AbortController();
      catalogueRequest = request;
      try {
        const results = await searchMarkets(query, kind, { signal: request.signal });
        if (request.signal.aborted || disposed) return;
        foundInstruments = results;
        catalogueStatus = undefined;
      } catch {
        if (request.signal.aborted || disposed) return;
        catalogueStatus = "marketsUnavailable";
      }
      if (!detail && screen === "browse") {
        showList();
        refreshQuotes(true);
      }
    }, 230);
  }

  function parseAmount(value) {
    const normalized = value.trim().replace(/[٠-٩۰-۹]/gu, digit => String(digit.codePointAt(0) & 15))
      .replaceAll("٫", ".").replaceAll(decimal, ".");
    return /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/u.test(normalized) ? Number(normalized) : NaN;
  }

  function quoteDescription(instrument, quote) {
    const info = element("div", "markets-quote-info");
    const source = element("a", "markets-source", t(providerLabels[instrument.kind]));
    source.href = providers[instrument.kind];
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    info.append(source);
    if (quote?.asOf) {
      const formatted = formatStamp(quote.asOf);
      if (formatted) {
        const stamp = element("time", "markets-time", t("marketsUpdated", { date: formatted }));
        stamp.dateTime = quote.asOf;
        info.append(stamp);
      }
    }
    if ((quoteError || quote?.stale) && validPrice(quote?.price)) {
      info.append(element("span", "markets-stale", t("marketsStale")));
    }
    return info;
  }

  function changeDirection(change) {
    return change > 0 ? "up" : change < 0 ? "down" : "flat";
  }

  function quoteValue(instrument, quote) {
    const values = element("span", "markets-values");
    const price = validPrice(quote?.price);
    const amount = element("strong", "markets-price");
    if (price) {
      amount.append(element("bdi", "", priceLabel(instrument, quote.price)), " ",
        element("bdi", "markets-price-unit", quoteUnit(instrument)));
    } else {
      amount.dataset.missing = "true";
      amount.append(element("span", "markets-no-quote", t("marketsNoQuote")));
    }
    values.append(amount);
    if (price && Number.isFinite(quote.changePercent)) {
      const change = element("span", "markets-change");
      const direction = changeDirection(quote.changePercent);
      const formatted = percent.format(quote.changePercent / 100);
      if (direction !== "flat") {
        const arrow = element("span", "", direction === "up" ? "↑" : "↓");
        arrow.setAttribute("aria-hidden", "true");
        change.append(arrow);
      }
      change.append(element("bdi", "", formatted));
      change.title = t(instrument.kind === "fx" ? "marketsFxChange" : "marketsCryptoChange");
      change.setAttribute("role", "img");
      change.setAttribute("aria-label", `${change.title} ${formatted}`);
      change.dataset.direction = direction;
      values.append(change);
    }
    return values;
  }

  function seriesCanvas(series, detailed, direction = "flat") {
    const canvas = element("canvas", detailed ? "markets-history-chart" : "markets-sparkline");
    canvas.dataset.direction = direction;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", t(detailed ? "marketsPriceHistory" : "marketsTrend"));
    chartData.set(canvas, { series, detailed });
    return canvas;
  }

  function queueCharts() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const canvas of module.querySelectorAll("canvas")) {
        const { series, detailed } = chartData.get(canvas);
        drawSeries(canvas, series, detailed);
      }
    });
  }

  function watchAction(instrument, action, label, symbol) {
    const button = control(`${t(label)} ${marketLabel(instrument)}`, "icon-button markets-row-action", () => {
      save(button, () => onWatchlist({ symbol: instrument.symbol, instrument, action }));
    }, symbol, true);
    button.dataset.marketAction = action;
    return button;
  }

  function watchToggle(instrument) {
    const watching = state.watchlist.includes(instrument.symbol);
    const button = watchAction(instrument, watching ? "remove" : "add", watching ? "marketsRemove" : "marketsAdd", "star");
    button.classList.add("markets-watch-star");
    button.setAttribute("aria-pressed", String(watching));
    return button;
  }

  function bindReorder(row, target, instrument, index, count) {
    if (screen !== "watchlist" || count < 2) return;
    const move = (action) => save(target, () => onWatchlist({ symbol: instrument.symbol, action }));
    onWatchlistMenu?.(target, marketLabel(instrument), (action) => {
      if (index > 0) action("marketsMoveUp", "chevron-up", () => move("up"));
      if (index < count - 1) action("marketsMoveDown", "chevron-down", () => move("down"));
    });
    target.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    target.addEventListener("keydown", (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      if (event.repeat) return;
      if (event.key === "ArrowUp" && index > 0) move("up");
      if (event.key === "ArrowDown" && index < count - 1) move("down");
    });
    target.draggable = true;
    target.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      dragging = instrument.symbol;
      row.dataset.dragging = "true";
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-ease-market", dragging);
    });
    function clearDrop() {
      dragging = undefined;
      for (const item of listPane.querySelectorAll("[data-dragging], [data-market-drop]")) {
        delete item.dataset.dragging;
        delete item.dataset.marketDrop;
      }
    }
    target.addEventListener("dragend", clearDrop);
    function dropPosition(event) {
      const boundary = row.getBoundingClientRect();
      return event.clientY < boundary.top + boundary.height / 2 ? "before" : "after";
    }
    row.addEventListener("dragover", (event) => {
      if (!dragging || dragging === instrument.symbol) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      row.dataset.marketDrop = dropPosition(event);
    });
    row.addEventListener("dragleave", (event) => {
      if (!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget)) delete row.dataset.marketDrop;
    });
    row.addEventListener("drop", (event) => {
      if (!dragging || dragging === instrument.symbol) return;
      event.preventDefault();
      const symbol = dragging;
      clearDrop();
      save(target, () => onWatchlist({ symbol, action: "move", targetSymbol: instrument.symbol, position: dropPosition(event) }));
    });
  }

  function renderRow(instrument, index, count) {
    const quote = quotes.get(instrument.symbol);
    const row = element("li", "markets-row");
    row.dataset.symbol = instrument.symbol;
    const target = element("button", "markets-row-open");
    target.type = "button";
    target.title = t("marketsDetails");
    target.dataset.marketAction = "open";
    target.addEventListener("click", () => openInstrument(instrument.symbol));
    const identity = element("span", "markets-identity");
    const symbol = element("bdi", "markets-symbol", marketLabel(instrument));
    symbol.dir = "ltr";
    const subtitle = element("span", "markets-row-subtitle");
    subtitle.append(symbol);
    if ((quoteError || quote?.stale) && validPrice(quote?.price)) {
      subtitle.append(element("span", "markets-stale", t("marketsStale")));
    }
    const name = element("span", "markets-name", instrumentName(instrument));
    name.dir = "auto";
    name.title = name.textContent;
    identity.append(name, subtitle);
    target.append(assetBadge(instrument, state.watchlist.includes(instrument.symbol)), identity);
    const trend = quote?.trend?.filter(validPrice) ?? [];
    if (trend.length > 1) {
      target.dataset.trend = "true";
      target.append(seriesCanvas(trend.map((value, at) => ({ value, at })), false,
        changeDirection(trend.at(-1) - trend[0])));
    }
    target.append(quoteValue(instrument, quote));
    bindReorder(row, target, instrument, index, count);
    row.append(watchToggle(instrument), target);
    return row;
  }

  function showList(focusSymbol) {
    const previous = document.activeElement;
    const previousRow = listPane.contains(previous) ? previous.closest(".markets-row") : null;
    const previousIndex = previousRow ? Array.from(previousRow.parentElement.children).indexOf(previousRow) : -1;
    const previousAction = previous?.dataset.marketAction;
    toolbar.hidden = false;
    filters.group.hidden = screen !== "browse";
    catalogue.hidden = screen !== "browse";
    navigation.select(screen);
    filters.select(kind);
    listPane.hidden = false;
    detailPane.hidden = true;
    const items = listInstruments();
    if (!items.length) {
      const isSearch = screen === "browse";
      const title = element("h2", "", t(isSearch ? catalogueStatus ?? "marketsNoPairs" : "marketsEmptyWatchlist"));
      const empty = element("div", "markets-empty");
      empty.append(title);
      if (!isSearch) empty.append(element("p", "", t("marketsEmptyWatchlistHint")));
      listPane.replaceChildren(empty);
      if (previousRow || focusSymbol) navigation.focus(screen);
      return;
    }
    const list = element("ul", "markets-list");
    const rows = new Map();
    items.forEach((instrument, index) => {
      const row = renderRow(instrument, index, items.length);
      rows.set(instrument.symbol, row);
      list.append(row);
    });
    listPane.replaceChildren(list);
    const row = rows.get(focusSymbol ?? previousRow?.dataset.symbol)
      ?? (previousIndex >= 0 ? list.children[Math.min(previousIndex, list.children.length - 1)] : null);
    const focusAction = previous?.classList.contains("markets-watch-star") ? ".markets-watch-star"
      : previousAction ? `[data-market-action="${previousAction}"]:not(:disabled)` : null;
    const control = focusAction && row?.querySelector(focusAction);
    (control || row?.querySelector(".markets-row-open"))?.focus({ preventScroll: true });
    if (focusSymbol && !row) navigation.focus(screen);
    queueCharts();
  }

  function displayedSymbols() {
    return detail ? [detail.instrument.symbol] : listInstruments().map(item => item.symbol);
  }

  function updateQuoteStatus() {
    const loading = Boolean(quoteRequest);
    const waitingForPrices = loading && displayedSymbols().every(symbol => !validPrice(quotes.get(symbol)?.price));
    const message = waitingForPrices ? "marketsLoading" : quoteError && !loading ? "marketsUnavailable" : undefined;
    module.toggleAttribute("data-loading-quotes", loading);
    quoteStatus.hidden = !message;
    if (message) quoteStatus.textContent = t(message);
    refresh.disabled = loading;
    if (detail) detail.refresh.disabled = Boolean(quoteRequest || detail.historyRequest);
  }

  async function refreshQuotes(restart = false) {
    if (disposed || (quoteRequest && !restart)) return;
    if (restart) quoteRequest?.abort();
    const symbols = displayedSymbols();
    if (!symbols.length) {
      quoteRequest = undefined;
      quoteError = false;
      updateQuoteStatus();
      return;
    }
    const request = new AbortController();
    quoteRequest = request;
    updateQuoteStatus();
    try {
      const response = await getMarketQuotes({ symbols, signal: request.signal });
      if (disposed || request.signal.aborted) return;
      const next = new Map(quotes);
      for (const symbol of symbols) if (next.has(symbol)) next.set(symbol, { ...next.get(symbol), stale: true });
      for (const quote of response.quotes) {
        if (validPrice(quote.price) || !validPrice(next.get(quote.symbol)?.price)) {
          next.delete(quote.symbol);
          next.set(quote.symbol, quote);
        }
      }
      while (next.size > 150) next.delete(next.keys().next().value);
      quotes = next;
      quoteError = false;
    } catch {
      if (disposed || request.signal.aborted) return;
      quoteError = true;
    } finally {
      if (quoteRequest === request) quoteRequest = undefined;
      if (!disposed && !request.signal.aborted) {
        updateQuoteStatus();
        if (detail) showDetailQuote(detail);
        else showList();
      }
    }
  }

  function section(title, className) {
    const panel = element("section", `markets-detail-section ${className}`);
    panel.append(element("h3", "", t(title)));
    return panel;
  }

  function field(label, input) {
    const wrapper = element("label", "markets-field");
    wrapper.append(element("span", "", t(label)), input);
    return wrapper;
  }

  function setupConverter(instrument) {
    const panel = section("marketsConverter", "markets-converter");
    const row = element("div", "markets-converter-row");
    const amount = element("input", "markets-input");
    amount.type = "text";
    amount.inputMode = "decimal";
    amount.maxLength = 40;
    amount.dir = "ltr";
    amount.value = prices.format(1);
    const inputField = field("marketsConvertAmount", amount);
    const from = element("bdi", "markets-converter-unit");
    from.dir = "ltr";
    inputField.append(from);
    const result = element("output", "markets-converter-result");
    result.setAttribute("aria-live", "polite");
    const value = element("bdi", "markets-converted");
    const to = element("bdi", "markets-converter-unit");
    to.dir = "ltr";
    result.append(value, to);
    let reversed = false;
    function updateValue() {
      from.textContent = reversed ? instrument.quote : instrument.base;
      to.textContent = reversed ? instrument.base : instrument.quote;
      const rate = quotes.get(instrument.symbol)?.price;
      const input = parseAmount(amount.value);
      const converted = validPrice(rate) && input >= 0 && Number.isFinite(input) ? (reversed ? input / rate : input * rate) : NaN;
      value.textContent = Number.isFinite(converted) ? prices.format(converted) : t("marketsNoQuote");
    }
    const flip = control(`${t("marketsFlip")} ${marketLabel(instrument)}`, "icon-button markets-flip", () => {
      reversed = !reversed;
      updateValue();
    }, "swap", true);
    amount.addEventListener("input", updateValue);
    row.append(inputField, flip, result);
    panel.append(row);
    return { panel, updateValue };
  }

  function setupAlerts(instrument) {
    const panel = section("marketsAlerts", "markets-alerts");
    const form = element("form", "markets-alert-form");
    const direction = element("select", "markets-input");
    direction.add(new Option(t("marketsAlertAbove"), "above"));
    direction.add(new Option(t("marketsAlertBelow"), "below"));
    const threshold = element("input", "markets-input");
    threshold.type = "text";
    threshold.inputMode = "decimal";
    threshold.maxLength = 40;
    threshold.dir = "ltr";
    threshold.required = true;
    threshold.addEventListener("input", () => threshold.setCustomValidity(""));
    const submit = element("button", "primary-button", t("marketsAlertAdd"));
    submit.type = "submit";
    const list = element("ul", "markets-alert-list");
    const thresholdField = field("marketsAlertAt", threshold);
    thresholdField.firstElementChild.append(" ", element("bdi", "", instrument.quote));
    form.append(field("marketsAlerts", direction), thresholdField, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const price = parseAmount(threshold.value);
      const alert = { symbol: instrument.symbol, instrument, direction: direction.value, price };
      if (!validMarketAlert(alert)) {
        threshold.setCustomValidity(t("marketsInvalidPreference"));
        threshold.reportValidity();
        return;
      }
      if (await save(submit, () => onAddAlert(alert))) {
        threshold.value = "";
      }
    });
    panel.append(form, list);
    return { panel, list };
  }

  function showAlerts(current) {
    const alerts = state.alerts.filter(alert => alert.symbol === current.instrument.symbol);
    const list = current.alerts.list;
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.alertId : undefined;
    const controls = new Map();
    if (!alerts.length) {
      list.replaceChildren(element("li", "markets-no-alerts", t("marketsAlertEmpty")));
      if (focused) current.alerts.panel.querySelector("[type=submit]").focus({ preventScroll: true });
      return;
    }
    const items = alerts.map(alert => {
      const row = element("li", "markets-alert-row");
      const rule = element("div", "markets-alert-rule");
      const threshold = element("bdi", "", `${prices.format(alert.price)} ${current.instrument.quote}`);
      rule.append(element("strong", "", t(alert.direction === "above" ? "marketsAlertAbove" : "marketsAlertBelow")), threshold);
      const fired = formatStamp(alertState?.[alert.id]?.firedAt);
      const status = element("span", "markets-alert-status", fired ? t("marketsAlertTriggered", { date: fired }) : t("marketsAlertWaiting"));
      status.dataset.fired = String(Boolean(fired));
      const details = element("div", "markets-alert-details");
      details.append(rule, status);
      const remove = control(t("marketsAlertRemove"), "icon-button markets-row-action markets-alert-remove",
        () => save(remove, () => onRemoveAlert(alert.id)), "trash", true);
      remove.dataset.alertId = alert.id;
      remove.setAttribute("aria-label", `${t("marketsAlertRemove")} ${threshold.textContent}`);
      controls.set(alert.id, remove);
      row.append(details, remove);
      return row;
    });
    list.replaceChildren(...items);
    if (focused) (controls.get(focused) ?? controls.values().next().value)?.focus({ preventScroll: true });
  }

  function showDetailQuote(current) {
    const quote = quotes.get(current.instrument.symbol);
    current.quote.replaceChildren(quoteValue(current.instrument, quote), quoteDescription(current.instrument, quote));
    current.converter.updateValue();
  }

  function showDetailWatch(current) {
    const previous = current.actions.firstElementChild;
    const focused = document.activeElement === previous;
    const toggle = watchToggle(current.instrument);
    if (previous) previous.replaceWith(toggle);
    else current.actions.append(toggle, current.refresh);
    if (focused) toggle.focus({ preventScroll: true });
  }

  function showHistory(current, history) {
    const points = (history?.points ?? []).map(({ at, value }) => ({ at: new Date(at).getTime(), stamp: at, value }))
      .filter(({ at, value }) => Number.isFinite(at) && validPrice(value)).sort((first, second) => first.at - second.at);
    if (!points.length) {
      current.history.replaceChildren(element("p", "markets-history-hint", t("marketsNoHistory")));
      return;
    }
    const chart = seriesCanvas(points, true, changeDirection(points.at(-1).value - points[0].value));
    const range = element("div", "markets-history-range");
    range.append(element("span", "", formatStamp(points[0].stamp)));
    if (points.length > 1) range.append(element("span", "", formatStamp(points.at(-1).stamp)));
    current.history.replaceChildren(chart, range);
    if (history.stale) current.history.append(element("span", "markets-stale", t("marketsStale")));
    queueCharts();
  }

  async function fetchHistory(current) {
    current.historyRequest?.abort();
    const request = new AbortController();
    current.historyRequest = request;
    if (!current.historyData) current.history.replaceChildren(element("p", "markets-history-hint", t("marketsLoading")));
    updateQuoteStatus();
    function apply(history) {
      if (detail !== current || request.signal.aborted || disposed) return;
      if (history?.points.length) current.historyData = history;
      showHistory(current, history?.points.length ? history : current.historyData && { ...current.historyData, stale: true });
    }
    try {
      apply(await getMarketHistory(current.instrument.symbol, { signal: request.signal }));
    } catch {
      apply();
    } finally {
      if (current.historyRequest === request) current.historyRequest = undefined;
      if (!disposed) updateQuoteStatus();
    }
  }

  function closeInstrument() {
    if (!detail) return;
    const { instrument, historyRequest } = detail;
    historyRequest?.abort();
    detail = undefined;
    detailPane.replaceChildren();
    feedback();
    showList(instrument.symbol);
    refreshQuotes(true);
  }

  function openInstrument(symbol) {
    const instrument = availableInstruments().get(symbol) ?? marketInstrument(symbol);
    if (!instrument || disposed) return false;
    if (detail?.instrument.symbol === symbol) {
      detail.heading.focus();
      return true;
    }
    detail?.historyRequest?.abort();
    const heading = element("h2", "markets-detail-symbol");
    const pair = element("bdi", "", marketLabel(instrument));
    pair.dir = "ltr";
    heading.append(pair);
    heading.tabIndex = -1;
    const identity = element("div", "markets-detail-identity");
    identity.append(heading, element("p", "markets-name", instrumentName(instrument)));
    const rtl = getComputedStyle(module).direction === "rtl";
    const back = control(t("close"), "icon-button markets-back", closeInstrument, rtl ? "chevron-right" : "chevron-left", true);
    const actions = element("div", "markets-row-actions");
    const refreshDetail = control(t("marketsRefresh"), "icon-button markets-refresh", () => {
      refreshQuotes();
      fetchHistory(detail);
    }, "refresh", true);
    const head = element("div", "markets-detail-header");
    head.append(back, assetBadge(instrument, true), identity, actions);
    const quote = element("div", "markets-detail-quote");
    const historyPanel = section("marketsPriceHistory", "markets-history");
    const history = element("div", "markets-history-inner");
    historyPanel.append(history);
    const converter = setupConverter(instrument);
    const alerts = setupAlerts(instrument);
    detail = { instrument, quote, actions, history, converter, alerts, heading, refresh: refreshDetail };
    toolbar.hidden = true;
    filters.group.hidden = true;
    catalogue.hidden = true;
    listPane.hidden = true;
    detailPane.hidden = false;
    detailPane.replaceChildren(head, quote, historyPanel, converter.panel, alerts.panel);
    feedback();
    showDetailWatch(detail);
    showDetailQuote(detail);
    showAlerts(detail);
    refreshQuotes(true);
    fetchHistory(detail);
    heading.focus({ preventScroll: true });
    head.scrollIntoView({ block: "nearest" });
    return true;
  }

  const resize = new ResizeObserver(queueCharts);
  resize.observe(module);
  const theme = matchMedia("(prefers-color-scheme: dark)");
  theme.addEventListener("change", queueCharts);
  const refreshTimer = setInterval(() => {
    if (!document.hidden && module.isConnected) {
      refreshQuotes();
      if (detail && !detail.historyRequest) fetchHistory(detail);
    }
  }, quoteRefreshInterval);
  showList();
  refreshQuotes();
  return {
    update({ state: nextState, alertState: nextAlerts }) {
      if (disposed) return;
      const previousList = state.watchlist.join(",");
      if (nextState) state = nextState;
      if (nextAlerts) alertState = nextAlerts;
      if (detail) {
        showDetailWatch(detail);
        showAlerts(detail);
        queueCharts();
      } else {
        showList();
        if (screen === "watchlist" && previousList !== state.watchlist.join(",")) refreshQuotes(true);
      }
    },
    openInstrument,
    dispose() {
      disposed = true;
      quoteRequest?.abort();
      detail?.historyRequest?.abort();
      for (const url of iconUrls.values()) URL.revokeObjectURL(url);
      catalogueRequest?.abort();
      clearTimeout(catalogueTimer);
      clearInterval(refreshTimer);
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.removeEventListener("change", queueCharts);
    }
  };
}
