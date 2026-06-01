from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol


TaskFieldType = Literal["text", "password", "number", "textarea", "select", "multi-select", "checkbox"]
LogLevel = Literal["info", "warn", "error", "debug", "verbose"]
BrowserCleanupAction = Literal["keep_open", "close", "delete"]


@dataclass(slots=True)
class TaskConfigField:
    key: str
    label: str
    block: str = "general"
    field_type: TaskFieldType = "text"
    required: bool = False
    description: str = ""
    placeholder: str = ""
    default: Any = None
    options: list[str] = field(default_factory=list)


@dataclass(slots=True)
class TaskResultDefinition:
    key: str
    label: str
    description: str = ""


@dataclass(slots=True)
class TaskArtifactDefinition:
    key: str
    label: str
    kind: str = "file"
    required: bool = False
    description: str = ""


@dataclass(slots=True)
class BrowserRequirement:
    required: bool = False
    max_sessions: int | None = None


@dataclass(slots=True)
class TaskModuleManifest:
    key: str
    name: str
    description: str
    config_fields: list[TaskConfigField]
    results: list[TaskResultDefinition] = field(default_factory=list)
    artifacts: list[TaskArtifactDefinition] = field(default_factory=list)
    browser: BrowserRequirement = field(default_factory=BrowserRequirement)


@dataclass(slots=True)
class WorkItemSpec:
    key: str
    input: dict[str, Any] = field(default_factory=dict)
    label: str = ""


@dataclass(slots=True)
class TaskResult:
    key: str = "output"
    data: dict[str, Any] = field(default_factory=dict)
    status: str = "completed"
    message: str = ""


@dataclass(slots=True)
class BrowserOpenOptions:
    profile_id: str | None = None
    create_payload: dict[str, Any] | None = None
    launch_args: list[str] = field(default_factory=list)
    new_page_url: str | None = None
    headless: bool = False
    restore_tabs: bool = False
    delete_cache: bool = False


@dataclass(slots=True)
class BrowserArrangeOptions:
    start_x: int = 0
    start_y: int = 0
    width: int = 500
    height: int = 950
    col: int = 3
    space_x: int = -200
    space_y: int = 0


@dataclass(slots=True)
class BrowserSessionInfo:
    id: str
    vendor: str
    profile_id: str
    status: str
    debug_address: str = ""
    websocket_url: str | None = None
    pid: int | None = None
    seq: int | None = None


class ResultWriter(Protocol):
    async def add(
        self,
        key: str,
        data: dict[str, Any],
        *,
        status: str = "completed",
        message: str = "",
    ) -> str:
        ...


class ArtifactWriter(Protocol):
    async def save_bytes(
        self,
        key: str,
        filename: str,
        content: bytes,
        *,
        kind: str = "file",
        mime_type: str = "application/octet-stream",
        name: str = "",
    ) -> str:
        ...

    async def save_text(
        self,
        key: str,
        filename: str,
        content: str,
        *,
        kind: str = "text",
        mime_type: str = "text/plain",
        name: str = "",
    ) -> str:
        ...


class BrowserSessionManager(Protocol):
    async def open(self, options: BrowserOpenOptions | None = None) -> BrowserSessionInfo:
        ...

    async def close(self, session_id: str, *, delete: bool = False) -> None:
        ...

    async def keep_open(self, session_id: str) -> None:
        ...

    async def arrange(
        self,
        session_ids: Sequence[str] | None = None,
        options: BrowserArrangeOptions | None = None,
    ) -> None:
        ...


@dataclass(slots=True)
class TaskExecutionContext:
    run_id: str
    work_item_id: str
    work_item_index: int
    work_item_key: str
    vendor: str
    config: dict[str, Any]
    input: dict[str, Any]
    log: Callable[[LogLevel, str], Awaitable[Any]]
    results: ResultWriter
    artifacts: ArtifactWriter
    browser: BrowserSessionManager
    is_stopping: Callable[[], bool]
    raise_if_stopping: Callable[[], None]

    @property
    def item_index(self) -> int:
        return self.work_item_index


class AutomationTaskModule(ABC):
    manifest: TaskModuleManifest

    def build_work_items(self, config: dict[str, Any]) -> Sequence[WorkItemSpec]:
        return [WorkItemSpec(key="default", input=dict(config), label="默认任务项")]

    @abstractmethod
    async def run(self, context: TaskExecutionContext) -> TaskResult | dict[str, Any] | None:
        raise NotImplementedError
