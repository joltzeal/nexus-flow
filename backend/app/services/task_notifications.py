from __future__ import annotations

from typing import Any
from uuid import uuid4

from app.services.models import utc_now
from app.services.runtime_events import runtime_event_hub


class TaskNotificationWriter:
    """One work item's interface for requesting desktop attention."""

    def __init__(
        self,
        *,
        service: "TaskNotificationService",
        run_id: str,
        work_item_id: str,
    ) -> None:
        self._service = service
        self.run_id = run_id
        self.work_item_id = work_item_id

    async def manual_action(
        self,
        *,
        title: str,
        message: str,
        speech: str = "",
        sound: str = "ding",
        dedupe_key: str = "",
        requires_ack: bool = False,
        browser_session_id: str | None = None,
    ) -> str:
        notification_id = uuid4().hex
        notification = {
            "id": notification_id,
            "run_id": self.run_id,
            "work_item_id": self.work_item_id,
            "browser_session_id": browser_session_id,
            "kind": "manual_action",
            "title": title,
            "message": message,
            "speech": speech or message,
            "sound": sound,
            "dedupe_key": dedupe_key,
            "requires_ack": requires_ack,
            "created_at": utc_now(),
        }
        return self._service.raise_notification(notification)

    async def resolve(self, notification_id: str) -> None:
        self._service.resolve_notification(self.run_id, notification_id)


class TaskNotificationService:
    """In-memory active notifications with a realtime, non-log event stream.

    Active notifications are replayed only to a newly connected notification
    socket. Unlike log history, the client deduplicates by notification id and
    therefore does not repeat audio after a reconnect.
    """

    def __init__(self) -> None:
        self._active_by_run: dict[str, dict[str, dict[str, Any]]] = {}

    def create_writer(self, *, run_id: str, work_item_id: str) -> TaskNotificationWriter:
        return TaskNotificationWriter(service=self, run_id=run_id, work_item_id=work_item_id)

    def list_active(self, run_id: str) -> list[dict[str, Any]]:
        return list(self._active_by_run.get(run_id, {}).values())

    def raise_notification(self, notification: dict[str, Any]) -> str:
        run_id = str(notification["run_id"])
        notification_id = str(notification["id"])
        active = self._active_by_run.setdefault(run_id, {})
        dedupe_key = str(notification.get("dedupe_key") or "")
        if dedupe_key:
            for existing in active.values():
                if (
                    existing.get("dedupe_key") == dedupe_key
                    and existing.get("work_item_id") == notification.get("work_item_id")
                ):
                    return str(existing["id"])

        active[notification_id] = dict(notification)
        self._publish(run_id, "raised", notification)
        return notification_id

    def resolve_notification(self, run_id: str, notification_id: str) -> None:
        notification = self._active_by_run.get(run_id, {}).pop(notification_id, None)
        if notification is None:
            return
        self._publish(run_id, "resolved", notification)
        if not self._active_by_run.get(run_id):
            self._active_by_run.pop(run_id, None)

    def clear_run(self, run_id: str) -> None:
        for notification_id in list(self._active_by_run.get(run_id, {})):
            self.resolve_notification(run_id, notification_id)

    @staticmethod
    def _publish(run_id: str, event: str, notification: dict[str, Any]) -> None:
        runtime_event_hub.publish(
            f"run:{run_id}:notifications",
            {"type": "notification", "event": event, "notification": dict(notification)},
        )


task_notification_service = TaskNotificationService()
