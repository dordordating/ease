const broker = "https://static.115.164.76.144.clients.your-server.de/v1/mail";
const gmail = "https://www.googleapis.com/gmail/v1/users/me";
const graph = "https://graph.microsoft.com/v1.0/me";
const outlookHosts = new Set(["outlook.live.com", "outlook.office.com", "outlook.office365.com", "outlook.cloud.microsoft"]);
const gmailId = /^[0-9a-f]{8,64}$/iu;
const inboxSize = 12;
export const mailProviders = Object.freeze({
  gmail: { host: "https://www.googleapis.com/*", authorization: "https://accounts.google.com", label: "Gmail" },
  outlook: { host: "https://graph.microsoft.com/*", authorization: "https://login.microsoftonline.com", label: "Outlook" }
});
export const imapPresets = Object.freeze({
  icloud: { host: "imap.mail.me.com", smtp: "smtp.mail.me.com", label: "iCloud Mail" },
  yahoo: { host: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", label: "Yahoo Mail" },
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

async function jsonRequest(url, { body, token, headers, milliseconds = 10_000, empty = false } = {}) {
  try {
    const options = { credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(milliseconds) };
    if (body) {
      options.method = "POST";
      options.body = JSON.stringify(body);
      options.headers = { "Content-Type": "application/json" };
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
        if (total > 256 * 1024) throw new MailError("mailUnavailable");
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

export async function imapMessages(connection) {
  try {
    const { messages, unread } = await jsonRequest(`${broker}/imap/sync`, { body: connection, milliseconds: 17_000 });
    if (!Array.isArray(messages) || messages.length > inboxSize || !Number.isSafeInteger(unread) || unread < 0) {
      throw new MailError("mailImapUnavailable");
    }
    return {
      unread,
      messages: messages.filter(row => row && typeof row.id === "string" && /^\d{1,10}$/u.test(row.id)
        && Number.isFinite(row.received) && row.received > 0 && row.received <= 8.64e15).map(row => ({
        id: row.id, received: row.received, subject: text(row.subject, 300), sender: text(row.sender, 254), unread: row.unread === true
      }))
    };
  } catch (error) {
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
  return btoa(String.fromCharCode(...array)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function mailConfig() {
  const answer = await jsonRequest(`${broker}/config?extension=${chrome.runtime.id}`);
  return { gmail: answer?.gmail === true, outlook: answer?.outlook === true };
}

export async function authorizeMailbox(provider, send = false) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const endpoint = `${broker}/oauth/${provider}`;
  const start = await jsonRequest(`${endpoint}/start`, { body: { challenge, extension_id: chrome.runtime.id, send } });
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
    ? `https://www.googleapis.com/auth/gmail.readonly${send ? " https://www.googleapis.com/auth/gmail.send" : ""}`
    : `Mail.Read${send ? " Mail.Send" : ""}`;
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

async function gmailMessages(account, token) {
  const [list, label] = await Promise.all([
    jsonRequest(`${gmail}/messages?labelIds=INBOX&maxResults=${inboxSize}&fields=messages(id,threadId)`, { token }),
    jsonRequest(`${gmail}/labels/INBOX?fields=messagesUnread`, { token })
  ]);
  const ids = (list.messages ?? []).filter(row => typeof row.id === "string" && gmailId.test(row.id)).slice(0, inboxSize);
  const messages = [];
  for (let index = 0; index < ids.length; index += 4) {
    const rows = await Promise.all(ids.slice(index, index + 4).map(async ({ id, threadId }) => {
      try {
        const row = await jsonRequest(
          `${gmail}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&fields=internalDate,labelIds,payload(headers)`, { token }
        );
        const headers = row.payload?.headers ?? [];
        return {
          id, subject: text(headers.find(item => item.name?.toLowerCase() === "subject")?.value, 300),
          sender: text(headers.find(item => item.name?.toLowerCase() === "from")?.value, 254),
          received: Number(row.internalDate), unread: row.labelIds?.includes("UNREAD") === true,
          url: `https://mail.google.com/mail/u/${encodeURIComponent(account.email)}/#inbox/${gmailId.test(threadId ?? "") ? threadId : id}`
        };
      } catch (error) {
        if (error.status !== 404) throw error;
        return null; // A message can leave the mailbox between the list and its metadata request.
      }
    }));
    messages.push(...rows.filter(Boolean));
  }
  return { messages, unread: label.messagesUnread };
}

async function outlookMessages(token) {
  const [list, folder] = await Promise.all([
    jsonRequest(`${graph}/mailFolders/inbox/messages?$top=${inboxSize}&$select=id,subject,from,receivedDateTime,isRead,webLink&$orderby=receivedDateTime%20desc`, { token }),
    jsonRequest(`${graph}/mailFolders/inbox?$select=unreadItemCount`, { token })
  ]);
  const messages = list.value.slice(0, inboxSize).map(row => ({
    id: text(row.id, 512),
    subject: text(row.subject, 300),
    sender: text(row.from?.emailAddress?.name || row.from?.emailAddress?.address, 254),
    senderAddress: text(row.from?.emailAddress?.address, 254),
    received: Date.parse(row.receivedDateTime), unread: row.isRead === false,
    url: mailMessageLink("outlook", row.webLink)
  }));
  return { messages, unread: folder.unreadItemCount };
}

export async function mailboxMessages(account, token) {
  try {
    const { messages, unread } = await (account.provider === "gmail" ? gmailMessages(account, token) : outlookMessages(token));
    return {
      messages: messages.filter(row => row.id && Number.isFinite(row.received) && row.received > 0 && row.received <= 8.64e15),
      unread: Number.isSafeInteger(unread) && unread >= 0 ? unread : messages.filter(row => row.unread).length
    };
  } catch (error) {
    if (error instanceof MailError) throw error;
    throw new MailError("mailUnavailable");
  }
}

const addressPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const encoder = new TextEncoder();

export function senderDomain(message) {
  let address = (message.senderAddress || message.sender || "").trim();
  address = address.match(/<([^<>]+)>\s*$/u)?.[1]?.trim() ?? address;
  if (!addressPattern.test(address)) return "";
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
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
  if (account.provider === "imap") return { read: true, send: Boolean(smtpConnection(account)) };
  const scopes = (account.scope ?? "").toLowerCase().split(/\s+/u).map(scope => scope.split("/").at(-1));
  return account.provider === "gmail"
    ? { read: scopes.includes("gmail.readonly"), send: scopes.includes("gmail.send") }
    : { read: scopes.includes("mail.read"), send: scopes.includes("mail.send") };
}

function htmlText(html) {
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
  const bytes = Uint8Array.from(atob(data.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function readMailMessage(account, message, token) {
  let result;
  try {
    if (account.provider === "imap") {
      if (!/^[1-9][0-9]{0,9}$/u.test(message.id)) throw new MailError("mailReadFailed");
      result = await jsonRequest(`${broker}/imap/message`, {
        body: { ...account.connection, uid: message.id }, milliseconds: 17_000
      });
    } else if (account.provider === "gmail") {
      if (!gmailId.test(message.id)) throw new MailError("mailReadFailed");
      const fields = "mimeType,filename,body(data),parts(mimeType,filename,body(data),parts(mimeType,filename,body(data),parts(mimeType,filename,body(data))))";
      const response = await jsonRequest(`${gmail}/messages/${message.id}?format=full&fields=${encodeURIComponent(`snippet,payload(${fields})`)}`, { token });
      const plain = findMailPart(response.payload, "text/plain");
      const html = plain ? null : findMailPart(response.payload, "text/html");
      result = { body: plain ? decodeBody(plain) : html ? htmlText(decodeBody(html)) : htmlText(response.snippet ?? ""), partial: !plain && !html };
    } else {
      const response = await jsonRequest(`${graph}/messages/${encodeURIComponent(message.id)}?$select=body`, {
        token, headers: { Prefer: 'outlook.body-content-type="text"' }
      });
      const body = response.body?.content ?? "";
      result = { body: response.body?.contentType?.toLowerCase() === "html" ? htmlText(body) : body };
    }
    if (typeof result?.body !== "string") throw new MailError("mailReadFailed");
    return { body: result.body.slice(0, 48_000), partial: result.partial === true || result.body.length > 48_000 };
  } catch (error) {
    if (error?.status === 401) throw new MailError("mailReconnect", 401);
    if (error?.status === 403 && account.provider !== "imap") throw new MailError("mailReadPermission", 403);
    throw new MailError("mailReadFailed");
  }
}

export function composeMail(data) {
  const { to, subject, body } = data ?? {};
  const recipients = typeof to === "string" && to.length <= 2600 ? [...new Set(to.split(/[\s,;،]+/u).filter(Boolean))] : [];
  if (!recipients.length || recipients.length > 10 || recipients.some(address => address.length > 254 || !addressPattern.test(address))
    || typeof subject !== "string" || [...subject].length > 180 || /[\u0000-\u001f\u007f]/u.test(subject)
    || typeof body !== "string" || !body.trim() || [...body].length > 5000 || encoder.encode(body).length > 16_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)) throw new MailError("mailSendInvalid");
  return { to: recipients, subject, body };
}

function encode64(text) {
  return btoa(String.fromCharCode(...encoder.encode(text)));
}

function gmailRaw(email, { to, subject, body }) {
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
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"
  ];
  const content = encode64(body.replace(/\r\n|\r|\n/gu, "\r\n")).match(/.{1,76}/gu).join("\r\n");
  return base64url(encoder.encode(headers.join("\r\n") + "\r\n\r\n" + content + "\r\n"));
}

export async function deliverMail(account, message, token) {
  if (!addressPattern.test(account.email)) throw new MailError("mailSendInvalid");
  try {
    if (account.provider === "imap") {
      const smtp = smtpConnection(account);
      if (!smtp) throw new MailError("mailSmtpSetup");
      await jsonRequest(`${broker}/smtp/send`, { body: { ...smtp, sender: account.email, ...message }, milliseconds: 17_000 });
    } else if (account.provider === "gmail") {
      await jsonRequest(`${gmail}/messages/send`, { token, body: { raw: gmailRaw(account.email, message) }, empty: true });
    } else {
      await jsonRequest(`${graph}/sendMail`, { token, empty: true, body: {
        message: { subject: message.subject, body: { contentType: "Text", content: message.body },
          toRecipients: message.to.map(address => ({ emailAddress: { address } })) }, saveToSentItems: true
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
