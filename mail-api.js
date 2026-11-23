const broker = "https://static.115.164.76.144.clients.your-server.de/v1/mail";
const gmail = "https://www.googleapis.com/gmail/v1/users/me";
const graph = "https://graph.microsoft.com/v1.0/me";
const outlookHosts = new Set(["outlook.live.com", "outlook.office.com", "outlook.office365.com", "outlook.cloud.microsoft"]);
const gmailId = /^[0-9a-f]{8,64}$/iu;
const inboxSize = 12;
export const mailUploadLimit = 2 * 1024 * 1024;
export const mailDownloadLimit = 5 * 1024 * 1024;
export const mailProviders = Object.freeze({
  gmail: { host: "https://www.googleapis.com/*", authorization: "https://accounts.google.com", label: "Gmail" },
  outlook: { host: "https://graph.microsoft.com/*", authorization: "https://login.microsoftonline.com", label: "Outlook" }
});
export const imapPresets = Object.freeze({
  icloud: { host: "imap.mail.me.com", smtp: "smtp.mail.me.com", web: "https://www.icloud.com/mail/", label: "iCloud Mail" },
  yahoo: { host: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", web: "https://mail.yahoo.com/", label: "Yahoo Mail" },
  custom: { label: "IMAP" }
});

export class MailError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function mailPermission(provider) {
  return { origins: [mailProviders[provider].host] };
}

async function jsonRequest(url, { body, token, headers, milliseconds = 10_000, empty = false, method = "POST",
  limit = 256 * 1024, raw = false } = {}) {
  try {
    const options = { credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(milliseconds) };
    if (body) {
      options.method = method;
      options.body = raw ? body : JSON.stringify(body);
      options.headers = { "Content-Type": raw ? "text/plain" : "application/json" };
    }
    options.headers = { ...options.headers, ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const response = await fetch(url, options);
    if (response.ok && empty) {
      await response.body?.cancel().catch(() => {});
      return { sent: true };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new MailError(response.status === 401 ? "mailReconnect" : "mailUnavailable", response.status);
    }
    const reader = response.body.getReader();
    let text = "";
    let total = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw new MailError("mailUnavailable");
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof MailError) throw error;
    throw new MailError("mailUnavailable");
  }
}

async function downloadGraphBytes(url, token) {
  const response = await fetch(url, { credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(17_000), headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok || !response.body) throw new MailError("mailAttachmentFailed", response.status);
  const pieces = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > mailDownloadLimit) throw new MailError("mailDownloadLimit");
      pieces.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.length;
  }
  return encodeMailBytes(bytes);
}

function text(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum) : "";
}

export function imapAccount(data) {
  const { preset, email, username, password, security } = data ?? {};
  if (!Object.hasOwn(imapPresets, preset) || typeof email !== "string" || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim())
    || typeof username !== "string" || !username.trim() || username.length > 254
    || typeof password !== "string" || !password || password.length > 1024
    || /[\u0000-\u001f\u007f]/u.test(username + password)) throw new MailError("mailImapInvalid");
  const host = mailHostname(imapPresets[preset].host ?? data.host);
  const smtpHost = imapPresets[preset].smtp ?? data.smtpHost;
  let smtp;
  if (smtpHost) {
    const sendUser = data.smtpUsername?.trim() || (preset === "icloud" || preset === "yahoo" ? email.trim() : username);
    const sendPassword = data.smtpPassword || password;
    if (sendUser.length > 254 || sendPassword.length > 1024 || /[\u0000-\u001f\u007f]/u.test(sendUser + sendPassword)) {
      throw new MailError("mailImapInvalid");
    }
    smtp = { host: mailHostname(smtpHost), security: preset === "custom" && data.smtpSecurity === "tls" ? "tls" : "starttls",
      username: sendUser, password: sendPassword };
  }
  return {
    provider: "imap", preset, email: email.trim(), ...(smtp ? { smtp } : {}),
    connection: { host, security: preset === "custom" && security === "starttls" ? "starttls" : "tls", username, password }
  };
}

