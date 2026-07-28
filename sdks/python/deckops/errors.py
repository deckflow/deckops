from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

RETRY_DELAYS = (5.0, 10.0, 20.0)
RETRIABLE_STATUS_CODES = frozenset((502, 604))


def _request_id(headers: Mapping[str, Any] | None, data: Any) -> str | None:
    for key, value in (headers or {}).items():
        normalized = key.strip().lower().replace("_", "-")
        if normalized in {"x-request-id", "x-requestid", "request-id"}:
            text = str(value).strip()
            if text:
                return text
    if isinstance(data, Mapping):
        for key in (
            "requestId",
            "request_id",
            "RequestId",
            "xRequestId",
            "XRequestId",
            "traceId",
            "trace_id",
            "TraceId",
            "correlationId",
            "correlation_id",
        ):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _error_message(data: Any, fallback: str) -> str:
    if data is None:
        return fallback
    if isinstance(data, str):
        return f"{data[:500]}..." if len(data) > 500 else data
    if isinstance(data, Mapping):
        for key in ("message", "error", "msg"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return fallback


class APIError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        response_data: Any = None,
        request_id: str | None = None,
    ) -> None:
        self.status_code = status_code
        self.response_data = response_data
        self.request_id = request_id
        status = status_code if status_code is not None else "unknown"
        suffix = f" [X-RequestId: {request_id}]" if request_id else ""
        super().__init__(f"API Error ({status}): {message}{suffix}")

    @classmethod
    def from_response(cls, response: httpx.Response) -> APIError:
        try:
            data: Any = response.json()
        except (ValueError, UnicodeDecodeError):
            data = response.text
        request_id = _request_id(response.headers, data)
        return cls(
            _error_message(data, response.reason_phrase or "Request failed"),
            status_code=response.status_code,
            response_data=data,
            request_id=request_id,
        )

    @classmethod
    def auth_api_key(cls, base: APIError) -> APIError:
        return cls(
            "Authentication failed. Please update your API key.",
            status_code=401,
            request_id=base.request_id,
        )

    @classmethod
    def auth_token(cls, base: APIError) -> APIError:
        return cls(
            "Authentication expired. Please log in again.",
            status_code=401,
            request_id=base.request_id,
        )

    @classmethod
    def payment_required(cls, base: APIError) -> APIError:
        return cls(
            "Payment is required. Please complete checkout and try again.",
            status_code=402,
            request_id=base.request_id,
        )


def is_retriable_exception(error: Exception) -> bool:
    return isinstance(error, httpx.TransportError)
