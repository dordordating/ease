import asyncio
import json
from contextlib import aclosing
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

import httpx
from pydantic import ValidationError

from ease_api import assistant
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

    async def test_provider_error_tries_fallback_with_the_same_payload_and_privacy(self):
        async with self.client(httpx.Response(429), answer("Fallback draft")) as client:
            events = [event async for event in self.stream(client)]
        self.assertEqual(self.models(), [PRIMARY, FALLBACK])
        self.assertEqual(events[0], {"type": "delta", "text": "Fallback draft"})
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(self.requests[0]["messages"], self.requests[1]["messages"])
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
