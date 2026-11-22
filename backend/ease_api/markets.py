"""Cached, read-only snapshots of ECB, CoinGecko and Wallex public market data."""

import json
import math
from asyncio import Lock, gather, timeout
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from email.utils import parsedate_to_datetime
from time import monotonic
from xml.etree import ElementTree

import httpx

from .market_pairs import (
    FX_CURRENCIES, MARKET_SYMBOLS, Pair, coin_catalogue, crypto_results, instrument, parse_pair,
)

_ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml"
_ECB_CUBE = "{http://www.ecb.int/vocabulary/2002-08-01/eurofxref}Cube"
_CRYPTO_API = "https://api.coingecko.com/api/v3"
_WALLEX_API = "https://api.wallex.ir/v1"
_WALLEX_TTL = 120
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


def _parse_fx(content: bytes, today: date) -> dict[date, dict[str, float]]:
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
            if currency not in FX_CURRENCIES or currency in rates:
                continue
            parsed = _rate(item.get("rate"))
            if parsed is not None:
                rates[currency] = parsed
        if len(rates) > 1:
            rates_by_date[observed] = rates

    if not rates_by_date:
        raise _Unavailable()
    return dict(sorted(rates_by_date.items())[-_TREND_POINTS:])


def _fx_points(rates: dict[date, dict[str, float]], pair: Pair) -> tuple[_Point, ...]:
    return tuple(
        _Point(day.isoformat(), value)
        for day, values in rates.items() if pair.base in values and pair.quote in values
        if (value := _price(values[pair.quote] / values[pair.base])) is not None
    )


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


def _parse_crypto_quote(quote: object, currency: str, now: datetime) -> _CryptoQuote | None:
    if not isinstance(quote, dict) or (price := _price(quote.get(currency))) is None:
        return None
    change = _numeric(quote.get(f"{currency}_24h_change"))
    return _CryptoQuote(price, change if change is not None and change >= -100 else None,
                        _timestamp(quote.get("last_updated_at"), now))


