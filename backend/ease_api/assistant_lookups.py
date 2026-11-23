"""Resolve bounded live market and weather queries from the assistant."""

import asyncio
import json
import math
import re
from dataclasses import dataclass
from datetime import date
from typing import Annotated, Literal
from unicodedata import normalize

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .assistant_lookup_locales import ASK_CITY, CONDITIONS, CURRENT_WEATHER, MESSAGES
from .market_pairs import parse_pair
from .markets import MarketsService


_GEO = "https://geocoding-api.open-meteo.com/v1/search"
_FORECAST = "https://api.open-meteo.com/v1/forecast"
_SOURCES = {"fx": "ECB", "crypto": "CoinGecko", "wallex": "Wallex"}
_COMMON_COINS = {"BTC": "bitcoin", "ETH": "ethereum", "USDT": "tether", "SOL": "solana", "XRP": "ripple"}
_ALIASES = {"IRT": "TMN", "TOMAN": "TMN", "DOLLAR": "USD", "EURO": "EUR", "تومان": "TMN", "تومن": "TMN",
            "ریال": "IRR", "دلار": "USD", "یورو": "EUR", "تتر": "USDT", "بیت کوین": "BTC", "بیت‌کوین": "BTC"}
_WEATHER_CODES = {
    code: index for index, group in enumerate(((0,), (1, 2, 3), (45, 48), (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82),
                                              (71, 73, 75, 77, 85, 86), (95, 96, 99))) for code in group
}
Locale = Literal["en", "fa", "es", "fr", "pt-BR", "ar", "de", "ja"]
Asset = Annotated[str, Field(pattern=r"^[\w\- .‌]{1,60}$")]


class _Arguments(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)
    language: Locale | None = Field(default=None, description="Answer language, when different from the interface")


class MarketQuery(_Arguments):
    base: Asset = Field(description="Base currency or coin ticker, for example USD, BTC, ETH, or USDT")
    quote: Asset = Field(description="Quote currency ticker. Use TMN for Iranian toman, IRR for Iranian rial")
    amount: float = Field(default=1, gt=0, le=1e12, description="Number of base units the user wants to convert")


class WeatherQuery(_Arguments):
    city: str = Field(pattern=r"^[\w .,'’\-‌]{2,80}$", description="City name copied literally from the user's message, without the country")
    search_name: str | None = Field(default=None, pattern=r"^[A-Za-z][A-Za-z .,'-]{1,79}$",
                                    description="Standard romanized name of the same city for geocoding non-Latin names")
    country: str | None = Field(default=None, pattern=r"^[A-Z]{2}$", description="ISO country code, only if known")
    day_offset: int = Field(default=0, ge=0, le=6, description="0 for today, 1 for tomorrow, up to 6")
    unit: Literal["celsius", "fahrenheit"] = "celsius"


def _tool(name, description, model):
    return {"type": "function", "function": {"name": name, "description": description, "parameters": model.model_json_schema()}}


TOOLS = [
    _tool("market_quote", "Look up the latest supported exchange rate or crypto quote. Use USD for a crypto price "
          "with no quote currency. Use TMN for casual Persian requests for the Iranian price of dollars (e.g. دلار چنده). "
          "Never substitute tether for dollars yourself. The quote service labels the distinction.", MarketQuery),
    _tool("weather_forecast", "Get the real forecast for a named city for one of the next seven days. Ask the user for "
          "the city if the user has not named it. Never infer a city from the user's language, calendar or date.", WeatherQuery),
]


@dataclass(frozen=True, slots=True)
class LookupCall:
    name: str
    arguments: str


