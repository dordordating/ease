"""Exchange mail OAuth credentials without receiving or storing mailbox data."""

import asyncio
import hashlib
import hmac
import json
import logging
import re
import secrets
from base64 import urlsafe_b64encode
from dataclasses import dataclass
from time import time
from typing import Literal
from urllib.parse import urlencode, urlsplit

import httpx
import jwt
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from .settings import Settings

Provider = Literal["gmail", "outlook"]
extension_id = re.compile(r"[a-p]{32}")
verifier_pattern = r"^[A-Za-z0-9_-]{43}$"
no_referrer = {"Referrer-Policy": "no-referrer", "Cache-Control": "no-store"}


class HideMailOAuthCallback(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) >= 3:
            path = str(record.args[2]).split("?", 1)[0]
            return not (path.startswith("/v1/mail/oauth/") and path.endswith("/callback"))
        return True


@dataclass(frozen=True)
class MailProvider:
    client_id: str
    secret: SecretStr
    authorize: str
    token: str
    scopes: str
    extras: dict[str, str]


class MailRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Start(MailRequest):
    challenge: str = Field(pattern=verifier_pattern)
    extension_id: str = Field(pattern=r"^[a-p]{32}$")


class Exchange(MailRequest):
    state: str = Field(min_length=1, max_length=2048)
    code: SecretStr = Field(min_length=1, max_length=4096)
    verifier: str = Field(pattern=verifier_pattern)


class Refresh(MailRequest):
    extension_id: str = Field(pattern=r"^[a-p]{32}$")
    refresh_token: SecretStr = Field(min_length=1, max_length=8192)


