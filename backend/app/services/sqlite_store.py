from __future__ import annotations

import json
import os
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from app.core.paths import get_data_dir
from app.services.models import BrowserSessionRecord, TaskArtifactRecord, TaskResultRecord, utc_now


class SQLiteStore:
    RESOURCE_RESERVATION_TIMEOUT = timedelta(minutes=30)

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

                CREATE TABLE IF NOT EXISTS task_resources (
                    id TEXT PRIMARY KEY,
                    task_key TEXT NOT NULL,
                    resource_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'available',
                    used INTEGER NOT NULL DEFAULT 0,
                    reservation_run_id TEXT,
                    reservation_work_item_id TEXT,
                    reserved_at TEXT,
                    used_at TEXT,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_task_resources_available
                    ON task_resources(task_key, resource_type, state, created_at);

                CREATE TABLE IF NOT EXISTS task_resource_allocations (
                    id TEXT PRIMARY KEY,
                    task_key TEXT NOT NULL,
                    resource_type TEXT NOT NULL,
                    resource_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    work_item_id TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'reserved',
                    claimed_at TEXT NOT NULL,
                    used_at TEXT,
                    released_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_task_resource_allocations_owner
                    ON task_resource_allocations(task_key, run_id, work_item_id, state);

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
            resource_columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(task_resources)").fetchall()
            }
            if "used" not in resource_columns:
                connection.execute(
                    "ALTER TABLE task_resources ADD COLUMN used INTEGER NOT NULL DEFAULT 0"
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

    def list_task_resources(self, task_key: str, resource_type: str) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, resource_type, payload_json, state, used, created_at, updated_at, used_at
                FROM task_resources
                WHERE task_key = ? AND resource_type = ? AND deleted_at IS NULL
                ORDER BY created_at, id
                """,
                (task_key, resource_type),
            ).fetchall()
        return [_task_resource_row_to_dict(row) for row in rows]

    def replace_task_resources(
        self, task_key: str, resource_type: str, items: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        now = utc_now()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                existing_rows = connection.execute(
                    """
                    SELECT id, state FROM task_resources
                    WHERE task_key = ? AND resource_type = ? AND deleted_at IS NULL
                    """,
                    (task_key, resource_type),
                ).fetchall()
                existing = {str(row["id"]): str(row["state"]) for row in existing_rows}
                incoming_ids = {
                    str(item["id"])
                    for item in items
                    if isinstance(item.get("id"), str) and item["id"] in existing
                }

                reserved_ids = [
                    resource_id
                    for resource_id, state in existing.items()
                    if state == "reserved" and resource_id not in incoming_ids
                ]
                if reserved_ids:
                    raise ValueError("运行中的资料不能删除。")

                for resource_id in set(existing) - incoming_ids:
                    connection.execute(
                        """
                        UPDATE task_resources
                        SET state = 'deleted', deleted_at = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (now, now, resource_id),
                    )

                for item in items:
                    payload = item.get("payload")
                    if not isinstance(payload, dict):
                        raise ValueError("资料内容必须是对象。")
                    resource_id = item.get("id")
                    if isinstance(resource_id, str) and resource_id in existing:
                        previous = connection.execute(
                            "SELECT payload_json FROM task_resources WHERE id = ?", (resource_id,)
                        ).fetchone()
                        if existing[resource_id] == "reserved":
                            if previous and _loads(str(previous["payload_json"]), {}) == payload:
                                continue
                            raise ValueError("运行中的资料不能编辑。")
                        if existing[resource_id] == "used" and previous and _loads(str(previous["payload_json"]), {}) != payload:
                            connection.execute(
                                """
                                UPDATE task_resources
                                SET state = 'deleted', deleted_at = ?, updated_at = ?
                                WHERE id = ?
                                """,
                                (now, now, resource_id),
                            )
                            connection.execute(
                                """
                                INSERT INTO task_resources
                                    (id, task_key, resource_type, payload_json, state, created_at, updated_at)
                                VALUES (?, ?, ?, ?, 'available', ?, ?)
                                """,
                                (uuid4().hex, task_key, resource_type, _dumps(payload), now, now),
                            )
                            continue
                        connection.execute(
                            """
                            UPDATE task_resources
                            SET payload_json = ?, version = version + 1, updated_at = ?
                            WHERE id = ?
                            """,
                            (_dumps(payload), now, resource_id),
                        )
                    else:
                        connection.execute(
                            """
                            INSERT INTO task_resources
                                (id, task_key, resource_type, payload_json, state, created_at, updated_at)
                            VALUES (?, ?, ?, ?, 'available', ?, ?)
                            """,
                            (uuid4().hex, task_key, resource_type, _dumps(payload), now, now),
                        )
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        return self.list_task_resources(task_key, resource_type)

    def append_task_resources(
        self, task_key: str, resource_type: str, items: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Atomically add resource records without replacing existing records."""
        now = utc_now()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                for item in items:
                    payload = item.get("payload")
                    if not isinstance(payload, dict):
                        raise ValueError("资料内容必须是对象。")
                    connection.execute(
                        """
                        INSERT INTO task_resources
                            (id, task_key, resource_type, payload_json, state, created_at, updated_at)
                        VALUES (?, ?, ?, ?, 'available', ?, ?)
                        """,
                        (uuid4().hex, task_key, resource_type, _dumps(payload), now, now),
                    )
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        return self.list_task_resources(task_key, resource_type)

    def count_available_task_resources(self, task_key: str, resource_type: str) -> int:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS count FROM task_resources
                WHERE task_key = ? AND resource_type = ? AND state = 'available' AND deleted_at IS NULL
                """,
                (task_key, resource_type),
            ).fetchone()
        return int(row["count"] if row else 0)

    def claim_task_resources(
        self,
        *,
        task_key: str,
        run_id: str,
        work_item_id: str,
        resource_types: list[str],
    ) -> list[dict[str, Any]]:
        unique_types = list(dict.fromkeys(resource_type for resource_type in resource_types if resource_type))
        if not unique_types:
            return []

        now = utc_now()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                self._release_expired_resource_reservations(connection, now)
                claims: list[dict[str, Any]] = []
                for resource_type in unique_types:
                    row = connection.execute(
                        """
                        SELECT id, payload_json FROM task_resources
                        WHERE task_key = ? AND resource_type = ? AND state = 'available' AND deleted_at IS NULL
                        ORDER BY created_at, id
                        LIMIT 1
                        """,
                        (task_key, resource_type),
                    ).fetchone()
                    if not row:
                        raise ValueError(f"没有可用的 {resource_type} 资料。")

                    resource_id = str(row["id"])
                    updated = connection.execute(
                        """
                        UPDATE task_resources
                        SET state = 'reserved', reservation_run_id = ?, reservation_work_item_id = ?,
                            reserved_at = ?, updated_at = ?
                        WHERE id = ? AND state = 'available' AND deleted_at IS NULL
                        """,
                        (run_id, work_item_id, now, now, resource_id),
                    )
                    if updated.rowcount != 1:
                        raise RuntimeError("资料领取冲突，请重试。")

                    allocation_id = uuid4().hex
                    payload = _loads(str(row["payload_json"]), {})
                    snapshot = {"id": resource_id, "resource_type": resource_type, "payload": payload}
                    connection.execute(
                        """
                        INSERT INTO task_resource_allocations
                            (id, task_key, resource_type, resource_id, run_id, work_item_id,
                             snapshot_json, state, claimed_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)
                        """,
                        (
                            allocation_id,
                            task_key,
                            resource_type,
                            resource_id,
                            run_id,
                            work_item_id,
                            _dumps(snapshot),
                            now,
                        ),
                    )
                    claims.append({"allocation_id": allocation_id, **snapshot, "state": "reserved", "used": False})
                connection.commit()
                return claims
            except Exception:
                connection.rollback()
                raise

    def _release_expired_resource_reservations(
        self, connection: sqlite3.Connection, now: str
    ) -> None:
        cutoff = (datetime.now(UTC) - self.RESOURCE_RESERVATION_TIMEOUT).isoformat()
        rows = connection.execute(
            """
            SELECT id, resource_id FROM task_resource_allocations
            WHERE state = 'reserved' AND claimed_at < ?
            """,
            (cutoff,),
        ).fetchall()
        for row in rows:
            allocation_id = str(row["id"])
            resource_id = str(row["resource_id"])
            connection.execute(
                """
                UPDATE task_resource_allocations
                SET state = 'released', released_at = ?
                WHERE id = ? AND state = 'reserved'
                """,
                (now, allocation_id),
            )
            connection.execute(
                """
                UPDATE task_resources
                SET state = 'available', used = 0, reservation_run_id = NULL,
                    reservation_work_item_id = NULL, reserved_at = NULL, updated_at = ?
                WHERE id = ? AND state = 'reserved'
                """,
                (now, resource_id),
            )

    def mark_task_resources_used(
        self, *, task_key: str, run_id: str, work_item_id: str, allocation_ids: list[str]
    ) -> None:
        if not allocation_ids:
            return
        self._transition_task_resource_allocations(
            task_key=task_key,
            run_id=run_id,
            work_item_id=work_item_id,
            allocation_ids=allocation_ids,
            target_state="used",
        )

    def release_task_resource_allocations(
        self, *, task_key: str, run_id: str, work_item_id: str, allocation_ids: list[str] | None = None
    ) -> None:
        if allocation_ids == []:
            return
        self._transition_task_resource_allocations(
            task_key=task_key,
            run_id=run_id,
            work_item_id=work_item_id,
            allocation_ids=allocation_ids or [],
            target_state="released",
        )

    def _transition_task_resource_allocations(
        self,
        *,
        task_key: str,
        run_id: str,
        work_item_id: str,
        allocation_ids: list[str],
        target_state: str,
    ) -> None:
        if target_state not in {"used", "released"}:
            raise ValueError("不支持的资料状态。")
        now = utc_now()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                conditions = ""
                params: list[Any] = [task_key, run_id, work_item_id]
                if allocation_ids:
                    placeholders = ", ".join("?" for _ in allocation_ids)
                    conditions = f" AND id IN ({placeholders})"
                    params.extend(allocation_ids)
                rows = connection.execute(
                    f"""
                    SELECT id, resource_id FROM task_resource_allocations
                    WHERE task_key = ? AND run_id = ? AND work_item_id = ? AND state = 'reserved'{conditions}
                    """,
                    params,
                ).fetchall()
                for row in rows:
                    allocation_id = str(row["id"])
                    resource_id = str(row["resource_id"])
                    if target_state == "used":
                        connection.execute(
                            """
                            UPDATE task_resource_allocations SET state = 'used', used_at = ? WHERE id = ?
                            """,
                            (now, allocation_id),
                        )
                        connection.execute(
                            """
                            UPDATE task_resources
                            SET state = 'used', used = 1, used_at = ?, reservation_run_id = NULL,
                                reservation_work_item_id = NULL, reserved_at = NULL, updated_at = ?
                            WHERE id = ?
                            """,
                            (now, now, resource_id),
                        )
                    else:
                        connection.execute(
                            """
                            UPDATE task_resource_allocations SET state = 'released', released_at = ? WHERE id = ?
                            """,
                            (now, allocation_id),
                        )
                        connection.execute(
                            """
                            UPDATE task_resources
                            SET state = 'available', used = 0, reservation_run_id = NULL,
                                reservation_work_item_id = NULL, reserved_at = NULL, updated_at = ?
                            WHERE id = ? AND state = 'reserved'
                            """,
                            (now, resource_id),
                        )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

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


def _task_resource_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "resource_type": str(row["resource_type"]),
        "payload": _loads(str(row["payload_json"]), {}),
        "state": str(row["state"]),
        "used": bool(row["used"]),
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
        "used_at": str(row["used_at"]) if row["used_at"] else None,
    }


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
