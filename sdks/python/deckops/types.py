from __future__ import annotations

from collections.abc import Callable, Mapping, MutableMapping
from os import PathLike
from typing import Any, BinaryIO, Protocol, TypeAlias, TypedDict

DEFAULT_ROOT = "https://app.deckflow.com/v1"
DEFAULT_TIMEOUT = 300.0
DEFAULT_POLL_INTERVAL = 2.0
DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024
# When creating a task with files under this total size, attach them inline as `files`
# instead of async upload + `fileIds`.
INLINE_TASK_FILES_MAX_BYTES = 10 * 1024 * 1024

DECK_TASK_TYPES = (
    "file.compress",
    "image.ocr",
    "pptx.split",
    "pptx.join",
    "pptx.getFontInfo",
    "pptx.getTextShapes",
    "pptx.embedFonts",
    "convertor.ppt2image",
    "convertor.ppt2pptx",
    "convertor.ppt2pdf",
    "convertor.doc2pdf",
    "convertor.ppt2video",
    "convertor.pdf2image",
    "convertor.keynote2image",
    "convertor.keynote2html",
    "convertor.keynote2pdf",
    "convertor.html2png",
    "convertor.markdown2png",
    "convertor.html2pptx",
    "html.buildPlayer",
    "video.compress",
    "image.convertWebp",
    "image.resize",
    "pdf.pdfParse",
    "pptx.parse",
    "docx.parseTextAndImage",
    "keynote.parseTextAndImage",
    "html.getByURL",
    "generation",
    "translation",
    "revamp",
)

PARSE_TASK_TYPE_BY_EXTENSION = {
    ".pdf": "pdf.pdfParse",
    ".pptx": "pptx.parse",
    ".docx": "docx.parseTextAndImage",
    ".key": "keynote.parseTextAndImage",
}
PARSE_SUPPORTED_EXTENSIONS = tuple(PARSE_TASK_TYPE_BY_EXTENSION)

JSONValue: TypeAlias = str | int | float | bool | None | list["JSONValue"] | dict[str, "JSONValue"]
Task: TypeAlias = dict[str, Any]
TaskResult: TypeAlias = Any
UploadInput: TypeAlias = str | PathLike[str] | bytes | bytearray | memoryview | BinaryIO
TaskUploadInput: TypeAlias = UploadInput | Mapping[str, Any]
ProgressCallback: TypeAlias = Callable[[float], None]
TaskCallback: TypeAlias = Callable[[Task], None]
ErrorCallback: TypeAlias = Callable[[Exception], None]
ImageURLResolver: TypeAlias = Callable[[str], str]


class AuthUUIDStorage(Protocol):
    def get(self) -> str | None: ...

    def set(self, value: str) -> None: ...


class DeckTask(TypedDict, total=False):
    id: str
    spaceId: str
    type: str
    status: str
    fileIds: list[str]
    name: str
    params: dict[str, Any]
    preview: Any
    result: Any
    error: str | None
    createdAt: str
    updatedAt: str


class TaskListResponse(TypedDict):
    tasks: list[Task]
    total: int


class FileUploadResult(TypedDict, total=False):
    id: str
    name: str
    key: str
    bytes: int
    hash: str


class ParseResult(TypedDict, total=False):
    """``deck.parse()`` 的返回。

    ``markdown`` 系字段在 ``output`` 为 ``"markdown"`` / ``"all"`` 时出现；
    ``result`` 在 ``output`` 为 ``"ir"`` / ``"all"`` 时出现，是服务端返回体的原样透传。
    """

    taskId: str
    type: str
    markdown: str
    markdownPages: list[str]
    markdownImages: dict[str, Any]
    markdownError: str
    result: Any


Headers: TypeAlias = MutableMapping[str, str]
