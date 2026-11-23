"""Bounded MIME metadata and attachment validation for the mail transports."""

import base64
import binascii
import quopri
import re
from email.header import decode_header
from email.utils import collapse_rfc2231_value, decode_params

from pydantic import BaseModel, ConfigDict, Field, field_validator

download_limit = 5 * 1024 * 1024
upload_limit = 2 * 1024 * 1024
message_id_pattern = re.compile(r"<[!-;=?A-~]{1,160}@[!-;=?A-~]{1,160}>")
token_pattern = re.compile(rb'\s*("(?:[^"\\]|\\.)*"|[()]|[^\s()]+)')
control = re.compile(r"[\x00-\x1f\x7f/\\]")


def filename(value: object) -> str:
    value = control.sub("_", str(value or "")).strip().strip(".")[:180]
    return value or "attachment"


def decoded_name(value: str) -> str:
    try:
        return "".join(item.decode(charset or "utf-8", errors="replace") if isinstance(item, bytes) else item
                       for item, charset in decode_header(value))
    except (LookupError, UnicodeError, ValueError):
        return value


def parameter(values: object, key: str) -> str | None:
    if not isinstance(values, list):
        return None
    pairs = [(str(values[i]), str(values[i + 1])) for i in range(0, len(values) - 1, 2)]
    try:
        # decode_params expects a leading content type entry.
        for label, value in decode_params([("", ""), *pairs])[1:]:
            if label.lower() == key:
                return decoded_name(collapse_rfc2231_value(value, errors="replace").strip('"'))
    except (LookupError, UnicodeError, ValueError):
        return None


def structure(rows) -> list:
    chunks = []
    for row in rows or ():
        if isinstance(row, tuple):
            first, literal = row
            quoted = b'"' + literal.replace(b"\\", b"\\\\").replace(b'"', b'\\"') + b'"'
            chunks.append(re.sub(rb"\{\d+\}$", lambda _: quoted, first))
        elif isinstance(row, bytes):
            chunks.append(row)
    data = b" ".join(chunks)
    origin = data.upper().find(b"BODYSTRUCTURE ")
    if origin < 0:
        return []
    stack = []
    for step, match in enumerate(token_pattern.finditer(data, origin + 14)):
        token = match[1]
        if step > 6000:
            return []
        if token == b"(":
            if len(stack) > 28:
                return []
            stack.append([])
        elif token == b")":
            if not stack:
                return []
            item = stack.pop()
            if not stack:
                return item
            stack[-1].append(item)
        elif stack:
            if token.startswith(b'"'):
                token = re.sub(rb"\\(.)", rb"\1", token[1:-1])
            stack[-1].append(token.decode("utf-8", errors="replace"))
    return []


def attachment_parts(tree: list) -> list[dict]:
    parts = []

    def walk(node: list, prefix: str):
        if len(parts) >= 40 or not node:
            return
        if isinstance(node[0], list):
            children = 0
            for item in node:
                if not isinstance(item, list):
                    break
                children += 1
                walk(item, f"{prefix}.{children}" if prefix else str(children))
            return
        if len(node) < 7:
            return
        group, subtype = str(node[0]).lower(), str(node[1]).lower()
        extension = 9 if group == "text" else 11 if (group, subtype) == ("message", "rfc822") else 8
        disposition = node[extension] if len(node) > extension else None
        name = parameter(disposition[1], "filename") if isinstance(disposition, list) and len(disposition) > 1 else None
        name = name or parameter(node[2], "name")
        if not name and not (isinstance(disposition, list) and disposition and str(disposition[0]).lower() == "attachment"):
            return
        encoding = str(node[5]).lower()
        wire = int(node[6]) if isinstance(node[6], str) and re.fullmatch(r"\d{1,10}", node[6]) else None
        parts.append({"id": prefix or "1", "name": filename(name), "size": wire * 3 // 4 if wire is not None and encoding == "base64" else wire,
                      "encoding": encoding})

    walk(tree, "")
    return parts


class AttachedFile(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    name: str = Field(min_length=1, max_length=180)
    data: str = Field(max_length=(upload_limit + 2) // 3 * 4)

    @field_validator("name")
    @classmethod
    def safe_name(cls, value):
        return filename(value)

    @field_validator("data")
    @classmethod
    def valid_encoding(cls, value):
        try:
            if len(base64.b64decode(value, validate=True)) > upload_limit:
                raise ValueError("Attachment too large")
            return value
        except binascii.Error:
            raise ValueError("Invalid attachment encoding") from None


def decode_part(payload: bytes, encoding: str) -> bytes:
    if encoding == "base64":
        return base64.b64decode(re.sub(rb"\s+", b"", payload), validate=True)
    if encoding == "quoted-printable":
        return quopri.decodestring(payload)
    return payload
