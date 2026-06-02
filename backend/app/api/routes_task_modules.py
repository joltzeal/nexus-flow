from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile

from app.schemas.tasks import (
    PluginInstallFromUrlRequest,
    PluginModuleResponse,
    PluginRepositoryCheckRequest,
    PluginRepositoryPluginResponse,
)
from app.services.plugin_registry import PluginError, PluginRecord, plugin_registry

router = APIRouter(prefix="/api/task-modules", tags=["task-modules"])
DOWNLOAD_TIMEOUT_SECONDS = 60


@router.get("", response_model=list[PluginModuleResponse])
async def list_plugin_modules() -> list[dict]:
    return [_plugin_record_to_dict(record) for record in plugin_registry.list_records()]


@router.post("/upload", response_model=PluginModuleResponse)
async def upload_plugin_module(file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="请上传 .zip 插件包。")

    suffix = Path(file.filename).suffix or ".zip"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
        temporary_path = Path(temporary.name)
        while chunk := await file.read(1024 * 1024):
            temporary.write(chunk)

    try:
        record = plugin_registry.install_zip(temporary_path)
    except PluginError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"插件上传失败：{exc}") from exc
    finally:
        temporary_path.unlink(missing_ok=True)

    return _plugin_record_to_dict(record)


@router.post("/repository/check", response_model=list[PluginRepositoryPluginResponse])
async def check_plugin_repository(payload: PluginRepositoryCheckRequest) -> list[dict]:
    repository_url = _validate_http_url(payload.repository_url, label="仓库地址")
    try:
        async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_SECONDS) as client:
            response = await client.get(repository_url)
            response.raise_for_status()
            index = response.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"读取插件仓库失败：{exc}") from exc

    if not isinstance(index, dict) or not isinstance(index.get("plugins"), list):
        raise HTTPException(status_code=400, detail="插件仓库 index.json 格式错误。")

    local_records = {record.key: record for record in plugin_registry.list_records()}
    plugins: list[dict] = []
    for item in index["plugins"]:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if not key:
            continue

        remote_version = str(item.get("version") or "").strip()
        local_record = local_records.get(key)
        local_version = local_record.version if local_record else ""
        url = str(item.get("url") or "").strip()
        file_path = str(item.get("file") or "").strip()
        if not url and file_path:
            url = urljoin(repository_url, file_path)

        plugins.append(
            {
                "key": key,
                "name": str(item.get("name") or key),
                "version": remote_version,
                "description": str(item.get("description") or ""),
                "url": url,
                "file": file_path,
                "sha256": str(item.get("sha256") or ""),
                "size": int(item.get("size") or 0),
                "changelog": str(item.get("changelog") or ""),
                "local_version": local_version,
                "installed": local_record is not None,
                "has_update": bool(
                    local_record
                    and remote_version
                    and _compare_versions(remote_version, local_version) > 0
                ),
            }
        )

    return plugins


@router.post("/repository/install", response_model=PluginModuleResponse)
async def install_plugin_from_repository(payload: PluginInstallFromUrlRequest) -> dict:
    url = _validate_http_url(payload.url, label="插件下载地址")
    suffix = Path(urlparse(url).path).suffix or ".zip"
    if suffix.lower() != ".zip":
        suffix = ".zip"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
        temporary_path = Path(temporary.name)

    try:
        digest = hashlib.sha256()
        async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_SECONDS) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                with temporary_path.open("wb") as output:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        output.write(chunk)
                        digest.update(chunk)

        expected_sha256 = payload.sha256.strip().lower()
        actual_sha256 = digest.hexdigest()
        if expected_sha256 and actual_sha256 != expected_sha256:
            raise HTTPException(
                status_code=400,
                detail=f"插件校验失败：sha256 不匹配，实际 {actual_sha256}。",
            )

        record = plugin_registry.install_zip(temporary_path)
    except HTTPException:
        raise
    except PluginError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"插件安装失败：{exc}") from exc
    finally:
        temporary_path.unlink(missing_ok=True)

    return _plugin_record_to_dict(record)


@router.post("/{key}/reload", response_model=PluginModuleResponse)
async def reload_plugin_module(key: str) -> dict:
    try:
        record = plugin_registry.reload(key)
    except PluginError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _plugin_record_to_dict(record)


@router.delete("/{key}", response_model=list[PluginModuleResponse])
async def delete_plugin_module(key: str) -> list[dict]:
    try:
        plugin_registry.delete(key)
    except PluginError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [_plugin_record_to_dict(record) for record in plugin_registry.list_records()]


@router.post("/reload", response_model=list[PluginModuleResponse])
async def reload_all_plugin_modules() -> list[dict]:
    return [_plugin_record_to_dict(record) for record in plugin_registry.reload_all()]


def _plugin_record_to_dict(record: PluginRecord) -> dict:
    return {
        "key": record.key,
        "name": record.name,
        "version": record.version,
        "description": record.description,
        "entry": record.entry,
        "status": record.status,
        "error": record.error,
    }


def _validate_http_url(value: str, *, label: str) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail=f"{label}必须是 HTTP/HTTPS URL。")
    return url


def _compare_versions(left: str, right: str) -> int:
    left_parts = _version_parts(left)
    right_parts = _version_parts(right)
    max_len = max(len(left_parts), len(right_parts))
    for index in range(max_len):
        left_part = left_parts[index] if index < len(left_parts) else (0, 0)
        right_part = right_parts[index] if index < len(right_parts) else (0, 0)
        if left_part == right_part:
            continue
        return 1 if left_part > right_part else -1
    return 0


def _version_parts(value: str) -> list[tuple[int, int | str]]:
    parts: list[tuple[int, int | str]] = []
    for part in str(value or "").replace("-", ".").split("."):
        if not part:
            continue
        parts.append((0, int(part)) if part.isdigit() else (1, part))
    return parts
