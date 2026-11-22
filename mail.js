import { mailMessageLink, mailPermission, mailProviders } from "./mail-api.js";

export function inboxMessages(accounts) {
  return accounts.flatMap(({ id, provider, email, messages }) => messages.map(message => ({
    ...message, url: mailMessageLink(provider, message.url), accountId: id, provider, email
  }))).sort((left, right) => right.received - left.received);
}

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

export function renderMail(container, { dateLocale, t, icon, settingsButton, accounts, send, followUp, requestInWorker }) {
  const dates = new Intl.DateTimeFormat(dateLocale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const numbers = new Intl.NumberFormat(dateLocale);
  let accountId = "";
  let unreadOnly = false;
  let managing = false;
  let busy = false;
  let disposed = false;
  let configured;
  let error;
  let verifying = false;

  const module = element("section", "mail-module");
  const inbox = element("section", "mail-inbox");
  const settings = element("section", "mail-settings");
  const controls = element("div", "mail-toolbar");
  const accountSelect = element("select", "translator-select mail-account-select");
  accountSelect.setAttribute("aria-label", t("mailAccounts"));
  const unread = control("mailUnread", null, () => { unreadOnly = !unreadOnly; renderInbox(); });
  const reload = control("mailRefresh", "refresh", () => act("refresh", { force: true }), true);
  const accountSummary = element("p", "mail-summary");
  const list = element("ul", "mail-list");
  const state = element("p", "mail-state");
  state.setAttribute("role", "status");
  const settingsTitle = element("h2", "", t("mailAccounts"));
  const settingsHint = element("p", "mail-hint", t("mailPrivacy"));
  const connect = element("div", "mail-provider-buttons");
  const linked = element("ul", "mail-list mail-linked");
  controls.append(accountSelect, unread, reload);
  inbox.append(controls, accountSummary, list);
  settings.append(settingsTitle, settingsHint, connect, linked);
  module.append(state, inbox, settings);
  container.append(module);

  function control(key, symbol, run, iconOnly = false, values) {
    const label = t(key, values);
    const button = element("button", iconOnly ? "icon-button mail-icon-button" : "secondary-button");
    button.type = "button";
    if (symbol) button.innerHTML = icon(symbol);
    if (iconOnly) {
      button.title = label;
      button.setAttribute("aria-label", label);
    } else button.append(element("span", "", label));
    button.addEventListener("click", run);
    return button;
  }

  async function act(action, data = {}) {
    if (busy || disposed) return;
    busy = true;
    error = undefined;
    render();
    try {
      const answer = await send(action, data);
      if (disposed) return;
      if (answer?.ok) accounts = answer.value;
      else error = answer?.error ?? "mailUnavailable";
    } catch {
      error = "mailUnavailable";
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }

  async function verifyProviders(force = false) {
    if ((configured && !force) || verifying) return;
    verifying = true;
    render();
    try {
      const answer = await send("config");
      if (answer?.ok) configured = answer.value;
      else error = "mailUnavailable";
    } catch {
      error = "mailUnavailable";
    } finally {
      verifying = false;
      if (!disposed) render();
    }
  }

  async function linkAccount(provider) {
    if (busy) return;
    if (!requestInWorker) {
      // Check access from the same click that opened the account chooser.
      const allowed = await chrome.permissions.request(mailPermission(provider)).catch(() => false);
      if (!allowed) { error = "mailPermission"; render(); return; }
    }
    await act("connect", { provider, requestPermission: requestInWorker });
  }

  function renderSettings() {
    connect.replaceChildren(...Object.entries(mailProviders).map(([provider, { label }]) => {
      const button = control("mailConnect", "plus", () => linkAccount(provider), false, { provider: label });
      button.disabled = busy || verifying || configured?.[provider] === false;
      return button;
    }));
    linked.replaceChildren(...accounts.map(account => {
      const row = element("li", "mail-account-row");
      const copy = element("div", "mail-account-copy");
      const address = element("strong", "", account.email);
      address.dir = "ltr";
      address.title = account.email;
      copy.append(address, element("small", "", t(account.issue ?? "mailConnected", { provider: mailProviders[account.provider].label })));
      const disconnect = control("mailDisconnect", "close", () => act("disconnect", { id: account.id }), true);
      disconnect.disabled = busy;
      row.append(copy, disconnect);
      return row;
    }));
  }

  function renderInbox() {
    if (!accounts.some(account => account.id === accountId)) accountId = "";
    accountSelect.replaceChildren(new Option(t("mailAllAccounts"), ""), ...accounts.map(account => new Option(account.email, account.id)));
    accountSelect.value = accountId;
    unread.setAttribute("aria-pressed", String(unreadOnly));
    reload.disabled = busy;
    const selected = accounts.filter(account => !accountId || account.id === accountId);
    const unreadCount = selected.reduce((total, account) => total + account.unread, 0);
    accountSummary.textContent = t("mailUnreadCount", { count: numbers.format(unreadCount) });
    const rows = inboxMessages(selected).filter(row => !unreadOnly || row.unread);
    list.replaceChildren(...rows.map(message => {
      const row = element("li", "mail-row");
      row.dataset.unread = String(message.unread);
      const open = element(message.url ? "a" : "div", "mail-row-open");
      if (message.url) {
        open.href = message.url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
      }
      const subject = element("strong", "mail-subject", message.subject || t("mailNoSubject"));
      subject.dir = "auto";
      subject.title = subject.textContent;
      const sender = element("span", "mail-sender", message.sender || t("mailUnknownSender"));
      sender.dir = "auto";
      sender.title = sender.textContent;
      const detail = element("span", "mail-details");
      const date = element("time", "", dates.format(message.received));
      date.dateTime = new Date(message.received).toISOString();
      const address = element("bdi", "mail-address", message.email);
      address.title = message.email;
      detail.append(date, address);
      open.append(subject, sender, detail);
      if (message.unread) open.append(element("span", "mail-unread-dot"));
      row.append(open);
      if (message.url) row.append(control("mailFollowUp", "calendar", () => followUp(message), true));
      return row;
    }));
    if (!rows.length) list.append(element("li", "mail-empty", t(unreadOnly ? "mailNoUnread" : "mailEmpty")));
  }

  function render() {
    const showSettings = managing || !accounts.length;
    settings.hidden = !showSettings;
    inbox.hidden = showSettings;
    settingsButton.setAttribute("aria-expanded", String(showSettings));
    const status = error ?? (busy ? "mailWorking"
      : showSettings && configured && !Object.values(configured).some(Boolean) ? "mailNotConfigured"
        : !showSettings && accounts.some(account => account.issue) ? "mailPartial" : undefined);
    state.hidden = !status;
    state.textContent = status ? t(status) : "";
    if (showSettings) {
      list.replaceChildren();
      accountSelect.replaceChildren();
      renderSettings();
    } else renderInbox();
  }

  function toggleSettings() {
    if (!accounts.length) {
      verifyProviders(true);
      return;
    }
    managing = !managing;
    if (managing) verifyProviders();
    render();
  }

  accountSelect.addEventListener("change", () => { accountId = accountSelect.value; renderInbox(); });
  settingsButton.addEventListener("click", toggleSettings);
  render();
  if (!accounts.length) verifyProviders(); else act("refresh");

  return {
    update(next) {
      const loaded = !accounts.length && next.length;
      accounts = next;
      if (loaded && !busy) act("refresh");
      else render();
    },
    dispose() {
      disposed = true;
      settingsButton.removeEventListener("click", toggleSettings);
    }
  };
}
