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

export function renderMail(container, { dateLocale, t, icon, settingsButton, composeButton, accounts, send, followUp, requestInWorker }) {
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
  let smtpSecurity = "starttls";
  let opened;
  let composing = false;
  let alertAccountId;
  const draftKey = "easeMailComposeDraft";

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
  const reader = element("section", "mail-reader");
  const compose = element("form", "mail-imap-form mail-compose");
  const composeAccount = element("select", "translator-select");
  composeAccount.setAttribute("aria-label", t("mailComposeFrom"));
  const composeTo = field("mailComposeTo", { maxLength: 2600, required: true, inputMode: "email" });
  const composeSubject = field("mailComposeSubject", { maxLength: 180, dir: "auto" });
  const composeText = element("textarea", "translator-textarea");
  composeText.maxLength = 5000;
  composeText.required = true;
  composeText.rows = 5;
  composeText.dir = "auto";
  const composeBody = element("label", "translator-field");
  composeBody.append(element("span", "", t("mailComposeBody")), composeText);
  const sendButton = element("button", "primary-button", t("mailSend"));
  sendButton.type = "submit";
  const composeActions = element("div", "mail-provider-buttons");
  const enableSend = control("mailSendPermissionAction", null, upgradeSender);
  const composeCancel = control("cancel", null, () => closeComposer());
  composeActions.append(sendButton, enableSend, composeCancel);
  compose.append(element("h3", "", t("mailCompose")), composeAccount, composeTo.label, composeSubject.label, composeBody, composeActions);
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
  const outgoing = element("details", "mail-smtp-fields");
  const smtpHost = field("mailSmtpHost", { name: "smtpHost", maxLength: 253, placeholder: "smtp.example.com" });
  const smtpUsername = field("mailImapUser", { name: "smtpUsername", maxLength: 254 });
  const smtpPassword = field("mailSmtpPassword", { name: "smtpPassword", type: "password", autocomplete: "new-password", maxLength: 1024 });
  const smtpTransport = element("div", "mail-imap-transport");
  const smtpStarttls = smtpButton("starttls", "STARTTLS · 587");
  const smtpTls = smtpButton("tls", "TLS · 465");
  smtpTransport.append(smtpStarttls, smtpTls);
  outgoing.append(element("summary", "", t("mailSmtpSettings")), smtpHost.label, smtpTransport, smtpUsername.label, smtpPassword.label);
  const alerts = element("form", "mail-imap-form");
  const alertAddress = element("bdi", "mail-hint");
  const alertMode = element("select", "translator-select");
  alertMode.setAttribute("aria-label", t("mailAlerts"));
  alertMode.append(new Option(t("mailAlertOff"), "off"), new Option(t("mailAlertAll"), "all"), new Option(t("mailAlertDomains"), "domains"));
  const alertDomains = field("mailAlertDomainList", { placeholder: "example.com, company.com", maxLength: 2048 });
  const alertActions = element("div", "mail-provider-buttons");
  const saveAlert = element("button", "primary-button", t("save"));
  saveAlert.type = "submit";
  alertActions.append(saveAlert, control("cancel", null, () => { alertAccountId = undefined; error = undefined; render(); }));
  alerts.append(element("h3", "", t("mailAlerts")), alertAddress, alertMode, alertDomains.label, alertActions);
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
  imap.append(imapTitle, imapHint, emailField.label, hostField.label, transport, usernameField.label, passwordField.label, outgoing, imapActions);
  controls.append(accountSelect, unread, reload);
  inbox.append(controls, accountSummary, list);
  settings.append(settingsTitle, settingsHint, connect, imap, alerts, linked);
  module.append(state, inbox, reader, compose, settings);
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

  function smtpButton(value, label) {
    const button = element("button", "secondary-button", label);
    button.type = "button";
    button.dir = "ltr";
    button.addEventListener("click", () => { smtpSecurity = value; renderImap(); });
    return button;
  }

  function closeImap() {
    imapPreset = undefined;
    replacing = undefined;
    imap.reset();
    outgoing.open = false;
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
    smtpHost.input.value = account?.imap.smtp?.host ?? "";
    smtpUsername.input.value = account?.imap.smtp?.username ?? "";
    smtpSecurity = account?.imap.smtp?.security ?? "starttls";
    outgoing.open = Boolean(smtpHost.input.value);
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
    outgoing.hidden = !custom;
    tlsButton.setAttribute("aria-pressed", String(security === "tls"));
    starttlsButton.setAttribute("aria-pressed", String(security === "starttls"));
    smtpTls.setAttribute("aria-pressed", String(smtpSecurity === "tls"));
    smtpStarttls.setAttribute("aria-pressed", String(smtpSecurity === "starttls"));
    for (const item of imap.elements) item.disabled = busy;
  }

  imap.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !imapPreset) return;
    const email = emailField.input.value.trim();
    const username = usernameField.input.value.trim() || (imapPreset === "icloud" ? email.split("@")[0] : email);
    act("connect-imap", { replaceId: replacing, data: {
      preset: imapPreset, email, username, password: passwordField.input.value, host: hostField.input.value, security,
      smtpHost: smtpHost.input.value.trim(), smtpUsername: smtpUsername.input.value.trim(), smtpPassword: smtpPassword.input.value, smtpSecurity
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
    if (busy || disposed) return false;
    busy = true;
    error = undefined;
    render();
    try {
      const answer = await send(action, data);
      if (disposed) return false;
      if (answer?.ok) {
        accounts = answer.value;
        if (action === "connect-imap") closeImap();
        if (action === "notifications") alertAccountId = undefined;
        return true;
      } else error = answer?.error ?? "mailUnavailable";
    } catch {
      error = "mailUnavailable";
    } finally {
      busy = false;
      if (!disposed) render();
    }
    return false;
  }

  async function openMessage(message) {
    const choice = { message, loading: true };
    opened = choice;
    error = undefined;
    render();
    try {
      const answer = await send("message", { id: message.accountId, data: message.id });
      if (answer?.ok) choice.result = answer.value;
      else choice.error = answer?.error ?? "mailReadFailed";
    } catch { choice.error = "mailReadFailed"; }
    choice.loading = false;
    if (!disposed && opened === choice) renderReader();
  }

  function renderReader() {
    if (!opened) return;
    const { message, loading, result, error: readError } = opened;
    const account = accounts.find(item => item.id === message.accountId);
    const actions = element("div", "mail-provider-buttons");
    actions.append(control("calendarBack", null, () => { opened = undefined; render(); }));
    if (message.url) actions.append(control("mailOpenMessage", "link", () => {
      chrome.tabs.create({ url: message.url }).catch(() => {});
    }));
    actions.append(control("mailFollowUp", "calendar", () => followUp(message), true));
    const subject = element("h3", "", message.subject || t("mailNoSubject"));
    subject.dir = "auto";
    const sender = element("p", "mail-hint", message.sender || t("mailUnknownSender"));
    sender.dir = "auto";
    const status = element("p", "mail-state", loading ? t("mailWorking") : readError ? t(readError) : "");
    status.setAttribute("role", "status");
    status.hidden = !loading && !readError;
    reader.replaceChildren(actions, subject, sender, status);
    if (readError && account?.provider !== "imap" && account
      && (readError === "mailReadPermission" || readError === "mailReconnect")) {
      const upgrade = control("mailReadPermissionAction", null, async () => {
        if (await act("upgrade", { id: account.id, provider: account.provider, send: account.capabilities.send })) openMessage(message);
      });
      upgrade.disabled = busy;
      reader.append(upgrade);
    }
    if (result) {
      const body = element("div", "mail-message-body", result.body || t("mailEmptyBody"));
      body.dir = "auto";
      reader.append(body);
      if (result.partial) reader.append(element("p", "mail-hint", t("mailPartialBody")));
    }
  }

  async function openComposer() {
    if (!accounts.length || busy) return;
    opened = undefined;
    managing = false;
    closeImap();
    composing = true;
    const draft = (await chrome.storage.session.get(draftKey).catch(() => ({})))[draftKey];
    if (disposed || !composing) return;
    render();
    if (draft) {
      if (accounts.some(account => account.id === draft.id)) composeAccount.value = draft.id;
      composeTo.input.value = draft.to ?? "";
      composeSubject.input.value = draft.subject ?? "";
      composeText.value = draft.body ?? "";
    }
    renderComposer();
    composeTo.input.focus();
  }

  function composeDraft() {
    return { id: composeAccount.value, to: composeTo.input.value, subject: composeSubject.input.value, body: composeText.value };
  }

  function closeComposer() {
    composing = false;
    compose.reset();
    chrome.storage.session.remove(draftKey).catch(() => {});
    render();
  }

  function renderComposer() {
    const chosen = composeAccount.value || accountId;
    composeAccount.replaceChildren(...accounts.map(account => new Option(account.email, account.id)));
    if (accounts.some(account => account.id === chosen)) composeAccount.value = chosen;
    const current = accounts.find(account => account.id === composeAccount.value);
    const canSend = current?.capabilities?.send;
    enableSend.hidden = !current || canSend;
    enableSend.lastElementChild.textContent = t(current?.provider === "imap" ? "mailSmtpSettings" : "mailSendPermissionAction");
    for (const item of compose.elements) item.disabled = busy;
    sendButton.disabled = busy || !canSend;
  }

  async function upgradeSender() {
    const account = accounts.find(item => item.id === composeAccount.value);
    if (!account || busy) return;
    await chrome.storage.session.set({ [draftKey]: composeDraft() }).catch(() => {});
    if (account.provider === "imap") {
      composing = false;
      managing = true;
      openImap(account.imap.preset, account);
      outgoing.open = true;
      return;
    }
    await act("upgrade", { id: account.id, provider: account.provider, send: true });
  }

  composeAccount.addEventListener("change", renderComposer);
  compose.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || sendButton.disabled) return;
    const { id, ...data } = composeDraft();
    busy = true;
    error = undefined;
    render();
    try {
      const answer = await send("send", { id, data });
      if (disposed) return;
      if (answer?.ok) { closeComposer(); error = "mailSent"; }
      else error = answer?.error ?? "mailSendFailed";
    } catch { error = "mailSendUnknown"; }
    finally { busy = false; if (!disposed) render(); }
  });

  function openAlerts(account) {
    alertAccountId = account.id;
    alertAddress.textContent = account.email;
    alertMode.value = account.notifications?.mode ?? "off";
    alertDomains.input.value = (account.notifications?.domains ?? []).join(", ");
    error = undefined;
    render();
    alertMode.focus();
  }

  alertMode.addEventListener("change", render);
  alerts.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mode = alertMode.value;
    if (mode !== "off" && !requestInWorker) {
      const allowed = await chrome.permissions.request({ permissions: ["notifications"] }).catch(() => false);
      if (!allowed) { error = "mailAlertPermission"; render(); return; }
    }
    act("notifications", { id: alertAccountId, mode, domains: alertDomains.input.value, requestPermission: requestInWorker });
  });

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
    const editing = Boolean(imapPreset || alertAccountId);
    settingsHint.hidden = editing;
    connect.hidden = editing;
    linked.hidden = editing;
    alerts.hidden = !alertAccountId;
    alertDomains.label.hidden = alertMode.value !== "domains";
    for (const item of alerts.elements) item.disabled = busy;
    if (editing) {
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
      const alert = control("mailAlerts", "bell", () => openAlerts(account), true);
      alert.setAttribute("aria-pressed", String(account.notifications?.mode !== "off"));
      alert.disabled = busy;
      disconnect.disabled = busy;
      row.append(copy, alert, disconnect);
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
      const open = element("button", "mail-row-open");
      open.type = "button";
      open.addEventListener("click", () => openMessage(message));
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
    const showSettings = !opened && !composing && (managing || !accounts.length);
    settings.hidden = !showSettings;
    inbox.hidden = showSettings || Boolean(opened) || composing;
    reader.hidden = !opened;
    compose.hidden = !composing;
    composeButton.disabled = busy || !accounts.length;
    composeButton.setAttribute("aria-pressed", String(composing));
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
    } else if (opened) renderReader();
    else if (composing) renderComposer();
    else renderInbox();
  }

  function toggleSettings() {
    if (busy) return;
    if (opened) opened = undefined;
    if (composing) closeComposer();
    if (alertAccountId) { alertAccountId = undefined; error = undefined; render(); return; }
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
    showMessage: openMessage,
    openComposer,
    dispose() {
      disposed = true;
      settingsButton.removeEventListener("click", toggleSettings);
    }
  };
}