function mailHostname(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 253 || /[\s:/\\?#@%\[\]]/u.test(input.trim())) {
    throw new MailError("mailImapInvalid");
  }
  let host;
  try {
    host = new URL(`https://${input.trim().replace(/\.$/u, "")}`).hostname;
  } catch {
    throw new MailError("mailImapInvalid");
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]*[a-z][a-z0-9-]*$/u.test(host)) {
    throw new MailError("mailImapInvalid");
  }
  return host;
}

export async function imapMessages(connection, folder = "inbox", cursor) {
  try {
    const { messages, unread, available, next } = await jsonRequest(`${broker}/imap/sync`, {
      body: { ...connection, ...(folder === "sent" ? { folder } : {}), ...cursor }, milliseconds: 17_000
    });
    if (!Array.isArray(messages) || messages.length > inboxSize || !Number.isSafeInteger(unread) || unread < 0) {
      throw new MailError("mailImapUnavailable");
    }
    return {
      unread, ...(available === false ? { available } : {}),
      next: /^[1-9][0-9]{0,9}$/u.test(next?.before_uid ?? "") ? { before_uid: next.before_uid,
        ...(/^[1-9][0-9]{0,9}$/u.test(next.uid_validity ?? "") ? { uid_validity: next.uid_validity } : {}) } : null,
      messages: messages.filter(row => row && typeof row.id === "string" && /^\d{1,10}$/u.test(row.id)
        && Number.isFinite(row.received) && row.received > 0 && row.received <= 8.64e15).map(row => ({
        id: row.id, received: row.received, subject: text(row.subject, 300), sender: text(row.sender, 254), unread: row.unread === true,
        ...(/^[1-9][0-9]{0,9}$/u.test(row.uidValidity ?? "") ? { uidValidity: row.uidValidity } : {})
      }))
    };
  } catch (error) {
    if (error.status === 409) throw new MailError("mailPageExpired");
    if (error?.status === 401) throw new MailError("mailReconnect");
    if (error?.status === 422) throw new MailError("mailImapInvalid");
    if (error?.status === 429) throw new MailError("mailImapBusy");
    throw new MailError("mailImapUnavailable");
  }
}

function expiry(result, savedRefreshToken) {
  const { access_token: accessToken, refresh_token: rotated, expires_in: expiresIn, scope } = result ?? {};
  const refreshToken = rotated ?? savedRefreshToken;
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > 8192
    || typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 8192
    || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 86_400) throw new MailError("mailUnavailable");
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000, ...(typeof scope === "string" ? { scope } : {}) };
}

function base64url(array) {
  return encodeMailBytes(array).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function mailConfig() {
  const answer = await jsonRequest(`${broker}/config?extension=${chrome.runtime.id}`);
  return { gmail: answer?.gmail === true, outlook: answer?.outlook === true };
}

export async function authorizeMailbox(provider, send = false, mark = false) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const endpoint = `${broker}/oauth/${provider}`;
  const start = await jsonRequest(`${endpoint}/start`, { body: { challenge, extension_id: chrome.runtime.id, send, mark } });
  const url = new URL(start.url);
  if (url.origin !== mailProviders[provider].authorization || url.username || url.password
    || typeof start.state !== "string" || url.searchParams.get("state") !== start.state) throw new MailError("mailUnavailable");
  const redirect = new URL(chrome.identity.getRedirectURL("mail-oauth"));
  let result;
  try {
    result = new URL(await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true }));
  } catch {
    throw new MailError("mailConsentCanceled");
  }
  if (result.origin !== redirect.origin || result.pathname !== redirect.pathname
    || result.searchParams.get("state") !== start.state) throw new MailError("mailUnavailable");
  if (result.searchParams.has("error")) throw new MailError("mailConsentCanceled");
  const code = result.searchParams.get("code");
  if (!code) throw new MailError("mailUnavailable");
  const credentials = expiry(await jsonRequest(`${endpoint}/exchange`, { body: { verifier, state: start.state, code } }));
  if (credentials.scope === undefined) credentials.scope = provider === "gmail"
    ? `https://www.googleapis.com/auth/gmail.${mark ? "modify" : "readonly"}${send ? " https://www.googleapis.com/auth/gmail.send" : ""}`
    : `Mail.Read${mark ? "Write" : ""}${send ? " Mail.Send" : ""}`;
  if (send) credentials.sendConsent = true;
  return credentials;
}

