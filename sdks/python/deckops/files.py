from __future__ import annotations

import hashlib
import io
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote
from xml.etree import ElementTree

import httpx

from .errors import APIError
from .http_client import HTTPClient
from .types import (
    DEFAULT_CHUNK_SIZE,
    FileUploadResult,
    ProgressCallback,
    UploadInput,
)


@dataclass(frozen=True)
class _NormalizedUpload:
    name: str
    data: bytes
    hash: str
    chunk_size: int

    @property
    def size(self) -> int:
        return len(self.data)


class FilesClient:
    def __init__(self, http: HTTPClient) -> None:
        self._http = http

    def request_upload(
        self,
        *,
        name: str,
        bytes: int,
        hash: str,
        space_id: str | None = None,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
    ) -> dict[str, Any]:
        resolved_space_id = self._http.resolve_space_id(space_id)
        response = self._http.request(
            "POST",
            f"/spaces/{quote(resolved_space_id, safe='')}/file/auth",
            json={
                "name": name,
                "bytes": bytes,
                "hash": hash,
                "chunkSize": chunk_size,
            },
        )
        payload = response.json()
        if not isinstance(payload, dict):
            raise TypeError("upload authorization response must be an object")
        return payload

    def upload(
        self,
        input: UploadInput,
        *,
        space_id: str | None = None,
        name: str | None = None,
        hash: str | None = None,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        on_progress: ProgressCallback | None = None,
    ) -> FileUploadResult:
        normalized = self._normalize_input(
            input,
            name=name,
            supplied_hash=hash,
            chunk_size=chunk_size,
        )
        auth = self.request_upload(
            space_id=space_id,
            name=normalized.name,
            bytes=normalized.size,
            hash=normalized.hash,
            chunk_size=normalized.chunk_size,
        )

        upload_auth = auth.get("auth")
        if not isinstance(upload_auth, Mapping):
            if on_progress:
                on_progress(1.0)
        elif auth.get("multipart"):
            self._upload_multipart(normalized, auth, on_progress)
        else:
            self._upload_single(normalized, auth, on_progress)

        result: FileUploadResult = {
            "id": str(auth.get("id") or ""),
            "name": normalized.name,
            "bytes": normalized.size,
            "hash": normalized.hash,
        }
        key = auth.get("key")
        if isinstance(key, str):
            result["key"] = key
        return result

    @staticmethod
    def _normalize_input(
        input: UploadInput,
        *,
        name: str | None,
        supplied_hash: str | None,
        chunk_size: int,
    ) -> _NormalizedUpload:
        inferred_name: str | None = None
        data: bytes

        if isinstance(input, (str, Path)):
            path = Path(input)
            data = path.read_bytes()
            inferred_name = path.name
        elif isinstance(input, bytes):
            data = input
        elif isinstance(input, (bytearray, memoryview)):
            data = bytes(input)
        elif hasattr(input, "read"):
            stream = input
            content = stream.read()
            if isinstance(content, str):
                raise TypeError("upload stream must be opened in binary mode")
            data = bytes(content)
            stream_name = getattr(stream, "name", None)
            if isinstance(stream_name, str) and stream_name:
                inferred_name = Path(stream_name).name
        else:
            raise TypeError("upload input must be a path, bytes, memoryview, or binary stream")

        resolved_name = name or inferred_name
        if not resolved_name:
            raise ValueError("name is required when uploading binary input")
        resolved_hash = supplied_hash or hashlib.md5(data, usedforsecurity=False).hexdigest()
        return _NormalizedUpload(
            name=resolved_name,
            data=data,
            hash=resolved_hash,
            chunk_size=chunk_size or DEFAULT_CHUNK_SIZE,
        )

    @staticmethod
    def _auth_headers(auth: Mapping[str, Any]) -> dict[str, str]:
        raw_headers = auth.get("headers")
        headers = (
            {str(key): str(value) for key, value in raw_headers.items()}
            if isinstance(raw_headers, Mapping)
            else {}
        )
        authorization = auth.get("Authorization")
        if isinstance(authorization, str) and authorization:
            headers["Authorization"] = authorization
        return headers

    @staticmethod
    def _raise_for_upload(response: httpx.Response) -> None:
        if not response.is_success:
            raise APIError.from_response(response)

    def _upload_single(
        self,
        file: _NormalizedUpload,
        auth_response: Mapping[str, Any],
        on_progress: ProgressCallback | None,
    ) -> None:
        auth = auth_response.get("auth")
        if not isinstance(auth, Mapping):
            raise ValueError("missing auth in upload response")
        url = str(auth.get("url") or "")
        headers = self._auth_headers(auth)
        if auth_response.get("platform") == "oss":
            response = self._http.client.put(url, content=file.data, headers=headers)
        else:
            response = self._http.client.put(
                url,
                files={"file": (file.name, file.data)},
                headers=headers,
            )
        self._raise_for_upload(response)
        if on_progress:
            on_progress(1.0)

    def _upload_multipart(
        self,
        file: _NormalizedUpload,
        auth_response: Mapping[str, Any],
        on_progress: ProgressCallback | None,
    ) -> None:
        auth = auth_response.get("auth")
        part_auths = auth_response.get("multipartPartAuths")
        if not isinstance(auth, Mapping):
            raise ValueError("missing auth in upload response")
        if not isinstance(part_auths, list) or not part_auths:
            raise ValueError("multipart upload authorization missing")

        chunk_size = int(auth_response.get("multipartPartSize") or file.chunk_size)
        platform = str(auth_response.get("platform") or "")
        completed = 0

        def upload_part(item: tuple[int, Any]) -> dict[str, Any]:
            index, part_auth = item
            if not isinstance(part_auth, Mapping):
                raise TypeError("multipart part authorization must be an object")
            start = index * chunk_size
            chunk = file.data[start : start + chunk_size]
            headers = self._auth_headers(part_auth)
            url = str(part_auth.get("url") or "")
            if platform == "oss":
                response = self._http.client.put(url, content=chunk, headers=headers)
                self._raise_for_upload(response)
                return {
                    "partNumber": index + 1,
                    "eTag": response.headers.get("etag", "").strip('"'),
                }
            response = self._http.client.put(
                url,
                files={"file": (file.name, io.BytesIO(chunk))},
                headers=headers,
            )
            self._raise_for_upload(response)
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            return {
                "partNumber": index + 1,
                "hash": str(payload.get("hash") or "") if isinstance(payload, Mapping) else "",
            }

        results: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=5) as pool:
            for result in pool.map(upload_part, enumerate(part_auths)):
                results.append(result)
                completed += 1
                if on_progress:
                    on_progress(0.95 * completed / len(part_auths))

        results.sort(key=lambda item: int(item["partNumber"]))
        self._complete_multipart(auth, platform, results)
        if on_progress:
            on_progress(1.0)

    def _complete_multipart(
        self,
        auth: Mapping[str, Any],
        platform: str,
        parts: list[dict[str, Any]],
    ) -> None:
        url = str(auth.get("url") or "")
        headers = self._auth_headers(auth)
        if platform == "oss":
            root = ElementTree.Element("CompleteMultipartUpload")
            for item in parts:
                part = ElementTree.SubElement(root, "Part")
                ElementTree.SubElement(part, "PartNumber").text = str(item["partNumber"])
                ElementTree.SubElement(part, "ETag").text = str(item.get("eTag") or "")
            response = self._http.client.post(
                url,
                content=ElementTree.tostring(root, encoding="unicode"),
                headers=headers,
            )
        else:
            response = self._http.client.post(
                url,
                json={"parts": parts},
                headers={**headers, "Content-Type": "application/json"},
            )
        self._raise_for_upload(response)

    # TypeScript-compatible alias.
    requestUpload = request_upload


# Backward-friendly name matching the TypeScript implementation class.
FilesApi = FilesClient