def _number(value: float, locale: str) -> str:
    text = f"{value:,.8f}".rstrip("0").rstrip(".") if not 0 < abs(value) < 1e-8 else f"{value:.8g}"
    if locale in {"es", "fr", "pt-BR", "de"}:
        return text.translate(str.maketrans(",.", " ," if locale == "fr" else ".,"))
    if locale == "fa":
        return text.translate(str.maketrans("0123456789,.", "۰۱۲۳۴۵۶۷۸۹٬٫"))
    if locale == "ar":
        return text.translate(str.maketrans("0123456789,.", "٠١٢٣٤٥٦٧٨٩٬٫"))
    return text


def _asset(value: str) -> str:
    value = " ".join(value.upper().split())
    return _ALIASES.get(value, value)


def _location_words(value: str) -> str:
    folded = normalize("NFKC", value).casefold().replace("ي", "ی").replace("ك", "ک")
    return " ".join(re.findall(r"\w+", folded))


def _matches_location(city: str, messages: list[str]) -> bool:
    words = _location_words(city)
    if not words:
        return False
    if re.search(r"[\u3040-\u30ff\u3400-\u9fff]", words):
        return any(words in _location_words(message) for message in messages)
    return any(f" {words} " in f" {_location_words(message)} " for message in messages)


class AssistantLookups:
    def __init__(self, client: httpx.AsyncClient, markets: MarketsService):
        self._client = client
        self._markets = markets

    async def answer(self, calls: list[LookupCall], locale: Locale, user_messages: list[str]) -> tuple[str, str] | None:
        tasks = []
        kinds = set()
        for call in dict.fromkeys(calls):
            try:
                if call.name == "market_quote":
                    query = MarketQuery.model_validate_json(call.arguments)
                    kinds.add("market")
                    tasks.append(self._quote(query, query.language or locale))
                elif call.name == "weather_forecast":
                    query = WeatherQuery.model_validate_json(call.arguments)
                    kinds.add("weather")
                    tasks.append(self._weather(query, query.language or locale, user_messages))
            except ValidationError:
                continue
        if not tasks:
            return None
        return "\n\n".join(await asyncio.gather(*tasks)), kinds.pop() if len(kinds) == 1 else "workflow"

    async def _market_symbol(self, base: str, quote: str) -> str | None:
        local = f"wlx:{base}/{quote}"
        if quote in {"TMN", "USDT"} and parse_pair(local):
            return local
        symbol = f"{base}/{quote}"
        if parse_pair(symbol):
            return symbol
        if base in _COMMON_COINS:
            symbol = f"cg:{_COMMON_COINS[base]}/{quote.lower()}"
            if parse_pair(symbol):
                return symbol
        entries = await self._markets.catalogue(f"{base}/{quote}", "all")
        requested_base = base.casefold()
        matches = [item["symbol"] for item in entries if item["quote"] == quote
                   and requested_base in {item["base"].casefold(), item["name"].casefold()}]
        return matches[0] if len(matches) == 1 else None

    async def _quote(self, query: MarketQuery, locale: str) -> str:
        unavailable, unit_price, dollar_note, cached, _, _ = MESSAGES[locale]
        base, quote = _asset(query.base), _asset(query.quote)
        is_rial = quote == "IRR"
        local_quote = "TMN" if is_rial else quote
        uses_tether = base == "USD" and local_quote == "TMN"
        lookup_base = "USDT" if uses_tether else base
        try:
            async with asyncio.timeout(9):
                symbol = await self._market_symbol(lookup_base, local_quote)
                result = (await self._markets.quotes((symbol,)))[0] if symbol else {}
        except TimeoutError:
            result = {}
        price = result.get("price")
        if price is None:
            return unavailable.format(base=base, quote=quote)
        if is_rial:
            price *= 10
        quote_name = {"TMN": "تومان", "IRR": "ریال", "USD": "دلار آمریکا"}.get(quote, quote) if locale == "fa" else quote
        answer = unit_price.format(base=lookup_base, price=_number(price, locale), quote=quote_name)
        if uses_tether:
            answer = dollar_note + "\n" + answer
        elif query.amount != 1:
            answer += f"\n{_number(query.amount, locale)} {base} = {_number(price * query.amount, locale)} {quote_name}"
        source = _SOURCES[parse_pair(symbol).source]
        parts = [source, result.get("asOf"), cached if result.get("stale") else None]
        return answer + "\n" + " · ".join(part for part in parts if part)

    async def _json(self, url: str, params: dict) -> object:
        async with self._client.stream("GET", url, params=params, timeout=4.0, follow_redirects=False) as response:
            response.raise_for_status()
            content = bytearray()
            async for chunk in response.aiter_bytes():
                if len(content) + len(chunk) > 32_000:
                    raise ValueError("Weather response too large")
                content.extend(chunk)
            return json.loads(content)

    async def _weather(self, query: WeatherQuery, locale: str, user_messages: list[str]) -> str:
        if not _matches_location(query.city, user_messages):
            return ASK_CITY[locale]
        _, _, _, _, unavailable, forecast = MESSAGES[locale]
        search = {"name": query.city, "count": 5, "language": locale.split("-")[0]}
        if query.country:
            search["countryCode"] = query.country
        try:
            async with asyncio.timeout(8):
                place = await self._find_place(search)
                if place is None and query.search_name and query.search_name.casefold() != query.city.casefold():
                    place = await self._find_place({**search, "name": query.search_name})
                if place is None:
                    return unavailable.format(city=query.city)
                latitude, longitude = float(place["latitude"]), float(place["longitude"])
                if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                    raise ValueError("Invalid weather location")
                forecast_data = await self._json(_FORECAST, {
                    "latitude": latitude, "longitude": longitude, "timezone": "auto", "forecast_days": query.day_offset + 1,
                    "daily": "weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max",
                    "temperature_unit": query.unit,
                    **({"current": "weather_code,temperature_2m"} if query.day_offset == 0 else {}),
                })
                daily = forecast_data["daily"]
            offset = query.day_offset
            day = date.fromisoformat(daily["time"][offset])
            code = int(daily["weather_code"][offset])
            low = float(daily["temperature_2m_min"][offset])
            high = float(daily["temperature_2m_max"][offset])
            rain = float(daily["precipitation_probability_max"][offset])
            condition = CONDITIONS[locale][_WEATHER_CODES[code]]
            if not all(math.isfinite(number) for number in (low, high, rain)) or not 0 <= rain <= 100:
                raise ValueError("Invalid weather forecast")
        except (httpx.HTTPError, TimeoutError, KeyError, IndexError, AttributeError, TypeError, ValueError, RecursionError):
            return unavailable.format(city=query.city)
        separator = "، " if locale in {"fa", "ar"} else ", "
        city = separator.join(part for key in ("name", "country") if isinstance(part := place.get(key), str)) or query.city
        unit = "°F" if query.unit == "fahrenheit" else "°C"
        answer = forecast.format(city=city, day=day.isoformat(), condition=condition, low=_number(low, locale),
                                 high=_number(high, locale), rain=_number(rain, locale), unit=unit)
        current = forecast_data.get("current")
        if offset == 0 and isinstance(current, dict):
            temperature, condition_code = current.get("temperature_2m"), current.get("weather_code")
            if type(temperature) in (int, float) and math.isfinite(temperature) and type(condition_code) is int and condition_code in _WEATHER_CODES:
                condition = CONDITIONS[locale][_WEATHER_CODES[condition_code]]
                first_line, _, daily_lines = answer.partition("\n")
                now = CURRENT_WEATHER[locale].format(temp=_number(temperature, locale), unit=unit, condition=condition)
                answer = "\n".join((first_line, now, daily_lines))
        return answer + "\nOpen-Meteo"

    async def _find_place(self, search: dict) -> dict | None:
        response = await self._json(_GEO, search)
        places = response.get("results", []) if isinstance(response, dict) else []
        return next((row for row in places if isinstance(row, dict) and str(row.get("feature_code")).startswith("PPL")), None)
