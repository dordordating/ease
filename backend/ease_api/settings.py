import re
from urllib.parse import urlsplit

from psycopg.conninfo import make_conninfo
from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

GOOGLE_CLIENT_ID = re.compile(r"[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com")
OPENROUTER_MODEL = re.compile(r"[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._:+-]*", re.IGNORECASE)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", hide_input_in_errors=True, env_ignore_empty=True)

    database_url: SecretStr | None = None
    pghost: str = "db"
    pgport: int = Field(default=5432, ge=1, le=65535)
    pguser: str = "ease"
    pgpassword: SecretStr | None = None
    pgdatabase: str = "ease"

    google_client_ids: str
    session_secret: SecretStr = Field(min_length=32)
    openrouter_api_key: SecretStr = Field(min_length=1)
    cors_origins: str = ""

    openrouter_model_economy: str = "google/gemma-4-31b-it"
    openrouter_model_standard: str = "google/gemini-2.5-flash-lite"
    openrouter_model_premium: str = "openai/gpt-5.6-luna"
    user_daily_limit: int = Field(default=30, ge=1)
    global_daily_limit: int = Field(default=200, ge=1)
    session_ttl_minutes: int = Field(default=30, ge=5, le=120)
    max_translation_characters: int = Field(default=4000, ge=100, le=12000)
    max_output_tokens: int = Field(default=3000, ge=128, le=12000)
    max_concurrent_translations: int = Field(default=2, ge=1, le=16)

    @field_validator("google_client_ids")
    @classmethod
    def validate_client_ids(cls, value: str) -> str:
        ids = [item.strip() for item in value.split(",")]
        if not ids or any(not GOOGLE_CLIENT_ID.fullmatch(item) for item in ids):
            raise ValueError("GOOGLE_CLIENT_IDS must list valid Google OAuth client IDs")
        return ",".join(dict.fromkeys(ids))

    @field_validator("cors_origins")
    @classmethod
    def validate_origins(cls, value: str) -> str:
        origins = [item.strip().rstrip("/") for item in value.split(",") if item.strip()]
        for origin in origins:
            parsed = urlsplit(origin)
            if not parsed.hostname or "*" in origin or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                raise ValueError("CORS_ORIGINS must list exact origins")
            if parsed.scheme == "chrome-extension":
                if not re.fullmatch(r"[a-p]{32}", parsed.netloc):
                    raise ValueError("Use the Chrome extension ID in its origin")
            elif parsed.scheme != "https":
                raise ValueError("CORS origins must use HTTPS or chrome-extension")
        return ",".join(dict.fromkeys(origins))

    @field_validator("openrouter_model_economy", "openrouter_model_standard", "openrouter_model_premium")
    @classmethod
    def validate_model(cls, value: str) -> str:
        if not OPENROUTER_MODEL.fullmatch(value):
            raise ValueError("Use an explicit OpenRouter provider/model ID")
        return value

    @model_validator(mode="after")
    def validate_database(self):
        if not self.database_url and not (self.pgpassword and self.pgpassword.get_secret_value()):
            raise ValueError("Set PGPASSWORD or DATABASE_URL")
        return self

    def database_connection_string(self) -> str:
        if self.database_url:
            return self.database_url.get_secret_value()
        return make_conninfo(
            host=self.pghost,
            port=self.pgport,
            user=self.pguser,
            password=self.pgpassword.get_secret_value(),
            dbname=self.pgdatabase,
            connect_timeout=5,
        )

    @property
    def oauth_client_ids(self) -> tuple[str, ...]:
        return tuple(self.google_client_ids.split(","))

    @property
    def origins(self) -> list[str]:
        return self.cors_origins.split(",") if self.cors_origins else []

    @property
    def models(self) -> dict[str, str]:
        return {
            "economy": self.openrouter_model_economy,
            "standard": self.openrouter_model_standard,
            "premium": self.openrouter_model_premium,
        }
