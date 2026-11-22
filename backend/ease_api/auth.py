"""Verify Google access tokens and issue short-lived Ease sessions.

Google's OAuth library introspects opaque access tokens with a Bearer POST to
https://oauth2.googleapis.com/tokeninfo, keeping tokens out of request URLs:
https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/oauth2client.ts

The OpenID configuration advertises https://openidconnect.googleapis.com/v1/userinfo:
https://accounts.google.com/.well-known/openid-configuration
"""

import asyncio
import re
import time
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

import httpx
import jwt

_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo"
_USER_INFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
_GOOGLE_TIMEOUT = httpx.Timeout(8.0, connect=4.0)
_BEARER_TOKEN = re.compile(r"[A-Za-z0-9._~+/-]+=*")
_SUBJECT = re.compile(r"[!-~]{1,255}")
_SESSION_ISSUER = "ease-api"
_SESSION_AUDIENCE = "ease-extension"


@dataclass(frozen=True, slots=True)
class GoogleIdentity:
    subject: str
    email: str
    name: str


class InvalidGoogleCredential(ValueError):
    def __init__(self) -> None:
        super().__init__("Invalid Google credential")


class GoogleAuthUnavailable(RuntimeError):
    def __init__(self) -> None:
        super().__init__("Google authentication is temporarily unavailable")


async def _google_json(
    http_client: httpx.AsyncClient, method: str, url: str, token: str
) -> dict:
    headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    if method == "POST":
        headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8"
    try:
        response = await http_client.request(
            method, url, headers=headers, timeout=_GOOGLE_TIMEOUT, follow_redirects=False
        )
    except httpx.RequestError:
        raise GoogleAuthUnavailable() from None
    if response.status_code in (400, 401, 403):
        raise InvalidGoogleCredential()
    if response.status_code != 200:
        raise GoogleAuthUnavailable()

    try:
        data = response.json()
    except ValueError:
        raise GoogleAuthUnavailable() from None
    if not isinstance(data, dict):
        raise GoogleAuthUnavailable()
    return data


def _positive_int(value: object) -> int:
    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,16}", value):
        value = int(value)
    if type(value) is not int or not 0 < value <= 9_999_999_999_999_999:
        raise InvalidGoogleCredential()
    return value


def _verify_token_info(
    info: dict, allowed_client_ids: Collection[str]
) -> tuple[str, float]:
    audience = info.get("aud")
    if not isinstance(audience, str) or not audience or audience not in allowed_client_ids:
        raise InvalidGoogleCredential()
    if "azp" in info and info["azp"] != audience:
        raise InvalidGoogleCredential()

    subject = info.get("sub")
    if not isinstance(subject, str) or not _SUBJECT.fullmatch(subject):
        raise InvalidGoogleCredential()

    now = time.time()
    expiration = []
    if "exp" in info:
        expiration.append(_positive_int(info["exp"]))
    if "expires_in" in info:
        expiration.append(now + _positive_int(info["expires_in"]))
    if not expiration or min(expiration) <= now:
        raise InvalidGoogleCredential()
    return subject, min(expiration)


def _contains_control(value: str) -> bool:
    return any(
        ord(char) < 32 or 127 <= ord(char) <= 159 or 0xD800 <= ord(char) <= 0xDFFF
        for char in value
    )


def _verify_user_info(info: dict, subject: str) -> GoogleIdentity:
    if info.get("sub") != subject or info.get("email_verified") is not True:
        raise InvalidGoogleCredential()

    email = info.get("email")
    if not isinstance(email, str) or len(email) > 254 or _contains_control(email):
        raise InvalidGoogleCredential()
    local_part, separator, domain = email.partition("@")
    if not separator or not local_part or not domain or "@" in domain or any(char.isspace() for char in email):
        raise InvalidGoogleCredential()

    name = info.get("name")
    if name is None:
        return GoogleIdentity(subject, email, email)
    if not isinstance(name, str) or len(name) > 255 or _contains_control(name):
        raise InvalidGoogleCredential()
    return GoogleIdentity(subject, email, name.strip() or email)


async def verify_google_access_token(
    http_client: httpx.AsyncClient, token: str, allowed_client_ids: Collection[str]
) -> GoogleIdentity:
    if (
        not allowed_client_ids
        or isinstance(allowed_client_ids, (str, bytes))
        or not isinstance(token, str)
        or len(token) > 16_384
        or not _BEARER_TOKEN.fullmatch(token)
    ):
        raise InvalidGoogleCredential()

    profile = asyncio.create_task(_google_json(http_client, "GET", _USER_INFO_URL, token))
    try:
        info = await _google_json(http_client, "POST", _TOKEN_INFO_URL, token)
        subject, expires_at = _verify_token_info(info, allowed_client_ids)
        identity = await profile
    finally:
        if not profile.done():
            profile.cancel()
        await asyncio.gather(profile, return_exceptions=True)
    if expires_at <= time.time():
        raise InvalidGoogleCredential()
    return _verify_user_info(identity, subject)


def issue_session(user_id: UUID, secret: str | bytes, ttl_minutes: int) -> str:
    if ttl_minutes <= 0:
        raise ValueError("Session lifetime must be positive")
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "iss": _SESSION_ISSUER,
            "aud": _SESSION_AUDIENCE,
            "sub": str(user_id),
            "iat": now,
            "exp": now + timedelta(minutes=ttl_minutes),
        },
        secret,
        algorithm="HS256",
    )


def validate_session(token: str, secret: str | bytes) -> UUID:
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            issuer=_SESSION_ISSUER,
            audience=_SESSION_AUDIENCE,
            options={"require": ["iss", "aud", "sub", "iat", "exp"], "strict_aud": True},
        )
        subject = claims["sub"]
        user_id = UUID(subject)
        if (
            str(user_id) != subject
            or type(claims["exp"]) is not int
            or type(claims["iat"]) is not int
            or claims["exp"] <= claims["iat"]
        ):
            raise ValueError("Invalid Ease session claims")
        return user_id
    except (jwt.InvalidTokenError, AttributeError, KeyError, TypeError, ValueError):
        raise jwt.InvalidTokenError("Invalid Ease session") from None