export async function refreshMailToken(provider, refreshToken) {
  return expiry(await jsonRequest(`${broker}/oauth/${provider}/refresh`, {
    body: { extension_id: chrome.runtime.id, refresh_token: refreshToken }
  }), refreshToken);
}

export async function mailboxProfile(provider, token) {
  if (provider === "gmail") {
    const profile = await jsonRequest(`${gmail}/profile?fields=emailAddress`, { token });
    const email = text(profile.emailAddress, 254);
    if (!email.includes("@")) throw new MailError("mailUnavailable");
    return { externalId: email.toLowerCase(), email };
  }
  const profile = await jsonRequest(`${graph}?$select=id,mail,userPrincipalName`, { token });
  const externalId = text(profile.id, 256);
  const email = text(profile.mail || profile.userPrincipalName, 254);
  if (!externalId || !email.includes("@")) throw new MailError("mailUnavailable");
  return { externalId, email };
}

export function mailMessageLink(provider, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.href.length > 1900) return null;
    if ((!provider || provider === "gmail") && url.hostname === "mail.google.com"
      || (!provider || provider === "outlook") && outlookHosts.has(url.hostname)) {
      return url.href;
    }
  } catch {}
  return null;
}

function cursorString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 6000 ? value : null;
}

async function gmailMessages(account, token, folder, cursor) {
  const labelId = folder === "sent" ? "SENT" : "INBOX";
  const [list, label] = await Promise.all([
    jsonRequest(`${gmail}/messages?labelIds=${labelId}&maxResults=${inboxSize}&fields=messages(id,threadId),nextPageToken${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`, { token }),
    folder === "sent" || cursor ? {} : jsonRequest(`${gmail}/labels/INBOX?fields=messagesUnread`, { token })
  ]);
  const ids = (list.messages ?? []).filter(row => typeof row.id === "string" && gmailId.test(row.id)).slice(0, inboxSize);
  const messages = [];
  for (let index = 0; index < ids.length; index += 4) {
    const rows = await Promise.all(ids.slice(index, index + 4).map(async ({ id, threadId }) => {
      try {
        const row = await jsonRequest(
          `${gmail}/messages/${id}?format=metadata&metadataHeaders=${folder === "sent" ? "To" : "From"}&metadataHeaders=Subject&fields=internalDate,labelIds,payload(headers)`, { token }
        );
        const headers = row.payload?.headers ?? [];
        return {
          id, subject: text(headers.find(item => item.name?.toLowerCase() === "subject")?.value, 300),
          sender: text(headers.find(item => item.name?.toLowerCase() === (folder === "sent" ? "to" : "from"))?.value, 254),
          received: Number(row.internalDate), unread: folder !== "sent" && row.labelIds?.includes("UNREAD") === true,
          url: `https://mail.google.com/mail/u/${encodeURIComponent(account.email)}/#${folder}/${gmailId.test(threadId ?? "") ? threadId : id}`
        };
      } catch (error) {
        if (error.status !== 404) throw error;
        return null; // A message can leave the mailbox between the list and its metadata request.
      }
    }));
    messages.push(...rows.filter(Boolean));
  }
  return { messages, unread: label.messagesUnread, next: cursorString(list.nextPageToken) };
}

