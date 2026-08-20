"""``deck.parse()`` 门面：按扩展名/链接路由到对应解析任务 → 等待完成 → 取结果。

markdown 由服务端生成（slave >= 0.21.0），这里只做三件事：路由、翻译 ``output`` 档位
为 slave 的 markdown 开关、把结果分拣成 ``{"markdown": ..., "result": ...}``。
没有任何格式转换。
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

from .parse import parse_task_type_for
from .tasks import TasksClient
from .types import PARSE_SUPPORTED_EXTENSIONS, ParseResult, TaskUploadInput

#: ``output`` 档位 → slave 的 markdown 开关
_MARKDOWN_SWITCHES: dict[str, dict[str, bool]] = {
    # 只要 markdown，丢结构化结果压缩响应体
    "markdown": {"markdown": True, "markdownOnly": True},
    # 两者都要
    "all": {"markdown": True},
    # 不生成 markdown，省掉服务端一次渲染
    "ir": {},
}

#: 各任务类型认得的直通参数：SDK 侧参数名 → slave 参数名
_PASSTHROUGH: dict[str, dict[str, str]] = {
    "pdf.pdfParse": {
        "password": "password",
        "parse_profile": "parseProfile",
        "parseProfile": "parseProfile",
        "include_images": "includeImages",
        "includeImages": "includeImages",
        "markdown_meta": "markdownMeta",
        "markdownMeta": "markdownMeta",
    },
    "pptx.parse": {
        "markdown_pages": "markdownPages",
        "markdownPages": "markdownPages",
    },
    "keynote.parseTextAndImage": {
        "markdown_pages": "markdownPages",
        "markdownPages": "markdownPages",
        "stay_image_area_rate": "stayImageAreaRate",
        "stayImageAreaRate": "stayImageAreaRate",
    },
    "docx.parseTextAndImage": {},
    "html.getByURL": {},
}

#: 所有任务类型共用的直通参数
_COMMON_PASSTHROUGH = {
    "markdown_strict": "markdownStrict",
    "markdownStrict": "markdownStrict",
}


class ParseFacade:
    def __init__(self, tasks: TasksClient) -> None:
        self._tasks = tasks

    def parse(
        self,
        source: Any,
        options: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> ParseResult:
        """解析一个文件或链接。

        ``output`` 决定要 markdown（默认）、原始结构（``"ir"``）、还是两者（``"all"``）::

            deck.parse("./a.pptx")["markdown"]
            deck.parse("./a.pdf", output="ir")["result"]
            deck.parse({"url": "https://…"}, output="all")
        """
        opts: dict[str, Any] = {**dict(options or {}), **kwargs}
        output = str(opts.get("output") or "markdown")
        if output not in _MARKDOWN_SWITCHES:
            raise ValueError(f"unsupported output: {output!r}; expected 'markdown', 'ir' or 'all'")
        space_id = _value(opts, "space_id", "spaceId")
        wait = opts.get("wait")

        if isinstance(source, Mapping) and "url" in source:
            params = {
                "url": str(source["url"]),
                "mode": source.get("mode") or "runtime",
                **self._task_params("html.getByURL", output, opts),
            }
            task = self._tasks.create(type="html.getByURL", space_id=space_id, params=params)
            done = self._wait(task, wait)
            raw = self._tasks.down(str(done["id"]))
            return _to_parse_result(raw, str(done["id"]), "html.getByURL", output)

        normalized: Mapping[str, Any]
        if isinstance(source, (str, Path)):
            normalized = {"file": source}
        elif isinstance(source, Mapping):
            normalized = source
        else:
            raise self._unsupported("")

        file_id = _value(normalized, "file_id", "fileId")
        name = str(normalized.get("name") or "")
        if not name and file_id is None:
            name = self._name_for_routing(normalized.get("file"))
        task_type = parse_task_type_for(name)
        if not task_type:
            raise self._unsupported(name)

        file_source = normalized.get("file")
        if file_id is None and file_source is None:
            raise self._unsupported(name)
        task = self._tasks.create(
            type=task_type,
            space_id=space_id,
            file_ids=[str(file_id)] if file_id is not None else None,
            files=None if file_id is not None else [cast(TaskUploadInput, file_source)],
            params=self._task_params(task_type, output, opts),
        )
        done = self._wait(task, wait)
        raw = self._tasks.down(str(done["id"]))
        return _to_parse_result(raw, str(done["id"]), task_type, output)

    @staticmethod
    def _task_params(task_type: str, output: str, opts: Mapping[str, Any]) -> dict[str, Any]:
        """markdown 档位 + 该任务类型认得的直通参数。"""
        params: dict[str, Any] = dict(_MARKDOWN_SWITCHES[output])
        allowed = {**_COMMON_PASSTHROUGH, **_PASSTHROUGH.get(task_type, {})}
        for key, slave_key in allowed.items():
            if key in opts and opts[key] is not None:
                params[slave_key] = opts[key]
        return params

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
    def _unsupported(name: str) -> ValueError:
        label = f'"{name}"' if name else "input"
        supported = ", ".join(PARSE_SUPPORTED_EXTENSIONS)
        return ValueError(
            f"Cannot determine parser for {label}. Supported extensions: {supported}. "
            "Pass { name } to specify the file name."
        )


def _to_parse_result(raw: Any, task_id: str, task_type: str, output: str) -> ParseResult:
    """把服务端返回体分拣成 markdown 字段 + result。"""
    body: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
    result: ParseResult = {"taskId": task_id, "type": task_type}

    if output != "ir":
        result["markdown"] = str(body.get("markdown") or "")
        for key in ("markdownPages", "markdownImages", "markdownError"):
            if key in body:
                result[key] = body[key]  # type: ignore[literal-required]
    if output != "markdown":
        # 原样透传：'all' 下 markdown 字段同时也在这里面
        result["result"] = raw

    return result


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
