from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from deckops import DEFAULT_ROOT, APIError, create_deck
from deckops import http_client as http_client_module

TEST_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"


def _client(handler: Callable[[httpx.Request], httpx.Response], **options: Any):
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return create_deck(
        {
            "root": "http://localhost:3000/api",
            "token": "token-1",
            "space_id": "space-1",
            "auth_uuid": TEST_UUID,
            "http_client": http,
            **options,
        }
    )


def test_default_root() -> None:
    deck = create_deck(auth_uuid=TEST_UUID)
    try:
        assert deck.root == DEFAULT_ROOT
    finally:
        deck.close()


def test_task_shortcut_sends_auth_and_schema_aligned_payload() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Auth-Token"] == "token-1"
        assert request.headers["X-Auth-UUID"] == TEST_UUID
        body = json.loads(request.content)
        assert body == {
            "spaceId": "space-1",
            "fileIds": ["file-1"],
            "type": "convertor.ppt2pdf",
            "params": {},
            "name": "slides",
        }
        return httpx.Response(
            200,
            json={
                "id": "task-1",
                "spaceId": "space-1",
                "type": "convertor.ppt2pdf",
                "status": "pending",
            },
        )

    deck = _client(handler)
    task = deck.convert_ppt_to_pdf(file_ids=["file-1"], name="slides")
    assert task["id"] == "task-1"


def test_space_id_is_resolved_from_user_profile() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/user"):
            return httpx.Response(200, json={"id": "space-from-user"})
        body = json.loads(request.content)
        assert body["spaceId"] == "space-from-user"
        return httpx.Response(
            200,
            json={
                "id": "task-1",
                "spaceId": "space-from-user",
                "type": "image.ocr",
                "status": "pending",
            },
        )

    http = httpx.Client(transport=httpx.MockTransport(handler))
    deck = create_deck(
        root="http://localhost:3000/api",
        token="token-1",
        auth_uuid=TEST_UUID,
        http_client=http,
    )
    assert deck.image_ocr(file_ids=["file-1"])["spaceId"] == "space-from-user"


def test_upload_hashes_bytes_and_task_helper_uses_uploaded_id() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/file/auth"):
            body = json.loads(request.content)
            assert body["name"] == "slides.pptx"
            assert body["bytes"] == 3
            assert body["hash"] == "900150983cd24fb0d6963f7d28e17f72"
            return httpx.Response(
                200,
                json={
                    "id": "uploaded-1",
                    "key": "files/slides.pptx",
                    "hash": body["hash"],
                    "platform": "oss",
                    "multipart": False,
                },
            )
        body = json.loads(request.content)
        seen.extend(body["fileIds"])
        return httpx.Response(
            200,
            json={
                "id": "task-1",
                "spaceId": "space-1",
                "type": "convertor.ppt2pdf",
                "status": "pending",
            },
        )

    deck = _client(handler)
    deck.convert_ppt_to_pdf(
        file_ids=["existing"],
        files=[{"input": b"abc", "name": "slides.pptx"}],
    )
    assert seen == ["existing", "uploaded-1"]


def test_multipart_oss_upload_completes_sorted_parts() -> None:
    completed_xml = ""
    progress: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal completed_xml
        if request.url.path.endswith("/file/auth"):
            return httpx.Response(
                200,
                json={
                    "id": "file-1",
                    "key": "files/a.bin",
                    "hash": "hash",
                    "platform": "oss",
                    "multipart": True,
                    "multipartPartSize": 2,
                    "multipartPartAuths": [
                        {"url": "https://upload.test/part/1", "headers": {}},
                        {"url": "https://upload.test/part/2", "headers": {}},
                    ],
                    "auth": {"url": "https://upload.test/complete", "headers": {}},
                },
            )
        if request.url.path.startswith("/part/"):
            part_number = request.url.path.rsplit("/", 1)[-1]
            return httpx.Response(200, headers={"etag": f'"etag-{part_number}"'})
        if request.url.path == "/complete":
            completed_xml = request.content.decode()
            return httpx.Response(200)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    deck = _client(handler)
    uploaded = deck.files.upload(
        b"abcd",
        name="a.bin",
        on_progress=progress.append,
    )
    assert uploaded["id"] == "file-1"
    assert "<PartNumber>1</PartNumber><ETag>etag-1</ETag>" in completed_xml
    assert "<PartNumber>2</PartNumber><ETag>etag-2</ETag>" in completed_xml
    assert progress[-1] == 1.0


