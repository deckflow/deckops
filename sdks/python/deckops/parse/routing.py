from __future__ import annotations

from pathlib import PurePath
from urllib.parse import urlsplit

from ..types import PARSE_TASK_TYPE_BY_EXTENSION


def extension_of(name_or_path: str) -> str:
    clean = urlsplit(name_or_path).path
    name = PurePath(clean.replace("\\", "/")).name
    if not name or name.startswith(".") and name.count(".") == 1:
        return ""
    return PurePath(name).suffix.lower()


def parse_task_type_for(name_or_path: str) -> str | None:
    return PARSE_TASK_TYPE_BY_EXTENSION.get(extension_of(name_or_path))


extensionOf = extension_of
parseTaskTypeFor = parse_task_type_for
