from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from threading import RLock
from typing import Any

from app.core.paths import get_data_dir
from app.services.models import BrowserSessionRecord, TaskArtifactRecord, TaskResultRecord, utc_now


class SQLiteStore:
    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or _default_db_path()
        self._lock = RLock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_db(self) -> None:
        with self._lock, self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS task_configurations (
                    task_key TEXT PRIMARY KEY,
                    config_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS task_results (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    work_item_id TEXT NOT NULL,
                    task_key TEXT NOT NULL,
                    key TEXT NOT NULL,
                    status TEXT NOT NULL,
                    message TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_task_results_task_key_created
                    ON task_results(task_key, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_task_results_run_id
                    ON task_results(run_id);

                CREATE TABLE IF NOT EXISTS task_artifacts (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    work_item_id TEXT NOT NULL,
                    task_key TEXT NOT NULL,
                    key TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_task_artifacts_task_key_created
                    ON task_artifacts(task_key, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_task_artifacts_run_id
                    ON task_artifacts(run_id);

                CREATE TABLE IF NOT EXISTS browser_sessions (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    work_item_id TEXT NOT NULL,
                    task_key TEXT NOT NULL,
                    vendor TEXT NOT NULL,
                    profile_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    debug_address TEXT NOT NULL,
                    websocket_url TEXT,
                    pid INTEGER,
                    seq INTEGER,
                    created_by_core INTEGER NOT NULL,
                    cleanup_policy TEXT NOT NULL,
                    raw_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    opened_at TEXT,
                    closed_at TEXT,
                    error TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_browser_sessions_run_id
                    ON browser_sessions(run_id);
                CREATE INDEX IF NOT EXISTS idx_browser_sessions_task_key_created
                    ON browser_sessions(task_key, created_at DESC);
                """
            )
            connection.commit()

    def save_task_configuration(self, task_key: str, config: dict[str, Any]) -> None:
        now = utc_now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO task_configurations (task_key, config_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(task_key) DO UPDATE SET
                    config_json = excluded.config_json,
                    updated_at = excluded.updated_at
                """,
                (task_key, _dumps(config), now),
            )
            connection.commit()

    def get_task_configuration(self, task_key: str) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT config_json FROM task_configurations WHERE task_key = ?",
                (task_key,),
            ).fetchone()
        if not row:
            return {}
        return _loads(str(row["config_json"]), {})

    def add_task_result(self, task_key: str, result: TaskResultRecord) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO task_results
                    (id, run_id, work_item_id, task_key, key, status, message, data_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    result.id,
                    result.run_id,
                    result.work_item_id,
                    task_key,
                    result.key,
                    result.status,
                    result.message,
                    _dumps(result.data),
                    result.created_at,
                ),
            )
            connection.commit()

    def list_task_results(self, task_key: str | None = None, run_id: str | None = None) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[str] = []
        if task_key:
            clauses.append("task_key = ?")
            params.append(task_key)
        if run_id:
            clauses.append("run_id = ?")
            params.append(run_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM task_results {where} ORDER BY created_at DESC",
                params,
            ).fetchall()
        return [_result_row_to_dict(row) for row in rows]

    def add_task_artifact(self, task_key: str, artifact: TaskArtifactRecord) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO task_artifacts
                    (id, run_id, work_item_id, task_key, key, kind, name, filename, mime_type,
                     relative_path, size_bytes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    artifact.id,
                    artifact.run_id,
                    artifact.work_item_id,
                    task_key,
                    artifact.key,
                    artifact.kind,
                    artifact.name,
                    artifact.filename,
                    artifact.mime_type,
                    artifact.relative_path,
                    artifact.size_bytes,
                    artifact.created_at,
                ),
            )
            connection.commit()

    def list_task_artifacts(self, task_key: str | None = None, run_id: str | None = None) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[str] = []
        if task_key:
            clauses.append("task_key = ?")
            params.append(task_key)
        if run_id:
            clauses.append("run_id = ?")
            params.append(run_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM task_artifacts {where} ORDER BY created_at DESC",
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def save_browser_session(self, task_key: str, session: BrowserSessionRecord) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO browser_sessions
                    (id, run_id, work_item_id, task_key, vendor, profile_id, status, debug_address,
                     websocket_url, pid, seq, created_by_core, cleanup_policy, raw_json, created_at,
                     opened_at, closed_at, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    debug_address = excluded.debug_address,
                    websocket_url = excluded.websocket_url,
                    pid = excluded.pid,
                    seq = excluded.seq,
                    raw_json = excluded.raw_json,
                    opened_at = excluded.opened_at,
                    closed_at = excluded.closed_at,
                    error = excluded.error
                """,
                (
                    session.id,
                    session.run_id,
                    session.work_item_id,
                    task_key,
                    session.vendor,
                    session.profile_id,
                    session.status,
                    session.debug_address,
                    session.websocket_url,
                    session.pid,
                    session.seq,
                    1 if session.created_by_core else 0,
                    session.cleanup_policy,
                    _dumps(session.raw),
                    session.created_at,
                    session.opened_at,
                    session.closed_at,
                    session.error,
                ),
            )
            connection.commit()

    def list_browser_sessions(self, task_key: str | None = None, run_id: str | None = None) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[str] = []
        if task_key:
            clauses.append("task_key = ?")
            params.append(task_key)
        if run_id:
            clauses.append("run_id = ?")
            params.append(run_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM browser_sessions {where} ORDER BY created_at DESC",
                params,
            ).fetchall()
        return [_browser_session_row_to_dict(row) for row in rows]


def _default_db_path() -> Path:
    if data_dir := os.getenv("NEXUS_FLOW_DATA_DIR"):
        return Path(data_dir) / "nexus-flow-v2.sqlite3"
    return get_data_dir() / "nexus-flow-v2.sqlite3"


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _loads(value: str, default: Any) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _result_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["data"] = _loads(str(data.pop("data_json")), {})
    return data


def _browser_session_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["created_by_core"] = bool(data["created_by_core"])
    data["raw"] = _loads(str(data.pop("raw_json")), {})
    return data


sqlite_store = SQLiteStore()
