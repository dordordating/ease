"""Interpret the market IDs stored by Ease and build catalogue results."""

import re
from dataclasses import dataclass

FX_CURRENCIES = frozenset(
    "AUD BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR".split()
)
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
COINGECKO_QUOTES = frozenset(
    "btc eth ltc bch bnb eos xrp xlm link dot yfi sol usd aed ars aud bdt bhd bmd brl cad chf clp cny czk dkk eur gbp gel hkd huf idr ils inr jpy krw kwd lkr mmk mxn myr ngn nok nzd php pkr pln rub sar sek sgd thb try twd uah vef vnd zar xdr xag xau bits sats".split()
)
_CANONICAL_COINS = ("bitcoin", "ethereum", "tether", "solana", "ripple", "usd-coin", "cardano", "dogecoin")
_LEGACY = {value: symbol for symbol, value in CRYPTO_MARKETS.items()}
_COIN_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,119}")
_TICKER = re.compile(r"[A-Z0-9][A-Z0-9._-]{0,19}")


@dataclass(frozen=True, slots=True)
class Pair:
    source: str
    base: str
    quote: str

    def operands(self) -> tuple[tuple[str, str], ...]:
        if self.quote.startswith("cg:"):
            return ((self.base, "usd"), (self.quote[3:], "usd"))
        return ((self.base, self.quote),)


def parse_pair(symbol: str) -> Pair | None:
    if symbol in CRYPTO_MARKETS:
        return Pair("crypto", *CRYPTO_MARKETS[symbol])
    left, slash, right = symbol.partition("/")
    if not slash or left == right:
        return None
    if left in FX_CURRENCIES and right in FX_CURRENCIES:
        return Pair("fx", left, right)
    if left.startswith("wlx:") and _TICKER.fullmatch(left[4:]) and right in {"TMN", "USDT"}:
        return Pair("wallex", left[4:], right) if left[4:] != right else None
    if left.startswith("cg:") and _COIN_ID.fullmatch(left[3:]):
        if right in COINGECKO_QUOTES or (right.startswith("cg:") and _COIN_ID.fullmatch(right[3:])):
            return Pair("crypto", left[3:], right)
    return None


def instrument(symbol: str, base: str, quote: str, name: str, quote_name: str = "") -> dict:
    return {
        "symbol": symbol, "kind": parse_pair(symbol).source, "base": base,
        "quote": quote, "name": name, "quoteName": quote_name,
    }


def coin_catalogue(payload: object, _now: object) -> tuple[tuple[str, str, str], ...]:
    if not isinstance(payload, list):
        return ()
    coins = []
    for row in payload[:30_000]:
        if not isinstance(row, dict):
            continue
        coin, ticker, name = (row.get(key) for key in ("id", "symbol", "name"))
        if (isinstance(coin, str) and _COIN_ID.fullmatch(coin)
                and isinstance(ticker, str) and ticker.strip() and isinstance(name, str) and name.strip()):
            coins.append((coin, ticker.upper()[:24], name[:100]))
    return tuple(coins)


def find_coins(coins: tuple[tuple[str, str, str], ...], query: str, limit: int) -> list[tuple[str, str, str]]:
    candidates = [coin for coin in coins if any(query in value.casefold() for value in coin)]
    return sorted(candidates, key=lambda c: (
        min((index for index, value in enumerate(c) if value.casefold() == query), default=3),
        c[0] not in _CANONICAL_COINS, not c[2].casefold().startswith(query), len(c[2]), c[0],
    ))[:limit]


def crypto_results(coins: tuple[tuple[str, str, str], ...], base: str, quote: str) -> list[dict]:
    matches = find_coins(coins, base, 8)
    right = [(quote, quote.upper(), "")] if quote in COINGECKO_QUOTES else [
        (f"cg:{coin}", ticker, name) for coin, ticker, name in find_coins(coins, quote, 3)
    ]
    return [
        instrument(_LEGACY.get((coin, currency), f"cg:{coin}/{currency}"), ticker, counter, name, quote_name)
        for currency, counter, quote_name in right for coin, ticker, name in matches
        if currency != f"cg:{coin}" and ticker != counter
    ][:20]
