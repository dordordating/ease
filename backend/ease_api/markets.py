"""Cached, read-only snapshots of ECB and CoinGecko public market data."""

import json
import math
from asyncio import Lock, gather, timeout
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from email.utils import parsedate_to_datetime
from time import monotonic
from xml.etree import ElementTree

import httpx

FX_SYMBOLS = ("EUR/USD", "USD/JPY", "GBP/USD", "EUR/GBP", "USD/CHF", "USD/CAD", "AUD/USD", "EUR/JPY")
CRYPTO_MARKETS = {
    "BTC/USD": ("bitcoin", "usd"),
    "ETH/USD": ("ethereum", "usd"),
    "SOL/USD": ("solana", "usd"),
    "XRP/USD": ("ripple", "usd"),
    "BTC/EUR": ("bitcoin", "eur"),
    "ETH/EUR": ("ethereum", "eur"),
}
MARKET_SYMBOLS = (*FX_SYMBOLS, *CRYPTO_MARKETS)

_ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml"
_ECB_CUBE = "{http://www.ecb.int/vocabulary/2002-08-01/eurofxref}Cube"
_ECB_CURRENCIES = {currency for symbol in FX_SYMBOLS for currency in symbol.split("/")} - {"EUR"}
_CRYPTO_API = "https://api.coingecko.com/api/v3"
_FX_TTL = 60 * 60
_CRYPTO_TTL = 10 * 60
_RESPONSE_TIMEOUT = httpx.Timeout(6, connect=3)
_TREND_POINTS = 30
_CRYPTO_HISTORY_POINTS = 180


@dataclass(frozen=True, slots=True)
class _Point:
    at: str
    value: float


@dataclass(frozen=True, slots=True)
class _CryptoQuote:
    price: float
    change: float | None
    updated_at: datetime | None


@dataclass(frozen=True, slots=True)
class _Batch[T]:
    values: dict[str, T]
    present: frozenset[str]


def _batch[T](previous: _Batch[T] | None, current: dict[str, T]) -> _Batch[T]:
    # A partial feed should not erase the previous value of a missing symbol.
    return _Batch({**(previous.values if previous else {}), **current}, frozenset(current))


class _Unavailable(Exception):
    def __init__(self, delay: float = 0) -> None:
        self.delay = delay


class _Cache[T]:
    def __init__(self, ttl: int, retry_delay: int) -> None:
        self._ttl = ttl
        self._retry_delay = retry_delay
        self._lock = Lock()
        self.data: T | None = None
        self._expires = 0.0
        self._retry_at = 0.0
        self.stale = True

    async def read(self, load: Callable[[], Awaitable[T]]) -> tuple[T | None, bool]:
        async with self._lock:
            now = monotonic()
            if now < self._expires or now < self._retry_at:
                return self.data, self.stale
            try:
                self.data = await load()
            except _Unavailable as error:
                self._retry_at = monotonic() + max(self._retry_delay, error.delay)
                self.stale = True
            else:
                self._expires = monotonic() + self._ttl
                self.stale = False
            return self.data, self.stale