async function outlookMessages(token, folder, cursor) {
  const mailbox = folder === "sent" ? "sentitems" : "inbox";
  const stamp = folder === "sent" ? "sentDateTime" : "receivedDateTime";
  const endpoint = `${graph}/mailFolders/${mailbox}/messages`;
  const params = new URLSearchParams({ $top: inboxSize, $select: `id,subject,${folder === "sent" ? "toRecipients" : "from"},${stamp},isRead,webLink`, $orderby: `${stamp} desc` });
  if (cursor?.key === "$skip" || cursor?.key === "$skiptoken") params.set(cursor.key, cursor.value);
  const [list, stats] = await Promise.all([
    jsonRequest(`${endpoint}?${params}`, { token }),
    folder === "sent" || cursor ? {} : jsonRequest(`${graph}/mailFolders/inbox?$select=unreadItemCount`, { token })
  ]);
  const messages = list.value.slice(0, inboxSize).map(row => ({
    id: text(row.id, 512),
    subject: text(row.subject, 300),
    sender: text(folder === "sent" ? (row.toRecipients ?? []).map(person => person.emailAddress?.name || person.emailAddress?.address).filter(Boolean).join(", ")
      : row.from?.emailAddress?.name || row.from?.emailAddress?.address, 254),
    senderAddress: text(row.from?.emailAddress?.address, 254),
    received: Date.parse(row[stamp]), unread: folder !== "sent" && row.isRead === false,
    url: mailMessageLink("outlook", row.webLink)
  }));
  let next = null;
  try {
    const link = new URL(list["@odata.nextLink"]);
    const expected = new URL(endpoint);
    if (link.origin === expected.origin && link.pathname.startsWith("/v1.0/") && link.pathname.endsWith("/messages")) {
      const key = link.searchParams.has("$skiptoken") ? "$skiptoken" : "$skip";
      const value = cursorString(link.searchParams.get(key));
      if (value) next = { key, value };
    }
  } catch {}
  return { messages, unread: stats.unreadItemCount, next };
}

export async function mailboxMessages(account, token, folder = "inbox", cursor) {
  try {
    const { messages, unread, next } = await (account.provider === "gmail" ? gmailMessages(account, token, folder, cursor) : outlookMessages(token, folder, cursor));
    return {
      messages: messages.filter(row => row.id && Number.isFinite(row.received) && row.received > 0 && row.received <= 8.64e15),
      unread: Number.isSafeInteger(unread) && unread >= 0 ? unread : messages.filter(row => row.unread).length, next
    };
  } catch (error) {
    if (error instanceof MailError) throw error;
    throw new MailError("mailUnavailable");
  }
}

const addressPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const encoder = new TextEncoder();

export function senderAddress(message) {
  return mailAddress(message.senderAddress || message.sender).toLowerCase();
}

export function senderDomain(message) {
  return senderAddress(message).split("@")[1] ?? "";
}

export function blockedMailSender(message, rules = []) {
  if (!rules.length) return false;
  const address = senderAddress(message);
  if (!address) return false;
  const domain = address.split("@")[1];
  return rules.some(({ mode, value }) => value === (mode === "domain" ? domain : address));
}

export function mailDomains(value) {
  if (typeof value !== "string" || value.length > 2048) throw new MailError("mailAlertDomainInvalid");
  const entries = value.split(/[\s,;،]+/u).filter(Boolean);
  if (!entries.length || entries.length > 20) throw new MailError("mailAlertDomainInvalid");
  try { return [...new Set(entries.map(mailHostname))]; }
  catch { throw new MailError("mailAlertDomainInvalid"); }
}

export function smtpConnection(account) {
  if (account.smtp) return account.smtp;
  const preset = imapPresets[account.preset];
  if (preset?.smtp) return {
    host: preset.smtp, security: "starttls", username: account.email, password: account.connection.password
  };
}

