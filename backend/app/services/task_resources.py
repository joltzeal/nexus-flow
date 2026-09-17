from __future__ import annotations

from collections.abc import Sequence

from app.services.sqlite_store import sqlite_store
from app.task_modules.base import ResourceClaim, TaskResource


class WorkItemResourceManager:
    """Core-owned, plugin-neutral resource claims for one work item."""

    def __init__(self, *, task_key: str, run_id: str, work_item_id: str) -> None:
        self.task_key = task_key
        self.run_id = run_id
        self.work_item_id = work_item_id

    async def claim(self, resource_types: Sequence[str]) -> list[ResourceClaim]:
        rows = sqlite_store.claim_task_resources(
            task_key=self.task_key,
            run_id=self.run_id,
            work_item_id=self.work_item_id,
            resource_types=list(resource_types),
        )
        return [
            ResourceClaim(
                allocation_id=str(row["allocation_id"]),
                resource=TaskResource(
                    id=str(row["id"]),
                    resource_type=str(row["resource_type"]),
                    payload=dict(row["payload"]),
                    state=str(row["state"]),
                    used=bool(row["used"]),
                ),
            )
            for row in rows
        ]

    async def mark_used(self, allocation_ids: Sequence[str]) -> None:
        sqlite_store.mark_task_resources_used(
            task_key=self.task_key,
            run_id=self.run_id,
            work_item_id=self.work_item_id,
            allocation_ids=list(allocation_ids),
        )

    async def release(self, allocation_ids: Sequence[str]) -> None:
        if not allocation_ids:
            return
        sqlite_store.release_task_resource_allocations(
            task_key=self.task_key,
            run_id=self.run_id,
            work_item_id=self.work_item_id,
            allocation_ids=list(allocation_ids),
        )

    async def release_all(self) -> None:
        sqlite_store.release_task_resource_allocations(
            task_key=self.task_key,
            run_id=self.run_id,
            work_item_id=self.work_item_id,
        )
