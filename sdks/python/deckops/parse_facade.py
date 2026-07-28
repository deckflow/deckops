from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

from .parse import (
    docx_result_to_markdown,
    html_to_markdown,
    keynote_result_to_markdown,
    parse_task_type_for,
    pdf_result_to_markdown,
    pptx_result_to_markdown,
)
from .tasks import TasksClient
from .types import PARSE_SUPPORTED_EXTENSIONS, ParseResult, TaskUploadInput


class ParseFacade:
    def __init__(self, tasks: TasksClient) -> None:
        self._tasks = tasks

    def parse(self, input: Any) -> str:
        return self.parse_detailed(input)["markdown"]

    def parse_detailed(self, input: Any) -> ParseResult:
        if isinstance(input, Mapping) and "url" in input:
            url = str(input["url"])
            task = self._tasks.create(
                type="html.getByURL",
                space_id=_value(input, "space_id", "spaceId"),
                params={"url": url, "mode": input.get("mode") or "runtime"},
            )
            done = self._wait(task, input.get("wait"))
            raw = self._tasks.down(str(done["id"]))
            html = raw.get("html") if isinstance(raw, Mapping) else ""
            return {
                "markdown": html_to_markdown(str(html or ""), url=url),
                "taskId": str(done["id"]),
                "type": "html.getByURL",
            }

        normalized: Mapping[str, Any]
        if isinstance(input, (str, Path)):
            normalized = {"file": input}
        elif isinstance(input, Mapping):
            normalized = input
        else:
            raise self._unsupported("")

        file_id = _value(normalized, "file_id", "fileId")
        name = str(normalized.get("name") or "")
        if not name and file_id is None:
            name = self._name_for_routing(normalized.get("file"))
        task_type = parse_task_type_for(name)
        if not task_type:
            raise self._unsupported(name)

        source = normalized.get("file")
        if file_id is None and source is None:
            raise self._unsupported(name)
        task = self._tasks.create(
            type=task_type,
            space_id=_value(normalized, "space_id", "spaceId"),
            file_ids=[str(file_id)] if file_id is not None else None,
            files=None if file_id is not None else [cast(TaskUploadInput, source)],
        )
        done = self._wait(task, normalized.get("wait"))
        raw = self._tasks.down(str(done["id"]))
        markdown = self._to_markdown(task_type, raw)
        return {
            "markdown": markdown,
            "taskId": str(done["id"]),
            "type": task_type,
        }

    def _wait(self, task: Mapping[str, Any], options: Any) -> dict[str, Any]:
        kwargs = _snake_options(options) if isinstance(options, Mapping) else {}
        return self._tasks.wait(str(task["id"]), **kwargs)

    @staticmethod
    def _name_for_routing(file: Any) -> str:
        if isinstance(file, (str, Path)):
            return str(file)
        if isinstance(file, Mapping):
            if file.get("name"):
                return str(file["name"])
            nested = file.get("input")
            if isinstance(nested, (str, Path)):
                return str(nested)
        name = getattr(file, "name", "")
        return str(name or "")

    @staticmethod
    def _to_markdown(task_type: str, result: Any) -> str:
        if not isinstance(result, Mapping):
            raise TypeError(f"{task_type} result must be an object")
        if task_type == "pdf.parse":
            return pdf_result_to_markdown(result)
        if task_type == "pptx.parse":
            return pptx_result_to_markdown(result)
        if task_type == "docx.parseTextAndImage":
            return docx_result_to_markdown(result)
        if task_type == "keynote.parseTextAndImage":
            return keynote_result_to_markdown(result)
        raise ValueError(f"unsupported parser task type: {task_type}")

    @staticmethod
    def _unsupported(name: str) -> ValueError:
        label = f'"{name}"' if name else "input"
        supported = ", ".join(PARSE_SUPPORTED_EXTENSIONS)
        return ValueError(
            f"Cannot determine parser for {label}. Supported extensions: {supported}. "
            "Pass { name } to specify the file name."
        )


def _value(mapping: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in mapping:
            return mapping[name]
    return None


def _snake_options(options: Mapping[str, Any]) -> dict[str, Any]:
    aliases = {
        "useEventStream": "use_event_stream",
        "onProgress": "on_progress",
        "pollInterval": "poll_interval",
    }
    return {aliases.get(key, key): value for key, value in options.items()}