def test_list_get_down_delete_and_polling_wait() -> None:
    deleted = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal deleted
        if request.method == "DELETE":
            deleted = True
            return httpx.Response(204)
        if request.url.path.endswith("/download"):
            return httpx.Response(200, json=[["out.pdf", 10, "hash"]])
        if request.url.path.endswith("/tools/tasks"):
            return httpx.Response(
                200,
                json=[{"id": "task-1", "status": "pending"}],
                headers={"x-content-record-total": "1"},
            )
        return httpx.Response(
            200,
            json={
                "id": "task-1",
                "spaceId": "space-1",
                "type": "image.ocr",
                "status": "completed",
            },
            headers={"content-type": "application/json"},
        )

    deck = _client(handler)
    assert deck.tasks.list()["total"] == 1
    assert deck.tasks.get("task-1")["status"] == "completed"
    assert deck.tasks.wait("task-1", use_event_stream=False, timeout=1)["status"] == "completed"
    assert deck.tasks.down("task-1")[0][0] == "out.pdf"
    deck.tasks.delete("task-1")
    assert deleted


def test_sse_wait_reads_terminal_event() -> None:
    event = {
        "id": "task-stream",
        "spaceId": "space-1",
        "type": "image.ocr",
        "status": "completed",
    }

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=f"data: {json.dumps(event)}\n\n",
            headers={"content-type": "text/event-stream"},
        )

    deck = _client(handler)
    assert deck.tasks.wait("task-stream", timeout=2)["status"] == "completed"


def test_unauthorized_refreshes_token_and_rewrites_space_id() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if request.headers.get("X-Auth-Token") == "old-token":
            return httpx.Response(401, json={"message": "expired"})
        assert request.headers["X-Auth-Token"] == "new-token"
        assert request.url.params["spaceId"] == "space-new"
        return httpx.Response(
            200,
            json={"id": "task-1", "spaceId": "space-new", "status": "completed"},
            headers={"content-type": "application/json"},
        )

    http = httpx.Client(transport=httpx.MockTransport(handler))
    deck = create_deck(
        root="http://localhost:3000/api",
        token="old-token",
        space_id="space-old",
        auth_uuid=TEST_UUID,
        http_client=http,
        on_unauthorized=lambda: {"token": "new-token", "spaceId": "space-new"},
    )
    assert deck.tasks.get("task-1")["spaceId"] == "space-new"
    assert calls == 2


def test_api_error_includes_request_id_and_specific_auth_guidance() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"message": "invalid key"},
            headers={"x-request-id": "req-1"},
        )

    http = httpx.Client(transport=httpx.MockTransport(handler))
    deck = create_deck(
        root="http://localhost:3000/api",
        api_key="key-1",
        space_id="space-1",
        auth_uuid=TEST_UUID,
        http_client=http,
    )
    with pytest.raises(APIError) as caught:
        deck.tasks.get("task-1")
    assert caught.value.status_code == 401
    assert "API key" in str(caught.value)
    assert "req-1" in str(caught.value)


def test_retries_502_three_times_before_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(http_client_module, "RETRY_DELAYS", (0.0, 0.0, 0.0))
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls <= 3:
            return httpx.Response(502, json={"message": "bad gateway"})
        return httpx.Response(
            200,
            json={"id": "task-1", "status": "completed"},
            headers={"content-type": "application/json"},
        )

    deck = _client(handler)
    assert deck.tasks.get("task-1")["id"] == "task-1"
    assert calls == 4


