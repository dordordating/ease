import { imapPresets, mailMessageLink, mailPermission, mailProviders } from "./mail-api.js";

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
  let imapPreset;
  let replacing;
  let security = "tls";

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
  const imap = element("form", "mail-imap-form");
  const imapTitle = element("h3");
  const imapHint = element("p", "mail-hint", t("mailImapPrivacy"));
  const emailField = field("mailImapEmail", { name: "email", inputMode: "email", maxLength: 254, required: true });
  const hostField = field("mailImapHost", { name: "host", maxLength: 253, placeholder: "imap.example.com" });
  const usernameField = field("mailImapUser", { name: "username", maxLength: 254 });
  const passwordField = field("mailImapPassword", { name: "password", type: "password", autocomplete: "new-password", maxLength: 1024, required: true });
  const transport = element("div", "mail-imap-transport");
  transport.setAttribute("role", "group");
  transport.setAttribute("aria-label", t("mailImapSecurity"));
  const tlsButton = transportButton("tls", "TLS · 993");
  const starttlsButton = transportButton("starttls", "STARTTLS · 143");
  transport.append(tlsButton, starttlsButton);
  const imapActions = element("div", "mail-provider-buttons");
  const submit = element("button", "primary-button", t("mailImapConnect"));
  submit.type = "submit";
  const cancel = control("cancel", null, () => { closeImap(); render(); });
  imapActions.append(submit, cancel);
  imap.append(imapTitle, imapHint, emailField.label, hostField.label, transport, usernameField.label, passwordField.label, imapActions);
  controls.append(accountSelect, unread, reload);
  inbox.append(controls, accountSummary, list);
  settings.append(settingsTitle, settingsHint, connect, imap, linked);
  module.append(state, inbox, settings);
  container.append(module);

  function field(key, properties) {
    const label = element("label", "translator-field");
    const input = Object.assign(element("input", "translator-select"), { dir: "ltr", spellcheck: false }, properties);
    label.append(element("span", "", t(key)), input);
    return { label, input };
  }

  function transportButton(value, label) {
    const button = element("button", "secondary-button", label);
    button.type = "button";
    button.dir = "ltr";
    button.addEventListener("click", () => { security = value; renderImap(); });
    return button;
  }

  function closeImap() {
    imapPreset = undefined;
    replacing = undefined;
    imap.reset();
    error = undefined;
  }

  function openImap(preset, account) {
    closeImap();
    imapPreset = preset;
    replacing = account?.id;
    imapTitle.textContent = preset === "custom" ? t("mailImapCustom") : imapPresets[preset].label;
    emailField.input.value = account?.email ?? "";
    usernameField.input.value = account?.imap.username ?? "";
    hostField.input.value = account?.imap.host ?? "";
    security = account?.imap.security ?? "tls";
    render();
    (account ? passwordField.input : emailField.input).focus({ preventScroll: true });
    imap.scrollIntoView({ block: "nearest" });
  }

  function renderImap() {
    imap.hidden = !imapPreset;
    const custom = imapPreset === "custom";
    hostField.label.hidden = !custom;
    hostField.input.required = custom;
    transport.hidden = !custom;
    tlsButton.setAttribute("aria-pressed", String(security === "tls"));
    starttlsButton.setAttribute("aria-pressed", String(security === "starttls"));
    for (const item of imap.elements) item.disabled = busy;
  }

  imap.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !imapPreset) return;
    const email = emailField.input.value.trim();
    const username = usernameField.input.value.trim() || (imapPreset === "icloud" ? email.split("@")[0] : email);
    act("connect-imap", { replaceId: replacing, data: {
      preset: imapPreset, email, username, password: passwordField.input.value, host: hostField.input.value, security
    } });
  });

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
      if (answer?.ok) {
        accounts = answer.value;
        if (action === "connect-imap") closeImap();
      } else error = answer?.error ?? "mailUnavailable";
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
      else configured = { gmail: false, outlook: false };
    } catch {
      configured = { gmail: false, outlook: false };
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
    const editingImap = Boolean(imapPreset);
    settingsHint.hidden = editingImap;
    connect.hidden = editingImap;
    linked.hidden = editingImap;
    if (editingImap) {
      renderImap();
      return;
    }
    const oauth = Object.entries(mailProviders).map(([provider, { label }]) => {
      const button = control("mailConnect", "plus", () => linkAccount(provider), false, { provider: label });
      button.disabled = busy || verifying || configured?.[provider] === false;
      return button;
    });
    const imapButtons = Object.entries(imapPresets).map(([preset, { label }]) => {
      const button = control(preset === "custom" ? "mailImapCustom" : "mailConnect", "plus", () => openImap(preset), false, { provider: label });
      button.disabled = busy;
      return button;
    });
    connect.replaceChildren(...oauth, ...imapButtons);
    linked.replaceChildren(...accounts.map(account => {
      const row = element("li", "mail-account-row");
      const copy = element("div", "mail-account-copy");
      const address = element("strong", "", account.email);
      address.dir = "ltr";
      address.title = account.email;
      const label = account.imap ? imapPresets[account.imap.preset]?.label : mailProviders[account.provider]?.label;
      copy.append(address, element("small", "", t(account.issue ?? "mailConnected", { provider: label })));
      const disconnect = control("mailDisconnect", "close", () => act("disconnect", { id: account.id }), true);
      disconnect.disabled = busy;
      row.append(copy, disconnect);
      if (account.imap) {
        const edit = control("mailImapEdit", "edit", () => openImap(account.imap.preset, account), true);
        edit.disabled = busy;
        row.insertBefore(edit, disconnect);
      }
      return row;
    }));
    renderImap();
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
      row.dataset.messageId = message.id;
      row.dataset.accountId = message.accountId;
      const open = element(message.url ? "a" : "div", "mail-row-open");
      if (message.url) {
        open.href = message.url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
      } else open.tabIndex = -1;
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
      row.append(control("mailFollowUp", "calendar", () => followUp(message), true));
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
      : showSettings && !imapPreset && configured && !Object.values(configured).some(Boolean) ? "mailNotConfigured"
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
    if (busy) return;
    if (imapPreset) { closeImap(); render(); return; }
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
    showMessage(message) {
      accountId = message.accountId;
      unreadOnly = false;
      managing = false;
      closeImap();
      render();
      const row = Array.from(list.children).find(item => item.dataset.accountId === message.accountId && item.dataset.messageId === message.id);
      row?.querySelector(".mail-row-open")?.focus();
    },
    dispose() {
      disposed = true;
      settingsButton.removeEventListener("click", toggleSettings);
    }
  };
}
