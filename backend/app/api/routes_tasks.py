from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

from app.schemas.tasks import (
    BrowserSessionResponse,
    TaskArtifactResponse,
    TaskConfigurationResponse,
    TaskConfigurationSaveRequest,
    TaskModuleResponse,
    TaskResourceRecordResponse,
    TaskResourceSaveRequest,
    TaskResultResponse,
    TaskRunCreateRequest,
    TaskRunLogResponse,
    TaskRunResponse,
)
from app.services.log_store import log_store
from app.services.runtime_events import runtime_event_hub
from app.services.runtime_store import runtime_store
from app.services.sqlite_store import sqlite_store
from app.services.task_control import TaskControlError, task_control
from app.services.task_notifications import task_notification_service
from app.task_modules.registry import get_task_module, list_task_modules

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("", response_model=list[TaskModuleResponse])
async def list_tasks() -> list[dict]:
    return [_task_to_dict(task) for task in list_task_modules()]


@router.get("/configurations/{task_key}", response_model=TaskConfigurationResponse)
async def get_task_configuration(task_key: str) -> dict:
    _ensure_task(task_key)
    return {"task_key": task_key, "config": sqlite_store.get_task_configuration(task_key)}


@router.put("/configurations/{task_key}", response_model=TaskConfigurationResponse)
async def save_task_configuration(task_key: str, payload: TaskConfigurationSaveRequest) -> dict:
    _ensure_task(task_key)
    sqlite_store.save_task_configuration(task_key, payload.config)
    return {"task_key": task_key, "config": payload.config}


@router.get("/{task_key}/resources/{resource_type}", response_model=list[TaskResourceRecordResponse])
async def list_task_resources(task_key: str, resource_type: str) -> list[dict]:
    _ensure_resource_type(task_key, resource_type)
    return sqlite_store.list_task_resources(task_key, resource_type)


