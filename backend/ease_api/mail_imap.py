"""Read a small, read-only inbox snapshot over verified IMAP TLS."""

import asyncio
import base64
import imaplib
import ipaddress
import re
import socket
import ssl
from collections import OrderedDict, deque
from datetime import datetime
from email import policy
from email.errors import MessageError
from email.parser import BytesHeaderParser, BytesParser
from time import monotonic
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from .mail_mime import attachment_parts, decode_part, download_limit, message_id_pattern, structure

router = APIRouter(prefix="/v1/mail/imap")
tls = ssl.create_default_context()
tls.minimum_version = ssl.TLSVersion.TLSv1_2
hostname_label = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
unsafe_control = re.compile(r"[\x00-\x1f\x7f]")
internal_date = re.compile(rb'\bINTERNALDATE "([^"]+)"')
uid_pattern = re.compile(rb"\bUID ([0-9]{1,10})\b")
unseen_pattern = re.compile(rb"\bUNSEEN ([0-9]{1,10})\b")
header_limit = 8192
preview_limit = 96 * 1024
line_limit = 16_384
byte_limit = 256 * 1024
snapshot_size = 12
# These transition ranges can tunnel an embedded address independently of routing checks.
transition_ranges = tuple(
    ipaddress.IPv6Network(network) for network in ("64:ff9b::/96", "64:ff9b:1::/48", "2001::/32", "2002::/16")
)