def mail_oauth_router(settings: Settings) -> APIRouter:
    router = APIRouter(prefix="/v1/mail")
    ids = set(settings.mail_extension_ids.split(","))
    origin = settings.mail_oauth_origin
    if origin:
        parsed = urlsplit(origin)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("MAIL_OAUTH_ORIGIN must be an exact HTTPS origin")
    # Use a distinct key and audience from the Ease account session.
    key = hmac.digest(settings.session_secret.get_secret_value().encode(), b"ease-mail-oauth", "sha256")
    providers: dict[Provider, MailProvider] = {}
    microsoft = "https://login.microsoftonline.com/common/oauth2/v2.0/"
    if origin and settings.mail_google_client_id and settings.mail_google_client_secret:
        providers["gmail"] = MailProvider(
            settings.mail_google_client_id, settings.mail_google_client_secret,
            "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token",
            "https://www.googleapis.com/auth/gmail.metadata",
            {"access_type": "offline", "prompt": "consent select_account"},
        )
    if origin and settings.mail_microsoft_client_id and settings.mail_microsoft_client_secret:
        providers["outlook"] = MailProvider(
            settings.mail_microsoft_client_id, settings.mail_microsoft_client_secret,
            microsoft + "authorize", microsoft + "token",
            "offline_access https://graph.microsoft.com/Mail.ReadBasic https://graph.microsoft.com/User.Read",
            {"prompt": "select_account"},
        )
    if providers:
        access_log = logging.getLogger("uvicorn.access")
        if not any(isinstance(item, HideMailOAuthCallback) for item in access_log.filters):
            access_log.addFilter(HideMailOAuthCallback())
    slots = asyncio.Semaphore(3)

    def allowed(client: str) -> bool:
        return bool(extension_id.fullmatch(client) and client in ids)

    def app(provider: Provider) -> MailProvider:
        if provider not in providers:
            raise HTTPException(503, "mail_not_configured")
        return providers[provider]

    def callback(provider: Provider) -> str:
        return f"{origin}/v1/mail/oauth/{provider}/callback"

    def read_state(state: str, provider: Provider) -> dict:
        try:
            claims = jwt.decode(
                state, key, algorithms=["HS256"], audience="ease-mail-oauth", issuer="ease-api",
                options={"require": ["exp", "iat", "jti", "sub", "aud", "iss"]},
            )
            if (claims.get("provider") != provider or not allowed(claims["sub"])
                    or not re.fullmatch(verifier_pattern, claims.get("challenge", ""))):
                raise ValueError
            return claims
        except (jwt.InvalidTokenError, ValueError, TypeError):
            raise HTTPException(400, "mail_oauth_invalid") from None

    async def tokens(request: Request, provider: MailProvider, data: dict[str, str]) -> dict:
        data.update(client_id=provider.client_id, client_secret=provider.secret.get_secret_value())
        try:
            async with asyncio.timeout(12), slots, request.app.state.http.stream(
                "POST", provider.token, data=data, headers={"Accept": "application/json"}
            ) as response:
                status = response.status_code
                if status not in (200, 400):
                    raise HTTPException(502, "mail_provider_unavailable")
                body = bytearray()
                async for part in response.aiter_bytes():
                    body.extend(part)
                    if len(body) > 32_768:
                        raise ValueError
        except (TimeoutError, httpx.HTTPError, ValueError):
            raise HTTPException(502, "mail_provider_unavailable") from None
        try:
            result = json.loads(body)
            if status == 400:
                if isinstance(result, dict) and result.get("error") in ("invalid_grant", "interaction_required", "consent_required"):
                    raise HTTPException(401, "mail_reconnect")
                raise ValueError
            access = result["access_token"]
            refresh = result.get("refresh_token")
            expires = result["expires_in"]
            if (not isinstance(expires, int) or isinstance(expires, bool) or not 1 <= expires <= 86_400
                    or not isinstance(access, str) or not 1 <= len(access) <= 8192
                    or (refresh is not None and (not isinstance(refresh, str) or not 1 <= len(refresh) <= 8192))):
                raise ValueError
            return {"access_token": access, "refresh_token": refresh, "expires_in": expires}
        except (ValueError, TypeError, KeyError, RecursionError):
            raise HTTPException(502, "mail_provider_unavailable") from None

    @router.get("/config")
    async def config(extension: str = Query(max_length=32)):
        return {provider: allowed(extension) and provider in providers for provider in ("gmail", "outlook")}

    @router.post("/oauth/{provider}/start")
    async def start(provider: Provider, payload: Start):
        client = app(provider)
        if not allowed(payload.extension_id):
            raise HTTPException(403, "mail_not_configured")
        now = int(time())
        state = jwt.encode({
            "iss": "ease-api", "aud": "ease-mail-oauth", "sub": payload.extension_id, "jti": secrets.token_urlsafe(24),
            "provider": provider, "challenge": payload.challenge, "iat": now, "exp": now + 600,
        }, key, algorithm="HS256")
        params = dict(
            client_id=client.client_id, redirect_uri=callback(provider), response_type="code",
            scope=client.scopes, state=state, code_challenge=payload.challenge, code_challenge_method="S256",
            **client.extras,
        )
        return {"url": client.authorize + "?" + urlencode(params), "state": state}

    @router.get("/oauth/{provider}/callback")
    async def finish(
        provider: Provider, state: str = Query(max_length=2048),
        code: str | None = Query(default=None, max_length=4096), error: str | None = Query(default=None, max_length=100),
    ):
        app(provider)
        claims = read_state(state, provider)
        values = {"state": state, **({"code": code} if code and not error else {"error": "denied"})}
        return RedirectResponse(f"https://{claims['sub']}.chromiumapp.org/mail-oauth?" + urlencode(values), 303, no_referrer)

    @router.post("/oauth/{provider}/exchange")
    async def exchange(provider: Provider, payload: Exchange, request: Request):
        client = app(provider)
        claims = read_state(payload.state, provider)
        digest = urlsafe_b64encode(hashlib.sha256(payload.verifier.encode()).digest()).rstrip(b"=").decode()
        if not hmac.compare_digest(digest, claims["challenge"]):
            raise HTTPException(400, "mail_oauth_invalid")
        result = await tokens(request, client, {
            "grant_type": "authorization_code", "code": payload.code.get_secret_value(),
            "redirect_uri": callback(provider), "code_verifier": payload.verifier,
        })
        if not result["refresh_token"]:
            raise HTTPException(401, "mail_reconnect")
        return result

    @router.post("/oauth/{provider}/refresh")
    async def refresh(provider: Provider, payload: Refresh, request: Request):
        client = app(provider)
        if not allowed(payload.extension_id):
            raise HTTPException(403, "mail_not_configured")
        return await tokens(request, client, {
            "grant_type": "refresh_token", "refresh_token": payload.refresh_token.get_secret_value()
        })

    return router
