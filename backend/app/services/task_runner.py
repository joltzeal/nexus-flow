from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

from app.services.browser_sessions import browser_session_service
from app.services.log_store import log_store
from app.services.runtime_store import runtime_store
from app.services.task_io import ArtifactWriter, ResultWriter
from app.task_modules.base import (
    BrowserArrangeOptions,
    BrowserOpenOptions,
    BrowserSessionInfo,
    TaskExecutionContext,
    TaskResult,
)
from app.task_modules.registry import get_task_module


class TaskStopRequested(asyncio.CancelledError):
    pass


class WorkItemBrowserManager:
    def __init__(self, *, run_id: str, work_item_id: str, vendor: str, task_key: str, cleanup_policy: str) -> None:
        self.run_id = run_id
        self.work_item_id = work_item_id
        self.vendor = vendor
        self.task_key = task_key
        self.cleanup_policy = cleanup_policy
        self.session_ids: list[str] = []

    async def open(self, options: BrowserOpenOptions | None = None) -> BrowserSessionInfo:
        session = await browser_session_service.open_for_work_item(
            run_id=self.run_id,
            work_item_id=self.work_item_id,
            vendor=self.vendor,
            task_key=self.task_key,
            cleanup_policy=self.cleanup_policy,
            options=options,
        )
        self.session_ids.append(session.id)
        return session

    async def close(self, session_id: str, *, delete: bool = False) -> None:
        await browser_session_service.close_session(session_id, delete=delete, task_key=self.task_key)

    async def keep_open(self, session_id: str) -> None:
        await browser_session_service.keep_open(session_id, task_key=self.task_key)

    async def arrange(
        self,
        session_ids: Sequence[str] | None = None,
        options: BrowserArrangeOptions | None = None,
    ) -> None:
        await browser_session_service.arrange_run(
            self.run_id,
            vendor=self.vendor,
            session_ids=session_ids,
            options=options,
        )


async def run_task(run_id: str) -> None:
    run = runtime_store.get_run(run_id)
    task_module = get_task_module(run.task_key)
    runtime_store.start_run(run_id)
    await log_store.add(run_id, "info", "任务开始运行。")

    queue: asyncio.Queue[str] = asyncio.Queue()
    for item in run.items:
        queue.put_nowait(item.id)

    async def worker() -> None:
        while not queue.empty():
            raise_if_stopping(run_id)
            item_id = await queue.get()
            try:
                await run_item(run_id, item_id)
            finally:
                queue.task_done()

    try:
        await asyncio.gather(*(worker() for _ in range(max(run.concurrency, 1))))
    except TaskStopRequested:
        runtime_store.cancel_pending_items(run_id)
        await log_store.add(run_id, "warn", "任务已取消，未继续执行后续任务项。")
    except asyncio.CancelledError:
        runtime_store.request_stop(run_id)
        runtime_store.cancel_pending_items(run_id)
        await log_store.add(run_id, "warn", "任务已取消。")
        raise
    except Exception as exc:
        runtime_store.fail_run(run_id, str(exc))
        await log_store.add(run_id, "error", f"任务运行失败：{exc}")
        raise
    finally:
        await browser_session_service.cleanup_run(run_id, task_key=run.task_key)
        if runtime_store.get_run(run_id).status != "failed":
            runtime_store.finish_run(run_id)
        await log_store.add(run_id, "info", f"任务结束，状态：{runtime_store.get_run(run_id).status}。")


async def run_item(run_id: str, work_item_id: str) -> None:
    run = runtime_store.get_run(run_id)
    task_module = get_task_module(run.task_key)
    item = runtime_store.start_item(run_id, work_item_id)
    # await log_store.add(run_id, "debug", f"第 {item.index} 项开始运行。", work_item_id=item.id)

    def is_stopping() -> bool:
        return runtime_store.is_stopping(run_id)

    def raise_current_if_stopping() -> None:
        raise_if_stopping(run_id)

    context = TaskExecutionContext(
        run_id=run_id,
        work_item_id=item.id,
        work_item_index=item.index,
        work_item_key=item.key,
        vendor=run.vendor,
        config=dict(run.config),
        input=dict(item.input),
        log=lambda level, message: _log_task(run_id, item.id, level, message),
        results=ResultWriter(task_key=run.task_key, run_id=run_id, work_item_id=item.id),
        artifacts=ArtifactWriter(task_key=run.task_key, run_id=run_id, work_item_id=item.id),
        browser=WorkItemBrowserManager(
            run_id=run_id,
            work_item_id=item.id,
            vendor=run.vendor,
            task_key=run.task_key,
            cleanup_policy=run.cleanup_policy,
        ),
        is_stopping=is_stopping,
        raise_if_stopping=raise_current_if_stopping,
    )

    try:
        result = await task_module.run(context)
        await _record_returned_result(context, result)
    except TaskStopRequested:
        runtime_store.cancel_pending_items(run_id)
        raise
    except Exception as exc:
        runtime_store.fail_item(run_id, item.id, str(exc))
        await log_store.add(run_id, "error", f"第 {item.index} 项失败：{exc}", work_item_id=item.id)
        return
    else:
        runtime_store.complete_item(run_id, item.id, _result_message(result))
    finally:
        await browser_session_service.cleanup_work_item(
            run_id,
            item.id,
            task_key=run.task_key,
        )


def raise_if_stopping(run_id: str) -> None:
    if runtime_store.is_stopping(run_id):
        raise TaskStopRequested("任务已请求停止。")


async def _record_returned_result(context: TaskExecutionContext, result: TaskResult | dict[str, Any] | None) -> None:
    if result is None:
        return
    if isinstance(result, TaskResult):
        await context.results.add(result.key, result.data, status=result.status, message=result.message)
        return
    if isinstance(result, dict):
        payload = dict(result)
        key = str(payload.pop("key", "output"))
        status = str(payload.pop("status", "completed"))
        message = str(payload.pop("message", ""))
        await context.results.add(key, payload, status=status, message=message)


def _result_message(result: TaskResult | dict[str, Any] | None) -> str:
    if isinstance(result, TaskResult) and result.message:
        return result.message
    if isinstance(result, dict):
        message = result.get("message")
        if isinstance(message, str) and message:
            return message
    return "任务项执行完成。"


def _log_task(run_id: str, work_item_id: str, level: str, message: str) -> asyncio.Task:
    return asyncio.create_task(log_store.add(run_id, level, message, work_item_id=work_item_id))