@router.put("/{task_key}/resources/{resource_type}", response_model=list[TaskResourceRecordResponse])
async def replace_task_resources(
    task_key: str, resource_type: str, payload: TaskResourceSaveRequest
) -> list[dict]:
    _ensure_resource_type(task_key, resource_type)
    try:
        return sqlite_store.replace_task_resources(
            task_key,
            resource_type,
            [item.model_dump() for item in payload.items],
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{task_key}/resources/{resource_type}", response_model=list[TaskResourceRecordResponse])
async def append_task_resources(
    task_key: str, resource_type: str, payload: TaskResourceSaveRequest
) -> list[dict]:
    _ensure_resource_type(task_key, resource_type)
    try:
        return sqlite_store.append_task_resources(
            task_key,
            resource_type,
            [item.model_dump() for item in payload.items],
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/runs", response_model=TaskRunResponse)
async def create_task_run(payload: TaskRunCreateRequest) -> dict:
    task = _ensure_task(payload.task_key)
    active_run = runtime_store.get_active_run()
    if active_run:
        raise HTTPException(status_code=409, detail="已有任务正在运行，请先停止当前任务。")

    try:
        build_config = dict(payload.config)
        build_config["_run_concurrency"] = payload.concurrency
        task.validate_config(build_config)
        required_resources = [
            field for field in task.manifest.config_fields if field.required and field.resource_type
        ]
        missing_resources = [
            field.resource_type
            for field in required_resources
            if not _has_usable_task_resource(task.manifest.key, field)
        ]
        if missing_resources:
            raise ValueError(f"缺少可用资料：{', '.join(missing_resources)}。")
        work_items = list(task.build_work_items(build_config))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"任务配置无法生成工作项：{exc}") from exc
    if not work_items:
        raise HTTPException(status_code=400, detail="任务没有可执行的工作项。")

    run = runtime_store.create_run(
        task_key=task.manifest.key,
        task_name=task.manifest.name,
        vendor=payload.vendor,
        concurrency=payload.concurrency,
        config=payload.config,
        work_items=work_items,
        cleanup_policy=_cleanup_policy_from_config(payload.config, payload.cleanup_policy),
    )
    try:
        await task_control.start(run.id)
    except TaskControlError as exc:
        runtime_store.fail_run(run.id, str(exc))
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return run.to_dict()


@router.post("/runs/active/stop", response_model=TaskRunResponse)
async def stop_active_task_run(force_cleanup: bool = Query(default=False)) -> dict:
    run_id = await task_control.stop(force_cleanup=force_cleanup)
    if not run_id:
        raise HTTPException(status_code=404, detail="没有正在运行的任务。")
    return runtime_store.get_run(run_id).to_dict()


@router.post("/runs/{run_id}/stop", response_model=TaskRunResponse)
async def stop_task_run(run_id: str, force_cleanup: bool = Query(default=False)) -> dict:
    _ensure_run(run_id)
    stopped_run_id = await task_control.stop(run_id, force_cleanup=force_cleanup)
    if not stopped_run_id:
        raise HTTPException(status_code=404, detail="没有正在运行的任务。")
    return runtime_store.get_run(stopped_run_id).to_dict()


@router.get("/runs", response_model=list[TaskRunResponse])
async def list_task_runs() -> list[dict]:
    return [run.to_dict() for run in runtime_store.list_runs()]


@router.websocket("/runs/ws")
async def stream_task_runs(websocket: WebSocket) -> None:
    await websocket.accept()
    for run in runtime_store.list_runs():
        await websocket.send_json(run.to_dict())

    queue = runtime_event_hub.subscribe("runs")
    try:
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        runtime_event_hub.unsubscribe("runs", queue)


@router.get("/runs/{run_id}", response_model=TaskRunResponse)
async def get_task_run(run_id: str) -> dict:
    return _ensure_run(run_id).to_dict()


@router.get("/runs/{run_id}/logs", response_model=list[TaskRunLogResponse])
async def get_task_run_logs(run_id: str, limit: int = Query(default=1000, ge=1, le=10000)) -> list[dict]:
    _ensure_run(run_id)
    return log_store.list(run_id, limit=limit)


@router.websocket("/runs/{run_id}/logs/ws")
async def stream_task_run_logs(websocket: WebSocket, run_id: str) -> None:
    await websocket.accept()
    try:
        _ensure_run(run_id)
    except HTTPException:
        await websocket.close(code=4404, reason="Task run not found.")
        return

    for log in log_store.list(run_id, limit=1000):
        await websocket.send_json(log)

    queue = runtime_event_hub.subscribe(f"run:{run_id}:logs")
    try:
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        runtime_event_hub.unsubscribe(f"run:{run_id}:logs", queue)


@router.websocket("/runs/{run_id}/notifications/ws")
async def stream_task_run_notifications(websocket: WebSocket, run_id: str) -> None:
    await websocket.accept()
    try:
        _ensure_run(run_id)
    except HTTPException:
        await websocket.close(code=4404, reason="Task run not found.")
        return

    # Deliver only unresolved attention requests when a client connects. They
    # are not mixed into persisted log history, avoiding repeated TTS on a log
    # socket reconnect.
    for notification in task_notification_service.list_active(run_id):
        await websocket.send_json(
            {"type": "notification", "event": "raised", "notification": notification}
        )

    queue = runtime_event_hub.subscribe(f"run:{run_id}:notifications")
    try:
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        runtime_event_hub.unsubscribe(f"run:{run_id}:notifications", queue)


@router.get("/runs/{run_id}/browser-sessions", response_model=list[BrowserSessionResponse])
async def list_run_browser_sessions(run_id: str) -> list[dict]:
    _ensure_run(run_id)
    return sqlite_store.list_browser_sessions(run_id=run_id)


@router.get("/runs/{run_id}/results", response_model=list[TaskResultResponse])
async def list_run_results(run_id: str) -> list[dict]:
    _ensure_run(run_id)
    return sqlite_store.list_task_results(run_id=run_id)


@router.get("/runs/{run_id}/artifacts", response_model=list[TaskArtifactResponse])
async def list_run_artifacts(run_id: str) -> list[dict]:
    _ensure_run(run_id)
    return sqlite_store.list_task_artifacts(run_id=run_id)


@router.get("/{task_key}/results", response_model=list[TaskResultResponse])
async def list_task_results(task_key: str) -> list[dict]:
    _ensure_task(task_key)
    return sqlite_store.list_task_results(task_key=task_key)


@router.get("/{task_key}/artifacts", response_model=list[TaskArtifactResponse])
async def list_task_artifacts(task_key: str) -> list[dict]:
    _ensure_task(task_key)
    return sqlite_store.list_task_artifacts(task_key=task_key)


@router.get("/{task_key}/browser-sessions", response_model=list[BrowserSessionResponse])
async def list_task_browser_sessions(task_key: str) -> list[dict]:
    _ensure_task(task_key)
    return sqlite_store.list_browser_sessions(task_key=task_key)


def _task_to_dict(task) -> dict:
    manifest = task.manifest
    return {
        "key": manifest.key,
        "name": manifest.name,
        "description": manifest.description,
        "config_fields": [asdict(field) for field in manifest.config_fields],
        "results": [asdict(result) for result in manifest.results],
        "artifacts": [asdict(artifact) for artifact in manifest.artifacts],
        "browser": asdict(manifest.browser),
    }


def _cleanup_policy_from_config(config: dict, default: str) -> str:
    value = config.get("cleanup_policy", default)
    if value in {"keep_open", "close", "delete"}:
        return str(value)
    return default


def _ensure_task(task_key: str):
    try:
        return get_task_module(task_key)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _ensure_resource_type(task_key: str, resource_type: str) -> None:
    task = _ensure_task(task_key)
    if not any(field.resource_type == resource_type for field in task.manifest.config_fields):
        raise HTTPException(status_code=404, detail=f"任务 {task_key} 没有 {resource_type} 资料类型。")


def _has_usable_task_resource(task_key: str, field) -> bool:
    records = sqlite_store.list_task_resources(task_key, field.resource_type)
    for record in records:
        if record["state"] != "available":
            continue
        payload = record["payload"]
        if field.field_type == "table":
            if field.table_columns and all(str(payload.get(column, "")).strip() for column in field.table_columns):
                return True
            continue
        if field.field_type == "textarea":
            if str(payload.get("value", "")).strip():
                return True
            continue
        if payload:
            return True
    return False


def _ensure_run(run_id: str):
    try:
        return runtime_store.get_run(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Task run not found.") from exc
