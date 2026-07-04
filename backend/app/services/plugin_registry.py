from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import ModuleType
from typing import Any

from app.core.paths import get_plugins_dir
from app.task_modules.base import AutomationTaskModule


PLUGIN_NAMESPACE = "nexus_flow_dynamic_plugins"
PLUGIN_MANIFEST = "manifest.json"


class PluginError(RuntimeError):
    pass


@dataclass(slots=True)
class PluginRecord:
    key: str
    name: str
    version: str
    description: str
    entry: str
    path: Path
    status: str = "loaded"
    error: str = ""
    task: AutomationTaskModule | None = None


class PluginRegistry:
    def __init__(self) -> None:
        self._records: dict[str, PluginRecord] = {}
        self.reload_all()

    def list_records(self) -> list[PluginRecord]:
        return sorted(self._records.values(), key=lambda record: record.key)

    def list_modules(self) -> list[AutomationTaskModule]:
        return [
            record.task
            for record in self.list_records()
            if record.status == "loaded" and record.task is not None
        ]

    def get_module(self, key: str) -> AutomationTaskModule:
        record = self._records.get(key)
        if not record or record.status != "loaded" or record.task is None:
            raise PluginError(f"Plugin task not loaded: {key}")
        return record.task

    def has_module(self, key: str) -> bool:
        record = self._records.get(key)
        return bool(record and record.status == "loaded" and record.task is not None)

    def reload_all(self) -> list[PluginRecord]:
        self._records.clear()
        plugins_dir = get_plugins_dir()
        plugins_dir.mkdir(parents=True, exist_ok=True)

        for plugin_dir in sorted(path for path in plugins_dir.iterdir() if path.is_dir()):
            self._records[plugin_dir.name] = self._load_plugin(plugin_dir)

        return self.list_records()

    def reload(self, key: str) -> PluginRecord:
        plugin_dir = get_plugins_dir() / key
        if not plugin_dir.exists():
            raise PluginError(f"Plugin not found: {key}")

        self._clear_modules(key)
        record = self._load_plugin(plugin_dir)
        self._records[record.key] = record
        return record

    def install_zip(self, archive_path: Path) -> PluginRecord:
        manifest = _read_manifest_from_zip(archive_path)
        key = _validate_plugin_key(str(manifest.get("key") or ""))
        destination = get_plugins_dir() / key
        temporary = get_plugins_dir() / f".{key}.upload"

        if temporary.exists():
            shutil.rmtree(temporary)
        temporary.mkdir(parents=True, exist_ok=True)

        try:
            _extract_zip_safely(archive_path, temporary)
            _validate_manifest_file(temporary / PLUGIN_MANIFEST)

            if destination.exists():
                shutil.rmtree(destination)
            shutil.move(str(temporary), str(destination))
        except Exception:
            if temporary.exists():
                shutil.rmtree(temporary)
            raise

        self._clear_modules(key)
        record = self._load_plugin(destination)
        self._records[record.key] = record
        return record

    def delete(self, key: str) -> None:
        key = _validate_plugin_key(key)
        plugin_dir = get_plugins_dir() / key
        if plugin_dir.exists():
            shutil.rmtree(plugin_dir)
        self._clear_modules(key)
        self._records.pop(key, None)

    def _load_plugin(self, plugin_dir: Path) -> PluginRecord:
        try:
            manifest = _validate_manifest_file(plugin_dir / PLUGIN_MANIFEST)
            key = _validate_plugin_key(str(manifest["key"]))
            entry = str(manifest.get("entry") or "module:TaskModule")
            record = PluginRecord(
                key=key,
                name=str(manifest.get("name") or key),
                version=str(manifest.get("version") or ""),
                description=str(manifest.get("description") or ""),
                entry=entry,
                path=plugin_dir,
            )
            record.task = _load_task(plugin_dir, key, entry)
            return record
        except Exception as exc:
            fallback_key = plugin_dir.name
            return PluginRecord(
                key=fallback_key,
                name=fallback_key,
                version="",
                description="",
                entry="",
                path=plugin_dir,
                status="error",
                error=str(exc),
            )

    def _clear_modules(self, key: str) -> None:
        safe_key = _safe_module_key(key)
        prefixes = (
            f"{PLUGIN_NAMESPACE}.{safe_key}",
            f"{PLUGIN_NAMESPACE}.{safe_key}.",
        )
        for module_name in list(sys.modules):
            if module_name == prefixes[0] or module_name.startswith(prefixes[1]):
                sys.modules.pop(module_name, None)