def test_payment_callback_is_invoked_once_then_request_retries() -> None:
    calls = 0
    checkout_calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(402, json={"message": "payment required"})
        return httpx.Response(
            200,
            json={"id": "task-1", "status": "completed"},
            headers={"content-type": "application/json"},
        )

    def checkout() -> None:
        nonlocal checkout_calls
        checkout_calls += 1

    deck = _client(handler, on_payment_required=checkout)
    assert deck.tasks.get("task-1")["status"] == "completed"
    assert checkout_calls == 1


def _parse_handler(task_type: str, download: dict[str, Any], seen: list[dict[str, Any]]):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            body = json.loads(request.content)
            seen.append(body)
            assert body["type"] == task_type
            return httpx.Response(200, json={"id": "parse-1", "status": "pending"})
        if request.url.path.endswith("/download"):
            return httpx.Response(200, json=download)
        return httpx.Response(
            200,
            json={"id": "parse-1", "status": "completed"},
            headers={"content-type": "application/json"},
        )

    return handler


def test_parse_facade_routes_and_defaults_to_markdown_only() -> None:
    seen: list[dict[str, Any]] = []
    deck = _client(_parse_handler("pdf.pdfParse", {"markdown": "# 解析完成"}, seen))
    result = deck.parse(
        {
            "file_id": "file-1",
            "name": "document.pdf",
            "wait": {"use_event_stream": False},
        }
    )

    assert seen[0]["fileIds"] == ["file-1"]
    assert seen[0]["params"] == {"markdown": True, "markdownOnly": True}
    assert result == {
        "taskId": "parse-1",
        "type": "pdf.pdfParse",
        "markdown": "# 解析完成",
    }


def test_parse_output_ir_skips_markdown_and_returns_raw() -> None:
    seen: list[dict[str, Any]] = []
    raw = {"document": {"elements": []}, "images": []}
    deck = _client(_parse_handler("pdf.pdfParse", raw, seen))
    result = deck.parse(
        {"file_id": "file-1", "name": "a.pdf", "wait": {"use_event_stream": False}},
        output="ir",
    )

    assert seen[0]["params"] == {}
    assert result["result"] == raw
    assert "markdown" not in result


def test_parse_output_all_passes_through_task_params() -> None:
    seen: list[dict[str, Any]] = []
    raw = {"slides": [{}], "markdown": "# a", "markdownPages": ["# a"]}
    deck = _client(_parse_handler("pptx.parse", raw, seen))
    result = deck.parse(
        {"file_id": "file-1", "name": "a.pptx", "wait": {"use_event_stream": False}},
        output="all",
        markdown_pages=True,
        markdown_strict=True,
    )

    assert seen[0]["params"] == {
        "markdown": True,
        "markdownPages": True,
        "markdownStrict": True,
    }
    assert result["markdown"] == "# a"
    assert result["markdownPages"] == ["# a"]
    assert result["result"] == raw


def test_parse_drops_params_the_task_type_does_not_accept() -> None:
    seen: list[dict[str, Any]] = []
    deck = _client(_parse_handler("docx.parseTextAndImage", {"markdown": ""}, seen))
    deck.parse(
        {"file_id": "file-1", "name": "a.docx", "wait": {"use_event_stream": False}},
        markdown_pages=True,
        stay_image_area_rate=0.08,
    )

    assert seen[0]["params"] == {"markdown": True, "markdownOnly": True}


def test_parse_link_sends_url_mode_and_markdown_switches() -> None:
    seen: list[dict[str, Any]] = []
    deck = _client(_parse_handler("html.getByURL", {"markdown": "# page"}, seen))
    result = deck.parse(
        {"url": "https://example.com/a", "mode": "source"},
        wait={"use_event_stream": False},
    )

    assert seen[0]["params"] == {
        "url": "https://example.com/a",
        "mode": "source",
        "markdown": True,
        "markdownOnly": True,
    }
    assert result["type"] == "html.getByURL"
    assert result["markdown"] == "# page"


def test_parse_rejects_unsupported_extension() -> None:
    deck = _client(_parse_handler("pdf.pdfParse", {}, []))
    with pytest.raises(ValueError, match=r"Supported extensions: \.pdf, \.pptx, \.docx, \.key"):
        deck.parse("./a.txt")
