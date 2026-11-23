import asyncio
import json
from contextlib import aclosing
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from pydantic import ValidationError

from ease_api import assistant
from ease_api.assistant_lookups import ASK_CITY, AssistantLookups, LookupCall
from ease_api.markets import MarketsService
from ease_api.openrouter import OpenRouterRejected, OpenRouterUnavailable


PRIMARY = "google/gemini-3.1-flash-lite"
FALLBACK = "openai/gpt-5.6-luna"
PAYLOAD = assistant.AssistantRequest(
    prompt="Draft a follow-up task for tomorrow.", locale="en", calendar="gregory",
    local_date="2026-11-23", local_time="17:30",
)


class AssistantInputTest(TestCase):
    def test_legacy_automatic_target_resolves_to_english(self):
        payload = {**PAYLOAD.model_dump(), "locale": "fa", "calendar": "persian", "translation_language": "auto"}
        self.assertEqual(assistant.AssistantRequest.model_validate(payload).translation_language, "en")
        self.assertEqual(assistant.AssistantRequest.model_validate({**payload, "translation_language": "fa"}).translation_language, "fa")

    def test_untitled_attachment_has_a_usable_label(self):
        source = {"id": "s1", "kind": "page", "text": "An excerpt."}
        for label in ({}, {"label": " \n "}, {"label": None}):
            with self.subTest(label=label):
                payload = assistant.AssistantRequest.model_validate({**PAYLOAD.model_dump(), "sources": [{**source, **label}]})
                self.assertEqual(payload.sources[0].label, "Current page")
                self.assertEqual(payload.sources[0].text, source["text"])

    def test_validation_log_allowlists_fields_and_omits_input(self):
        errors = [
            {"loc": ("body", "translation_language"), "input": "private input"},
            {"loc": ("body", "sources", 0, "label"), "input": "private title"},
            {"loc": ("body", "history", 1, "answer"), "input": "private reply"},
            {"loc": ("body", "sources", 0, "private field name")},
            {"loc": ("body", "private field name")},
            {"loc": ("body", 2)},
        ]
        self.assertEqual(assistant.assistant_validation_fields(errors), "body,history.answer,sources,sources.label,translation_language")
        with self.assertRaises(ValidationError):
            assistant.AssistantRequest.model_validate({**PAYLOAD.model_dump(), "translation_language": "invalid language"})

    def test_task_label_uses_existing_reference(self):
        items = [{"kind": "task", "title": label, "label": label} for label in ("l2", "l9", "invalid")]
        result = assistant.read_result(json.dumps({"actions": items}), [], [assistant.TaskLabel(id="l2", name="Work")])
        self.assertEqual([item.get("label") for item in result["actions"]], ["l2", None, None])


def delta(text):
    chunk = {"choices": [{"delta": {"content": text}, "finish_reason": None}]}
    return f"data: {json.dumps(chunk)}\n\n".encode()


def answer(text):
    metadata = '{"citations":[],"actions":[{"kind":"task","title":"Follow up","date":"2026-11-24"}]}'
    return httpx.Response(
        200,
        content=delta(text) + delta(assistant.MARKER + metadata) + b'data: [DONE]\n\n',
    )


class StalledBody(httpx.AsyncByteStream):
    def __init__(self, text):
        self.text = text
        self.waiting = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        yield b": heartbeat\n\n" + delta(self.text)
        self.waiting.set()
        await asyncio.Event().wait()

    async def aclose(self):
        self.closed = True