class ImapSync(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    host: str = Field(min_length=4, max_length=253)
    security: Literal["tls", "starttls"] = "tls"
    username: str = Field(min_length=1, max_length=254)
    password: SecretStr = Field(min_length=1, max_length=1024)

    @field_validator("host")
    @classmethod
    def public_hostname(cls, value: str) -> str:
        try:
            name = value.strip().rstrip(".").encode("idna").decode().lower()
        except UnicodeError:
            raise ValueError("Invalid IMAP hostname") from None
        labels = name.split(".")
        if (len(labels) < 2 or not any(char.isalpha() for char in labels[-1])
                or len(name) > 253 or any(not hostname_label.fullmatch(label) for label in labels)):
            raise ValueError("Invalid IMAP hostname")
        return name

    @field_validator("username")
    @classmethod
    def no_username_controls(cls, value: str) -> str:
        if not value.strip() or unsafe_control.search(value):
            raise ValueError("Invalid IMAP username")
        return value

    @field_validator("password")
    @classmethod
    def no_password_controls(cls, value: SecretStr) -> SecretStr:
        if unsafe_control.search(value.get_secret_value()):
            raise ValueError("Invalid IMAP password")
        return value


class AuthenticationFailed(Exception):
    pass


class ImapFolder(ImapSync):
    folder: Literal["inbox", "sent"] = "inbox"
    before_uid: str | None = Field(default=None, pattern=r"^[1-9][0-9]{0,9}$")
    uid_validity: str | None = Field(default=None, pattern=r"^[1-9][0-9]{0,9}$")


class ImapMessage(ImapFolder):
    uid: str = Field(pattern=r"^[1-9][0-9]{0,9}$")
    mark_read: bool = False


class ImapAttachment(ImapMessage):
    part: str = Field(pattern=r"^[1-9][0-9]{0,2}(\.[1-9][0-9]{0,2}){0,15}$")


def public_address(value: str) -> bool:
    address = ipaddress.ip_address(value)
    return (
        address.is_global and not address.is_multicast and not address.is_reserved and not address.is_link_local
        and (address.version == 4 or not address.ipv4_mapped
             and not any(address in network for network in transition_ranges))
    )


async def resolve_public(host: str, port: int) -> list[tuple]:
    loop = asyncio.get_running_loop()
    addresses = await asyncio.wait_for(loop.getaddrinfo(host + ".", port, type=socket.SOCK_STREAM), 3)
    if not addresses or any(not public_address(entry[4][0]) for entry in addresses):
        raise ValueError("IMAP server must have public addresses")
    return list(dict.fromkeys(addresses))[:4]


class PinnedMailIO:
    def __init__(self, addresses: list[tuple], secure: bool) -> None:
        self.deadline = monotonic() + 11
        self.addresses = addresses
        self.buffer = bytearray()
        self.remaining = byte_limit
        self.secure = secure

    def timeout(self, maximum: float = 4) -> float:
        left = self.deadline - monotonic()
        if left <= 0:
            raise TimeoutError
        return min(left, maximum)

    def open(self, host: str, port: int, timeout: float = 3) -> None:
        self.host, self.port = host, port
        for family, kind, proto, _, address in self.addresses:
            sock = socket.socket(family, kind, proto)
            try:
                sock.settimeout(self.timeout(min(timeout, 2.5)))
                sock.connect(address)
                sock.settimeout(self.timeout())
                self.sock = tls.wrap_socket(sock, server_hostname=host) if self.secure else sock
                return
            except OSError:
                sock.close()
        raise OSError("Could not reach IMAP server")

    def upgrade_tls(self) -> None:
        self.buffer.clear()
        self.sock.settimeout(self.timeout())
        self.sock = tls.wrap_socket(self.sock, server_hostname=self.host)
        self.secure = True

    def receive(self, size: int) -> None:
        self.sock.settimeout(self.timeout())
        received = self.sock.recv(min(size, self.remaining + 1))
        self.remaining -= len(received)
        if not received or self.remaining < 0:
            raise imaplib.IMAP4.abort("IMAP response exceeded its bounds or closed")
        self.buffer.extend(received)

    def readline(self) -> bytes:
        while True:
            end = self.buffer.find(b"\n")
            if 0 <= end < line_limit:
                line = bytes(self.buffer[:end + 1])
                del self.buffer[:end + 1]
                return line
            if len(self.buffer) >= line_limit:
                raise imaplib.IMAP4.abort("IMAP response line exceeded its bounds")
            self.receive(4096)

    def send(self, data: bytes) -> None:
        self.sock.settimeout(self.timeout())
        self.sock.sendall(data)

    def shutdown(self) -> None:
        self.sock.close()


class PinnedImap(PinnedMailIO, imaplib.IMAP4):
    def __init__(self, host: str, port: int, addresses: list[tuple], secure: bool) -> None:
        PinnedMailIO.__init__(self, addresses, secure)
        self.literal_limit = header_limit
        imaplib.IMAP4.__init__(self, host, port, timeout=3)

    def upgrade(self) -> None:
        if self.secure:
            return
        if "STARTTLS" not in self.capabilities or self._simple_command("STARTTLS")[0] != "OK":
            raise imaplib.IMAP4.error("Server does not support STARTTLS")
        self.untagged_responses.clear()
        self.upgrade_tls()
        self._tls_established = True
        self._get_capabilities()

    def read(self, size: int) -> bytes:
        if size > self.literal_limit:
            raise imaplib.IMAP4.abort("IMAP literal exceeded its bounds")
        while len(self.buffer) < size:
            self.receive(size - len(self.buffer))
        data = bytes(self.buffer[:size])
        del self.buffer[:size]
        return data


def authenticate(client: PinnedImap, username: str, password: str) -> None:
    if client.state != "NONAUTH" or not client.secure:
        raise AuthenticationFailed
    try:
        if "AUTH=PLAIN" in client.capabilities:
            secret = ("\0" + username + "\0" + password).encode()
            client.authenticate("PLAIN", lambda _: secret)
        elif "LOGINDISABLED" not in client.capabilities and username.isascii() and password.isascii():
            client.login(client._quote(username), password)
        else:
            raise AuthenticationFailed
    except (imaplib.IMAP4.abort, OSError):
        raise
    except imaplib.IMAP4.error:
        raise AuthenticationFailed from None


def display_header(value: object, limit: int) -> str:
    return unsafe_control.sub(" ", str(value or "")).strip()[:limit]

_list_row = re.compile(rb'^\(([^)]*)\) (?:NIL|"[^"]*") (.+)$', re.IGNORECASE)
_sent_names = {"sent", "sent items", "sent messages", "sent mail", "[gmail]/sent mail", "inbox.sent"}


def special_mailbox(client: PinnedImap, role: bytes, names: set[str]) -> str | None:
    kind, rows = "NO", []
    if "SPECIAL-USE" in client.capabilities:
        try:
            kind, response = client._simple_command("LIST", '""', '"*"', "RETURN", "(SPECIAL-USE)")
            kind, rows = client._untagged_response(kind, response, "LIST")
        except imaplib.IMAP4.abort:
            raise
        except imaplib.IMAP4.error:
            pass
    if kind != "OK" or not any(rows or ()):
        kind, rows = client.list()
    if kind != "OK":
        return None
    fallback = None
    for row in rows or ():
        literal = isinstance(row, tuple)
        matched = _list_row.fullmatch(row[0] if literal else row) if isinstance(row, (bytes, tuple)) else None
        if not matched:
            continue
        flags, name = matched.groups()
        if b"\\noselect" in flags.lower().split():
            continue
        if literal:
            name = row[1]
        elif name.startswith(b'"') and name.endswith(b'"'):
            name = re.sub(rb'\\([\\"])', rb'\1', name[1:-1])
        try:
            label = name.decode("ascii")
        except UnicodeError:
            continue
        if not label or unsafe_control.search(label) or len(label) > 512:
            continue
        if role in flags.lower().split():
            return client._quote(label)
        if label.casefold() in names and fallback is None:
            fallback = client._quote(label)
    return fallback


def sent_mailbox(client: PinnedImap) -> str | None:
    return special_mailbox(client, b"\\sent", _sent_names)


def mailbox_validity(client: PinnedImap) -> str | None:
    _, values = client.response("UIDVALIDITY")
    value = values[0] if values else None
    return value.decode("ascii") if value and re.fullmatch(rb"[1-9][0-9]{0,9}", value) else None


def mark_seen(client: PinnedImap, mailbox: str, uid: str, validity: str | None) -> bool:
    try:
        if client.select(mailbox, readonly=False)[0] != "OK" or mailbox_validity(client) != validity:
            return False
        return client.uid("STORE", uid, "+FLAGS.SILENT", r"(\Seen)")[0] == "OK"
    except (imaplib.IMAP4.error, OSError):
        return False


def select_message(client: PinnedImap, config: ImapMessage) -> tuple[str, str | None]:
    mailbox = sent_mailbox(client) if config.folder == "sent" else "INBOX"
    if not mailbox or client.select(mailbox, readonly=True)[0] != "OK":
        raise HTTPException(404, "imap_message_missing")
    validity = mailbox_validity(client)
    if config.uid_validity and config.uid_validity != validity:
        raise HTTPException(404, "imap_message_missing")
    return mailbox, validity


def imap_parts(client: PinnedImap, uid: str) -> list[dict]:
    kind, rows = client.uid("FETCH", uid, "(UID BODYSTRUCTURE)")
    return attachment_parts(structure(rows)) if kind == "OK" else []


def read_message(config: ImapMessage, port: int, addresses: list[tuple]) -> dict:
    client = PinnedImap(config.host, port, addresses, config.security == "tls")
    try:
        client.upgrade()
        authenticate(client, config.username, config.password.get_secret_value())
        mailbox, validity = select_message(client, config)
        client.literal_limit = preview_limit
        kind, rows = client.uid("FETCH", config.uid, f"(UID FLAGS BODY.PEEK[]<0.{preview_limit}>)")
        for entry in rows if kind == "OK" and rows else ():
            if not isinstance(entry, tuple):
                continue
            uid = uid_pattern.search(entry[0])
            if not uid or uid[1].decode() != config.uid:
                continue
            message = BytesParser(policy=policy.default).parsebytes(entry[1])
            part = message.get_body(preferencelist=("html", "plain"))
            content = part.get_content(errors="replace") if part else ""
            html = part is not None and part.get_content_type() == "text/html"
            sender = message.get("Reply-To") or message.get("From")
            reply_address = sender.addresses[0].addr_spec if getattr(sender, "addresses", ()) else ""
            references = message_id_pattern.findall(str(message.get("References") or ""))[-12:]
            message_id = str(message.get("Message-ID") or "")
            try:
                attachments = [{key: value for key, value in item.items() if key != "encoding"}
                               for item in imap_parts(client, config.uid)]
            except (imaplib.IMAP4.error, OSError):
                attachments = []
            marked = config.folder == "inbox" and config.mark_read and (
                b"\\Seen" in imaplib.ParseFlags(entry[0]) or mark_seen(client, mailbox, config.uid, validity)
            )
            return {"body": content[:96_000], "format": "html" if html else "text", "marked": marked,
                    "partial": len(entry[1]) >= preview_limit or len(content) > 96_000, "attachments": attachments,
                    "replyAddress": reply_address, "references": references,
                    "messageId": message_id if message_id_pattern.fullmatch(message_id) else ""}
        raise HTTPException(404, "imap_message_missing")
    finally:
        client.shutdown()


def append_sent(config: ImapSync, raw: bytes, message_id: str, port: int, addresses: list[tuple]) -> bool:
    client = PinnedImap(config.host, port, addresses, config.security == "tls")
    try:
        client.upgrade()
        authenticate(client, config.username, config.password.get_secret_value())
        mailbox = sent_mailbox(client)
        if not mailbox:
            return False
        # A submission server may have already filed the message.
        if client.select(mailbox, readonly=True)[0] == "OK":
            status, identifiers = client.uid("SEARCH", "HEADER", "Message-ID", client._quote(message_id))
            if status == "OK" and any(identifiers or ()):
                return True
        return client.append(mailbox, r"(\Seen)", None, raw)[0] == "OK"
    finally:
        client.shutdown()


def inbox_message(item: object, folder: str = "inbox") -> dict | None:
    if not isinstance(item, tuple) or len(item) != 2 or not all(isinstance(part, bytes) for part in item):
        return None
    attributes, headers = item
    if b"\\Deleted" in imaplib.ParseFlags(attributes):
        return None
    uid = uid_pattern.search(attributes)
    stamp = internal_date.search(attributes)
    if not uid or not stamp:
        return None
    try:
        date = datetime.strptime(stamp[1].decode("ascii").strip(), "%d-%b-%Y %H:%M:%S %z")
        parsed = BytesHeaderParser(policy=policy.default).parsebytes(headers)
        return {
            "id": uid[1].decode("ascii"), "received": int(date.timestamp() * 1000),
            "sender": display_header(parsed.get("To" if folder == "sent" else "From"), 254),
            "subject": display_header(parsed.get("Subject"), 300),
            "unread": b"\\Seen" not in imaplib.ParseFlags(attributes),
        }
    except (ValueError, TypeError, IndexError, UnicodeError, MessageError):
        return None


def read_inbox(config: ImapSync, port: int, addresses: list[tuple], folder: str = "inbox") -> dict:
    client = PinnedImap(config.host, port, addresses, config.security == "tls")
    try:
        client.upgrade()
        authenticate(client, config.username, config.password.get_secret_value())
        mailbox = sent_mailbox(client) if folder == "sent" else "INBOX"
        if not mailbox:
            return {"messages": [], "unread": 0, "available": False}
        unread = None
        if folder == "inbox":
            try:
                kind, status = client.status(mailbox, "(UNSEEN)")
                unread = unseen_pattern.search(status[0]) if kind == "OK" and status and status[0] else None
            except imaplib.IMAP4.abort:
                raise
            except imaplib.IMAP4.error:
                pass
        kind, selected = client.select(mailbox, readonly=True)
        validity = mailbox_validity(client)
        if kind != "OK" or not selected or not selected[0] or not re.fullmatch(rb"\d{1,10}", selected[0]):
            raise imaplib.IMAP4.error("INBOX unavailable")
        total = int(selected[0])
        if isinstance(config, ImapFolder) and config.before_uid:
            if config.uid_validity and config.uid_validity != validity:
                raise HTTPException(409, "imap_cursor_expired")
            kind, anchor = client.uid("FETCH", config.before_uid, "(UID)")
            first = re.match(rb"(\d+) \(", anchor[0]) if kind == "OK" and anchor and isinstance(anchor[0], bytes) else None
            if not first:
                raise HTTPException(409, "imap_cursor_expired")
            total = int(first[1]) - 1
        messages = []
        next_cursor = None
        if total:
            person = "TO" if folder == "sent" else "FROM"
            start = max(1, total - snapshot_size + 1)
            kind, rows = client.fetch(
                f"{start}:{total}",
                f"(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS ({person} SUBJECT)]<0.{header_limit}>)",
            )
            if kind != "OK":
                raise imaplib.IMAP4.error("INBOX fetch failed")
            messages = [message for item in rows if (message := inbox_message(item, folder))][:snapshot_size]
            messages.sort(key=lambda message: message["received"], reverse=True)
            uids = [uid[1].decode() for item in rows if isinstance(item, tuple) and (uid := uid_pattern.search(item[0]))]
            if start > 1 and uids:
                next_cursor = {"before_uid": min(uids, key=int), **({"uid_validity": validity} if validity else {})}
        if validity:
            for message in messages:
                message["uidValidity"] = validity
        if folder == "sent":
            for message in messages:
                message["unread"] = False
        return {"messages": messages, "unread": int(unread[1]) if unread else sum(row["unread"] for row in messages),
                **({"next": next_cursor} if next_cursor else {})}
    finally:
        client.shutdown()


# This route is public because an IMAP account does not require an Ease login.
# Limit both total work and any one client, independently of upstream providers.
slots = asyncio.Semaphore(4)
global_window: deque[float] = deque()
client_windows: OrderedDict[str, deque[float]] = OrderedDict()


def allow_attempt(client: str) -> bool:
    recent = client_windows.setdefault(client, deque())
    client_windows.move_to_end(client)
    if len(client_windows) > 1024:
        client_windows.popitem(last=False)
    now = monotonic()
    for timestamps in (global_window, recent):
        while timestamps and timestamps[0] <= now - 60:
            timestamps.popleft()
    if len(global_window) >= 150 or len(recent) >= 36:
        return False
    global_window.append(now)
    recent.append(now)
    return True


async def run_mail_io(request: Request, host: str, port: int, operation):
    if not allow_attempt(request.client.host if request.client else ""):
        raise HTTPException(429, "imap_busy", headers={"Retry-After": "60"})
    try:
        await asyncio.wait_for(slots.acquire(), 1)
    except TimeoutError:
        raise HTTPException(429, "imap_busy", headers={"Retry-After": "5"}) from None
    try:
        addresses = await resolve_public(host, port)
        return await asyncio.to_thread(operation, addresses)
    except AuthenticationFailed:
        raise HTTPException(401, "imap_auth_failed") from None
    except (imaplib.IMAP4.error, OSError, ValueError, TypeError, LookupError, MessageError, RecursionError):
        raise HTTPException(502, "imap_unavailable") from None
    finally:
        slots.release()


@router.post("/sync")
async def sync_imap(payload: ImapFolder, request: Request):
    port = 993 if payload.security == "tls" else 143
    return await run_mail_io(request, payload.host, port, lambda addresses: read_inbox(payload, port, addresses, payload.folder))


@router.post("/message")
async def imap_message(payload: ImapMessage, request: Request):
    port = 993 if payload.security == "tls" else 143
    return await run_mail_io(request, payload.host, port, lambda addresses: read_message(payload, port, addresses))


def get_attachment(config: ImapAttachment, port: int, addresses: list[tuple]) -> dict:
    client = PinnedImap(config.host, port, addresses, config.security == "tls")
    try:
        client.upgrade()
        authenticate(client, config.username, config.password.get_secret_value())
        select_message(client, config)
        part = next((item for item in imap_parts(client, config.uid) if item["id"] == config.part), None)
        if not part:
            raise HTTPException(404, "imap_attachment_missing")
        if part["size"] is not None and part["size"] > download_limit:
            raise HTTPException(413, "imap_attachment_large")
        wire_limit = 8 * 1024 * 1024
        client.literal_limit = wire_limit
        client.remaining = wire_limit + 32 * 1024
        status, rows = client.uid("FETCH", config.uid, f"(UID BODY.PEEK[{config.part}]<0.{wire_limit}>)")
        for row in rows if status == "OK" and rows else ():
            if not isinstance(row, tuple):
                continue
            uid = uid_pattern.search(row[0])
            if not uid or uid[1].decode() != config.uid:
                continue
            if len(row[1]) >= wire_limit:
                raise HTTPException(413, "imap_attachment_large")
            data = decode_part(row[1], part["encoding"])
            if len(data) > download_limit:
                raise HTTPException(413, "imap_attachment_large")
            return {"name": part["name"], "data": base64.b64encode(data).decode("ascii")}
        raise HTTPException(404, "imap_attachment_missing")
    finally:
        client.shutdown()


@router.post("/attachment")
async def imap_attachment(payload: ImapAttachment, request: Request):
    port = 993 if payload.security == "tls" else 143
    return await run_mail_io(request, payload.host, port, lambda addresses: get_attachment(payload, port, addresses))


def trash_message(config: ImapMessage, port: int, addresses: list[tuple]) -> dict:
    client = PinnedImap(config.host, port, addresses, config.security == "tls")
    try:
        client.upgrade()
        authenticate(client, config.username, config.password.get_secret_value())
        mailbox = sent_mailbox(client) if config.folder == "sent" else "INBOX"
        trash = special_mailbox(client, b"\\trash", {"trash", "deleted items", "deleted messages", "[gmail]/trash", "inbox.trash"})
        if not trash or not mailbox or client.select(mailbox, readonly=False)[0] != "OK":
            raise HTTPException(409, "imap_trash_unavailable")
        validity = mailbox_validity(client)
        if config.uid_validity and config.uid_validity != validity:
            raise HTTPException(404, "imap_message_missing")
        kind, identifiers = client.uid("FETCH", config.uid, "(UID)")
        if kind != "OK" or not any(identifiers or ()):
            raise HTTPException(404, "imap_message_missing")
        if "MOVE" in client.capabilities:
            if client.uid("MOVE", config.uid, trash)[0] != "OK":
                raise HTTPException(502, "imap_trash_failed")
        else:
            if client.uid("COPY", config.uid, trash)[0] != "OK" or client.uid("STORE", config.uid, "+FLAGS.SILENT", r"(\Deleted)")[0] != "OK":
                raise HTTPException(502, "imap_trash_failed")
            if "UIDPLUS" in client.capabilities:
                client.uid("EXPUNGE", config.uid)
        return {"trashed": True}
    finally:
        client.shutdown()


@router.post("/trash")
async def imap_trash(payload: ImapMessage, request: Request):
    port = 993 if payload.security == "tls" else 143
    return await run_mail_io(request, payload.host, port, lambda addresses: trash_message(payload, port, addresses))
