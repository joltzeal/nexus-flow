from __future__ import annotations

from collections.abc import Sequence
from uuid import uuid4

from app.fingerprint_browsers.base import BrowserLaunchOptions
from app.fingerprint_browsers.factory import create_fingerprint_browser_client
from app.services.log_store import log_store
from app.services.models import BrowserSessionRecord, utc_now
from app.services.runtime_store import runtime_store
from app.services.sqlite_store import sqlite_store
from app.task_modules.base import BrowserArrangeOptions, BrowserOpenOptions, BrowserSessionInfo


class BrowserSessionService:
    async def open_for_work_item(
        self,
        *,
        run_id: str,
        work_item_id: str,
        vendor: str,
        task_key: str,
        cleanup_policy: str,
        options: BrowserOpenOptions | None = None,
    ) -> BrowserSessionInfo:
        open_options = options or BrowserOpenOptions()
        client = create_fingerprint_browser_client(vendor)
        created_by_core = False

        if open_options.profile_id:
            profile_id = open_options.profile_id
        else:
            create_payload = open_options.create_payload or {}
            profile = await client.create_profile(create_payload)
            profile_id = profile.profile_id
            created_by_core = True

        session = BrowserSessionRecord(
            id=uuid4().hex,
            run_id=run_id,
            work_item_id=work_item_id,
            vendor=vendor,
            profile_id=profile_id,
            status="opening",
            created_by_core=created_by_core,
            cleanup_policy=cleanup_policy,
        )
        runtime_store.add_session(session)
        sqlite_store.save_browser_session(task_key, session)
        await log_store.add(run_id, "debug", f"正在启动浏览器窗口：{profile_id}", work_item_id=work_item_id)

        try:
            launch = await client.start_profile(
                profile_id,
                BrowserLaunchOptions(
                    args=open_options.launch_args,
                    new_page_url=open_options.new_page_url,
                    headless=open_options.headless,
                    restore_tabs=open_options.restore_tabs,
                    delete_cache=open_options.delete_cache,
                ),
            )
        except Exception as exc:
            session = runtime_store.update_session(session.id, status="failed", error=str(exc))
            sqlite_store.save_browser_session(task_key, session)
            raise

        session = runtime_store.update_session(
            session.id,
            status="running",
            debug_address=launch.debug_address,
            websocket_url=launch.websocket_url,
            pid=launch.pid,
            seq=launch.seq,
            raw=launch.raw,
            opened_at=utc_now(),
        )
        sqlite_store.save_browser_session(task_key, session)
        await log_store.add(
            run_id,
            "info",
            f"浏览器窗口已启动：{profile_id} {launch.debug_address}",
            work_item_id=work_item_id,
            browser_session_id=session.id,
        )
        return _session_info(session)

    async def close_session(self, session_id: str, *, delete: bool = False, task_key: str) -> None:
        session = runtime_store.get_session(session_id)
        if session.status in {"closing", "closed", "deleted"}:
            return

        client = create_fingerprint_browser_client(session.vendor)

        session = runtime_store.update_session(session.id, status="closing")
        sqlite_store.save_browser_session(task_key, session)
        try:
            await client.stop_profile(session.profile_id)
        finally:
            session = runtime_store.update_session(session.id, status="closed", closed_at=utc_now())
            sqlite_store.save_browser_session(task_key, session)

        if delete:
            await client.delete_profile(session.profile_id)
            session = runtime_store.update_session(session.id, status="deleted")
            sqlite_store.save_browser_session(task_key, session)

    async def keep_open(self, session_id: str, *, task_key: str) -> None:
        session = runtime_store.update_session(session_id, cleanup_policy="keep_open")
        sqlite_store.save_browser_session(task_key, session)

    async def cleanup_run(self, run_id: str, *, task_key: str, force: bool = False) -> None:
        await self._cleanup_sessions(
            runtime_store.list_run_sessions(run_id),
            run_id=run_id,
            task_key=task_key,
            force=force,
        )

    async def cleanup_work_item(
        self,
        run_id: str,
        work_item_id: str,
        *,
        task_key: str,
        force: bool = False,
    ) -> None:
        await self._cleanup_sessions(
            [
                session
                for session in runtime_store.list_run_sessions(run_id)
                if session.work_item_id == work_item_id
            ],
            run_id=run_id,
            task_key=task_key,
            force=force,
        )

    async def _cleanup_sessions(
        self,
        sessions: Sequence[BrowserSessionRecord],
        *,
        run_id: str,
        task_key: str,
        force: bool = False,
    ) -> None:
        for session in sessions:
            if session.status not in {"running", "opening", "failed"}:
                continue
            if not force and session.cleanup_policy == "keep_open":
                continue
            delete = session.cleanup_policy == "delete" and session.created_by_core
            try:
                await self.close_session(session.id, delete=delete, task_key=task_key)
            except Exception as exc:
                failed = runtime_store.update_session(session.id, status="failed", error=str(exc))
                sqlite_store.save_browser_session(task_key, failed)
                await log_store.add(
                    run_id,
                    "warn",
                    f"清理浏览器窗口失败：{session.profile_id}，原因：{exc}",
                    browser_session_id=session.id,
                )

    async def arrange_run(
        self,
        run_id: str,
        *,
        vendor: str,
        session_ids: Sequence[str] | None = None,
        options: BrowserArrangeOptions | None = None,
    ) -> None:
        sessions = runtime_store.list_run_sessions(run_id)
        selected_ids = set(session_ids or [])
        profile_ids = [
            session.profile_id
            for session in sessions
            if session.status == "running" and (not selected_ids or session.id in selected_ids)
        ]
        if not profile_ids:
            return
        client = create_fingerprint_browser_client(vendor)
        arrange_options = options or BrowserArrangeOptions()
        await client.arrange_windows(
            profile_ids,
            start_x=arrange_options.start_x,
            start_y=arrange_options.start_y,
            width=arrange_options.width,
            height=arrange_options.height,
            col=arrange_options.col,
            space_x=arrange_options.space_x,
            space_y=arrange_options.space_y,
        )


def _session_info(session: BrowserSessionRecord) -> BrowserSessionInfo:
    return BrowserSessionInfo(
        id=session.id,
        vendor=session.vendor,
        profile_id=session.profile_id,
        status=session.status,
        debug_address=session.debug_address,
        websocket_url=session.websocket_url,
        pid=session.pid,
        seq=session.seq,
    )


browser_session_service = BrowserSessionService()