def _cross_crypto(base: _CryptoQuote, quote: _CryptoQuote) -> _CryptoQuote:
    change = None
    if base.change is not None and quote.change is not None and quote.change > -100:
        change = _percent(1 + base.change / 100, 1 + quote.change / 100)
    observed = min(base.updated_at, quote.updated_at) if base.updated_at and quote.updated_at else None
    return _CryptoQuote(base.price / quote.price, change, observed)


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
        self._fx = _Cache[dict[date, dict[str, float]]](_FX_TTL, 5 * 60)
        self._coins = _Cache[tuple[tuple[str, str, str], ...]](12 * 60 * 60, 5 * 60)
        self._wallex = _Cache[tuple[dict, datetime]](_WALLEX_TTL, 60)
        self._history: OrderedDict[Pair, _Cache[tuple[_Point, ...]]] = OrderedDict()
        self._prices: OrderedDict[tuple[str, str], tuple[_CryptoQuote | None, float, bool]] = OrderedDict()
        self._samples: OrderedDict[Pair, tuple[_Point, ...]] = OrderedDict()
        self._quote_fetch = Lock()
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

    async def _load_fx(self) -> dict[date, dict[str, float]]:
        return _parse_fx(await self._download(_ECB_URL, limit=512 * 1024), datetime.now(UTC).date())

    async def _crypto_data[T](self, path: str, params: dict[str, str], parse: Callable[[object, datetime], T]) -> T:
        try:
            async with timeout(9), self._crypto_fetch:
                delay = self._crypto_retry_at - monotonic()
                if delay > 0:
                    raise _Unavailable(delay)
                try:
                    content = await self._download(
                        _CRYPTO_API + path, params=params, headers=self._crypto_headers, limit=4 * 1024 * 1024 if path == "/coins/list" else 1024 * 1024
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

    async def _load_coins(self) -> tuple[tuple[str, str, str], ...]:
        catalogue = await self._crypto_data("/coins/list", {}, coin_catalogue)
        if not catalogue:
            raise _Unavailable()
        return catalogue

    async def _load_wallex(self) -> tuple[dict, datetime]:
        try:
            data = json.loads(await self._download(_WALLEX_API + "/markets", limit=1024 * 1024))
            symbols = data["result"]["symbols"]
        except (ValueError, KeyError, TypeError, RecursionError):
            raise _Unavailable() from None
        if not isinstance(symbols, dict) or not symbols:
            raise _Unavailable()
        rows = {}
        for row in symbols.values():
            if not isinstance(row, dict):
                continue
            base, quote = row.get("baseAsset"), row.get("quoteAsset")
            if not isinstance(base, str) or not isinstance(quote, str):
                continue
            if parse_pair(f"wlx:{base}/{quote}") and row.get("symbol") == base + quote:
                rows[f"wlx:{base}/{quote}"] = row
        if not rows:
            raise _Unavailable()
        return rows, datetime.now(UTC)

    async def catalogue(self, query: str, kind: str) -> list[dict]:
        left, _, right = query.casefold().strip().partition("/")
        left, right = left.strip(), right.strip()
        if not left:
            return []
        local = {"irt": "tmn", "تومان": "tmn", "تومن": "tmn"}
        right = local.get(right, right)
        extension = []
        fx_symbol = f"{left.upper()}/{right.upper()}"
        if kind in ("all", "fx") and (pair := parse_pair(fx_symbol)) and pair.source == "fx":
            extension.append(instrument(fx_symbol, pair.base, pair.quote, pair.base))
        elif kind in ("all", "fx") and not right and left.upper() in FX_CURRENCIES:
            base = left.upper()
            counters = ("EUR", "USD", "GBP", "JPY", "CHF", "CAD")
            extension.extend(instrument(f"{base}/{counter}", base, counter, base) for counter in counters if base != counter)
        if kind == "fx":
            return extension
        # A Toman quote is sourced only from the local venue. USD comes from the reference or crypto feed.
        search_crypto = kind in ("all", "crypto") and right != "tmn" and not extension
        search_local = kind in ("all", "wallex") and right in ("", "tmn", "usdt")
        crypto, domestic = await gather(
            self._coins.read(self._load_coins) if search_crypto else _nothing(),
            self._wallex.read(self._load_wallex) if search_local else _nothing(),
        )
        coins, _ = crypto
        market, _ = domestic
        local_results = []
        if market:
            for symbol, row in market[0].items():
                base, quote = row["baseAsset"], row["quoteAsset"]
                name = str(row.get("enBaseAsset") or base)[:100]
                if (not right or right == quote.lower()) and any(
                    left in str(part).casefold() for part in (base, name, row.get("faBaseAsset"))
                ):
                    local_results.append(instrument(symbol, base, quote, name))
            local_results.sort(key=lambda row: (
                row["base"].casefold() != left, row["quote"] != "TMN", row["base"]
            ))
        cg = crypto_results(coins, left, right or "usd") if coins else []
        return (extension + local_results[:12] + cg)[:24]

    async def _load_prices(self, operands: set[tuple[str, str]]) -> dict[tuple[str, str], tuple[_CryptoQuote | None, bool]]:
        if not operands:
            return {}
        async with self._quote_fetch:
            now = monotonic()
            missing = sorted(key for key in operands if self._prices.get(key, (None, 0, True))[1] <= now)
            if missing:
                ids, currencies = map(sorted, map(set, zip(*missing, strict=True)))
                try:
                    payload = await self._crypto_data("/simple/price", {
                        "ids": ",".join(ids), "vs_currencies": ",".join(currencies),
                        "include_24hr_change": "true", "include_last_updated_at": "true",
                    }, lambda result, _: result)
                    if not isinstance(payload, dict):
                        raise _Unavailable()
                    fetched = datetime.now(UTC)
                    ttl = monotonic() + _CRYPTO_TTL
                    for key in missing:
                        coin, currency = key
                        value = _parse_crypto_quote(payload.get(coin), currency, fetched)
                        if value is not None:
                            self._prices[key] = value, ttl, False
                        else:
                            self._prices[key] = self._prices.get(key, (None, 0, True))[0], now + 60, True
                except _Unavailable:
                    for key in missing:
                        self._prices[key] = self._prices.get(key, (None, 0, True))[0], now + 60, True
            result = {}
            for key in operands:
                value, _, stale = self._prices[key]
                self._prices.move_to_end(key)
                result[key] = value, stale
            while len(self._prices) > 2048:
                self._prices.popitem(last=False)
            return result

    def _trend(self, pair: Pair, at: str | None, price: float) -> tuple[_Point, ...]:
        history = self._history.get(pair)
        if history and history.data:
            return _sample(history.data, _TREND_POINTS)
        points = {point.at: point for point in self._samples.get(pair, ())}
        if at is not None:
            points[at] = _Point(at, price)
        self._samples[pair] = tuple(points[key] for key in sorted(points)[-_TREND_POINTS:])
        self._samples.move_to_end(pair)
        if len(self._samples) > 384:
            self._samples.popitem(last=False)
        return self._samples[pair]

    async def quotes(self, symbols: tuple[str, ...] = MARKET_SYMBOLS) -> list[dict]:
        pairs = [(symbol, parse_pair(symbol)) for symbol in symbols]
        operands = {operand for _, pair in pairs if pair.source == "crypto" for operand in pair.operands()}
        fx, crypto, domestic = await gather(
            self._fx.read(self._load_fx) if any(pair.source == "fx" for _, pair in pairs) else _nothing(),
            self._load_prices(operands),
            self._wallex.read(self._load_wallex) if any(pair.source == "wallex" for _, pair in pairs) else _nothing(),
        )
        rates, fx_stale = fx
        market, local_stale = domestic
        now = datetime.now(UTC)
        result = []
        for symbol, pair in pairs:
            if pair.source == "fx":
                points = _fx_points(rates or {}, pair)
                if points:
                    last = points[-1]
                    change = _percent(last.value, points[-2].value) if len(points) > 1 else None
                    stale = fx_stale or now.date() - date.fromisoformat(last.at) > timedelta(days=4)
                    result.append(_quote(symbol, last.value, change, last.at, stale, points))
                    continue
            elif pair.source == "wallex":
                row = market[0].get(symbol) if market else None
                stats = row.get("stats") if row else None
                if isinstance(stats, dict) and (price := _rate(str(stats.get("lastPrice")))) is not None:
                    at = _utc_stamp(market[1])
                    stale = local_stale or now - market[1] > timedelta(minutes=6)
                    change = _numeric(stats.get("24h_ch"))
                    result.append(_quote(symbol, price, change if change is not None and change >= -100 else None,
                                         at, stale, self._trend(pair, at, price)))
                    continue
            else:
                samples = [crypto[key] for key in pair.operands()]
                if all(sample[0] is not None for sample in samples):
                    value = samples[0][0] if len(samples) == 1 else _cross_crypto(samples[0][0], samples[1][0])
                    price = _price(value.price)
                    if price is None:
                        result.append(_quote(symbol, None, None, None, True, ()))
                        continue
                    at = _utc_stamp(value.updated_at) if value.updated_at else None
                    stale = (any(sample[1] for sample in samples)
                             or not value.updated_at or now - value.updated_at > timedelta(minutes=30))
                    result.append(_quote(symbol, price, value.change, at, stale, self._trend(pair, at, price)))
                    continue
            result.append(_quote(symbol, None, None, None, True, ()))
        return result

    async def _load_history(self, pair: Pair) -> tuple[_Point, ...]:
        if pair.source == "wallex":
            now = int(datetime.now(UTC).timestamp())
            try:
                payload = json.loads(await self._download(_WALLEX_API + "/udf/history", params={
                    "symbol": pair.base + pair.quote, "resolution": "60", "from": now - 7 * 86400, "to": now,
                }, limit=128 * 1024))
                points = [[seconds * 1000, _rate(str(close))]
                          for stamp, close in zip(payload["t"], payload["c"], strict=True)
                          if (seconds := _numeric(stamp)) is not None]
            except (ValueError, KeyError, TypeError, RecursionError):
                raise _Unavailable() from None
            return _parse_crypto_history({"prices": points}, datetime.now(UTC))

        async def series(asset: str, currency: str) -> tuple[_Point, ...]:
            return await self._crypto_data(
                f"/coins/{asset}/market_chart", {"vs_currency": currency, "days": "7"}, _parse_crypto_history
            )
        operands = pair.operands()
        if len(operands) == 1:
            return await series(*operands[0])
        left, right = await gather(*(series(*operand) for operand in operands))
        # CoinGecko can timestamp individual coin samples a few seconds apart.
        def hours(points: tuple[_Point, ...]) -> dict[str, float]:
            return {point.at[:13]: point.value for point in points}
        first, second = hours(left), hours(right)
        result = tuple(_Point(f"{hour}:00:00Z", value) for hour, price in first.items() if hour in second
                       if (value := _price(price / second[hour])) is not None)
        if not result:
            raise _Unavailable()
        return result

    async def history(self, symbol: str) -> dict:
        pair = parse_pair(symbol)
        if pair.source == "fx":
            data, stale = await self._fx.read(self._load_fx)
            points = _fx_points(data or {}, pair)
            if points:
                stale = stale or datetime.now(UTC).date() - date.fromisoformat(points[-1].at) > timedelta(days=4)
        else:
            if pair not in self._history:
                self._history[pair] = _Cache(_CRYPTO_TTL, 60)
            self._history.move_to_end(pair)
            if len(self._history) > 128:
                self._history.popitem(last=False)
            points, stale = await self._history[pair].read(lambda: self._load_history(pair))
            if points:
                stale = stale or datetime.now(UTC) - datetime.fromisoformat(points[-1].at) > timedelta(hours=2)
        return {"symbol": symbol, "points": [{"at": point.at, "value": point.value} for point in points or ()],
                "stale": stale or not points}


async def _nothing():
    return None, True
