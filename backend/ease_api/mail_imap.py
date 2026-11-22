"""Read a small, read-only inbox snapshot over verified IMAP TLS."""

import asyncio
import imaplib
import ipaddress
import re
import socket
import ssl
from collections import OrderedDict, deque
from datetime import datetime
from email import policy
from email.errors import MessageError
from email.parser import BytesHeaderParser
from time import monotonic
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

router = APIRouter(prefix="/v1/mail/imap")
tls = ssl.create_default_context()
tls.minimum_version = ssl.TLSVersion.TLSv1_2
hostname_label = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
unsafe_control = re.compile(r"[\x00-\x1f\x7f]")
internal_date = re.compile(rb'\bINTERNALDATE "([^"]+)"')
uid_pattern = re.compile(rb"\bUID ([0-9]{1,10})\b")
unseen_pattern = re.compile(rb"\bUNSEEN ([0-9]{1,10})\b")
header_limit = 8192
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


class PinnedImap(imaplib.IMAP4):
    def __init__(self, host: str, port: int, addresses: list[tuple], secure: bool) -> None:
        self.deadline = monotonic() + 11
        self.addresses = addresses
        self.buffer = bytearray()
        self.remaining = byte_limit
        self.secure = secure
        super().__init__(host, port, timeout=3)

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

    def upgrade(self) -> None:
        if self.secure:
            return
        if "STARTTLS" not in self.capabilities or self._simple_command("STARTTLS")[0] != "OK":
            raise imaplib.IMAP4.error("Server does not support STARTTLS")
        self.buffer.clear()
        self.untagged_responses.clear()
        self.sock.settimeout(self.timeout())
        self.sock = tls.wrap_socket(self.sock, server_hostname=self.host)
        self.secure = True
        self._tls_established = True
        self._get_capabilities()

    def receive(self, size: int) -> None:
        self.sock.settimeout(self.timeout())
        received = self.sock.recv(min(size, self.remaining + 1))
        self.remaining -= len(received)
        if not received or self.remaining < 0:
            raise imaplib.IMAP4.abort("IMAP response exceeded its bounds or closed")
        self.buffer.extend(received)

    def read(self, size: int) -> bytes:
        if size > header_limit:
            raise imaplib.IMAP4.abort("IMAP header exceeded its bounds")
        while len(self.buffer) < size:
            self.receive(size - len(self.buffer))
        data = bytes(self.buffer[:size])
        del self.buffer[:size]
        return data

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


def inbox_message(item: object) -> dict | None:
    if not isinstance(item, tuple) or len(item) != 2 or not all(isinstance(part, bytes) for part in item):
        return None
    attributes, headers = item
    uid = uid_pattern.search(attributes)
    stamp = internal_date.search(attributes)
    if not uid or not stamp:
        return None
    try:
        date = datetime.strptime(stamp[1].decode("ascii").strip(), "%d-%b-%Y %H:%M:%S %z")
        parsed = BytesHeaderParser(policy=policy.default).parsebytes(headers)
        return {
            "id": uid[1].decode("ascii"), "received": int(date.timestamp() * 1000),
            "sender": display_header(parsed.get("From"), 254), "subject": display_header(parsed.get("Subject"), 300),
            "unread": b"\\Seen" not in imaplib.ParseFlags(attributes),
        }
    except (ValueError, TypeError, IndexError, UnicodeError, MessageError):
        return None


def read_inbox(config: ImapSync, port: int, addresses: list[tuple]) -> dict:
    client = PinnedImap(config.host, port, addresses, config.security == "tls")
    try:
        client.upgrade()
        authenticate(client, config.username, config.password.get_secret_value())
        try:
            kind, status = client.status("INBOX", "(UNSEEN)")
            unread = unseen_pattern.search(status[0]) if kind == "OK" and status and status[0] else None
        except imaplib.IMAP4.abort:
            raise
        except imaplib.IMAP4.error:
            unread = None
        kind, selected = client.select("INBOX", readonly=True)
        if kind != "OK" or not selected or not selected[0] or not re.fullmatch(rb"\d{1,10}", selected[0]):
            raise imaplib.IMAP4.error("INBOX unavailable")
        total = int(selected[0])
        messages = []
        if total:
            kind, rows = client.fetch(
                f"{max(1, total - snapshot_size + 1)}:{total}",
                f"(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)]<0.{header_limit}>)",
            )
            if kind != "OK":
                raise imaplib.IMAP4.error("INBOX fetch failed")
            messages = [message for item in rows if (message := inbox_message(item))][:snapshot_size]
            messages.sort(key=lambda message: message["received"], reverse=True)
        return {"messages": messages, "unread": int(unread[1]) if unread else sum(row["unread"] for row in messages)}
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


@router.post("/sync")
async def sync_imap(payload: ImapSync, request: Request):
    if not allow_attempt(request.client.host if request.client else ""):
        raise HTTPException(429, "imap_busy", headers={"Retry-After": "60"})
    try:
        await asyncio.wait_for(slots.acquire(), 1)
    except TimeoutError:
        raise HTTPException(429, "imap_busy", headers={"Retry-After": "5"}) from None
    try:
        port = 993 if payload.security == "tls" else 143
        addresses = await resolve_public(payload.host, port)
        return await asyncio.to_thread(read_inbox, payload, port, addresses)
    except AuthenticationFailed:
        raise HTTPException(401, "imap_auth_failed") from None
    except (imaplib.IMAP4.error, OSError, ValueError, TypeError):
        raise HTTPException(502, "imap_unavailable") from None
    finally:
        slots.release()
