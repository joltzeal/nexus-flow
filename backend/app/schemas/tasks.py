from typing import Any, Literal

from pydantic import BaseModel, Field


class TaskConfigFieldResponse(BaseModel):
    key: str
    label: str
    block: str = "general"
    field_type: str
    required: bool
    description: str = ""
    placeholder: str = ""
    default: Any = None
    options: list[str] = Field(default_factory=list)
    tab: str = ""
    table_columns: list[str] = Field(default_factory=list)
    resource_type: str = ""


class TaskResourceRecordResponse(BaseModel):
    id: str
    resource_type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    state: str
    used: bool
    created_at: str
    updated_at: str
    used_at: str | None = None


class TaskResourceSaveItem(BaseModel):
    id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class TaskResourceSaveRequest(BaseModel):
    items: list[TaskResourceSaveItem] = Field(default_factory=list)


class TaskResultDefinitionResponse(BaseModel):
    key: str
    label: str
    description: str = ""


class TaskArtifactDefinitionResponse(BaseModel):
    key: str
    label: str
    kind: str = "file"
    required: bool = False
    description: str = ""


class BrowserRequirementResponse(BaseModel):
    required: bool = False
    max_sessions: int | None = None


class TaskModuleResponse(BaseModel):
    key: str
    name: str
    description: str
    config_fields: list[TaskConfigFieldResponse]
    results: list[TaskResultDefinitionResponse] = Field(default_factory=list)
    artifacts: list[TaskArtifactDefinitionResponse] = Field(default_factory=list)
    browser: BrowserRequirementResponse = Field(default_factory=BrowserRequirementResponse)


class PluginModuleResponse(BaseModel):
    key: str
    name: str
    version: str = ""
    description: str = ""
    entry: str = ""
    status: str
    error: str = ""


class PluginRepositoryCheckRequest(BaseModel):
    repository_url: str


class PluginRepositoryPluginResponse(BaseModel):
    key: str
    name: str = ""
    version: str = ""
    description: str = ""
    url: str = ""
    file: str = ""
    sha256: str = ""
    size: int = 0
    changelog: str = ""
    local_version: str = ""
    installed: bool = False
    has_update: bool = False


class PluginInstallFromUrlRequest(BaseModel):
    url: str
    sha256: str = ""
    key: str = ""
    version: str = ""


class TaskRunCreateRequest(BaseModel):
    task_key: str
    vendor: str = "bit_browser"
    concurrency: int = Field(default=1, ge=1, le=100)
    config: dict[str, Any] = Field(default_factory=dict)
    cleanup_policy: Literal["keep_open", "close", "delete"] = "delete"


class TaskConfigurationResponse(BaseModel):
    task_key: str
    config: dict[str, Any] = Field(default_factory=dict)


class TaskConfigurationSaveRequest(BaseModel):
    config: dict[str, Any] = Field(default_factory=dict)


class WorkItemResponse(BaseModel):
    id: str
    run_id: str
    index: int
    key: str
    label: str
    input: dict[str, Any]
    status: str
    message: str = ""
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None


class TaskRunResponse(BaseModel):
    id: str
    task_key: str
    task_name: str
    vendor: str
    status: str
    concurrency: int
    config: dict[str, Any]
    cleanup_policy: str
    items: list[WorkItemResponse]
    total: int
    completed: int
    failed: int
    cancelled: int
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    message: str = ""
    error: str | None = None


class TaskRunLogResponse(BaseModel):
    id: str
    run_id: str
    level: str
    message: str
    timestamp: str
    work_item_id: str | None = None
    browser_session_id: str | None = None


class BrowserSessionResponse(BaseModel):
    id: str
    run_id: str
    work_item_id: str
    task_key: str | None = None
    vendor: str
    profile_id: str
    status: str
    debug_address: str = ""
    websocket_url: str | None = None
    pid: int | None = None
    seq: int | None = None
    created_by_core: bool = False
    cleanup_policy: str = "delete"
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    opened_at: str | None = None
    closed_at: str | None = None
    error: str | None = None


class TaskResultResponse(BaseModel):
    id: str
    run_id: str
    work_item_id: str
    task_key: str
    key: str
    status: str
    message: str
    data: dict[str, Any]
    created_at: str


class TaskArtifactResponse(BaseModel):
    id: str
    run_id: str
    work_item_id: str
    task_key: str
    key: str
    kind: str
    name: str
    filename: str
    mime_type: str
    relative_path: str
    size_bytes: int
    created_at: str