def _numeric(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except OverflowError:
        return None
    return result if math.isfinite(result) else None


def _price(value: object) -> float | None:
    price = _numeric(value)
    return price if price is not None and price > 0 else None


def _percent(current: float, previous: float) -> float | None:
    return _numeric((current / previous - 1) * 100)


def _rate(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return _price(float(value))
    except ValueError:
        return None


def _parse_fx(content: bytes, today: date) -> dict[str, tuple[_Point, ...]]:
    if b"<!DOCTYPE" in content.upper():
        raise _Unavailable()
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError:
        raise _Unavailable() from None
    oldest = today - timedelta(days=120)
    rates_by_date: dict[date, dict[str, float]] = {}
    for day in root.findall(f"./{_ECB_CUBE}/{_ECB_CUBE}"):
        stamp = day.get("time", "")
        try:
            observed = date.fromisoformat(stamp)
        except ValueError:
            continue
        if observed.isoformat() != stamp or not oldest <= observed <= today or observed in rates_by_date:
            continue
        rates: dict[str, float] = {"EUR": 1.0}
        for item in day.findall(_ECB_CUBE):
            currency = item.get("currency")
            if currency not in _ECB_CURRENCIES or currency in rates:
                continue
            parsed = _rate(item.get("rate"))
            if parsed is not None:
                rates[currency] = parsed
        if len(rates) > 1:
            rates_by_date[observed] = rates

    series: dict[str, tuple[_Point, ...]] = {}
    days = sorted(rates_by_date)
    for symbol in FX_SYMBOLS:
        base, quote = symbol.split("/")
        points: list[_Point] = []
        for observed in days:
            rates = rates_by_date[observed]
            if base in rates and quote in rates:
                value = _price(rates[quote] / rates[base])
                if value is not None:
                    points.append(_Point(observed.isoformat(), value))
        series[symbol] = tuple(points[-_TREND_POINTS:])
    if not any(series.values()):
        raise _Unavailable()
    return series


def _timestamp(value: object, now: datetime, *, milliseconds: bool = False) -> datetime | None:
    seconds = _numeric(value)
    if seconds is None or seconds <= 0:
        return None
    if milliseconds:
        seconds /= 1000
    try:
        timestamp = datetime.fromtimestamp(seconds, UTC)
    except (ValueError, OverflowError, OSError):
        return None
    return timestamp if timestamp <= now + timedelta(minutes=5) else None


def _utc_stamp(value: datetime, *, milliseconds: bool = False) -> str:
    return value.isoformat(timespec="milliseconds" if milliseconds else "seconds").replace("+00:00", "Z")


def _sample(points: tuple[_Point, ...], limit: int) -> tuple[_Point, ...]:
    if len(points) <= limit:
        return points
    return tuple(points[index * (len(points) - 1) // (limit - 1)] for index in range(limit))


def _parse_crypto_quotes(payload: object, now: datetime) -> dict[str, _CryptoQuote]:
    if not isinstance(payload, dict):
        raise _Unavailable()
    result: dict[str, _CryptoQuote] = {}
    for symbol, (coin, currency) in CRYPTO_MARKETS.items():
        quote = payload.get(coin)
        if not isinstance(quote, dict):
            continue
        price = _price(quote.get(currency))
        if price is None:
            continue
        change = _numeric(quote.get(f"{currency}_24h_change"))
        updated = _timestamp(quote.get("last_updated_at"), now)
        result[symbol] = _CryptoQuote(price, change if change is not None and change >= -100 else None, updated)
    if not result:
        raise _Unavailable()
    return result


def _parse_crypto_history(payload: object, now: datetime) -> tuple[_Point, ...]:
    prices = payload.get("prices") if isinstance(payload, dict) else None
    if not isinstance(prices, list):
        raise _Unavailable()
    points: dict[str, _Point] = {}
    oldest = now - timedelta(days=8)
    for pair in prices:
        if not isinstance(pair, list) or len(pair) != 2:
            continue
        timestamp = _timestamp(pair[0], now, milliseconds=True)
        value = _price(pair[1])
        if timestamp is None or timestamp < oldest or value is None:
            continue
        at = _utc_stamp(timestamp, milliseconds=True)
        points[at] = _Point(at, value)
    if not points:
        raise _Unavailable()
    return _sample(tuple(points[key] for key in sorted(points)), _CRYPTO_HISTORY_POINTS)


def _retry_after(value: str | None) -> float:
    if not value:
        return 0
    try:
        wait = int(value)
    except ValueError:
        try:
            wait = (parsedate_to_datetime(value).astimezone(UTC) - datetime.now(UTC)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return 0
    return min(3600, max(0, wait))


def _quote(symbol: str, price: float | None, change: float | None, stamp: str | None,
           stale: bool, trend: tuple[_Point, ...]) -> dict:
    return {
        "symbol": symbol,
        "price": price,
        "changePercent": change,
        "asOf": stamp,
        "stale": stale,
        "trend": [point.value for point in trend],
    }


class MarketsService:
    def __init__(self, client: httpx.AsyncClient, demo_api_key: str | None = None) -> None:
        self._client = client
        self._crypto_headers = {"x-cg-demo-api-key": demo_api_key} if demo_api_key else {}
        self._fx = _Cache[_Batch[tuple[_Point, ...]]](_FX_TTL, 5 * 60)
        self._crypto = _Cache[_Batch[_CryptoQuote]](_CRYPTO_TTL, 60)
        self._crypto_history = {symbol: _Cache[tuple[_Point, ...]](_CRYPTO_TTL, 60) for symbol in CRYPTO_MARKETS}
        self._crypto_samples: dict[str, tuple[_Point, ...]] = {}
        self._crypto_fetch = Lock()
        self._crypto_retry_at = 0.0

    async def _download(self, url: str, *, params=None, headers=None, limit: int) -> bytes:
        try:
            async with timeout(8), self._client.stream(
                "GET", url, params=params, headers=headers, timeout=_RESPONSE_TIMEOUT, follow_redirects=False
            ) as response:
                if not response.is_success:
                    wait = _retry_after(response.headers.get("Retry-After"))
                    raise _Unavailable(max(120 if response.status_code == 429 else 0, wait))
                data = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=16 * 1024):
                    if len(data) + len(chunk) > limit:
                        raise _Unavailable()
                    data.extend(chunk)
                return bytes(data)
        except (httpx.RequestError, TimeoutError):
            raise _Unavailable() from None

    async def _load_fx(self) -> _Batch[tuple[_Point, ...]]:
        content = await self._download(_ECB_URL, limit=512 * 1024)
        result = _parse_fx(content, datetime.now(UTC).date())
        return _batch(self._fx.data, {symbol: points for symbol, points in result.items() if points})

    async def _crypto_data[T](self, path: str, params: dict[str, str], parse: Callable[[object, datetime], T]) -> T:
        try:
            async with timeout(9), self._crypto_fetch:
                delay = self._crypto_retry_at - monotonic()
                if delay > 0:
                    raise _Unavailable(delay)
                try:
                    content = await self._download(
                        _CRYPTO_API + path, params=params, headers=self._crypto_headers, limit=256 * 1024
                    )
                    return parse(json.loads(content), datetime.now(UTC))
                except (ValueError, RecursionError):
                    self._crypto_retry_at = monotonic() + 60
                    raise _Unavailable(60) from None
                except _Unavailable as error:
                    wait = max(60, error.delay)
                    self._crypto_retry_at = monotonic() + wait
                    raise _Unavailable(wait) from None
        except TimeoutError:
            raise _Unavailable(60) from None

    async def _load_crypto(self) -> _Batch[_CryptoQuote]:
        result = await self._crypto_data("/simple/price", {
            "ids": ",".join(dict.fromkeys(coin for coin, _ in CRYPTO_MARKETS.values())),
            "vs_currencies": "usd,eur",
            "include_24hr_change": "true",
            "include_last_updated_at": "true",
        }, _parse_crypto_quotes)
        for symbol, item in result.items():
            if item.updated_at is None:
                continue
            sample = _Point(_utc_stamp(item.updated_at), item.price)
            existing = self._crypto_samples.get(symbol, ())
            points = {point.at: point for point in existing}
            points[sample.at] = sample
            self._crypto_samples[symbol] = tuple(points[key] for key in sorted(points)[-_TREND_POINTS:])
        return _batch(self._crypto.data, result)

    async def quotes(self) -> list[dict]:
        (fx, fx_stale), (crypto, crypto_stale) = await gather(
            self._fx.read(self._load_fx), self._crypto.read(self._load_crypto)
        )
        now = datetime.now(UTC)
        result: list[dict] = []
        for symbol in FX_SYMBOLS:
            points = fx.values.get(symbol) if fx else None
            if not points:
                result.append(_quote(symbol, None, None, None, True, ()))
                continue
            last = points[-1]
            change = _percent(last.value, points[-2].value) if len(points) > 1 else None
            stale = fx_stale or symbol not in fx.present or now.date() - date.fromisoformat(last.at) > timedelta(days=4)
            result.append(_quote(symbol, last.value, change, last.at, stale, points))
        for symbol in CRYPTO_MARKETS:
            item = crypto.values.get(symbol) if crypto else None
            if item is None:
                result.append(_quote(symbol, None, None, None, True, ()))
                continue
            stamp = _utc_stamp(item.updated_at) if item.updated_at else None
            stale = (
                crypto_stale or symbol not in crypto.present
                or item.updated_at is None or now - item.updated_at > timedelta(minutes=30)
            )
            series = self._crypto_history[symbol].data
            trend = _sample(series, _TREND_POINTS) if series else self._crypto_samples.get(symbol, ())
            result.append(_quote(symbol, item.price, item.change, stamp, stale, trend))
        return result

    async def history(self, symbol: str) -> dict:
        if symbol in CRYPTO_MARKETS:
            coin, currency = CRYPTO_MARKETS[symbol]
            points, stale = await self._crypto_history[symbol].read(lambda: self._crypto_data(
                f"/coins/{coin}/market_chart", {"vs_currency": currency, "days": "7"}, _parse_crypto_history
            ))
            if points is not None:
                updated = datetime.fromisoformat(points[-1].at)
                stale = stale or datetime.now(UTC) - updated > timedelta(hours=2)
        else:
            fx, stale = await self._fx.read(self._load_fx)
            points = fx.values.get(symbol) if fx else None
            if points:
                stale = (
                    stale or symbol not in fx.present
                    or datetime.now(UTC).date() - date.fromisoformat(points[-1].at) > timedelta(days=4)
                )
        return {
            "symbol": symbol,
            "points": [{"at": point.at, "value": point.value} for point in points or ()],
            "stale": stale or not points,
        }