export function mailCapabilities(account) {
  if (account.provider === "imap") return { read: true, mark: true, send: Boolean(smtpConnection(account)) };
  const scopes = (account.scope ?? "").toLowerCase().split(/\s+/u).map(scope => scope.split("/").at(-1));
  const mark = scopes.includes(account.provider === "gmail" ? "gmail.modify" : "mail.readwrite");
  return account.provider === "gmail"
    ? { read: mark || scopes.includes("gmail.readonly"), mark,
      send: scopes.includes("gmail.send") || mark && account.sendConsent === true }
    : { read: mark || scopes.includes("mail.read"), mark, send: scopes.includes("mail.send") };
}

export function htmlText(html) {
  const symbols = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html.replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style|head|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<(?:br\b[^>]*|\/(?:p|div|li|tr|blockquote))\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/giu, (original, key) => {
      if (!key.startsWith("#")) return Object.hasOwn(symbols, key.toLowerCase()) ? symbols[key.toLowerCase()] : original;
      const hex = key[1].toLowerCase() === "x";
      const number = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : original;
    });
}

function findMailPart(part, kind, depth = 0) {
  if (!part || part.filename || depth > 8) return null;
  if (part.mimeType === kind && typeof part.body?.data === "string") return part.body.data;
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const found = findMailPart(child, kind, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function decodeBody(data) {
  const bytes = decodeFile(data);
  return new TextDecoder().decode(bytes);
}

function decodeFile(data) {
  return Uint8Array.from(atob(data.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
}

export function mailFileName(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f/\\]/gu, "_").trim().replace(/^\.+|\.+$/gu, "").slice(0, 180) || "attachment";
}

const messageIdPattern = /^<[!-;=?A-~]{1,160}@[!-;=?A-~]{1,160}>$/u;
const idList = /<[!-;=?A-~]{1,160}@[!-;=?A-~]{1,160}>/gu;
const attachmentKey = value => typeof value === "string" && value.length > 0 && value.length <= 1024;

function safeAttachment(item) {
  return item && attachmentKey(item.id) ? {
    id: item.id, name: mailFileName(item.name), size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null
  } : null;
}

function gmailContent(id, token) {
  const leaf = "partId,mimeType,filename,body(data,attachmentId,size)";
  const fields = `${leaf},headers(name,value),parts(${leaf},parts(${leaf},parts(${leaf})))`;
  return jsonRequest(`${gmail}/messages/${id}?format=full&fields=${encodeURIComponent(`snippet,threadId,payload(${fields})`)}`, { token, limit: 700 * 1024 });
}

function gmailAttachments(part, output = [], depth = 0) {
  if (!part || depth > 8 || output.length >= 40) return output;
  if (part.filename && (part.body?.attachmentId || typeof part.body?.data === "string")) {
    const id = part.body.attachmentId ?? `part:${part.partId ?? ""}`;
    output.push({ id, name: part.filename, size: part.body.size, data: part.body.data });
  }
  for (const child of part.parts ?? []) gmailAttachments(child, output, depth + 1);
  return output;
}

export function mailAddress(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  const match = normalized.match(/<([^<>]+)>\s*$/u)?.[1]?.trim() ?? normalized;
  return match.length <= 254 && addressPattern.test(match) ? match : "";
}

function imapMessageRequest(account, message, folder) {
  if (!/^[1-9][0-9]{0,9}$/u.test(message.id)) throw new MailError("mailReadFailed");
  return { ...account.connection, uid: message.id, folder, uid_validity: message.uidValidity };
}

export async function readMailMessage(account, message, token, folder = "inbox") {
  let result;
  const mark = folder === "inbox" && message.unread === true && mailCapabilities(account).mark;
  try {
    if (account.provider === "imap") {
      result = await jsonRequest(`${broker}/imap/message`, {
        body: { ...imapMessageRequest(account, message, folder), mark_read: mark }, milliseconds: 17_000
      });
    } else if (account.provider === "gmail") {
      if (!gmailId.test(message.id)) throw new MailError("mailReadFailed");
      const response = await gmailContent(message.id, token);
      const header = name => response.payload?.headers?.find(item => item.name?.toLowerCase() === name)?.value ?? "";
      const html = findMailPart(response.payload, "text/html");
      const plain = html ? null : findMailPart(response.payload, "text/plain");
      result = { body: html ? decodeBody(html) : plain ? decodeBody(plain) : htmlText(response.snippet ?? ""),
        format: html ? "html" : "text", partial: !plain && !html, attachments: gmailAttachments(response.payload),
        messageId: header("message-id"), references: header("references").match(idList) ?? [],
        replyAddress: header("reply-to") || header("from"), threadId: response.threadId };
      if (mark) result.marked = await jsonRequest(`${gmail}/messages/${message.id}/modify`, {
        token, empty: true, body: { removeLabelIds: ["UNREAD"] }
      }).then(() => true, () => false);
    } else {
      const endpoint = `${graph}/messages/${encodeURIComponent(message.id)}`;
      const response = await jsonRequest(`${endpoint}?$select=body,internetMessageId,replyTo,hasAttachments`, {
        token, headers: { Prefer: 'outlook.body-content-type="html"' }
      });
      const body = response.body?.content ?? "";
      result = { body, format: response.body?.contentType?.toLowerCase() === "html" ? "html" : "text",
        messageId: response.internetMessageId, replyAddress: response.replyTo?.[0]?.emailAddress?.address };
      if (response.hasAttachments) {
        const list = await jsonRequest(`${endpoint}/attachments?$select=id,name,size,isInline&$top=40`, { token }).catch(() => null);
        result.attachments = list?.value?.filter(item => !item.isInline);
      }
      if (mark) result.marked = await jsonRequest(`${graph}/messages/${encodeURIComponent(message.id)}`, {
        token, empty: true, method: "PATCH", body: { isRead: true }
      }).then(() => true, () => false);
    }
    if (typeof result?.body !== "string") throw new MailError("mailReadFailed");
    return { body: result.body.slice(0, 96_000), format: result.format === "html" ? "html" : "text",
      marked: result.marked === true, partial: result.partial === true || result.body.length > 96_000,
      attachments: Array.isArray(result.attachments) ? result.attachments.slice(0, 40).map(safeAttachment).filter(Boolean) : [],
      replyAddress: mailAddress(result.replyAddress) || mailAddress(message.senderAddress || message.sender),
      messageId: messageIdPattern.test(result.messageId ?? "") ? result.messageId : "",
      references: Array.isArray(result.references) ? result.references.filter(value => messageIdPattern.test(value)).slice(-12) : [],
      threadId: gmailId.test(result.threadId ?? "") ? result.threadId : "" };
  } catch (error) {
    if (error?.status === 401) throw new MailError("mailReconnect", 401);
    if (error?.status === 403 && account.provider !== "imap") throw new MailError("mailReadPermission", 403);
    throw new MailError("mailReadFailed");
  }
}

export async function downloadMailAttachment(account, message, attachment, token, folder) {
  if (!attachmentKey(attachment)) throw new MailError("mailAttachmentFailed");
  const limit = 7 * 1024 * 1024;
  let result;
  try {
    if (account.provider === "imap") {
      result = await jsonRequest(`${broker}/imap/attachment`, {
        body: { ...imapMessageRequest(account, message, folder), part: attachment }, milliseconds: 19_000, limit
      });
    } else if (account.provider === "gmail") {
      const response = await gmailContent(message.id, token);
      const part = gmailAttachments(response.payload).find(item => item.id === attachment);
      if (!part) throw new MailError("mailAttachmentFailed");
      if (part.size > mailDownloadLimit) throw new MailError("mailDownloadLimit");
      const item = typeof part.data === "string" ? { data: part.data }
        : await jsonRequest(`${gmail}/messages/${message.id}/attachments/${encodeURIComponent(part.id)}`, { token, limit });
      result = { name: part.name, data: item.data };
    } else {
      const endpoint = `${graph}/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment)}`;
      const item = await jsonRequest(`${endpoint}?$select=name,size`, { token });
      if (item.size > mailDownloadLimit) throw new MailError("mailDownloadLimit");
      result = { name: item.name, data: await downloadGraphBytes(`${endpoint}/$value`, token) };
    }
    if (typeof result?.data !== "string") throw new MailError("mailAttachmentFailed");
    const bytes = decodeFile(result.data);
    if (bytes.byteLength > mailDownloadLimit) throw new MailError("mailDownloadLimit");
    return { name: mailFileName(result.name), data: encodeMailBytes(bytes) };
  } catch (error) {
    throw new MailError(error?.status === 413 || error?.code === "mailDownloadLimit" ? "mailDownloadLimit" : "mailAttachmentFailed");
  }
}

export async function trashMailMessage(account, message, token, folder) {
  if (!mailCapabilities(account).mark) throw new MailError("mailDeletePermission");
  try {
    if (account.provider === "imap") await jsonRequest(`${broker}/imap/trash`, { body: imapMessageRequest(account, message, folder), milliseconds: 17_000 });
    else if (account.provider === "gmail") await jsonRequest(`${gmail}/messages/${encodeURIComponent(message.id)}/trash`, { token, body: {}, empty: true });
    else await jsonRequest(`${graph}/messages/${encodeURIComponent(message.id)}/move`, { token, body: { destinationId: "deleteditems" }, empty: true });
  } catch (error) {
    throw new MailError(error?.status === 403 && account.provider !== "imap" ? "mailDeletePermission" : "mailDeleteFailed");
  }
}

export function composeMail(data) {
  const { to, cc = "", subject, body, attachments = [], reply = null } = data ?? {};
  const recipients = addresses(to);
  const carbon = addresses(cc);
  if (!recipients.length || recipients.length > 10 || recipients.some(address => address.length > 254 || !addressPattern.test(address))
    || carbon.length > 10 || carbon.some(address => address.length > 254 || !addressPattern.test(address))
    || typeof subject !== "string" || [...subject].length > 180 || /[\u0000-\u001f\u007f]/u.test(subject)
    || typeof body !== "string" || !body.trim() || [...body].length > 5000 || encoder.encode(body).length > 16_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)) throw new MailError("mailSendInvalid");
  if (!Array.isArray(attachments) || attachments.length > 5) throw new MailError("mailUploadLimit");
  let bytes = 0;
  const files = attachments.map(item => {
    if (typeof item?.data !== "string" || item.data.length > Math.ceil(mailUploadLimit / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(item.data) || item.data.length % 4 !== 0) throw new MailError("mailUploadLimit");
    bytes += item.data.length / 4 * 3 - (item.data.endsWith("==") ? 2 : item.data.endsWith("=") ? 1 : 0);
    if (bytes > mailUploadLimit) throw new MailError("mailUploadLimit");
    return { name: mailFileName(item.name), data: item.data };
  });
  const threadId = typeof reply?.threadId === "string" && gmailId.test(reply.threadId) ? reply.threadId : "";
  const replyTo = typeof reply?.messageId === "string" && messageIdPattern.test(reply.messageId) ? reply.messageId : null;
  const references = Array.isArray(reply?.references) ? reply.references.filter(value => typeof value === "string" && messageIdPattern.test(value)).slice(-12) : [];
  return { to: recipients, cc: carbon.filter(item => !recipients.includes(item)), subject, body, attachments: files,
    ...(replyTo ? { reply_to_id: replyTo, references } : {}), ...(replyTo && threadId ? { threadId } : {}) };
}

function addresses(value) {
  if (typeof value !== "string" || value.length > 2600) throw new MailError("mailSendInvalid");
  return [...new Set(value.split(/[\s,;،]+/u).filter(Boolean))];
}

export function encodeMailBytes(bytes) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}

function encode64(text) {
  return encodeMailBytes(encoder.encode(text));
}

function wrapMime(value) {
  return value.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

function messageMime(email, { to, cc, subject, body, attachments, reply_to_id, references }) {
  const words = [];
  let word = "";
  // Keep each UTF-8 encoded word below the MIME header length limit.
  for (const character of subject) {
    if (encoder.encode(word + character).length > 36) {
      words.push(`=?UTF-8?B?${encode64(word)}?=`);
      word = "";
    }
    word += character;
  }
  if (word) words.push(`=?UTF-8?B?${encode64(word)}?=`);
  const headers = [
    `From: ${email}`, `To: ${to.join(",\r\n ")}`, `Subject: ${words.join("\r\n ")}`,
    "MIME-Version: 1.0"
  ];
  if (cc?.length) headers.push(`Cc: ${cc.join(",\r\n ")}`);
  if (reply_to_id) headers.push(`In-Reply-To: ${reply_to_id}`, `References: ${[...new Set([...references, reply_to_id])].join("\r\n ")}`);
  const textHeaders = 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64';
  const content = wrapMime(encode64(body.replace(/\r\n|\r|\n/gu, "\r\n")));
  if (!attachments?.length) return `${headers.join("\r\n")}\r\n${textHeaders}\r\n\r\n${content}\r\n`;
  const boundary = `ease-${crypto.randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = attachments.map(item => {
    const name = encodeURIComponent(item.name).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return `Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment;\r\n filename*=UTF-8''${name}\r\n\r\n${wrapMime(item.data)}\r\n`;
  });
  return `${headers.join("\r\n")}\r\n\r\n--${boundary}\r\n${textHeaders}\r\n\r\n${content}\r\n`
    + parts.map(part => `--${boundary}\r\n${part}`).join("") + `--${boundary}--\r\n`;
}

export async function deliverMail(account, message, token) {
  if (!addressPattern.test(account.email)) throw new MailError("mailSendInvalid");
  try {
    if (account.provider === "imap") {
      const smtp = smtpConnection(account);
      if (!smtp) throw new MailError("mailSmtpSetup");
      const { threadId, ...mail } = message;
      const result = await jsonRequest(`${broker}/smtp/send`, {
        body: { ...smtp, sender: account.email, ...mail, copy_to: account.connection }, milliseconds: 29_000
      });
      return { sent: true, savedCopy: result?.savedCopy };
    } else if (account.provider === "gmail") {
      await jsonRequest(`${gmail}/messages/send`, { token, milliseconds: 19_000,
        body: { raw: base64url(encoder.encode(messageMime(account.email, message))), ...(message.threadId ? { threadId: message.threadId } : {}) }, empty: true });
    } else if (message.reply_to_id) {
      await jsonRequest(`${graph}/sendMail`, { token, empty: true, raw: true, milliseconds: 19_000,
        body: encode64(messageMime(account.email, message)) });
    } else {
      await jsonRequest(`${graph}/sendMail`, { token, empty: true, milliseconds: 19_000, body: {
        message: { subject: message.subject, body: { contentType: "Text", content: message.body },
          toRecipients: message.to.map(address => ({ emailAddress: { address } })),
          ccRecipients: (message.cc ?? []).map(address => ({ emailAddress: { address } })),
          attachments: (message.attachments ?? []).map(item => ({ "@odata.type": "#microsoft.graph.fileAttachment",
            name: item.name, contentType: "application/octet-stream", contentBytes: item.data })) }, saveToSentItems: true
      } });
    }
    return { sent: true };
  } catch (error) {
    if (error.code === "mailSmtpSetup") throw error;
    if (error?.status === 401) throw new MailError("mailReconnect");
    if (error?.status === 403 && account.provider !== "imap") throw new MailError("mailSendPermission");
    if (!error?.status || error.status === 504 || account.provider !== "imap" && error.status >= 500) {
      throw new MailError("mailSendUnknown");
    }
    throw new MailError("mailSendFailed");
  }
}