def _load_task(plugin_dir: Path, key: str, entry: str) -> AutomationTaskModule:
    module_name, _, class_name = entry.partition(":")
    if not module_name or not class_name:
        raise PluginError("Plugin entry must use 'module.path:ClassName'.")

    module_path = _resolve_module_path(plugin_dir, module_name)
    if not module_path.exists():
        raise PluginError(f"Plugin entry file not found: {module_path.name}")

    import_name = f"{PLUGIN_NAMESPACE}.{_safe_module_key(key)}.{module_name}"
    _ensure_plugin_package(key, plugin_dir)
    _ensure_parent_packages(import_name, plugin_dir)

    spec = importlib.util.spec_from_file_location(import_name, module_path)
    if not spec or not spec.loader:
        raise PluginError(f"Cannot load plugin module: {module_name}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[import_name] = module
    spec.loader.exec_module(module)

    task_class = getattr(module, class_name, None)
    if task_class is None:
        raise PluginError(f"Plugin entry class not found: {class_name}")

    task = task_class()
    if not isinstance(task, AutomationTaskModule):
        raise PluginError("Plugin task must inherit AutomationTaskModule.")
    if task.manifest.key != key:
        raise PluginError("Plugin manifest key must match task manifest key.")
    if not hasattr(task, "build_work_items"):
        raise PluginError("Plugin task must implement build_work_items(config).")
    return task


def _resolve_module_path(plugin_dir: Path, module_name: str) -> Path:
    module_parts = module_name.split(".")
    module_file = plugin_dir / Path(*module_parts).with_suffix(".py")
    if module_file.exists():
        return module_file

    package_file = plugin_dir.joinpath(*module_parts, "__init__.py")
    if package_file.exists():
        return package_file

    return module_file


def _ensure_plugin_package(key: str, plugin_dir: Path) -> None:
    root = sys.modules.get(PLUGIN_NAMESPACE)
    if root is None:
        root = ModuleType(PLUGIN_NAMESPACE)
        root.__path__ = []  # type: ignore[attr-defined]
        sys.modules[PLUGIN_NAMESPACE] = root

    package_name = f"{PLUGIN_NAMESPACE}.{_safe_module_key(key)}"
    package = ModuleType(package_name)
    package.__path__ = [str(plugin_dir)]  # type: ignore[attr-defined]
    sys.modules[package_name] = package


def _ensure_parent_packages(import_name: str, plugin_dir: Path) -> None:
    parts = import_name.split(".")
    for index in range(2, len(parts)):
        package_name = ".".join(parts[:index])
        if package_name in sys.modules:
            continue

        relative_parts = parts[2:index]
        package_path = plugin_dir.joinpath(*relative_parts)
        if not package_path.is_dir():
            continue

        package = ModuleType(package_name)
        package.__path__ = [str(package_path)]  # type: ignore[attr-defined]
        sys.modules[package_name] = package


def _validate_manifest_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise PluginError("Plugin manifest.json is missing.")

    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PluginError(f"Invalid plugin manifest.json: {exc}") from exc

    if not isinstance(manifest, dict):
        raise PluginError("Plugin manifest.json must be a JSON object.")

    _validate_plugin_key(str(manifest.get("key") or ""))
    if not str(manifest.get("entry") or "module:TaskModule").partition(":")[2]:
        raise PluginError("Plugin manifest entry must use 'module.path:ClassName'.")
    return manifest


def _read_manifest_from_zip(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        manifest_name = _find_manifest_member(archive)
        try:
            manifest = json.loads(archive.read(manifest_name).decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise PluginError(f"Invalid plugin manifest.json: {exc}") from exc

    if not isinstance(manifest, dict):
        raise PluginError("Plugin manifest.json must be a JSON object.")
    _validate_plugin_key(str(manifest.get("key") or ""))
    return manifest


def _find_manifest_member(archive: zipfile.ZipFile) -> str:
    names = [name for name in archive.namelist() if not name.endswith("/")]
    if PLUGIN_MANIFEST in names:
        return PLUGIN_MANIFEST

    candidates = [name for name in names if PurePosixPath(name).name == PLUGIN_MANIFEST]
    if len(candidates) == 1:
        return candidates[0]
    raise PluginError("Plugin zip must contain one manifest.json.")


def _extract_zip_safely(path: Path, destination: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        root_prefix = _common_root_prefix(archive.namelist())
        for member in archive.infolist():
            if member.is_dir():
                continue

            member_path = PurePosixPath(member.filename)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise PluginError(f"Unsafe plugin archive path: {member.filename}")

            relative_parts = member_path.parts
            if root_prefix and relative_parts and relative_parts[0] == root_prefix:
                relative_parts = relative_parts[1:]
            if not relative_parts:
                continue

            target = destination.joinpath(*relative_parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def _common_root_prefix(names: list[str]) -> str:
    roots = {
        PurePosixPath(name).parts[0]
        for name in names
        if name and not name.startswith("/") and len(PurePosixPath(name).parts) > 1
    }
    top_level_files = [
        name for name in names if name and not name.endswith("/") and len(PurePosixPath(name).parts) == 1
    ]
    return next(iter(roots)) if len(roots) == 1 and not top_level_files else ""


def _validate_plugin_key(key: str) -> str:
    if not key:
        raise PluginError("Plugin key is required.")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", key):
        raise PluginError("Plugin key may only contain letters, numbers, hyphens, and underscores.")
    return key


def _safe_module_key(key: str) -> str:
    return key.replace("-", "_")


plugin_registry = PluginRegistry()