class AssistantFallbackTest(IsolatedAsyncioTestCase):
    def setUp(self):
        self.requests = []

    def client(self, *responses):
        def send(request):
            body = json.loads(request.content)
            self.requests.append(body)
            return responses[len(self.requests) - 1]

        return httpx.AsyncClient(transport=httpx.MockTransport(send))

    def stream(self, client, fallback=FALLBACK):
        return assistant.stream_assistant(client, "test-key", PRIMARY, PAYLOAD, 1600, fallback_model=fallback)

    def models(self):
        return [request["model"] for request in self.requests]

    async def test_primary_answer_uses_one_model(self):
        async with self.client(answer("Primary draft")) as client:
            events = [event async for event in self.stream(client)]
        self.assertEqual(self.models(), [PRIMARY])
        self.assertEqual(events[0], {"type": "delta", "text": "Primary draft"})
        self.assertEqual(events[-1]["actions"][0]["date"], "2026-11-24")
        self.assertEqual(events[-1]["execution"], {
            "guide": {"id": "ease-assistant", "version": 4}, "model": PRIMARY, "fallback": False,
        })

    async def test_provider_error_tries_fallback_with_the_same_payload_and_privacy(self):
        async with self.client(httpx.Response(429), answer("Fallback draft")) as client:
            events = [event async for event in self.stream(client)]
        self.assertEqual(self.models(), [PRIMARY, FALLBACK])
        self.assertEqual(events[0], {"type": "delta", "text": "Fallback draft"})
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(self.requests[0]["messages"], self.requests[1]["messages"])
        self.assertEqual(events[-1]["execution"]["model"], FALLBACK)
        self.assertTrue(events[-1]["execution"]["fallback"])
        guidance = self.requests[0]["messages"][0]["content"]
        self.assertIn("Lightly match the user's formality", guidance)
        self.assertIn("Do not mirror profanity, personal insults, slurs, threats, or graphic violence", guidance)
        for request in self.requests:
            self.assertEqual(request["provider"], {"data_collection": "deny", "zdr": True})

    async def test_whitespace_before_timeout_does_not_commit_to_primary(self):
        primary = StalledBody("   ")
        with patch.object(assistant, "PRIMARY_FIRST_TEXT_TIMEOUT", 0.03):
            async with self.client(httpx.Response(200, stream=primary), answer("Visible fallback")) as client:
                events = [event async for event in self.stream(client)]
        self.assertEqual(self.models(), [PRIMARY, FALLBACK])
        self.assertEqual(events[0], {"type": "delta", "text": "Visible fallback"})
        self.assertTrue(primary.closed)

    async def test_interruption_after_text_preserves_primary_and_skips_fallback(self):
        async with self.client(httpx.Response(200, content=delta("Partial draft"))) as client:
            async with aclosing(self.stream(client)) as events:
                self.assertEqual(await anext(events), {"type": "delta", "text": "Partial draft"})
                with self.assertRaises(OpenRouterRejected):
                    await anext(events)
        self.assertEqual(self.models(), [PRIMARY])

    async def test_overall_timeout_after_text_is_an_interruption(self):
        primary = StalledBody("Partial draft")
        with patch.object(assistant, "REQUEST_TIMEOUT", 0.05):
            async with self.client(httpx.Response(200, stream=primary)) as client:
                async with aclosing(self.stream(client)) as events:
                    self.assertEqual((await anext(events))["text"], "Partial draft")
                    with self.assertRaises(OpenRouterRejected):
                        await anext(events)
        self.assertEqual(self.models(), [PRIMARY])
        self.assertTrue(primary.closed)

    async def test_request_cancellation_closes_primary_without_retry(self):
        primary = StalledBody("")
        async with self.client(httpx.Response(200, stream=primary)) as client:
            async def wait_for_answer():
                async with aclosing(self.stream(client)) as events:
                    await anext(events)
            task = asyncio.create_task(wait_for_answer())
            await asyncio.wait_for(primary.waiting.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.models(), [PRIMARY])
        self.assertTrue(primary.closed)

    async def test_two_provider_failures_use_at_most_two_attempts(self):
        async with self.client(httpx.Response(503), httpx.Response(503)) as client:
            with self.assertRaises(OpenRouterUnavailable):
                await anext(self.stream(client))
        self.assertEqual(self.models(), [PRIMARY, FALLBACK])

    async def test_account_errors_and_duplicate_models_do_not_retry(self):
        for status, fallback in ((401, FALLBACK), (402, FALLBACK), (403, FALLBACK), (503, PRIMARY)):
            with self.subTest(status=status, fallback=fallback):
                self.requests.clear()
                async with self.client(httpx.Response(status)) as client:
                    with self.assertRaises(OpenRouterUnavailable):
                        await anext(self.stream(client, fallback))
                self.assertEqual(self.models(), [PRIMARY])

    async def test_account_error_within_stream_does_not_retry(self):
        async with self.client(httpx.Response(200, content=b'data: {"error":{"code":402}}\n')) as client:
            with self.assertRaises(OpenRouterUnavailable):
                await anext(self.stream(client))
        self.assertEqual(self.models(), [PRIMARY])

    async def test_fragmented_lookup_returns_provider_price_and_reported_model(self):
        def packet(function, reason=None):
            choice = {"delta": {"tool_calls": [{"index": 0, "function": function}]} if function else {}, "finish_reason": reason}
            return f"data: {json.dumps({'model': 'google/versioned-model', 'choices': [choice]})}\n\n".encode()

        content = (packet({"name": "market_quote", "arguments": '{"base":"USD",'})
                   + packet({"arguments": '"quote":"TMN"}'}) + packet(None, "tool_calls"))
        markets = AsyncMock(spec=MarketsService)
        markets.quotes.return_value = [{"price": 1234, "asOf": "2026-11-23T17:00:00Z", "stale": True}]
        payload = PAYLOAD.model_copy(update={"request_id": str(uuid4()), "prompt": "قیمت دلار؟", "locale": "fa"})
        async with self.client(httpx.Response(200, content=content)) as client:
            events = [event async for event in assistant.stream_assistant(
                client, "test", PRIMARY, payload, 1600, lookups=AssistantLookups(client, markets),
            )]
        markets.quotes.assert_awaited_once_with(("wlx:USDT/TMN",))
        self.assertNotIn("request_id", json.loads(self.requests[0]["messages"][1]["content"]))
        self.assertIn("نتونستم تأیید کنم", events[0]["text"])
        self.assertIn("USDT", events[0]["text"])
        self.assertIn("۱٬۲۳۴", events[0]["text"])
        self.assertIn("Wallex", events[0]["text"])
        self.assertEqual(events[1]["execution"]["model"], "google/versioned-model")
        self.assertEqual(events[1]["execution"]["lookup"], "market")
        self.assertEqual(events[1]["actions"], [])

    async def test_forecast_requires_city_from_the_user(self):
        async with self.client() as client:
            result = await AssistantLookups(client, AsyncMock(spec=MarketsService)).answer(
                [LookupCall("weather_forecast", '{"city":"تهران"}')], "fa", ["امروز هوا چطوره؟"],
            )
        self.assertEqual(result, (ASK_CITY["fa"], "weather"))
        self.assertEqual(self.requests, [])
