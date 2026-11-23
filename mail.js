import { blockedMailSender, encodeMailBytes, htmlText, imapPresets, mailAddress, mailDownloadLimit, mailFileName, mailMessageLink,
  mailPermission, mailProviders, mailUploadLimit, senderAddress } from "./mail-api.js";
import { htmlMailFrame } from "./mail-html.js";

export function inboxMessages(accounts, folder = "inbox") {
  return accounts.flatMap(({ id, provider, email, messages, sentMessages }) => (folder === "sent" ? sentMessages ?? [] : messages).map(message => ({
    ...message, url: mailMessageLink(provider, message.url), accountId: id, provider, email, folder
  }))).sort((left, right) => right.received - left.received);
}

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

export function renderMail(container, { dateLocale, t, icon, settingsButton, composeButton, accounts, send, followUp,
  requestInWorker, openMenu, confirmDelete }) {
  const dates = new Intl.DateTimeFormat(dateLocale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const numbers = new Intl.NumberFormat(dateLocale);
  let accountId = "";
  let folder = "inbox";
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
  let blockedAccountId;
  const draftKey = "easeMailComposeDraft";
  let files = [];
  let fileWork = false;
  let reply;
  let forwarded;

  const module = element("section", "mail-module");
  const inbox = element("section", "mail-inbox");
  const settings = element("section", "mail-settings");
  const controls = element("div", "mail-toolbar");
  const folderTabs = element("div", "mail-folder-tabs");
  folderTabs.setAttribute("role", "group");
  folderTabs.setAttribute("aria-label", t("mailFolders"));
  const inboxTab = control("mailInbox", "mail", () => switchFolder("inbox"));
  const sentTab = control("mailSentFolder", "send", () => switchFolder("sent"));
  folderTabs.append(inboxTab, sentTab);
  const accountSelect = element("select", "translator-select mail-account-select");
  accountSelect.setAttribute("aria-label", t("mailAccounts"));
  const unread = control("mailUnread", null, () => { unreadOnly = !unreadOnly; renderInbox(); });
  const reload = control("mailRefresh", "refresh", () => refreshFolder(true), true);
  const accountSummary = element("p", "mail-summary");
  const list = element("ul", "mail-list");
  const more = control("mailLoadMore", "chevron-down", () => act("older", { id: accountId, folder }));
  more.classList.add("mail-load-more");
  const reader = element("section", "mail-reader");
  const compose = element("form", "mail-imap-form mail-compose");
  const composeAccount = element("select", "translator-select");
  composeAccount.setAttribute("aria-label", t("mailComposeFrom"));
  const composeTo = field("mailComposeTo", { maxLength: 2600, required: true, inputMode: "email" });
  const composeCc = field("mailCc", { maxLength: 2600, inputMode: "email" });
  const ccButton = control("mailCc", null, () => {
    composeCc.label.hidden = !composeCc.label.hidden;
    ccButton.setAttribute("aria-expanded", String(!composeCc.label.hidden));
    if (!composeCc.label.hidden) composeCc.input.focus();
  });
  ccButton.setAttribute("aria-expanded", "false");
  composeCc.label.hidden = true;
  const recipients = element("div", "mail-compose-recipients");
  recipients.append(composeTo.label, ccButton);
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
  const fileInput = element("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const fileList = element("ul", "mail-attachments");
  const attach = control("mailAttach", "attach", () => fileInput.click());
  const originals = control("mailIncludeOriginals", "attach", includeOriginals);
  const fileActions = element("div", "mail-provider-buttons");
  fileActions.append(attach, originals);
  const enableSend = control("mailSendPermissionAction", null, upgradeSender);
  const composeCancel = control("cancel", null, () => closeComposer());
  composeActions.append(sendButton, enableSend, composeCancel);
  compose.append(element("h3", "", t("mailCompose")), composeAccount, recipients, composeCc.label, composeSubject.label, composeBody,
    fileInput, fileActions, fileList, composeActions);
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
  const blocked = element("section", "mail-imap-form");
  const blockedAccountAddress = element("bdi", "mail-hint");
  const blockedRules = element("ul", "mail-attachments");
  const backFromBlocked = control("calendarBack", null, closeBlocked);
  const blockedActions = element("div", "mail-provider-buttons");
  blockedActions.append(backFromBlocked);
  blocked.append(element("h3", "", t("mailBlockedSenders")), blockedAccountAddress,
    element("p", "mail-hint", t("mailBlockedHint")), blockedRules, blockedActions);
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
  inbox.append(folderTabs, controls, accountSummary, list, more);
  settings.append(settingsTitle, settingsHint, connect, imap, alerts, blocked, linked);
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
        if (action === "block-sender") {
          closeBlockedMessage();
          error = data.mode === "domain" ? "mailDomainBlocked" : "mailSenderBlocked";
        }
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

  function closeBlockedMessage() {
    const message = opened?.message;
    if (message?.folder !== "inbox") return;
    const account = accounts.find(item => item.id === message.accountId);
    if (blockedMailSender(message, account?.blockedSenders)) opened = undefined;
  }

  async function openMessage(message) {
    folder = message.folder ?? "inbox";
    const choice = { message, loading: true };
    opened = choice;
    error = undefined;
    render();
    try {
      const answer = await send("message", { id: message.accountId, data: message.id, folder });
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
    const replyButton = control("mailReply", "reply", () => respondTo(message, result, false), true);
    const forwardButton = control("mailForward", "forward", () => respondTo(message, result, true), true);
    replyButton.disabled = !result || busy;
    forwardButton.disabled = !result || busy;
    actions.append(replyButton, forwardButton, messageMenu(message));
    const subject = element("h3", "", message.subject || t("mailNoSubject"));
    subject.dir = "auto";
    const sender = element("p", "mail-hint", message.folder === "sent"
      ? t("mailSentRecipient", { recipient: message.sender || "—" }) : message.sender || t("mailUnknownSender"));
    sender.dir = "auto";
    const status = element("p", "mail-state", loading ? t("mailWorking") : readError ? t(readError) : "");
    status.setAttribute("role", "status");
    status.hidden = !loading && !readError;
    reader.replaceChildren(actions, subject, sender, status);
    if (readError && account?.provider !== "imap" && account
      && (readError === "mailReadPermission" || readError === "mailReconnect")) {
      const upgrade = control("mailReadPermissionAction", null, async () => {
        if (await act("upgrade", { id: account.id, provider: account.provider, send: account.capabilities.send,
          mark: account.capabilities.mark })) openMessage(message);
      });
      upgrade.disabled = busy;
      reader.append(upgrade);
    }
    if (result) {
      const body = result.format === "html" && result.body ? htmlMailFrame(result.body, t("mailMessagePreview"))
        : element("div", "mail-message-body", result.body || t("mailEmptyBody"));
      if (body.tagName !== "IFRAME") body.dir = "auto";
      reader.append(body);
      if (result.partial) reader.append(element("p", "mail-hint", t("mailPartialBody")));
      if (result.attachments?.length) {
        const attachments = element("ul", "mail-attachments");
        attachments.setAttribute("aria-label", t("mailAttachments"));
        for (const item of result.attachments) {
          const row = fileRow(item.name);
          const download = control("mailDownload", "download", () => saveAttachment(message, item, download), true);
          download.disabled = item.size > mailDownloadLimit;
          if (download.disabled) download.title = t("mailDownloadLimit");
          row.append(download);
          attachments.append(row);
        }
        reader.append(attachments);
      }
      if (message.folder !== "sent" && message.unread && !result.marked) {
        if (account && account.provider !== "imap" && !account.capabilities.mark) {
          const upgrade = control("mailMarkPermission", null, async () => {
            if (await act("upgrade", { id: account.id, provider: account.provider, send: account.capabilities.send, mark: true })) {
              openMessage(message);
            }
          });
          upgrade.disabled = busy;
          reader.append(upgrade);
        } else reader.append(element("p", "mail-hint", t("mailMarkFailed")));
      }
    }
  }

  function messageMenu(message) {
    const button = control("mailActions", "more", () => openMenu(button, action => {
      if (message.url) action("mailOpenMessage", "link", () => chrome.tabs.create({ url: message.url }).catch(() => {}));
      else {
        const account = accounts.find(item => item.id === message.accountId);
        const url = imapPresets[account?.imap?.preset]?.web;
        if (url) action("mailOpenWebmail", "link", () => chrome.tabs.create({ url }).catch(() => {}));
      }
      action("mailFollowUp", "calendar", () => followUp(message));
      if (message.folder === "inbox" && senderAddress(message)) {
        const block = mode => act("block-sender", { id: message.accountId, data: message.id, mode });
        action("mailBlockSender", "ban", () => block("address"));
        action("mailBlockDomain", "ban", () => block("domain"));
      }
      action("mailDelete", "trash", () => deleteMessage(message));
    }), true);
    button.setAttribute("aria-haspopup", "menu");
    button.disabled = busy;
    return button;
  }

  async function deleteMessage(message) {
    if (busy) return;
    const account = accounts.find(item => item.id === message.accountId);
    if (!account) return;
    if (!account.capabilities.mark && account.provider !== "imap") {
      if (!await act("upgrade", { id: account.id, provider: account.provider, send: account.capabilities.send, mark: true })) return;
    }
    confirmDelete(message.subject || t("mailNoSubject"), async () => {
      const success = await act("trash", { id: message.accountId, data: message.id, folder: message.folder });
      if (success) {
        if (opened?.message === message) opened = undefined;
        error = "mailDeleted";
        render();
      }
      return success;
    });
  }

  function fileRow(name) {
    const row = element("li", "mail-file");
    const title = element("bdi", "", name);
    title.title = name;
    row.append(title);
    return row;
  }

  async function fetchAttachment(message, item) {
    const answer = await send("attachment", { id: message.accountId, folder: message.folder, data: { id: message.id, attachment: item.id } });
    if (!answer?.ok) throw Object.assign(new Error("Attachment request failed"), { code: answer?.error ?? "mailAttachmentFailed" });
    return answer.value;
  }

  async function saveAttachment(message, item, button) {
    button.disabled = true;
    try {
      const file = await fetchAttachment(message, item);
      const bytes = Uint8Array.from(atob(file.data), character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const anchor = element("a");
      anchor.href = url;
      anchor.download = mailFileName(file.name);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15_000);
    } catch (issue) {
      if (!disposed) { error = issue.code ?? "mailAttachmentFailed"; render(); }
    } finally { button.disabled = false; }
  }

  function respondTo(message, result, forward) {
    if (!result) return;
    const title = message.subject || t("mailNoSubject");
    const body = result.format === "html" ? htmlText(result.body) : result.body;
    const quoted = body.trim().slice(0, 3200).split(/\r?\n/u).map(line => `> ${line}`).join("\n").slice(0, 3700);
    const prefix = forward ? "Fwd" : "Re";
    const subject = (new RegExp(`^${prefix}:`, "iu").test(title) ? title : `${prefix}: ${title}`).slice(0, 180);
    openComposer({ id: message.accountId, to: forward ? "" : result.replyAddress || mailAddress(message.sender), subject,
      body: `\n\n${quoted}`, reply: forward ? undefined : { messageId: result.messageId, references: result.references,
        threadId: result.threadId, accountId: message.accountId },
      forwarded: forward ? { message, attachments: result.attachments ?? [] } : undefined });
  }

  async function openComposer(seed) {
    if (!accounts.length || busy) return;
    opened = undefined;
    managing = false;
    closeImap();
    composing = true;
    const draft = seed ?? (await chrome.storage.session.get(draftKey).catch(() => ({})))[draftKey];
    if (disposed || !composing) return;
    render();
    compose.reset();
    files = draft?.attachments ?? [];
    reply = draft?.reply;
    forwarded = draft?.forwarded;
    composeCc.label.hidden = !draft?.cc;
    ccButton.setAttribute("aria-expanded", String(!composeCc.label.hidden));
    if (draft) {
      if (accounts.some(account => account.id === draft.id)) composeAccount.value = draft.id;
      composeTo.input.value = draft.to ?? "";
      composeCc.input.value = draft.cc ?? "";
      composeSubject.input.value = draft.subject ?? "";
      composeText.value = draft.body ?? "";
    }
    renderComposer();
    (seed?.to ? composeText : composeTo.input).focus();
    if (seed?.to) composeText.setSelectionRange(0, 0);
  }

  function composeDraft() {
    return { id: composeAccount.value, to: composeTo.input.value, cc: composeCc.input.value, subject: composeSubject.input.value,
      body: composeText.value, attachments: files,
      ...(reply ? { reply: { ...reply, threadId: composeAccount.value === reply.accountId ? reply.threadId : undefined } } : {}) };
  }

  function closeComposer() {
    composing = false;
    compose.reset();
    files = [];
    reply = undefined;
    forwarded = undefined;
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
    sendButton.disabled ||= fileWork;
    attach.disabled = busy || fileWork;
    originals.hidden = !forwarded?.attachments?.length;
    originals.disabled = busy || fileWork;
    fileList.replaceChildren(...files.map((file, index) => {
      const row = fileRow(file.name);
      const remove = control("remove", "close", () => { files = files.filter((_, selected) => selected !== index); renderComposer(); }, true);
      remove.disabled = busy || fileWork;
      row.append(remove);
      return row;
    }));
  }

  function addFiles(items) {
    const size = file => file.data.length / 4 * 3 - (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0);
    const next = [...files, ...items];
    if (next.length > 5 || next.reduce((sum, file) => sum + size(file), 0) > mailUploadLimit) {
      error = "mailUploadLimit";
      return false;
    }
    files = next;
    error = undefined;
    return true;
  }

  fileInput.addEventListener("change", async () => {
    const selected = Array.from(fileInput.files);
    fileInput.value = "";
    if (!selected.length || fileWork) return;
    if (selected.length + files.length > 5 || selected.reduce((sum, file) => sum + file.size, 0) > mailUploadLimit) {
      error = "mailUploadLimit"; render(); return;
    }
    fileWork = true;
    renderComposer();
    try {
      const items = await Promise.all(selected.map(async file => ({ name: mailFileName(file.name), data: encodeMailBytes(new Uint8Array(await file.arrayBuffer())) })));
      if (!disposed && composing) addFiles(items);
    } catch { error = "mailAttachmentFailed"; }
    finally { fileWork = false; if (!disposed) render(); }
  });

  async function includeOriginals() {
    const source = forwarded;
    if (fileWork || !source?.attachments.length) return;
    if (source.attachments.length + files.length > 5 || source.attachments.reduce((sum, item) => sum + (item.size ?? 0), 0) > mailUploadLimit) {
      error = "mailUploadLimit"; render(); return;
    }
    fileWork = true;
    renderComposer();
    try {
      const copies = [];
      for (const item of source.attachments) copies.push(await fetchAttachment(source.message, item));
      if (!disposed && composing && addFiles(copies)) forwarded = undefined;
    } catch (issue) { error = issue.code ?? "mailAttachmentFailed"; }
    finally { fileWork = false; if (!disposed) render(); }
  }

  async function upgradeSender() {
    const account = accounts.find(item => item.id === composeAccount.value);
    if (!account || busy) return;
    await chrome.storage.session.set({ [draftKey]: { ...composeDraft(), ...(forwarded ? { forwarded } : {}) } }).catch(() => {});
    if (account.provider === "imap") {
      composing = false;
      managing = true;
      openImap(account.imap.preset, account);
      outgoing.open = true;
      return;
    }
    await act("upgrade", { id: account.id, provider: account.provider, send: true, mark: account.capabilities.mark });
  }

  composeAccount.addEventListener("change", renderComposer);
  compose.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || sendButton.disabled) return;
    const { id, ...data } = composeDraft();
    let sentStatus;
    busy = true;
    error = undefined;
    render();
    try {
      const answer = await send("send", { id, data });
      if (disposed) return;
      if (answer?.ok) {
        closeComposer();
        sentStatus = answer.value?.savedCopy === false ? "mailSentNoCopy" : "mailSent";
        error = sentStatus;
      }
      else error = answer?.error ?? "mailSendFailed";
    } catch { error = "mailSendUnknown"; }
    finally { busy = false; if (!disposed) render(); }
    if (!disposed && sentStatus && folder === "sent") {
      await refreshFolder();
      if (!disposed) { error = sentStatus; render(); }
    }
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

  function closeBlocked() {
    blockedAccountId = undefined;
    error = undefined;
    render();
  }

  function renderBlocked(account) {
    blockedAccountAddress.textContent = account.email;
    blockedAccountAddress.dir = "ltr";
    blockedRules.replaceChildren(...(account.blockedSenders ?? []).map(({ mode, value }) => {
      const row = fileRow(value);
      const unblock = control("mailUnblockSender", null, () => act("unblock-sender", { id: account.id, mode, data: value }));
      unblock.disabled = busy;
      row.append(unblock);
      return row;
    }));
    if (!blockedRules.childElementCount) blockedRules.append(element("li", "mail-hint", t("mailNoBlockedSenders")));
    backFromBlocked.disabled = busy;
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
    const blockedAccount = accounts.find(account => account.id === blockedAccountId);
    if (!blockedAccount) blockedAccountId = undefined;
    const editing = Boolean(imapPreset || alertAccountId || blockedAccount);
    settingsHint.hidden = editing;
    connect.hidden = editing;
    linked.hidden = editing;
    alerts.hidden = !alertAccountId;
    blocked.hidden = !blockedAccount;
    if (blockedAccount) renderBlocked(blockedAccount);
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
      const manageBlocked = control("mailBlockedSenders", "ban", () => {
        blockedAccountId = account.id;
        error = undefined;
        render();
        backFromBlocked.focus();
      }, true);
      alert.setAttribute("aria-pressed", String(account.notifications?.mode !== "off"));
      alert.disabled = busy;
      manageBlocked.disabled = busy;
      disconnect.disabled = busy;
      row.append(copy, alert, manageBlocked, disconnect);
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
    const sent = folder === "sent";
    inboxTab.setAttribute("aria-pressed", String(!sent));
    sentTab.setAttribute("aria-pressed", String(sent));
    inboxTab.disabled = busy;
    sentTab.disabled = busy;
    accountSelect.disabled = busy;
    unread.hidden = sent;
    controls.dataset.folder = folder;
    unread.setAttribute("aria-pressed", String(unreadOnly));
    reload.disabled = busy;
    const selected = accounts.filter(account => !accountId || account.id === accountId);
    const unreadCount = selected.reduce((total, account) => total + account.unread, 0);
    accountSummary.hidden = sent && !selected.some(item => item.sentIssue);
    accountSummary.textContent = sent ? t("mailSentUnavailable") : t("mailUnreadCount", { count: numbers.format(unreadCount) });
    const rows = inboxMessages(selected, folder).filter(row => sent || !unreadOnly || row.unread);
    more.hidden = !selected.some(account => account.hasMore?.[folder]);
    more.disabled = busy;
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
      const sender = element("span", "mail-sender", sent ? t("mailSentRecipient", { recipient: message.sender || "—" })
        : message.sender || t("mailUnknownSender"));
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
      row.append(messageMenu(message));
      return row;
    }));
    if (!rows.length) list.append(element("li", "mail-empty", t(sent ? "mailSentEmpty" : unreadOnly ? "mailNoUnread" : "mailEmpty")));
  }

  function refreshFolder(force = false) {
    return folder === "sent" ? act("sent", { id: accountId, force }) : act("refresh", { force });
  }

  function switchFolder(destination) {
    if (busy || folder === destination) return;
    folder = destination;
    refreshFolder();
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
        : !showSettings && folder === "inbox" && accounts.some(account => account.issue) ? "mailPartial" : undefined);
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
    if (blockedAccountId) { closeBlocked(); return; }
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

  accountSelect.addEventListener("change", () => { accountId = accountSelect.value; if (folder === "sent") refreshFolder(); else renderInbox(); });
  settingsButton.addEventListener("click", toggleSettings);
  render();
  if (!accounts.length) verifyProviders(); else act("refresh");

  return {
    update(next) {
      const loaded = !accounts.length && next.length;
      accounts = next;
      closeBlockedMessage();
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
