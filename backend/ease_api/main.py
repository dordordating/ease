import asyncio
import re
from base64 import b64decode, urlsafe_b64encode
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import UTC, datetime, time, timedelta
from typing import Annotated, Literal

import httpx
import jwt
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError
from starlette.requests import ClientDisconnect
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import GoogleAuthUnavailable, InvalidGoogleCredential, issue_session, validate_session, verify_google_access_token
from .db import MAX_WORKSPACE_SYNC_REVISION, Database, QuotaExceeded, User
from .mail_imap import router as mail_imap_router
from .mail_oauth import mail_oauth_router
from .market_pairs import MARKET_SYMBOLS, parse_pair
from .markets import MarketsService
from .openrouter import OpenRouterRejected, OpenRouterUnavailable, translate_with_openrouter
from .settings import Settings

Tier = Literal["economy", "standard", "premium"]
language_code = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}")
bearer = HTTPBearer(auto_error=False)
max_workspace_ciphertext = 10 * 1024 * 1024 + 16
max_workspace_base64 = (max_workspace_ciphertext * 4 + 2) // 3
max_workspace_body = max_workspace_base64 + 1024
base64url_invalid = re.compile(r"[^A-Za-z0-9_-]")
base64url_alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


class GoogleLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    access_token: SecretStr = Field(min_length=1, max_length=8192)


class TranslationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=12000)
    source: str = Field(default="auto", max_length=30)
    target: str = Field(min_length=2, max_length=30)
    tier: Tier = "standard"
    notes_language: str | None = Field(default=None, min_length=2, max_length=30)


class WorkspaceEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: int = Field(alias="schema", ge=1, le=1)
    salt: str = Field(min_length=22, max_length=22)
    iv: str = Field(min_length=16, max_length=16)
    ciphertext: str = Field(min_length=22, max_length=max_workspace_base64)


class WorkspaceWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    revision: int = Field(ge=0, le=MAX_WORKSPACE_SYNC_REVISION)
    envelope: WorkspaceEnvelope


def encode_base64url(value: bytes) -> str:
    return urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode_base64url(value: str, minimum: int, maximum: int) -> bytes:
    size = len(value) * 3 // 4
    padding = -len(value) % 4
    if not minimum <= size <= maximum or padding == 3 or base64url_invalid.search(value):
        raise ValueError("Invalid envelope encoding")
    # Reject encodings with nonzero trailing pad bits, even if they decode to the same bytes.
    if padding and base64url_alphabet.index(value[-1]) & ((1 << (2 * padding)) - 1):
        raise ValueError("Invalid envelope encoding")
    return b64decode(value + "=" * padding, altchars=b"-_", validate=True)


async def read_workspace_write(request: Request) -> WorkspaceWrite:
    declared_length = request.headers.get("content-length")
    if declared_length is not None:
        try:
            declared_length = int(declared_length)
        except ValueError:
            raise HTTPException(422, "invalid_request") from None
        if declared_length > max_workspace_body:
            raise HTTPException(413, "request_too_large")

    data = bytearray()
    try:
        async with asyncio.timeout(90):
            async for chunk in request.stream():
                if len(data) + len(chunk) > max_workspace_body:
                    raise HTTPException(413, "request_too_large")
                data.extend(chunk)
    except TimeoutError:
        raise HTTPException(408, "workspace_sync_timeout") from None
    except ClientDisconnect:
        raise HTTPException(400, "request_incomplete") from None
    return WorkspaceWrite.model_validate_json(data)


@asynccontextmanager
async def workspace_sync_slot(request: Request):
    slots = request.app.state.workspace_sync_slots
    try:
        await asyncio.wait_for(slots.acquire(), timeout=1.0)
    except TimeoutError:
        raise HTTPException(503, "workspace_sync_busy", headers={"Retry-After": "2"}) from None
    try:
        yield
    finally:
        slots.release()


class RequestBodyLimit:
    def __init__(self, app: ASGIApp, limit: int):
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http" or scope["method"] != "POST":
            await self.app(scope, receive, send)
            return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > self.limit:
                response = JSONResponse({"detail": "request_too_large"}, status_code=413)
                await response(scope, receive, send)
                return
            body.extend(chunk)
            if not message.get("more_body", False):
                break

        sent = False

        async def replay() -> Message:
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)


