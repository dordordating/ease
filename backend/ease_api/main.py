import asyncio
import re
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import UTC, datetime, time, timedelta
from typing import Annotated, Literal

import httpx
import jwt
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import GoogleAuthUnavailable, InvalidGoogleCredential, issue_session, validate_session, verify_google_access_token
from .db import Database, QuotaExceeded, User
from .openrouter import OpenRouterRejected, OpenRouterUnavailable, translate_with_openrouter
from .settings import Settings

Tier = Literal["economy", "standard", "premium"]
language_code = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}")
bearer = HTTPBearer(auto_error=False)


class GoogleLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    access_token: SecretStr = Field(min_length=1, max_length=8192)


class TranslationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=12000)
    source: str = Field(default="auto", max_length=30)
    target: str = Field(min_length=2, max_length=30)
    tier: Tier = "standard"


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
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(25, connect=5),
                limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
                follow_redirects=False,
            ) as client:
                app.state.http = client
                yield
        finally:
            await database.close()

    app = FastAPI(title="Ease API", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(RequestBodyLimit, limit=max(24_576, settings.max_translation_characters * 12 + 2048))
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.origins, allow_methods=["GET", "POST"],
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
            )
        except QuotaExceeded as error:
            raise HTTPException(429, f"{error.scope}_daily_limit", headers={"Retry-After": retry_after_midnight()}) from None
        except OpenRouterUnavailable:
            raise HTTPException(503, "translation_unavailable") from None
        except OpenRouterRejected:
            raise HTTPException(502, "translation_invalid_response") from None
        finally:
            slots.release()

        return {"text": result.text, "tier": payload.tier, "model": model}

    return app
