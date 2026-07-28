from __future__ import annotations

import os
import re
import threading
import uuid
from pathlib import Path
from typing import TypeGuard

from .types import AuthUUIDStorage

AUTH_UUID_STORAGE_KEY = "df_uuid"
AUTH_UUID_FILENAME = "auth-uuid"
_UUID_V4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_cache_lock = threading.Lock()
_default_uuid: str | None = None


def is_valid_auth_uuid(value: str | None) -> TypeGuard[str]:
    return isinstance(value, str) and _UUID_V4_RE.fullmatch(value) is not None


def generate_auth_uuid() -> str:
    return str(uuid.uuid4())


def _config_dir() -> Path:
    configured = os.getenv("DECKOPS_CONFIG_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".deckops"


def _read_default() -> str | None:
    try:
        value = (_config_dir() / AUTH_UUID_FILENAME).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value if is_valid_auth_uuid(value) else None


def _write_default(value: str) -> None:
    try:
        directory = _config_dir()
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = directory / AUTH_UUID_FILENAME
        target.write_text(value, encoding="utf-8")
        target.chmod(0o600)
    except OSError:
        # Read-only filesystems are valid for containers; the in-process cache still works.
        pass


def resolve_auth_uuid(
    *,
    auth_uuid: str | None = None,
    storage: AuthUUIDStorage | None = None,
) -> str:
    if is_valid_auth_uuid(auth_uuid):
        return auth_uuid

    env_value = os.getenv("DECKOPS_AUTH_UUID")
    if is_valid_auth_uuid(env_value):
        return env_value

    if storage is not None:
        stored = storage.get()
        if is_valid_auth_uuid(stored):
            return stored
        generated = generate_auth_uuid()
        storage.set(generated)
        return generated

    global _default_uuid
    with _cache_lock:
        if is_valid_auth_uuid(_default_uuid):
            return _default_uuid
        stored = _read_default()
        if stored:
            _default_uuid = stored
            return stored
        generated = generate_auth_uuid()
        _write_default(generated)
        _default_uuid = generated
        return generated


def _reset_auth_uuid_cache_for_tests() -> None:
    global _default_uuid
    with _cache_lock:
        _default_uuid = None


# TypeScript-compatible aliases.
isValidAuthUuid = is_valid_auth_uuid
generateAuthUuid = generate_auth_uuid
resolveAuthUuid = resolve_auth_uuid