async def require_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> User:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(401, "session_required", headers={"WWW-Authenticate": "Bearer"})
    try:
        user_id = validate_session(credentials.credentials, request.app.state.session_secret)
    except jwt.InvalidTokenError:
        raise HTTPException(401, "session_invalid", headers={"WWW-Authenticate": "Bearer"}) from None
    user = await request.app.state.database.get_user(user_id)
    if not user:
        raise HTTPException(401, "session_invalid", headers={"WWW-Authenticate": "Bearer"})
    return user


def retry_after_midnight() -> str:
    now = datetime.now(UTC)
    next_day = datetime.combine(now.date() + timedelta(days=1), time.min, UTC)
    return str(max(1, int((next_day - now).total_seconds())))


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    session_secret = settings.session_secret.get_secret_value()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database = Database(settings.database_connection_string())
        try:
            await database.open()
            app.state.database = database
            app.state.session_secret = session_secret
            app.state.translation_slots = asyncio.Semaphore(settings.max_concurrent_translations)
            app.state.workspace_sync_slots = asyncio.Semaphore(2)
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(25, connect=5),
                limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
                follow_redirects=False,
            ) as client:
                app.state.http = client
                demo_key = settings.coingecko_demo_api_key
                app.state.markets = MarketsService(client, demo_key.get_secret_value() if demo_key else None)
                yield
        finally:
            await database.close()

    app = FastAPI(title="Ease API", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(mail_oauth_router(settings))
    app.include_router(mail_imap_router)
    app.add_middleware(RequestBodyLimit, limit=max(24_576, settings.max_translation_characters * 12 + 2048))
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.origins, allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Authorization", "Content-Type"], expose_headers=["Retry-After"], allow_credentials=False,
    )

    @app.middleware("http")
    async def disable_response_cache(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, _error: RequestValidationError):
        # Validation errors can include the original token or text.
        return JSONResponse({"detail": "invalid_request"}, status_code=422)

    @app.get("/healthz")
    async def health(request: Request):
        if not await request.app.state.database.check():
            raise HTTPException(503, "database_unavailable")
        return {"status": "ok"}

    @app.get("/v1/markets/quotes")
    async def market_quotes(request: Request, symbols: str | None = None):
        if symbols is None:
            selection = MARKET_SYMBOLS
        else:
            if len(symbols) > 13_000:
                raise HTTPException(422, "invalid_market_symbols")
            selection = tuple(dict.fromkeys(symbols.split(",")))
            if len(selection) > 50 or any(not parse_pair(symbol) for symbol in selection):
                raise HTTPException(422, "invalid_market_symbols")
        return {"quotes": await request.app.state.markets.quotes(selection)}

    @app.get("/v1/markets/catalogue")
    async def market_catalogue(request: Request, q: str = "", kind: Literal["all", "fx", "crypto", "wallex"] = "all"):
        if len(q) > 100:
            raise HTTPException(422, "invalid_market_query")
        return {"instruments": await request.app.state.markets.catalogue(q, kind)}

    @app.get("/v1/markets/history")
    async def market_history(request: Request, symbol: str):
        if len(symbol) > 245 or not parse_pair(symbol):
            raise HTTPException(422, "invalid_market_symbol")
        return await request.app.state.markets.history(symbol)

    @app.get("/v1/markets/icon")
    async def market_icon(request: Request, symbol: str):
        if len(symbol) > 245 or (pair := parse_pair(symbol)) is None:
            raise HTTPException(422, "invalid_market_symbol")
        icon = await request.app.state.markets.icon(pair)
        if icon is None:
            raise HTTPException(404, "market_icon_unavailable")
        mime, body = icon
        return Response(body, media_type=mime, headers={"X-Content-Type-Options": "nosniff"})

    @app.post("/v1/auth/google")
    async def google_login(payload: GoogleLogin, request: Request):
        try:
            identity = await verify_google_access_token(
                request.app.state.http, payload.access_token.get_secret_value(), settings.oauth_client_ids
            )
        except InvalidGoogleCredential:
            raise HTTPException(401, "google_credentials_invalid") from None
        except GoogleAuthUnavailable:
            raise HTTPException(503, "google_unavailable") from None
        user = await request.app.state.database.upsert_user(identity.subject, identity.email, identity.name)
        token = issue_session(user.id, session_secret, settings.session_ttl_minutes)
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_in": settings.session_ttl_minutes * 60,
            "user": asdict(user),
        }

    @app.get("/v1/me")
    async def me(user: Annotated[User, Depends(require_user)]):
        return asdict(user)

    @app.get("/v1/translation-tiers")
    async def translation_tiers(_user: Annotated[User, Depends(require_user)]):
        return {"tiers": [{"id": tier, "model": model} for tier, model in settings.models.items()]}

    @app.get("/v1/workspace-sync")
    async def get_workspace_sync(request: Request, user: Annotated[User, Depends(require_user)]):
        async with workspace_sync_slot(request):
            snapshot = await request.app.state.database.get_workspace_sync(user.id)
            if snapshot is None:
                return JSONResponse({"revision": 0, "envelope": None})
            return JSONResponse({
                "revision": snapshot.revision,
                "envelope": {
                    "schema": 1,
                    "salt": encode_base64url(snapshot.salt),
                    "iv": encode_base64url(snapshot.iv),
                    "ciphertext": encode_base64url(snapshot.ciphertext),
                },
            })

    @app.put("/v1/workspace-sync")
    async def put_workspace_sync(request: Request, user: Annotated[User, Depends(require_user)]):
        # Keep the large body out of FastAPI's argument parsing so authentication
        # and the concurrency limit run before the request is read.
        async with workspace_sync_slot(request):
            try:
                payload = await read_workspace_write(request)
                envelope = payload.envelope
                salt = decode_base64url(envelope.salt, 16, 16)
                iv = decode_base64url(envelope.iv, 12, 12)
                ciphertext = decode_base64url(envelope.ciphertext, 16, max_workspace_ciphertext)
            except (ValidationError, ValueError):
                raise HTTPException(422, "invalid_request") from None
            revision = await request.app.state.database.put_workspace_sync(
                user.id, payload.revision, salt, iv, ciphertext
            )
            if revision is None:
                raise HTTPException(409, "workspace_sync_conflict")
            return JSONResponse({"revision": revision, "envelope": envelope.model_dump(by_alias=True)})

    @app.post("/v1/translate")
    async def translate(payload: TranslationRequest, request: Request, user: Annotated[User, Depends(require_user)]):
        if not payload.text.strip() or len(payload.text) > settings.max_translation_characters:
            raise HTTPException(422, "invalid_translation_text")
        if (
            (payload.source != "auto" and not language_code.fullmatch(payload.source))
            or payload.target.lower() == "auto"
            or not language_code.fullmatch(payload.target)
            or payload.source.lower() == payload.target.lower()
        ):
            raise HTTPException(422, "invalid_language_pair")
        if payload.notes_language is not None and (
            not language_code.fullmatch(payload.notes_language)
            or payload.notes_language.lower().split("-")[0] in {"auto", "und", "mul", "zxx"}
        ):
            raise HTTPException(422, "invalid_learning_language")

        slots = request.app.state.translation_slots
        try:
            await asyncio.wait_for(slots.acquire(), timeout=1.0)
        except TimeoutError:
            raise HTTPException(503, "translation_busy", headers={"Retry-After": "2"}) from None

        model = settings.models[payload.tier]
        try:
            await request.app.state.database.reserve_translation(
                user.id, payload.tier, settings.user_daily_limit, settings.global_daily_limit
            )
            result = await translate_with_openrouter(
                request.app.state.http, settings.openrouter_api_key.get_secret_value(),
                model, payload.source, payload.target, payload.text, settings.max_output_tokens,
                notes_language=payload.notes_language,
            )
        except QuotaExceeded as error:
            raise HTTPException(429, f"{error.scope}_daily_limit", headers={"Retry-After": retry_after_midnight()}) from None
        except OpenRouterUnavailable:
            raise HTTPException(503, "translation_unavailable") from None
        except OpenRouterRejected:
            raise HTTPException(502, "translation_invalid_response") from None
        finally:
            slots.release()

        response: dict[str, object] = {"text": result.text, "tier": payload.tier, "model": model}
        if result.learning is not None:
            response["learning"] = result.learning
        return response

    return app
