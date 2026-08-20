"""解析类任务的扩展名路由。

服务端把 slave 的解析原语原样暴露为 ttask 类型（``pdf.pdfParse`` / ``pptx.parse`` /
``docx.parseTextAndImage`` / ``keynote.parseTextAndImage`` / ``html.getByURL``），
每个都能按参数返回结构化结果、markdown、或两者兼有。

markdown 由服务端生成（slave >= 0.21.0），SDK 侧不再有任何转换逻辑。
"""

from __future__ import annotations

from .routing import extension_of, extensionOf, parse_task_type_for, parseTaskTypeFor

#: 分页 markdown 的页分隔符，``markdown.split(PAGE_SEPARATOR)`` 可还原分页
PAGE_SEPARATOR = "\n\n---\n\n"

#: 支持逐页 markdown（``markdown_pages``）的任务类型 —— 只有分页格式有
PARSE_PAGED_TASK_TYPES = frozenset({"pptx.parse", "keynote.parseTextAndImage"})

__all__ = [
    "PAGE_SEPARATOR",
    "PARSE_PAGED_TASK_TYPES",
    "extension_of",
    "extensionOf",
    "parse_task_type_for",
    "parseTaskTypeFor",
]
