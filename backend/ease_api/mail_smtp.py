"""Submit a single plain-text message using the user's verified SMTP server."""

import imaplib
import base64
import re
import smtplib
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formatdate, make_msgid

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field, field_validator

from .mail_imap import AuthenticationFailed, ImapSync, PinnedMailIO, append_sent, run_mail_io
from .mail_mime import AttachedFile, message_id_pattern, upload_limit

router = APIRouter(prefix="/v1/mail/smtp")
address_pattern = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", re.ASCII)


def address(value: str) -> str:
    if len(value) > 254 or not address_pattern.fullmatch(value):
        raise ValueError("Invalid email address")
    return value


class SubmitMessage(ImapSync):
    sender: str = Field(max_length=254)
    to: list[str] = Field(min_length=1, max_length=10)
    cc: list[str] = Field(default_factory=list, max_length=10)
    subject: str = Field(max_length=180)
    body: str = Field(min_length=1, max_length=5000)
    copy_to: ImapSync | None = None
    attachments: list[AttachedFile] = Field(default_factory=list, max_length=5)
    reply_to_id: str | None = Field(default=None, max_length=324)
    references: list[str] = Field(default_factory=list, max_length=13)

    @field_validator("sender")
    @classmethod
    def sender_address(cls, value: str) -> str:
        return address(value)

    @field_validator("to", "cc")
    @classmethod
    def recipients(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(address(item) for item in values))

    @field_validator("attachments")
    @classmethod
    def total_size(cls, items):
        if sum(len(base64.b64decode(item.data)) for item in items) > upload_limit:
            raise ValueError("Attachments too large")
        return items

    @field_validator("reply_to_id")
    @classmethod
    def reference_id(cls, item):
        if item is not None and not message_id_pattern.fullmatch(item):
            raise ValueError("Invalid message ID")
        return item

    @field_validator("references")
    @classmethod
    def reference_ids(cls, values):
        return [cls.reference_id(item) for item in values]

    @field_validator("subject")
    @classmethod
    def subject_header(cls, value: str) -> str:
        if re.search(r"[\x00-\x1f\x7f]", value):
            raise ValueError("Invalid subject")
        return value

    @field_validator("body")
    @classmethod
    def text_body(cls, value: str) -> str:
        if not value.strip() or len(value.encode()) > 16_000 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
            raise ValueError("Invalid email body")
        return value


class PinnedSMTP(smtplib.SMTP):
    def __init__(self, config: SubmitMessage, port: int, addresses: list[tuple]):
        self.transport = PinnedMailIO(addresses, config.security == "tls")
        super().__init__(local_hostname="localhost", timeout=4)
        self._host = config.host
        try:
            code, _ = self.connect(config.host, port)
            if code != 220 or self.ehlo()[0] != 250:
                raise smtplib.SMTPException("SMTP service unavailable")
            if not self.transport.secure:
                if not self.has_extn("starttls") or self.docmd("STARTTLS")[0] != 220:
                    raise smtplib.SMTPException("SMTP requires TLS")
                self.transport.upgrade_tls()
                self.sock = self.transport.sock
                self.esmtp_features = {}
                if self.ehlo()[0] != 250:
                    raise smtplib.SMTPException("SMTP TLS greeting failed")
        except (OSError, smtplib.SMTPException, imaplib.IMAP4.error):
            self.close()
            raise

    def _get_socket(self, host, port, timeout):
        self.transport.open(host, port, timeout)
        return self.transport.sock

    def send(self, value):
        if isinstance(value, str):
            value = value.encode(self.command_encoding)
        self.transport.send(value)

    def getreply(self):
        responses = []
        previous_code = None
        while True:
            data = self.transport.readline()
            if len(data) < 5 or not data[:3].isdigit() or data[3:4] not in (b"-", b" ", b"\r"):
                raise smtplib.SMTPException("Malformed SMTP reply")
            code = int(data[:3])
            if previous_code is not None and code != previous_code:
                raise smtplib.SMTPException("Malformed SMTP reply")
            previous_code = code
            responses.append(data[4:].strip())
            if data[3:4] != b"-":
                return code, b"\n".join(responses)


def submit(config: SubmitMessage, port: int, addresses: list[tuple]) -> tuple[bytes, str]:
    client = PinnedSMTP(config, port, addresses)
    try:
        try:
            client.login(config.username, config.password.get_secret_value(), initial_response_ok=False)
        except (smtplib.SMTPAuthenticationError, smtplib.SMTPNotSupportedError, UnicodeError):
            raise AuthenticationFailed from None
        message = EmailMessage(policy=SMTP)
        message["From"], message["To"], message["Subject"] = config.sender, ", ".join(config.to), config.subject
        if config.cc:
            message["Cc"] = ", ".join(config.cc)
        if config.reply_to_id:
            message["In-Reply-To"] = config.reply_to_id
            message["References"] = " ".join(dict.fromkeys([*config.references, config.reply_to_id]))
        message["Date"], message["Message-ID"] = formatdate(localtime=False), make_msgid(domain=config.sender.split("@")[-1])
        message.set_content(config.body, cte="base64")
        for item in config.attachments:
            message.add_attachment(base64.b64decode(item.data), maintype="application", subtype="octet-stream", filename=item.name)
        recipients = dict.fromkeys([*config.to, *config.cc])
        if client.mail(config.sender)[0] != 250 or any(client.rcpt(recipient)[0] not in (250, 251, 252) for recipient in recipients):
            raise HTTPException(422, "smtp_recipient_rejected")
        raw = message.as_bytes()
        try:
            if client.data(raw)[0] != 250:
                raise HTTPException(422, "smtp_message_rejected")
        except smtplib.SMTPDataError:
            raise HTTPException(422, "smtp_message_rejected") from None
        except (OSError, smtplib.SMTPException, imaplib.IMAP4.error):
            raise HTTPException(504, "smtp_delivery_unknown") from None
        return raw, str(message["Message-ID"])
    finally:
        client.close()


@router.post("/send")
async def send(payload: SubmitMessage, request: Request):
    port = 465 if payload.security == "tls" else 587

    def deliver(addresses: list[tuple]) -> tuple[bytes, str]:
        try:
            return submit(payload, port, addresses)
        except smtplib.SMTPException:
            raise HTTPException(502, "smtp_unavailable") from None
    raw, message_id = await run_mail_io(request, payload.host, port, deliver)
    saved = None
    if payload.copy_to:
        mailbox = payload.copy_to
        imap_port = 993 if mailbox.security == "tls" else 143
        try:
            saved = await run_mail_io(request, mailbox.host, imap_port,
                                     lambda addresses: append_sent(mailbox, raw, message_id, imap_port, addresses))
        except HTTPException:
            saved = False
    return {"sent": True, "savedCopy": saved}
