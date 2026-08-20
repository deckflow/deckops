from .auth_uuid import (
    AUTH_UUID_FILENAME,
    AUTH_UUID_STORAGE_KEY,
    generate_auth_uuid,
    generateAuthUuid,
    is_valid_auth_uuid,
    isValidAuthUuid,
    resolve_auth_uuid,
    resolveAuthUuid,
)
from .client import DeckClient, create_deck, createDeck
from .errors import APIError
from .files import FilesApi, FilesClient
from .parse import (
    PAGE_SEPARATOR,
    PARSE_PAGED_TASK_TYPES,
    extension_of,
    extensionOf,
    parse_task_type_for,
    parseTaskTypeFor,
)
from .tasks import TasksApi, TasksClient
from .types import (
    DECK_TASK_TYPES,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_POLL_INTERVAL,
    DEFAULT_ROOT,
    DEFAULT_TIMEOUT,
    INLINE_TASK_FILES_MAX_BYTES,
    PARSE_SUPPORTED_EXTENSIONS,
    PARSE_TASK_TYPE_BY_EXTENSION,
    AuthUUIDStorage,
    DeckTask,
    FileUploadResult,
    ParseResult,
    Task,
    TaskListResponse,
)

__version__ = "0.8.0"

__all__ = [
    "APIError",
    "AUTH_UUID_FILENAME",
    "AUTH_UUID_STORAGE_KEY",
    "AuthUUIDStorage",
    "DECK_TASK_TYPES",
    "DEFAULT_CHUNK_SIZE",
    "DEFAULT_POLL_INTERVAL",
    "DEFAULT_ROOT",
    "DEFAULT_TIMEOUT",
    "INLINE_TASK_FILES_MAX_BYTES",
    "DeckClient",
    "DeckTask",
    "FileUploadResult",
    "FilesApi",
    "FilesClient",
    "PAGE_SEPARATOR",
    "PARSE_PAGED_TASK_TYPES",
    "PARSE_SUPPORTED_EXTENSIONS",
    "PARSE_TASK_TYPE_BY_EXTENSION",
    "ParseResult",
    "Task",
    "TaskListResponse",
    "TasksApi",
    "TasksClient",
    "create_deck",
    "createDeck",
    "extension_of",
    "extensionOf",
    "generate_auth_uuid",
    "generateAuthUuid",
    "is_valid_auth_uuid",
    "isValidAuthUuid",
    "parse_task_type_for",
    "parseTaskTypeFor",
    "resolve_auth_uuid",
    "resolveAuthUuid",
]
