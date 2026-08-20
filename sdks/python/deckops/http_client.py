from __future__ import annotations

import contextlib
import re
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from typing import Any
from urllib.parse import unquote

import httpx

from .auth_uuid import resolve_auth_uuid
from .errors import RETRIABLE_STATUS_CODES, RETRY_DELAYS, APIError, is_retriable_exception
from .types import DEFAULT_ROOT, AuthUUIDStorage

AuthRefresh = str | Mapping[str, str]

_SPACE_PATH_RE = re.compile(r"/spaces/([^/?#]+)/")


class HTTPClient:
    def __init__(
        self,
        *,
        root: str = DEFAULT_ROOT,
        token: str | None = None,
        api_key: str | None = None,
        space_id: str | None = None,
        auth_uuid: str | None = None,
        auth_uuid_storage: AuthUUIDStorage | None = None,
        on_unauthorized: Callable[[], AuthRefresh] | None = None,
        on_payment_required: Callable[[], None] | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.root = (root or DEFAULT_ROOT).rstrip("/")
        self.token = token
        self.api_key = api_key
        self.space_id = space_id
        self._space_id_explicit = bool(space_id)
        self.auth_uuid = resolve_auth_uuid(auth_uuid=auth_uuid, storage=auth_uuid_storage)
        self.on_unauthorized = on_unauthorized
        self.on_payment_required = on_payment_required
        self.client = client or httpx.Client(timeout=30.0)
        self._owns_client = client is None
        self._state_lock = threading.RLock()
        self._refresh_lock = threading.Lock()
        self._guest_downgrade_lock = threading.Lock()
        self._guest_downgrade_waiters: list[threading.Event] = []
        self._guest_downgrade_error: BaseException | None = None
        self._guest_downgrade_in_flight = False
        self._auth_downgraded_to_guest = False

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def set_token(self, token: str | None) -> None:
        with self._state_lock:
            self.token = token
            if token:
                self._auth_downgraded_to_guest = False
            self._clear_auto_space_id()

    def set_api_key(self, api_key: str | None) -> None:
        with self._state_lock:
            self.api_key = api_key
            if api_key:
                self._auth_downgraded_to_guest = False
            self._clear_auto_space_id()

    def set_space_id(self, space_id: str | None) -> None:
        with self._state_lock:
            self.space_id = space_id
            self._space_id_explicit = bool(space_id)

    def _clear_auto_space_id(self) -> None:
        if not self._space_id_explicit:
            self.space_id = None

    def resolve_space_id(self, space_id: str | None = None) -> str:
        if space_id:
            return space_id
        with self._state_lock:
            if self.space_id:
                return self.space_id

        # Resolve from GET /user. Only X-Auth-UUID is required, so this works
        # for authenticated users and guests.
        response = self.request("GET", "/user")
        user = response.json()
        resolved = user.get("id") if isinstance(user, Mapping) else None
        if not isinstance(resolved, str) or not resolved:
            raise ValueError("user.self did not return an id")
        with self._state_lock:
            if not self.space_id:
                self.space_id = resolved
            return self.space_id

    def url(self, path: str) -> str:
        return f"{self.root}/{path.lstrip('/')}"

    def _auth_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "X-Auth-UUID": self.auth_uuid}
        with self._state_lock:
            if self.token:
                headers["X-Auth-Token"] = self.token
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _is_api_key_auth(self) -> bool:
        with self._state_lock:
            return bool(self.api_key and not self.token)

    def _has_credentials(self) -> bool:
        with self._state_lock:
            return bool(self.token or self.api_key)

    def _refresh(self, request_token: str | None) -> tuple[str, str | None]:
        if self.on_unauthorized is None:
            raise RuntimeError("on_unauthorized is not configured")
        with self._refresh_lock:
            with self._state_lock:
                if self.token != request_token and self.token:
                    return self.token, self.space_id
            result = self.on_unauthorized()
            if isinstance(result, str):
                next_token = result
                next_space = self.space_id
            else:
                next_token = str(result.get("token") or "")
                next_space = result.get("spaceId") or result.get("space_id") or self.space_id
            if not next_token:
                raise ValueError("on_unauthorized did not return a token")
            self.set_token(next_token)
            if next_space:
                self.set_space_id(next_space)
            return next_token, next_space

    def _ensure_guest_mode(self) -> str:
        with self._state_lock:
            if (
                self._auth_downgraded_to_guest
                and not self.token
                and not self.api_key
                and self.space_id
                and not self._guest_downgrade_in_flight
            ):
                return self.space_id

        with self._guest_downgrade_lock:
            if self._guest_downgrade_in_flight:
                waiter = threading.Event()
                self._guest_downgrade_waiters.append(waiter)
            else:
                waiter = None
                self._guest_downgrade_in_flight = True
                self._guest_downgrade_error = None
                with self._state_lock:
                    self._auth_downgraded_to_guest = True
                    self.token = None
                    self.api_key = None
                    self.space_id = None
                    self._space_id_explicit = False

        if waiter is not None:
            waiter.wait()
            if self._guest_downgrade_error is not None:
                raise self._guest_downgrade_error
            with self._state_lock:
                if not self.space_id:
                    raise RuntimeError("Failed to resolve guest space id after auth downgrade")
                return self.space_id

        try:
            # Bypass request() so a nested 401 cannot re-enter guest downgrade.
            response = self.client.request(
                "GET",
                self.url("/user"),
                headers=self._auth_headers(),
            )
            if not response.is_success:
                raise APIError.from_response(response)
            user = response.json()
            guest_space = user.get("id") if isinstance(user, Mapping) else None
            if not isinstance(guest_space, str) or not guest_space:
                raise RuntimeError("Failed to resolve guest space id after auth downgrade")
            with self._state_lock:
                self.space_id = guest_space
            return guest_space
        except BaseException as error:
            self._guest_downgrade_error = error
            raise
        finally:
            with self._guest_downgrade_lock:
                self._guest_downgrade_in_flight = False
                waiters = list(self._guest_downgrade_waiters)
                self._guest_downgrade_waiters.clear()
            for pending in waiters:
                pending.set()

    @staticmethod
    def _space_id_from_request(
        *,
        url: str,
        params: dict[str, Any] | None,
        json_body: Any,
    ) -> str | None:
        if params and isinstance(params.get("spaceId"), str):
            return params["spaceId"]
        if isinstance(json_body, Mapping) and isinstance(json_body.get("spaceId"), str):
            return json_body["spaceId"]
        match = _SPACE_PATH_RE.search(url)
        if match:
            return unquote(match.group(1))
        return None

    @staticmethod
    def _rewrite_space(
        *,
        url: str,
        params: dict[str, Any] | None,
        json_body: Any,
        old_space: str | None,
        new_space: str | None,
    ) -> tuple[str, dict[str, Any] | None, Any]:
        if not old_space or not new_space or old_space == new_space:
            return url, params, json_body
        url = url.replace(f"/spaces/{old_space}/", f"/spaces/{new_space}/")
        if params and params.get("spaceId") == old_space:
            params = {**params, "spaceId": new_space}
        if isinstance(json_body, Mapping) and json_body.get("spaceId") == old_space:
            json_body = {**json_body, "spaceId": new_space}
        return url, params, json_body

    def _handle_unauthorized(
        self,
        *,
        request_token: str | None,
        url: str,
        mutable_params: dict[str, Any] | None,
        json_body: Any,
    ) -> tuple[str, dict[str, Any] | None, Any] | None:
        """Try token refresh, then guest downgrade. Returns rewritten request parts, or None to raise."""
        old_space = self._space_id_from_request(
            url=url, params=mutable_params, json_body=json_body
        ) or self.space_id

        if self.on_unauthorized is not None and self.token and not self._is_api_key_auth():
            try:
                _, next_space = self._refresh(request_token)
                return self._rewrite_space(
                    url=url,
                    params=mutable_params,
                    json_body=json_body,
                    old_space=old_space,
                    new_space=next_space,
                )
            except Exception:
                # Refresh failed — fall through to guest mode.
                pass

        with self._state_lock:
            can_downgrade = bool(
                self.token
                or self.api_key
                or self._auth_downgraded_to_guest
                or self._guest_downgrade_in_flight
            )
        if can_downgrade:
            guest_space = self._ensure_guest_mode()
            return self._rewrite_space(
                url=url,
                params=mutable_params,
                json_body=json_body,
                old_space=old_space,
                new_space=guest_space,
            )
        return None

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        url = self.url(path)
        mutable_params = dict(params) if params else None
        json_body = json
        auth_retried = False
        payment_retried = False
        network_attempt = 0

        while True:
            if network_attempt:
                time.sleep(RETRY_DELAYS[min(network_attempt - 1, len(RETRY_DELAYS) - 1)])
            request_token = self.token
            merged_headers = {**self._auth_headers(), **dict(headers or {})}
            try:
                response = self.client.request(
                    method,
                    url,
                    params=mutable_params,
                    json=json_body,
                    headers=merged_headers,
                )
            except Exception as error:
                if (
                    isinstance(error, Exception)
                    and is_retriable_exception(error)
                    and network_attempt < len(RETRY_DELAYS)
                ):
                    network_attempt += 1
                    continue
                raise

            if response.is_success:
                return response

            base = APIError.from_response(response)
            if response.status_code == 402 and not payment_retried:
                if self.on_payment_required is None:
                    raise APIError.payment_required(base)
                payment_retried = True
                self.on_payment_required()
                network_attempt = 0
                continue

            if response.status_code == 401 and not auth_retried:
                auth_retried = True
                rewritten = self._handle_unauthorized(
                    request_token=request_token,
                    url=url,
                    mutable_params=mutable_params,
                    json_body=json_body,
                )
                if rewritten is not None:
                    url, mutable_params, json_body = rewritten
                    network_attempt = 0
                    continue
                raise base

            if response.status_code in RETRIABLE_STATUS_CODES and network_attempt < len(
                RETRY_DELAYS
            ):
                network_attempt += 1
                continue
            raise base

    @contextlib.contextmanager
    def stream(
        self,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Iterator[httpx.Response]:
        url = self.url(path)
        mutable_params = dict(params) if params else None
        auth_retried = False
        payment_retried = False
        network_attempt = 0

        while True:
            if network_attempt:
                time.sleep(RETRY_DELAYS[min(network_attempt - 1, len(RETRY_DELAYS) - 1)])
            request_token = self.token
            manager = self.client.stream(
                "GET",
                url,
                params=mutable_params,
                headers={**self._auth_headers(), **dict(headers or {})},
            )
            try:
                response = manager.__enter__()
            except Exception as error:
                if is_retriable_exception(error) and network_attempt < len(RETRY_DELAYS):
                    network_attempt += 1
                    continue
                raise

            if response.is_success:
                try:
                    yield response
                finally:
                    manager.__exit__(None, None, None)
                return

            response.read()
            base = APIError.from_response(response)
            manager.__exit__(None, None, None)
            if response.status_code == 402 and not payment_retried:
                if self.on_payment_required is None:
                    raise APIError.payment_required(base)
                payment_retried = True
                self.on_payment_required()
                network_attempt = 0
                continue
            if response.status_code == 401 and not auth_retried:
                auth_retried = True
                rewritten = self._handle_unauthorized(
                    request_token=request_token,
                    url=url,
                    mutable_params=mutable_params,
                    json_body=None,
                )
                if rewritten is not None:
                    url, mutable_params, _ = rewritten
                    network_attempt = 0
                    continue
                raise base
            if response.status_code in RETRIABLE_STATUS_CODES and network_attempt < len(
                RETRY_DELAYS
            ):
                network_attempt += 1
                continue
            raise base

    # TypeScript-compatible aliases.
    setToken = set_token
    setApiKey = set_api_key
    setSpaceId = set_space_id
    resolveSpaceId = resolve_space_id
