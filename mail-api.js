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

async function jsonRequest(url, { body, token } = {}) {
  try {
    const options = { credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) };
    if (body) {
      options.method = "POST";
      options.body = JSON.stringify(body);
      options.headers = { "Content-Type": "application/json" };
    }
    if (token) options.headers = { Authorization: `Bearer ${token}` };
    const response = await fetch(url, options);
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

function expiry(result, savedRefreshToken) {
  const { access_token: accessToken, refresh_token: rotated, expires_in: expiresIn } = result ?? {};
  const refreshToken = rotated ?? savedRefreshToken;
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > 8192
    || typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 8192
    || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 86_400) throw new MailError("mailUnavailable");
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

function base64url(array) {
  return btoa(String.fromCharCode(...array)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function mailConfig() {
  const answer = await jsonRequest(`${broker}/config?extension=${chrome.runtime.id}`);
  return { gmail: answer?.gmail === true, outlook: answer?.outlook === true };
}

export async function authorizeMailbox(provider) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const endpoint = `${broker}/oauth/${provider}`;
  const start = await jsonRequest(`${endpoint}/start`, { body: { challenge, extension_id: chrome.runtime.id } });
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
  return expiry(await jsonRequest(`${endpoint}/exchange`, { body: { verifier, state: start.state, code } }));
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
    jsonRequest(`${gmail}/messages?labelIds=INBOX&maxResults=${inboxSize}&fields=messages(id)`, { token }),
    jsonRequest(`${gmail}/labels/INBOX?fields=messagesUnread`, { token })
  ]);
  const ids = (list.messages ?? []).map(row => row.id).filter(id => typeof id === "string" && gmailId.test(id)).slice(0, inboxSize);
  const messages = [];
  for (let index = 0; index < ids.length; index += 4) {
    const rows = await Promise.all(ids.slice(index, index + 4).map(async (id) => {
      try {
        const row = await jsonRequest(
          `${gmail}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&fields=internalDate,labelIds,payload(headers)`, { token }
        );
        const headers = row.payload?.headers ?? [];
        return {
          id, subject: text(headers.find(item => item.name?.toLowerCase() === "subject")?.value, 300),
          sender: text(headers.find(item => item.name?.toLowerCase() === "from")?.value, 254),
          received: Number(row.internalDate), unread: row.labelIds?.includes("UNREAD") === true,
          url: `https://mail.google.com/mail/u/${encodeURIComponent(account.email)}/#inbox/${id}`
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
