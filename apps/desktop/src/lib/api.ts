const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8765"
const WS_BASE = API_BASE.replace(/^http/, "ws")

export type TaskFieldType = "text" | "password" | "number" | "textarea" | "select" | "multi-select" | "checkbox"
export type LogLevel = "info" | "warn" | "error" | "debug" | "verbose"

export interface TaskConfigField {
  key: string
  label: string
  block: string
  field_type: TaskFieldType
  required: boolean
  description: string
  placeholder: string
  default: unknown
  options: string[]
}

export interface TaskResultDefinition {
  key: string
  label: string
  description: string
}

export interface TaskArtifactDefinition {
  key: string
  label: string
  kind: string
  required: boolean
  description: string
}

export interface BrowserRequirement {
  required: boolean
  max_sessions: number | null
}

export interface TaskModule {
  key: string
  name: string
  description: string
  config_fields: TaskConfigField[]
  results: TaskResultDefinition[]
  artifacts: TaskArtifactDefinition[]
  browser: BrowserRequirement
}

export interface PluginModule {
  key: string
  name: string
  version: string
  description: string
  entry: string
  status: string
  error: string
}

export interface BrowserHealthResponse {
  vendor: string
  ok: boolean
}

export interface BrowserArrangeWindowsPayload {
  run_id: string
  session_ids?: string[]
  start_x?: number
  start_y?: number
  width?: number
  height?: number
  col?: number
  space_x?: number
  space_y?: number
}

export interface ApiHealthResponse {
  ok: boolean
}

export interface TaskRunItem {
  id: string
  run_id: string
  index: number
  key: string
  label: string
  input: Record<string, unknown>
  status: string
  message: string
  error: string | null
  started_at: string | null
  finished_at: string | null
}

export interface TaskRunLog {
  id: string
  run_id: string
  level: LogLevel
  message: string
  timestamp: string
  work_item_id: string | null
  browser_session_id: string | null
}

export interface TaskRun {
  id: string
  task_key: string
  task_name: string
  vendor: string
  status: string
  concurrency: number
  config: Record<string, unknown>
  cleanup_policy: string
  items: TaskRunItem[]
  total: number
  completed: number
  failed: number
  cancelled: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  message: string
  error: string | null
}

export interface TaskConfigurationResponse {
  task_key: string
  config: Record<string, unknown>
}

export interface CreateTaskRunPayload {
  task_key: string
  vendor: string
  concurrency: number
  config: Record<string, unknown>
  cleanup_policy?: "keep_open" | "close" | "delete"
}

export interface BrowserOpenedProfile {
  profile_id: string
  debug_address: string
}

export interface BrowserOpenedProfilesResponse {
  vendor: string
  profiles: BrowserOpenedProfile[]
}

export interface BrowserSession {
  id: string
  run_id: string
  work_item_id: string
  task_key: string
  vendor: string
  profile_id: string
  status: string
  debug_address: string
  websocket_url: string | null
  pid: number | null
  seq: number | null
  created_by_core: boolean
  cleanup_policy: string
  raw: Record<string, unknown>
  created_at: string
  opened_at: string | null
  closed_at: string | null
  error: string | null
}

export interface TaskResult {
  id: string
  run_id: string
  work_item_id: string
  task_key: string
  key: string
  status: string
  message: string
  data: Record<string, unknown>
  created_at: string
}

export interface TaskArtifact {
  id: string
  run_id: string
  work_item_id: string
  task_key: string
  key: string
  kind: string
  name: string
  filename: string
  mime_type: string
  relative_path: string
  size_bytes: number
  created_at: string
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData
  let response: Response

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: isFormData
        ? init?.headers
        : {
            "Content-Type": "application/json",
            ...init?.headers,
          },
    })
  } catch (caught) {
    throw new Error(`无法连接后端服务：${getNetworkErrorMessage(caught)}`)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(parseErrorMessage(text) || `请求失败：${response.status}`)
  }

  return response.json() as Promise<T>
}

function getNetworkErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function parseErrorMessage(text: string) {
  if (!text) {
    return ""
  }

  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === "object" && parsed !== null && "detail" in parsed) {
      const detail = (parsed as { detail: unknown }).detail
      if (typeof detail === "string") {
        return detail
      }
    }
  } catch {
    return text
  }

  return text
}

export const api = {
  checkApiHealth: () => apiFetch<ApiHealthResponse>("/health"),
  checkBrowserHealth: (vendor: string) =>
    apiFetch<BrowserHealthResponse>(`/api/browsers/health/${vendor}`, {
      method: "POST",
    }),
  arrangeRunBrowserWindows: (payload: BrowserArrangeWindowsPayload) =>
    apiFetch<{ ok: boolean }>("/api/browsers/runs/arrange-windows", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listOpenedBrowsers: (vendor: string) =>
    apiFetch<BrowserOpenedProfilesResponse>(`/api/browsers/opened/${vendor}`),
  listTasks: () => apiFetch<TaskModule[]>("/api/tasks"),
  listPluginModules: () => apiFetch<PluginModule[]>("/api/task-modules"),
  reloadPluginModules: () =>
    apiFetch<PluginModule[]>("/api/task-modules/reload", {
      method: "POST",
    }),
  reloadPluginModule: (key: string) =>
    apiFetch<PluginModule>(`/api/task-modules/${key}/reload`, {
      method: "POST",
    }),
  deletePluginModule: (key: string) =>
    apiFetch<PluginModule[]>(`/api/task-modules/${key}`, {
      method: "DELETE",
    }),
  uploadPluginModule: (file: File) => {
    const body = new FormData()
    body.append("file", file)
    return apiFetch<PluginModule>("/api/task-modules/upload", {
      method: "POST",
      body,
    })
  },
  getTaskConfiguration: (taskKey: string) =>
    apiFetch<TaskConfigurationResponse>(`/api/tasks/configurations/${taskKey}`),
  saveTaskConfiguration: (taskKey: string, config: Record<string, unknown>) =>
    apiFetch<TaskConfigurationResponse>(`/api/tasks/configurations/${taskKey}`, {
      method: "PUT",
      body: JSON.stringify({ config }),
    }),
  listRuns: () => apiFetch<TaskRun[]>("/api/tasks/runs"),
  listRunLogs: (runId: string, limit = 1000) =>
    apiFetch<TaskRunLog[]>(`/api/tasks/runs/${runId}/logs?limit=${limit}`),
  listRunBrowserSessions: (runId: string) =>
    apiFetch<BrowserSession[]>(`/api/tasks/runs/${runId}/browser-sessions`),
  listRunResults: (runId: string) =>
    apiFetch<TaskResult[]>(`/api/tasks/runs/${runId}/results`),
  listRunArtifacts: (runId: string) =>
    apiFetch<TaskArtifact[]>(`/api/tasks/runs/${runId}/artifacts`),
  listTaskResults: (taskKey: string) =>
    apiFetch<TaskResult[]>(`/api/tasks/${taskKey}/results`),
  listTaskArtifacts: (taskKey: string) =>
    apiFetch<TaskArtifact[]>(`/api/tasks/${taskKey}/artifacts`),
  runsWsUrl: () => `${WS_BASE}/api/tasks/runs/ws`,
  runLogsWsUrl: (runId: string) => `${WS_BASE}/api/tasks/runs/${runId}/logs/ws`,
  createRun: (payload: CreateTaskRunPayload) =>
    apiFetch<TaskRun>("/api/tasks/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  stopRun: (runId: string) =>
    apiFetch<TaskRun>(`/api/tasks/runs/${runId}/stop`, {
      method: "POST",
    }),
  stopActiveRun: () =>
    apiFetch<TaskRun>("/api/tasks/runs/active/stop", {
      method: "POST",
    }),
}
