"""PostgreSQL persistence for Google users and translation quotas."""

from asyncio import Lock, timeout
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

from psycopg import Error
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

_MIGRATIONS = Path(__file__).with_name("migrations")
_MIGRATION_LOCK = int.from_bytes(b"ease_api", "big")


@dataclass(frozen=True, slots=True)
class User:
    id: UUID
    email: str
    name: str | None
    created_at: datetime
    last_seen_at: datetime


class QuotaExceeded(Exception):
    def __init__(self, scope: Literal["global", "user"]) -> None:
        self.scope = scope
        super().__init__(f"{scope} translation limit exceeded")


class Database:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        self._lifecycle = Lock()
        self._pool: AsyncConnectionPool | None = None

    async def open(self) -> None:
        async with self._lifecycle:
            if self._pool is not None:
                return
            pool = AsyncConnectionPool(
                self._database_url, min_size=1, max_size=10, open=False,
                kwargs={"row_factory": dict_row}, timeout=10, name="ease-api",
            )
            try:
                await pool.open(wait=True)
                await self._migrate(pool)
            except BaseException:
                await pool.close()
                raise
            self._pool = pool

    async def close(self) -> None:
        async with self._lifecycle:
            pool, self._pool = self._pool, None
            if pool is not None:
                await pool.close()

    async def check(self) -> bool:
        pool = self._pool
        if pool is None:
            return False
        try:
            async with timeout(3), pool.connection() as connection:
                await connection.execute("SELECT 1")
        except (Error, TimeoutError):
            return False
        return True

    def _open_pool(self) -> AsyncConnectionPool:
        if self._pool is None:
            raise RuntimeError("Database pool is not open")
        return self._pool

    @staticmethod
    async def _migrate(pool: AsyncConnectionPool) -> None:
        paths = sorted(_MIGRATIONS.glob("*.sql"))
        if not paths:
            raise RuntimeError("No database migrations found")

        # The transaction-scoped lock serializes startup across service instances.
        async with pool.connection() as connection:
            await connection.execute("SELECT pg_advisory_xact_lock(%s)", (_MIGRATION_LOCK,))
            await connection.execute("""
                CREATE TABLE IF NOT EXISTS ease_schema_migrations (
                    version TEXT PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """)
            rows = await connection.execute("SELECT version FROM ease_schema_migrations")
            applied = {row["version"] for row in await rows.fetchall()}
            for path in paths:
                if path.name in applied:
                    continue
                await connection.execute(path.read_text(encoding="utf-8"))
                await connection.execute(
                    "INSERT INTO ease_schema_migrations (version) VALUES (%s)", (path.name,),
                )

    async def upsert_user(self, subject: str, email: str, name: str | None) -> User:
        async with self._open_pool().connection() as connection:
            cursor = await connection.execute("""
                INSERT INTO ease_users (id, google_subject, email, name)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (google_subject) DO UPDATE SET
                    email = EXCLUDED.email,
                    name = EXCLUDED.name,
                    last_seen_at = GREATEST(ease_users.last_seen_at, CURRENT_TIMESTAMP)
                RETURNING id, email, name, created_at, last_seen_at
            """, (uuid4(), subject, email, name))
            row = await cursor.fetchone()
            if row is None:
                raise RuntimeError("User upsert returned no row")
            return User(**row)

    async def get_user(self, id: UUID) -> User | None:
        async with self._open_pool().connection() as connection:
            cursor = await connection.execute("""
                SELECT id, email, name, created_at, last_seen_at
                FROM ease_users
                WHERE id = %s
            """, (id,))
            row = await cursor.fetchone()
            return User(**row) if row is not None else None

    async def reserve_translation(
        self, user_id: UUID, tier: str, user_daily_limit: int, global_daily_limit: int
    ) -> None:
        if global_daily_limit <= 0:
            raise QuotaExceeded("global")

        # Every reservation locks the global row first. An exhausted user quota
        # rolls back the global increment when this connection scope exits.
        async with self._open_pool().connection() as connection:
            global_counter = await connection.execute("""
                INSERT INTO ease_translation_global_daily (day_utc, request_count)
                VALUES ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, 1)
                ON CONFLICT (day_utc) DO UPDATE
                    SET request_count = ease_translation_global_daily.request_count + 1
                    WHERE ease_translation_global_daily.request_count < %s
                RETURNING day_utc
            """, (global_daily_limit,))
            global_row = await global_counter.fetchone()
            if global_row is None:
                raise QuotaExceeded("global")
            if user_daily_limit <= 0:
                raise QuotaExceeded("user")

            day_utc = global_row["day_utc"]
            user_counter = await connection.execute("""
                INSERT INTO ease_translation_user_daily (user_id, day_utc, request_count)
                VALUES (%s, %s, 1)
                ON CONFLICT (user_id, day_utc) DO UPDATE
                    SET request_count = ease_translation_user_daily.request_count + 1
                    WHERE ease_translation_user_daily.request_count < %s
                RETURNING request_count
            """, (user_id, day_utc, user_daily_limit))
            if await user_counter.fetchone() is None:
                raise QuotaExceeded("user")

            await connection.execute("""
                INSERT INTO ease_translation_tier_daily (day_utc, tier, request_count)
                VALUES (%s, %s, 1)
                ON CONFLICT (day_utc, tier) DO UPDATE
                    SET request_count = ease_translation_tier_daily.request_count + 1
            """, (day_utc, tier))
