from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Iterator, Mapping, MutableSequence, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any, cast
from urllib.parse import quote

import httpx

from .errors import APIError
from .files import FilesClient
from .http_client import HTTPClient
from .types import (
    DEFAULT_POLL_INTERVAL,
    DEFAULT_TIMEOUT,
    ErrorCallback,
    Task,
    TaskCallback,
    TaskListResponse,
    TaskResult,
    TaskUploadInput,
)

SSE_RETRY_INTERVAL = 5.0
SSE_MAX_RETRIES = 100
_TERMINAL_STATUSES = frozenset(("completed", "failed"))


class TasksClient:
    def __init__(self, http: HTTPClient, files: FilesClient | None = None) -> None:
        self._http = http
        self._files = files

    def create(
        self,
        task_type: str | None = None,
        *,
        type: str | None = None,
        space_id: str | None = None,
        file_ids: Sequence[str] | None = None,
        files: Sequence[TaskUploadInput] | None = None,
        name: str | None = None,
        params: Mapping[str, Any] | None = None,
        upload: Mapping[str, Any] | None = None,
    ) -> Task:
        resolved_type = type or task_type
        if not resolved_type:
            raise ValueError("task type is required")
        resolved_space_id = self._http.resolve_space_id(space_id)
        resolved_file_ids = list(file_ids or ())
        if files:
            if self._files is None:
                raise RuntimeError("file upload is not available for this task client")
            files_client = self._files
            defaults = dict(upload or {})

            def upload_one(item: TaskUploadInput) -> str:
                source, options = self._normalize_task_upload(item, defaults)
                result = files_client.upload(source, space_id=resolved_space_id, **options)
                return result["id"]

            with ThreadPoolExecutor(max_workers=min(5, len(files))) as pool:
                resolved_file_ids.extend(pool.map(upload_one, files))

        payload: dict[str, Any] = {
            "spaceId": resolved_space_id,
            "fileIds": resolved_file_ids,
            "type": resolved_type,
            "params": dict(params or {}),
        }
        if name:
            payload["name"] = name
        response = self._http.request("POST", "/tools/tasks", json=payload)
        result = response.json()
        if not isinstance(result, dict):
            raise TypeError("task creation response must be an object")
        return result

    @staticmethod
    def _normalize_task_upload(
        item: TaskUploadInput,
        defaults: dict[str, Any],
    ) -> tuple[Any, dict[str, Any]]:
        if isinstance(item, Mapping) and "input" in item:
            source = item["input"]
            options = {**defaults, **{key: value for key, value in item.items() if key != "input"}}
        else:
            source = item
            options = dict(defaults)

        aliases = {
            "spaceId": "space_id",
            "chunkSize": "chunk_size",
            "onProgress": "on_progress",
        }
        return source, {aliases.get(key, key): value for key, value in options.items()}

    def list(
        self,
        *,
        space_id: str | None = None,
        type: str | None = None,
        start_index: int = 0,
        max_results: int = 50,
    ) -> TaskListResponse:
        resolved_space_id = self._http.resolve_space_id(space_id)
        query: dict[str, Any] = {
            "spaceId": resolved_space_id,
            "_startIndex": start_index,
            "_maxResults": max_results,
        }
        if type:
            query["type"] = type
        response = self._http.request("GET", "/tools/tasks", params=query)
        tasks = response.json()
        if not isinstance(tasks, list):
            raise TypeError("task list response must be an array")
        raw_total = response.headers.get("x-content-record-total")
        try:
            total = int(raw_total) if raw_total is not None else len(tasks)
        except ValueError:
            total = len(tasks)
        return {"tasks": tasks, "total": total}

    def get(self, task_id: str, *, use_event_stream: bool = False) -> Task:
        headers = {"response-event-stream": "yes"} if use_event_stream else None
        response = self._http.request(
            "GET",
            f"/tools/tasks/{quote(task_id, safe='')}",
            params=self._task_query_params(),
            headers=headers,
        )
        content_type = response.headers.get("content-type", "").lower()
        if "event-stream" in content_type:
            task = next(self._tasks_from_sse_lines(response.text.splitlines()), None)
            if task is None:
                raise ValueError("event stream did not contain a valid task")
            return task
        result = response.json()
        if not isinstance(result, dict):
            raise TypeError("task detail response must be an object")
        return result

    def delete(self, task_id: str) -> None:
        self._http.request(
            "DELETE",
            f"/tools/tasks/{quote(task_id, safe='')}",
            params=self._task_query_params(),
        )

    def down(
        self,
        task_id: str,
        *,
        type: str | None = None,
    ) -> TaskResult:
        query = {"_type": type} if type else None
        response = self._http.request(
            "GET",
            f"/tools/tasks/{quote(task_id, safe='')}/download",
            params=query,
        )
        return response.json()

    def wait(
        self,
        task_id: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        use_event_stream: bool = True,
        on_progress: TaskCallback | None = None,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
    ) -> Task:
        started = time.monotonic()
        if use_event_stream:
            done = threading.Event()
            state: dict[str, Any] = {}

            def on_update(task: Task) -> None:
                if on_progress:
                    on_progress(task)
                status = task.get("status")
                if status == "completed":
                    state["task"] = task
                    done.set()
                elif status == "failed":
                    state["error"] = RuntimeError(
                        f"Task failed: {task.get('error') or 'Unknown error'}"
                    )
                    done.set()

            def on_error(error: Exception) -> None:
                state["stream_error"] = error
                done.set()

            cancel = self.subscribe(task_id, on_update=on_update, on_error=on_error)
            if done.wait(timeout):
                cancel()
                if "task" in state:
                    return cast(Task, state["task"])
                if "error" in state:
                    raise cast(Exception, state["error"])
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise TimeoutError(f"Task {task_id} did not complete within {timeout}s")
                return self._wait_with_polling(
                    task_id,
                    timeout=remaining,
                    poll_interval=poll_interval,
                    on_progress=on_progress,
                )
            cancel()
            raise TimeoutError(f"Task {task_id} did not complete within {timeout}s")

        return self._wait_with_polling(
            task_id,
            timeout=timeout,
            poll_interval=poll_interval,
            on_progress=on_progress,
        )

    def subscribe(
        self,
        task_id: str,
        *,
        on_update: TaskCallback,
        on_error: ErrorCallback | None = None,
    ) -> Callable[[], None]:
        canceled = threading.Event()
        active_lock = threading.Lock()
        active_response: MutableSequence[httpx.Response | None] = [None]

        def close_active() -> None:
            with active_lock:
                if active_response[0] is not None:
                    active_response[0].close()
                    active_response[0] = None

        def run() -> None:
            retries = 0
            while not canceled.is_set():
                try:
                    self._open_event_stream(
                        task_id,
                        on_update=on_update,
                        on_parse_error=on_error,
                        canceled=canceled,
                        active_response=active_response,
                        active_lock=active_lock,
                    )
                    return
                except Exception as error:
                    if canceled.is_set():
                        return
                    if not self._is_sse_transport_error(error) or retries >= SSE_MAX_RETRIES:
                        if on_error:
                            on_error(error)
                        return
                    retries += 1
                    if canceled.wait(SSE_RETRY_INTERVAL):
                        return

        thread = threading.Thread(target=run, name=f"deckops-sse-{task_id}", daemon=True)
        thread.start()

        def cancel() -> None:
            canceled.set()
            close_active()

        return cancel

    def _open_event_stream(
        self,
        task_id: str,
        *,
        on_update: TaskCallback,
        on_parse_error: ErrorCallback | None,
        canceled: threading.Event,
        active_response: MutableSequence[httpx.Response | None],
        active_lock: threading.Lock,
    ) -> None:
        with self._http.stream(
            f"/tools/tasks/{quote(task_id, safe='')}",
            params=self._task_query_params(),
            headers={"response-event-stream": "yes"},
        ) as response:
            with active_lock:
                active_response[0] = response
            try:
                content_type = response.headers.get("content-type", "").lower()
                if "application/json" in content_type:
                    response.read()
                    payload = response.json()
                    if not isinstance(payload, dict):
                        raise TypeError("task stream JSON response must be an object")
                    on_update(payload)
                    return
                if "event-stream" not in content_type:
                    raise ValueError(f"Unexpected Content-Type: {content_type}")

                for task in self._tasks_from_sse_lines(response.iter_lines(), on_parse_error):
                    if canceled.is_set():
                        return
                    on_update(task)
                    if task.get("status") in _TERMINAL_STATUSES:
                        return
                if not canceled.is_set():
                    raise ConnectionError("SSE connection ended before task completion")
            finally:
                with active_lock:
                    active_response[0] = None

    @staticmethod
    def _tasks_from_sse_lines(
        lines: Iterator[str] | Sequence[str],
        on_parse_error: ErrorCallback | None = None,
    ) -> Iterator[Task]:
        data_lines: list[str] = []

        def parse() -> Task | None:
            if not data_lines:
                return None
            raw = "\n".join(data_lines)
            data_lines.clear()
            try:
                task = json.loads(raw)
            except (TypeError, ValueError) as error:
                if on_parse_error:
                    on_parse_error(error)
                return None
            return task if isinstance(task, dict) else None

        for line in lines:
            if line == "":
                task = parse()
                if task is not None:
                    yield task
                continue
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip(" "))
        task = parse()
        if task is not None:
            yield task

    @staticmethod
    def _is_sse_transport_error(error: Exception) -> bool:
        if isinstance(error, APIError):
            return False
        return not (
            isinstance(error, ValueError) and str(error).startswith("Unexpected Content-Type:")
        )

    def _wait_with_polling(
        self,
        task_id: str,
        *,
        timeout: float,
        poll_interval: float,
        on_progress: TaskCallback | None,
    ) -> Task:
        started = time.monotonic()
        while True:
            if time.monotonic() - started > timeout:
                raise TimeoutError(f"Task {task_id} did not complete within {timeout}s")
            task = self.get(task_id)
            if on_progress:
                on_progress(task)
            if task.get("status") == "completed":
                return task
            if task.get("status") == "failed":
                raise RuntimeError(f"Task failed: {task.get('error') or 'Unknown error'}")
            time.sleep(poll_interval)

    def _task_query_params(self) -> dict[str, str] | None:
        return {"spaceId": self._http.space_id} if self._http.space_id else None


# TypeScript naming.
TasksApi = TasksClient
