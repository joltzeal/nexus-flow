import { createListCollection } from "@ark-ui/react"
import { getVersion } from "@tauri-apps/api/app"
import { isTauri } from "@tauri-apps/api/core"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Toaster, toast } from "sonner"
import * as XLSX from "xlsx"
import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  LoaderCircleIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Rows3Icon,
  Settings2Icon,
  SquareIcon,
  PlayIcon,
  ReceiptTextIcon,
  Trash2Icon,
  UploadIcon,
  WorkflowIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectContext,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Button as DialogButton } from "@/components/ui/button"
import { AutoUpdateDialog, type UpdateCheckResult } from "@/components/auto-update-dialog"
import {
  ArrangeWindowsDialog,
  type WindowArrangeSettingKey,
  type WindowArrangeSettings,
} from "@/components/arrange-windows-dialog"
import { LogViewerTerminal } from "@/components/log-viewer"
import { StatusBadge } from "@/components/status-badge"
import packageJson from "../package.json"
import {
  api,
  type PluginModule,
  type PluginRepositoryModule,
  type TaskArtifact,
  type TaskArtifactDefinition,
  type TaskConfigField,
  type TaskModule,
  type TaskResult,
  type TaskResultDefinition,
  type TaskResourceRecord,
  type TaskRun,
  type TaskRunLog,
  type TaskRunNotificationEvent,
} from "@/lib/api"
import {
  API_START_TIMEOUT_MESSAGE,
  API_STARTING_MESSAGE,
  isBackendConnectionMessage,
  useApiReady,
} from "@/hooks/use-api-ready"
import { cn } from "@/lib/utils"
import { announceTaskNotification, unlockTaskNotificationAudio } from "@/lib/task-notification-audio"

const VENDOR_BIT_BROWSER = "bit_browser"
const VENDOR_ADS_POWER = "ads_power"
const PACKAGE_VERSION = packageJson.version
const MAX_LOGS_PER_RUN = 1000
const PLUGIN_REPOSITORY_URL_STORAGE_KEY = "nexus-flow.pluginRepositoryUrl"
const DEFAULT_PLUGIN_REPOSITORY_URL = ""

type Page = "launcher" | "records" | "modules"

type DashboardState = "booting" | "ready" | "loading-failed"

function App() {
  const [page, setPage] = useState<Page>("launcher")
  const [tasks, setTasks] = useState<TaskModule[]>([])
  const [plugins, setPlugins] = useState<PluginModule[]>([])
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [runLogs, setRunLogs] = useState<Record<string, TaskRunLog[]>>({})
  const [taskResults, setTaskResults] = useState<Record<string, TaskResult[]>>({})
  const [taskArtifacts, setTaskArtifacts] = useState<Record<string, TaskArtifact[]>>({})
  const seenNotificationIdsRef = useRef(new Set<string>())
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [selectedTaskKey, setSelectedTaskKey] = useState("")
  const [selectedVendor, setSelectedVendor] = useState(VENDOR_BIT_BROWSER)
  const [concurrency, setConcurrency] = useState(1)
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [taskResources, setTaskResources] = useState<Record<string, TaskResourceRecord[]>>({})
  const [browserStatuses, setBrowserStatuses] = useState<Record<string, "checking" | "online" | "offline">>({
    [VENDOR_BIT_BROWSER]: "checking",
    [VENDOR_ADS_POWER]: "checking",
  })
  const [error, setError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState(PACKAGE_VERSION)
  const [dashboardState, setDashboardState] = useState<DashboardState>("booting")
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [isSavingConfig, setIsSavingConfig] = useState(false)
  const [isUploadingPlugin, setIsUploadingPlugin] = useState(false)
  const [isReloadingPlugins, setIsReloadingPlugins] = useState(false)
  const [pluginRepositoryUrl, setPluginRepositoryUrl] = useState(loadPluginRepositoryUrl)
  const [repositoryPlugins, setRepositoryPlugins] = useState<PluginRepositoryModule[]>([])
  const [isCheckingPluginRepository, setIsCheckingPluginRepository] = useState(false)
  const [installingRepositoryPluginKey, setInstallingRepositoryPluginKey] = useState<string | null>(null)
  const [updateCheckRequestId, setUpdateCheckRequestId] = useState(0)
  const [isCheckingForUpdate, setIsCheckingForUpdate] = useState(false)
  const [updateCheckMessage, setUpdateCheckMessage] = useState<string | null>(null)
  const [isArrangeDialogOpen, setIsArrangeDialogOpen] = useState(false)
  const [isArrangingWindows, setIsArrangingWindows] = useState(false)
  const [windowArrangeSettings, setWindowArrangeSettings] = useState<WindowArrangeSettings>(loadWindowArrangeSettings)
  const [windowArrangeDraft, setWindowArrangeDraft] = useState(windowArrangeSettings)
  const [startupStage, setStartupStage] = useState("正在连接后端...")

  const handleApiStarting = useCallback(() => {
    setError((current) => (isBackendConnectionMessage(current) ? null : current))
    setStartupStage(API_STARTING_MESSAGE)
    setDashboardState("booting")
  }, [])
  const handleApiReady = useCallback(() => {
    setError((current) => (isBackendConnectionMessage(current) ? null : current))
    setDashboardState("ready")
    setStartupStage("核心就绪")
  }, [])
  const handleApiTimeout = useCallback(() => {
    setError(API_START_TIMEOUT_MESSAGE)
    setDashboardState("loading-failed")
  }, [])
  const { apiReady, checkApiReady } = useApiReady({
    onStarting: handleApiStarting,
    onReady: handleApiReady,
    onTimeout: handleApiTimeout,
  })

  const selectedTask = useMemo(
    () => tasks.find((task) => task.key === selectedTaskKey) ?? tasks[0],
    [selectedTaskKey, tasks],
  )
  const activeRun = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? null,
    [activeRunId, runs],
  )
  const selectedRunLogs = activeRunId ? runLogs[activeRunId] ?? [] : []
  const selectedTaskResults = selectedTask ? taskResults[selectedTask.key] ?? [] : []
  const selectedTaskArtifacts = selectedTask ? taskArtifacts[selectedTask.key] ?? [] : []
  const selectedTaskResources = useMemo(() => {
    if (!selectedTask) {
      return {}
    }
    return Object.fromEntries(
      resourceTypesForTask(selectedTask).map((resourceType) => [
        resourceType,
        taskResources[taskResourceStateKey(selectedTask.key, resourceType)] ?? [],
      ]),
    ) as Record<string, TaskResourceRecord[]>
  }, [selectedTask, taskResources])
  const browserStatusList = useMemo(
    () => [
      { key: VENDOR_BIT_BROWSER, label: "BitBrowser", status: browserStatuses[VENDOR_BIT_BROWSER] ?? "checking" },
      { key: VENDOR_ADS_POWER, label: "AdsPower", status: browserStatuses[VENDOR_ADS_POWER] ?? "checking" },
    ],
    [browserStatuses],
  )

  useEffect(() => {
    void checkApiReady()
  }, [checkApiReady])

  useEffect(() => {
    if (!apiReady) {
      return
    }

    let disposed = false

    async function bootstrap() {
      setStartupStage("加载任务与运行数据...")
      await loadInitialData()
      if (disposed) {
        return
      }
      setDashboardState("ready")
      setStartupStage("核心就绪")
    }

    void bootstrap()

    return () => {
      disposed = true
    }
  }, [apiReady])

  useEffect(() => {
    if (!isTauri()) {
      return
    }

    let disposed = false

    async function loadAppVersion() {
      try {
        const version = await getVersion()
        if (!disposed && version) {
          setAppVersion(version)
        }
      } catch (caught) {
        console.warn("Failed to load app version", caught)
      }
    }

    void loadAppVersion()

    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    if (!apiReady) {
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer = 0
    let retryCount = 0

    const connect = () => {
      socket = new WebSocket(api.runsWsUrl())

      socket.onopen = () => {
        if (disposed) {
          socket?.close()
          return
        }
        retryCount = 0
        setError((current) => (isBackendConnectionMessage(current) ? null : current))
      }

      socket.onmessage = (event) => {
        if (disposed) {
          return
        }
        const run = JSON.parse(event.data) as TaskRun
        setRuns((current) => upsertRun(current, run))
        if (run.id === activeRunId) {
          setActiveRunId(run.id)
        }
        if (selectedTask && run.task_key === selectedTask.key) {
          void loadTaskDetails(selectedTask.key)
        }
      }

      socket.onerror = () => {
        socket?.close()
      }

      socket.onclose = () => {
        if (disposed) {
          return
        }
        retryCount += 1
        setError("运行状态连接失败。")
        retryTimer = window.setTimeout(connect, Math.min(1000 + retryCount * 250, 5000))
      }
    }

    connect()

    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      if (socket) {
        closeWebSocket(socket)
      }
    }
  }, [apiReady, activeRunId, selectedTask])

  useEffect(() => {
    if (!activeRunId) {
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer = 0
    let retryCount = 0

    const connect = () => {
      socket = new WebSocket(api.runLogsWsUrl(activeRunId))

      socket.onopen = () => {
        if (disposed) {
          socket?.close()
          return
        }
        retryCount = 0
      }

      socket.onmessage = (event) => {
        if (disposed) {
          return
        }
        const log = JSON.parse(event.data) as TaskRunLog
        setRunLogs((current) => mergeRunLogs(current, activeRunId, [log]))
      }

      socket.onerror = () => {
        socket?.close()
      }

      socket.onclose = () => {
        if (disposed) {
          return
        }
        retryCount += 1
        if (retryCount >= 20) {
          setError("日志连接失败。")
        }
        retryTimer = window.setTimeout(connect, Math.min(1000 + retryCount * 250, 5000))
      }
    }

    connect()

    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      if (socket) {
        closeWebSocket(socket)
      }
    }
  }, [activeRunId])

  useEffect(() => {
    if (!activeRunId) {
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer = 0
    let retryCount = 0

    const connect = () => {
      socket = new WebSocket(api.runNotificationsWsUrl(activeRunId))
      socket.onopen = () => {
        retryCount = 0
      }
      socket.onmessage = (event) => {
        if (disposed) {
          return
        }
        const notificationEvent = JSON.parse(event.data) as TaskRunNotificationEvent
        if (notificationEvent.type !== "notification" || notificationEvent.event !== "raised") {
          return
        }
        const notification = notificationEvent.notification
        if (seenNotificationIdsRef.current.has(notification.id)) {
          return
        }
        seenNotificationIdsRef.current.add(notification.id)
        announceTaskNotification(notification)
        toast.warning(notification.title, {
          description: notification.message,
          duration: 30_000,
        })
      }
      socket.onerror = () => socket?.close()
      socket.onclose = () => {
        if (disposed) {
          return
        }
        retryCount += 1
        retryTimer = window.setTimeout(connect, Math.min(1000 + retryCount * 250, 5000))
      }
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      if (socket) {
        closeWebSocket(socket)
      }
    }
  }, [activeRunId])

  useEffect(() => {
    if (!selectedTask) {
      return
    }

    void loadTaskDetails(selectedTask.key)
  }, [selectedTask])

  const refreshActiveRunDetails = useCallback(() => {
    if (selectedTask) {
      return loadTaskDetails(selectedTask.key)
    }
    return Promise.resolve()
  }, [selectedTask])

  useEffect(() => {
    if (!selectedTask) {
      return
    }

    let disposed = false
    const defaults = defaultConfigForTask(selectedTask)

    async function loadTaskConfiguration() {
      try {
        const resourceTypes = resourceTypesForTask(selectedTask)
        const [saved, resourceEntries] = await Promise.all([
          api.getTaskConfiguration(selectedTask.key),
          Promise.all(resourceTypes.map((resourceType) => api.listTaskResources(selectedTask.key, resourceType))),
        ])
        if (!disposed) {
          setConfig({ ...defaults, ...saved.config })
          setTaskResources((current) => ({
            ...current,
            ...Object.fromEntries(
              resourceTypes.map((resourceType, index) => {
                const field = selectedTask.config_fields.find((item) => item.resource_type === resourceType)
                const storedResources = resourceEntries[index] ?? []
                return [
                  taskResourceStateKey(selectedTask.key, resourceType),
                  storedResources.length > 0 || !field
                    ? storedResources
                    : legacyTaskResources(field, saved.config[field.key]),
                ]
              }),
            ),
          }))
        }
      } catch (caught) {
        if (!disposed) {
          setConfig(defaults)
          setError(getErrorMessage(caught))
        }
      }
    }

    void loadTaskConfiguration()

    return () => {
      disposed = true
    }
  }, [selectedTask])

  async function loadInitialData() {
    setStartupStage("检查浏览器与插件...")
    await Promise.all([refreshTasks(), refreshRuns(), refreshPlugins(), refreshBrowserStatuses()])
  }

  async function refreshTasks() {
    try {
      const nextTasks = await api.listTasks()
      setTasks(nextTasks)
      if (nextTasks.length > 0 && !nextTasks.some((task) => task.key === selectedTaskKey)) {
        setSelectedTaskKey(nextTasks[0].key)
      }
    } catch (caught) {
      setError(getErrorMessage(caught))
    }
  }

  async function refreshRuns() {
    try {
      const nextRuns = await api.listRuns()
      setRuns(nextRuns)
      const nextActiveRun = nextRuns.find((run) => isRunActive(run)) ?? nextRuns[0] ?? null
      setActiveRunId((current) => current ?? nextActiveRun?.id ?? null)
      if (nextActiveRun) {
        await loadRecentLogs(nextActiveRun.id)
      }
    } catch (caught) {
      setError(getErrorMessage(caught))
    }
  }

  async function loadRecentLogs(runId: string) {
    try {
      const logs = await api.listRunLogs(runId, 1000)
      setRunLogs((current) => ({
        ...current,
        [runId]: logs.slice(-MAX_LOGS_PER_RUN),
      }))
    } catch (caught) {
      setError(getErrorMessage(caught))
    }
  }

  async function loadTaskDetails(taskKey: string) {
    try {
      const [results, artifacts] = await Promise.all([
        api.listTaskResults(taskKey),
        api.listTaskArtifacts(taskKey),
      ])
      setTaskResults((current) => ({
        ...current,
        [taskKey]: results,
      }))
      setTaskArtifacts((current) => ({
        ...current,
        [taskKey]: artifacts,
      }))
    } catch (caught) {
      setError(getErrorMessage(caught))
    }
  }

  async function refreshPlugins() {
    try {
      const nextPluginModules = await api.listPluginModules()
      setPlugins(nextPluginModules)
    } catch (caught) {
      setError(getErrorMessage(caught))
    }
  }

  async function refreshBrowserStatuses() {
    setBrowserStatuses({
      [VENDOR_BIT_BROWSER]: "checking",
      [VENDOR_ADS_POWER]: "checking",
    })

    await Promise.all(
      [VENDOR_BIT_BROWSER, VENDOR_ADS_POWER].map(async (vendor) => {
        try {
          const result = await api.checkBrowserHealth(vendor)
          setBrowserStatuses((current) => ({
            ...current,
            [vendor]: result.ok ? "online" : "offline",
          }))
        } catch {
          setBrowserStatuses((current) => ({
            ...current,
            [vendor]: "offline",
          }))
        }
      }),
    )
  }

  const handleManualUpdateCheckComplete = useCallback((result: UpdateCheckResult, message: string) => {
    setIsCheckingForUpdate(false)
    setUpdateCheckMessage(result === "failed" ? `更新检测失败：${message}` : message)
  }, [])

  function requestUpdateCheck() {
    setUpdateCheckMessage(null)
    setIsCheckingForUpdate(true)
    setUpdateCheckRequestId((current) => current + 1)
  }

  function openUpdateDialog() {
    setUpdateDialogOpen(true)
  }

  async function arrangeWindows() {
    if (!activeRun) {
      return
    }

    const settings = sanitizeWindowArrangeSettings(windowArrangeDraft)
    setError(null)
    setIsArrangingWindows(true)
    try {
      await api.arrangeRunBrowserWindows({
        run_id: activeRun.id,
        start_x: settings.startX,
        start_y: settings.startY,
        width: settings.width,
        height: settings.height,
        col: settings.col,
        space_x: settings.spaceX,
        space_y: settings.spaceY,
      })
      setWindowArrangeSettings(settings)
      window.localStorage.setItem("nexus-flow.windowArrangeSettings", JSON.stringify(settings))
      setIsArrangeDialogOpen(false)
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setIsArrangingWindows(false)
    }
  }

  function openWindowArrangeDialog() {
    setWindowArrangeDraft(windowArrangeSettings)
    setIsArrangeDialogOpen(true)
  }

  function updateWindowArrangeDraft(key: WindowArrangeSettingKey, value: number) {
    setWindowArrangeDraft((current) => sanitizeWindowArrangeSettings({ ...current, [key]: value }))
  }

  async function startRun() {
    if (!selectedTask) {
      return
    }

    void unlockTaskNotificationAudio()
    const profileValidationError = validateProfileConfigForRun(selectedTask, selectedTaskResources)
    if (profileValidationError) {
      setError(profileValidationError)
      return
    }

    setError(null)
    setIsStarting(true)

    try {
      await persistTaskResources(selectedTask, selectedTaskResources)
      const run = await api.createRun({
        task_key: selectedTask.key,
        vendor: selectedVendor,
        concurrency,
        config: sanitizeTaskConfig(selectedTask, config),
      })
      setRuns((current) => upsertRun(current, run))
      setActiveRunId(run.id)
      setPage("launcher")
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setIsStarting(false)
    }
  }

  async function stopRun() {
    if (!activeRun) {
      return
    }

    setError(null)
    setIsStopping(true)

    try {
      const run = await api.stopRun(activeRun.id)
      setRuns((current) => upsertRun(current, run))
      if (selectedTask) {
        await loadTaskDetails(selectedTask.key)
      }
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setIsStopping(false)
    }
  }

  async function saveTaskConfig() {
    if (!selectedTask) {
      return false
    }

    setError(null)
    setIsSavingConfig(true)
    try {
      await Promise.all([
        api.saveTaskConfiguration(selectedTask.key, sanitizeTaskConfig(selectedTask, config)),
        persistTaskResources(selectedTask, selectedTaskResources),
      ])
      return true
    } catch (caught) {
      setError(getErrorMessage(caught))
      return false
    } finally {
      setIsSavingConfig(false)
    }
  }

  async function persistTaskResources(
    task: TaskModule,
    resources: Record<string, TaskResourceRecord[]>,
  ) {
    const savedEntries = await Promise.all(
      resourceTypesForTask(task).map(async (resourceType) => [
        resourceType,
        await api.replaceTaskResources(
          task.key,
          resourceType,
          resourcesForPersistence(task, resourceType, resources[resourceType] ?? []),
        ),
      ] as const),
    )
    setTaskResources((current) => ({
      ...current,
      ...Object.fromEntries(
        savedEntries.map(([resourceType, savedResources]) => [
          taskResourceStateKey(task.key, resourceType),
          savedResources,
        ]),
      ),
    }))
  }

  function exportTaskConfig() {
    if (!selectedTask) {
      return
    }

    const exportedAt = new Date()
    const payload = {
      task_key: selectedTask.key,
      task_name: selectedTask.name,
      exported_at: exportedAt.toISOString(),
      config: sanitizeTaskConfig(selectedTask, config),
    }

    downloadJsonFile(`task-config-${selectedTask.key}-${formatDateForFilename(exportedAt)}.json`, payload)
  }

  async function importTaskConfig(file: File) {
    if (!selectedTask) {
      return
    }

    setError(null)

    try {
      const parsed = JSON.parse(await file.text()) as unknown
      const importedConfig = parseTaskConfigImport(parsed, selectedTask.key)
      setConfig({
        ...defaultConfigForTask(selectedTask),
        ...sanitizeTaskConfig(selectedTask, importedConfig),
      })
    } catch (caught) {
      setError(getErrorMessage(caught))
    }
  }

  async function uploadPluginModule(file: File) {
    setError(null)
    setIsUploadingPlugin(true)

    try {
      await api.uploadPluginModule(file)
      await Promise.all([refreshPlugins(), refreshTasks()])
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setIsUploadingPlugin(false)
    }
  }

  async function reloadPluginModules() {
    setError(null)
    setIsReloadingPlugins(true)

    try {
      const nextPluginModules = await api.reloadPluginModules()
      setPlugins(nextPluginModules)
      await refreshTasks()
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setIsReloadingPlugins(false)
    }
  }

  async function reloadPluginModule(key: string) {
    setError(null)
    setIsReloadingPlugins(true)

    try {
      await api.reloadPluginModule(key)
      await Promise.all([refreshPlugins(), refreshTasks()])
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setIsReloadingPlugins(false)
    }
  }

  async function deletePluginModule(key: string) {
    setError(null)
    setIsReloadingPlugins(true)

    try {
      const nextPluginModules = await api.deletePluginModule(key)
      setPlugins(nextPluginModules)
      await refreshTasks()
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setIsReloadingPlugins(false)
    }
  }

  async function checkPluginRepository() {
    const repositoryUrl = pluginRepositoryUrl.trim()
    if (!repositoryUrl) {
      setError("请先填写插件仓库 index.json 地址。")
      return
    }

    setError(null)
    setIsCheckingPluginRepository(true)
    localStorage.setItem(PLUGIN_REPOSITORY_URL_STORAGE_KEY, repositoryUrl)

    try {
      const modules = await api.checkPluginRepository(repositoryUrl)
      setRepositoryPlugins(modules)
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setIsCheckingPluginRepository(false)
    }
  }

  async function installRepositoryPlugin(plugin: PluginRepositoryModule) {
    if (!plugin.url) {
      setError("仓库插件缺少下载 URL。")
      return
    }

    setError(null)
    setInstallingRepositoryPluginKey(plugin.key)

    try {
      await api.installPluginFromRepository(plugin)
      await Promise.all([refreshPlugins(), refreshTasks()])
      if (pluginRepositoryUrl.trim()) {
        const modules = await api.checkPluginRepository(pluginRepositoryUrl.trim())
        setRepositoryPlugins(modules)
      }
    } catch (caught) {
      setError(getErrorMessage(caught))
    } finally {
      setInstallingRepositoryPluginKey(null)
    }
  }

  const content = dashboardState !== "ready" ? (
    <BootScreen
      state={dashboardState}
      stage={startupStage}
      error={error}
      onRetry={() => void checkApiReady()}
    />
  ) : page === "launcher" ? (
    <section className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
      <TaskLauncher
        tasks={tasks}
        selectedTask={selectedTask}
        selectedTaskKey={selectedTaskKey}
        selectedVendor={selectedVendor}
        concurrency={concurrency}
        config={config}
        resources={selectedTaskResources}
        activeRun={activeRun && isRunActive(activeRun) ? activeRun : null}
        isStarting={isStarting}
        isStopping={isStopping}
        isSavingConfig={isSavingConfig}
        onTaskChange={setSelectedTaskKey}
        onVendorChange={setSelectedVendor}
        onConcurrencyChange={setConcurrency}
        onConfigChange={setConfig}
        onResourcesChange={(resourceType, resources) => {
          if (!selectedTask) {
            return
          }
          setTaskResources((current) => ({
            ...current,
            [taskResourceStateKey(selectedTask.key, resourceType)]: resources,
          }))
        }}
        onConfigSave={() => saveTaskConfig()}
        onConfigExport={exportTaskConfig}
        onConfigImport={(file) => void importTaskConfig(file)}
        runResults={selectedTaskResults}
        runArtifacts={selectedTaskArtifacts}
        onRefreshRunDetails={refreshActiveRunDetails}
        onStart={() => void startRun()}
        onStop={() => void stopRun()}
      />
      <TaskRuntimePanel
        logs={selectedRunLogs}
      />
    </section>
  ) : page === "records" ? (
    <RunRecords
      runs={runs}
      runLogs={runLogs}
      onRefresh={() => void refreshRuns()}
      onSelectRun={(runId) => setActiveRunId(runId)}
    />
  ) : (
    <PluginModulesPanel
      modules={plugins}
      repositoryUrl={pluginRepositoryUrl}
      repositoryModules={repositoryPlugins}
      isUploading={isUploadingPlugin}
      isReloading={isReloadingPlugins}
      isCheckingRepository={isCheckingPluginRepository}
      installingRepositoryPluginKey={installingRepositoryPluginKey}
      onRepositoryUrlChange={setPluginRepositoryUrl}
      onCheckRepository={() => void checkPluginRepository()}
      onInstallRepositoryPlugin={(plugin) => void installRepositoryPlugin(plugin)}
      onUpload={(file) => void uploadPluginModule(file)}
      onReloadAll={() => void reloadPluginModules()}
      onReload={(key) => void reloadPluginModule(key)}
      onDelete={(key) => void deletePluginModule(key)}
    />
  )

  return (
    <main className="h-screen overflow-hidden bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-[1440px] flex-col gap-4 overflow-hidden px-4 py-4">
        <header className="flex shrink-0 flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-normal">Nexus Flow 自动化控制台</h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>v{appVersion}</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0 py-0 text-xs"
                onClick={requestUpdateCheck}
                disabled={isCheckingForUpdate}
              >
                {isCheckingForUpdate ? "检查中..." : "检查更新"}
              </Button>
              {updateCheckMessage ? <span className="text-xs">{updateCheckMessage}</span> : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant={page === "launcher" ? "secondary" : "ghost"}
              onClick={() => setPage("launcher")}
            >
              <WorkflowIcon data-icon="inline-start" />
              任务启动
            </Button>
            <Button
              variant={page === "records" ? "secondary" : "ghost"}
              onClick={() => setPage("records")}
            >
              <Rows3Icon data-icon="inline-start" />
              运行记录
            </Button>
            <Button
              variant={page === "modules" ? "secondary" : "ghost"}
              onClick={() => setPage("modules")}
            >
              <PackageIcon data-icon="inline-start" />
              任务插件
            </Button>
            <BrowserHealthStack statuses={browserStatusList} onRefresh={() => void refreshBrowserStatuses()} />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline">
                    <Settings2Icon data-icon="inline-start" />
                    操作
                    <ChevronDownIcon data-icon="inline-end" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => void openWindowArrangeDialog()}>
                  <Rows3Icon />
                  重排窗口
                </DropdownMenuItem>
                <DropdownMenuItem onClick={openUpdateDialog}>
                  <DownloadIcon />
                  在线升级
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {dashboardState === "ready" && error ? (
          <Alert variant="destructive" className="shrink-0">
            <AlertTitle>请求失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {content}
      </div>

      <ArrangeWindowsDialog
        open={isArrangeDialogOpen}
        settings={windowArrangeDraft}
        isArranging={isArrangingWindows}
        onOpenChange={setIsArrangeDialogOpen}
        onSettingChange={updateWindowArrangeDraft}
        onSubmit={() => void arrangeWindows()}
      />

      <UpdateDialog
        open={updateDialogOpen}
        appVersion={appVersion}
        checkRequestId={updateCheckRequestId}
        isChecking={isCheckingForUpdate}
        message={updateCheckMessage}
        onOpenChange={setUpdateDialogOpen}
        onManualCheckComplete={handleManualUpdateCheckComplete}
        onRequestCheck={() => {
          setUpdateCheckMessage(null)
          setIsCheckingForUpdate(true)
          setUpdateCheckRequestId((current) => current + 1)
        }}
      />
      <Toaster position="top-right" />
    </main>
  )
}

function BootScreen({
  state,
  stage,
  error,
  onRetry,
}: {
  state: DashboardState
  stage: string
  error: string | null
  onRetry: () => void
}) {
  const failed = state === "loading-failed"

  return (
    <section className="flex h-full items-center justify-center">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border p-6">
        <div className="flex items-center gap-3">
          <LoaderCircleIcon className={cn("h-5 w-5 text-muted-foreground", failed ? "" : "animate-spin")} />
          <div className="flex flex-col">
            <div className="font-medium">{failed ? "核心启动失败" : "正在启动核心"}</div>
            <div className="text-sm text-muted-foreground">{stage}</div>
          </div>
        </div>
        <Progress value={failed ? 100 : 60} />
        {failed && error ? <p className="text-sm text-destructive">{error}</p> : null}
        {failed ? (
          <Button onClick={onRetry}>重试</Button>
        ) : null}
      </div>
    </section>
  )
}

function BrowserHealthStack({
  statuses,
  onRefresh,
}: {
  statuses: { key: string; label: string; status: "checking" | "online" | "offline" }[]
  onRefresh: () => void
}) {
  return (
    <div className="flex w-[132px] shrink-0 items-stretch overflow-hidden rounded-md border bg-background">
      <div className="grid min-w-0 flex-1 grid-rows-2">
        {statuses.map((item) => (
          <div key={item.key} className="flex min-w-0 items-center justify-between gap-1 px-2 py-1 text-xs leading-none">
            <span className="truncate">{item.label}</span>
            <span className={browserDotClassName(item.status)} />
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-8 rounded-none border-l px-0"
        onClick={onRefresh}
        aria-label="刷新浏览器状态"
      >
        <RefreshCwIcon className="size-3.5" />
      </Button>
    </div>
  )
}

function TaskLauncher({
  tasks,
  selectedTask,
  selectedTaskKey,
  selectedVendor,
  concurrency,
  config,
  resources,
  activeRun,
  isStarting,
  isStopping,
  isSavingConfig,
  onTaskChange,
  onConcurrencyChange,
  onConfigChange,
  onResourcesChange,
  onConfigSave,
  onConfigExport,
  onConfigImport,
  runResults,
  runArtifacts,
  onRefreshRunDetails,
  onStart,
  onStop,
  onVendorChange,
}: {
  tasks: TaskModule[]
  selectedTask: TaskModule | undefined
  selectedTaskKey: string
  selectedVendor: string
  concurrency: number
  config: Record<string, unknown>
  resources: Record<string, TaskResourceRecord[]>
  activeRun: TaskRun | null
  isStarting: boolean
  isStopping: boolean
  isSavingConfig: boolean
  onTaskChange: (value: string) => void
  onConcurrencyChange: (value: number) => void
  onConfigChange: (value: Record<string, unknown>) => void
  onResourcesChange: (resourceType: string, resources: TaskResourceRecord[]) => void
  onConfigSave: () => Promise<boolean>
  onConfigExport: () => void
  onConfigImport: (file: File) => void
  runResults: TaskResult[]
  runArtifacts: TaskArtifact[]
  onRefreshRunDetails: () => Promise<void>
  onStart: () => void
  onStop: () => void
  onVendorChange: (value: string) => void
}) {
  const [isConfigOpen, setIsConfigOpen] = useState(false)
  const [isResultOpen, setIsResultOpen] = useState(false)
  const configBlocks = useMemo(() => groupFieldsByBlock(selectedTask?.config_fields ?? []), [selectedTask])
  const resultDefinitions = selectedTask?.results ?? []
  const resultArtifacts = selectedTask?.artifacts ?? []
  const taskResults = useMemo(
    () => collectTaskResults(runResults, resultDefinitions),
    [runResults, resultDefinitions],
  )

  useEffect(() => {
    if (isResultOpen) {
      void onRefreshRunDetails()
    }
  }, [isResultOpen, onRefreshRunDetails])

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <div className="rounded-lg border p-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="task-module">任务模块</FieldLabel>
            <SingleSelect
              id="task-module"
              value={selectedTaskKey}
              options={tasks.map((task) => ({ label: task.name, value: task.key }))}
              placeholder="请选择任务"
              onChange={onTaskChange}
            />
            <FieldDescription>{selectedTask?.description ?? "暂无可用任务模块。"}</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="browser-vendor">浏览器</FieldLabel>
            <SingleSelect
              id="browser-vendor"
              value={selectedVendor}
              disabled={Boolean(activeRun)}
              options={[
                { label: "BitBrowser", value: VENDOR_BIT_BROWSER },
                { label: "AdsPower", value: VENDOR_ADS_POWER },
              ]}
              onChange={onVendorChange}
            />
            <FieldDescription>任务启动时使用的指纹浏览器适配器。</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="concurrency">并发数</FieldLabel>
            <Input
              id="concurrency"
              type="number"
              min={1}
              max={100}
              value={concurrency}
              onChange={(event) => onConcurrencyChange(Number(event.currentTarget.value))}
            />
            <FieldDescription>当前任务按该数量并行调度。</FieldDescription>
          </Field>

          <Separator />

          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="text-sm font-medium">任务配置</div>
                <div className="text-xs text-muted-foreground">按任务 manifest 动态渲染。</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" onClick={() => setIsConfigOpen(true)} disabled={!selectedTask}>
                  <Settings2Icon data-icon="inline-start" />
                  配置
                </Button>
                {resultDefinitions.length > 0 ? (
                  <Button variant="outline" onClick={() => setIsResultOpen(true)} disabled={!selectedTask}>
                    <ReceiptTextIcon data-icon="inline-start" />
                    结果
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {configBlocks.map((block) => {
                const stats = getBlockStats(block, config, resources)
                return (
                  <Badge key={block.name} variant={stats.missingRequired > 0 ? "outline" : "secondary"}>
                    {block.name} {stats.completedRequired}/{stats.required}
                  </Badge>
                )
              })}
            </div>
          </div>

          <div className="grid gap-2">
            <Button
              onClick={activeRun ? onStop : onStart}
              disabled={isStarting || isStopping || (!activeRun && !selectedTask)}
              variant={activeRun ? "destructive" : "default"}
            >
              {activeRun ? <SquareIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
              {activeRun ? (isStopping ? "正在停止" : "停止任务") : isStarting ? "正在启动" : "启动任务"}
            </Button>
          </div>
        </FieldGroup>
      </div>

      <TaskConfigSheet
        open={isConfigOpen}
        taskKey={selectedTask?.key ?? ""}
        blocks={configBlocks}
        config={config}
        resources={resources}
        isSaving={isSavingConfig}
        onOpenChange={setIsConfigOpen}
        onConfigChange={onConfigChange}
        onResourcesChange={onResourcesChange}
        onConfigExport={onConfigExport}
        onConfigImport={onConfigImport}
        onDone={async () => {
          if (await onConfigSave()) {
            setIsConfigOpen(false)
          }
        }}
      />

      <TaskResultSheet
        open={isResultOpen}
        resultDefinitions={resultDefinitions}
        resultArtifacts={resultArtifacts}
        artifacts={runArtifacts}
        resultsByKey={taskResults}
        onOpenChange={setIsResultOpen}
      />
    </section>
  )
}

interface TaskConfigBlock {
  name: string
  fields: TaskConfigField[]
}

function TaskConfigSheet({
  open,
  taskKey,
  blocks,
  config,
  resources,
  isSaving,
  onOpenChange,
  onConfigChange,
  onResourcesChange,
  onConfigExport,
  onConfigImport,
  onDone,
}: {
  open: boolean
  taskKey: string
  blocks: TaskConfigBlock[]
  config: Record<string, unknown>
  resources: Record<string, TaskResourceRecord[]>
  isSaving: boolean
  onOpenChange: (value: boolean) => void
  onConfigChange: (value: Record<string, unknown>) => void
  onResourcesChange: (resourceType: string, resources: TaskResourceRecord[]) => void
  onConfigExport: () => void
  onConfigImport: (file: File) => void
  onDone: () => void
}) {
  const [activeBlockName, setActiveBlockName] = useState("")
  const importInputRef = useRef<HTMLInputElement>(null)
  const activeBlock = blocks.find((block) => block.name === activeBlockName) ?? blocks[0]

  useEffect(() => {
    if (!activeBlockName && blocks[0]) {
      setActiveBlockName(blocks[0].name)
      return
    }
    if (activeBlockName && !blocks.some((block) => block.name === activeBlockName)) {
      setActiveBlockName(blocks[0]?.name ?? "")
    }
  }, [activeBlockName, blocks])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-hidden" style={{ width: "min(96vw, 960px)", maxWidth: "96vw" }}>
        <SheetHeader>
          <SheetTitle>任务配置</SheetTitle>
          <SheetDescription>当前任务的分组运行参数。</SheetDescription>
        </SheetHeader>

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 pb-2 xl:grid-cols-[200px_minmax(0,1fr)]">
          <nav className="flex min-w-0 gap-2 overflow-x-auto xl:flex-col xl:overflow-x-visible">
            {blocks.map((block) => (
              <Button
                key={block.name}
                type="button"
                variant={block.name === activeBlock?.name ? "secondary" : "ghost"}
                className="h-auto min-w-32 justify-between px-2 py-2 xl:w-full"
                onClick={() => setActiveBlockName(block.name)}
              >
                <span className="truncate">{block.name}</span>
                <Badge variant="secondary">{block.fields.length}</Badge>
              </Button>
            ))}
          </nav>

          <div className="min-w-0 rounded-lg border">
            {activeBlock ? (
              <FieldSet className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="text-base font-medium">{activeBlock.name}</div>
                    <div className="text-sm text-muted-foreground">{activeBlock.fields.length} 个字段</div>
                  </div>
                  <Badge variant="outline">{activeBlock.fields.length}</Badge>
                </div>
                <Separator />
                {activeBlock.fields.some((field) => field.tab) ? (
                  <TaskConfigTabs
                    taskKey={taskKey}
                    fields={activeBlock.fields}
                    config={config}
                    resources={resources}
                    onConfigChange={onConfigChange}
                    onResourcesChange={onResourcesChange}
                  />
                ) : (
                  <FieldGroup>
                    {activeBlock.fields.map((field) => (
                      <TaskConfigControl
                        key={field.key}
                        taskKey={taskKey}
                        field={field}
                        value={field.resource_type ? resources[field.resource_type] ?? [] : config[field.key]}
                        onChange={(value) => {
                          if (field.resource_type) {
                            onResourcesChange(field.resource_type, value as TaskResourceRecord[])
                            return
                          }
                          onConfigChange({ ...config, [field.key]: value })
                        }}
                      />
                    ))}
                  </FieldGroup>
                )}
              </FieldSet>
            ) : (
              <div className="p-4 text-sm text-muted-foreground">暂无配置分组。</div>
            )}
          </div>
        </div>

        <SheetFooter>
          <div className="flex flex-1 items-center gap-2">
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ""
                if (file) {
                  onConfigImport(file)
                }
              }}
            />
            <Button type="button" variant="outline" onClick={onConfigExport} disabled={blocks.length === 0}>
              <DownloadIcon data-icon="inline-start" />
              导出
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => importInputRef.current?.click()}
              disabled={blocks.length === 0}
            >
              <UploadIcon data-icon="inline-start" />
              导入
            </Button>
          </div>
          <Button onClick={onDone} disabled={isSaving}>
            {isSaving ? "正在保存" : "完成"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function TaskConfigTabs({
  taskKey,
  fields,
  config,
  resources,
  onConfigChange,
  onResourcesChange,
}: {
  taskKey: string
  fields: TaskConfigField[]
  config: Record<string, unknown>
  resources: Record<string, TaskResourceRecord[]>
  onConfigChange: (value: Record<string, unknown>) => void
  onResourcesChange: (resourceType: string, resources: TaskResourceRecord[]) => void
}) {
  const tabNames = useMemo(() => Array.from(new Set(fields.map((field) => field.tab).filter(Boolean))), [fields])
  const standaloneFields = fields.filter((field) => !field.tab)
  const [activeTab, setActiveTab] = useState(tabNames[0] ?? "")

  useEffect(() => {
    if (!tabNames.includes(activeTab)) {
      setActiveTab(tabNames[0] ?? "")
    }
  }, [activeTab, tabNames])

  if (tabNames.length === 0) {
    return null
  }

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      {standaloneFields.length > 0 ? (
        <FieldGroup>
          {standaloneFields.map((field) => (
            <TaskConfigControl
              key={field.key}
              taskKey={taskKey}
              field={field}
              value={field.resource_type ? resources[field.resource_type] ?? [] : config[field.key]}
              onChange={(value) => {
                if (field.resource_type) {
                  onResourcesChange(field.resource_type, value as TaskResourceRecord[])
                  return
                }
                onConfigChange({ ...config, [field.key]: value })
              }}
            />
          ))}
        </FieldGroup>
      ) : null}
      <TabsList variant="line" className="w-full justify-start overflow-x-auto overflow-y-hidden">
        {tabNames.map((tab) => (
          <TabsTrigger key={tab} value={tab} className="shrink-0 capitalize">
            {tab}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabNames.map((tab) => (
        <TabsContent key={tab} value={tab} className="pt-4">
          <FieldGroup>
            {fields
              .filter((field) => field.tab === tab)
              .map((field) => (
                <TaskConfigControl
                  key={field.key}
                  taskKey={taskKey}
                  field={field}
                  value={field.resource_type ? resources[field.resource_type] ?? [] : config[field.key]}
                  onChange={(value) => {
                    if (field.resource_type) {
                      onResourcesChange(field.resource_type, value as TaskResourceRecord[])
                      return
                    }
                    onConfigChange({ ...config, [field.key]: value })
                  }}
                />
              ))}
          </FieldGroup>
        </TabsContent>
      ))}
    </Tabs>
  )
}

function TaskResultSheet({
  open,
  resultDefinitions,
  resultArtifacts,
  artifacts,
  resultsByKey,
  onOpenChange,
}: {
  open: boolean
  resultDefinitions: TaskResultDefinition[]
  resultArtifacts: TaskArtifactDefinition[]
  artifacts: TaskArtifact[]
  resultsByKey: Record<string, TaskResult[]>
  onOpenChange: (value: boolean) => void
}) {
  const [activeKey, setActiveKey] = useState("")
  const activeResult = resultDefinitions.find((item) => item.key === activeKey) ?? resultDefinitions[0]

  useEffect(() => {
    if (!activeKey && resultDefinitions[0]) {
      setActiveKey(resultDefinitions[0].key)
      return
    }
    if (activeKey && !resultDefinitions.some((item) => item.key === activeKey)) {
      setActiveKey(resultDefinitions[0]?.key ?? "")
    }
  }, [activeKey, resultDefinitions])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-hidden" style={{ width: "min(96vw, 1000px)", maxWidth: "96vw" }}>
        <SheetHeader>
          <SheetTitle>任务结果</SheetTitle>
          <SheetDescription>按 manifest 声明的结构化结果和附件。</SheetDescription>
        </SheetHeader>

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 pb-2 xl:grid-cols-[220px_minmax(0,1fr)]">
          <nav className="flex min-w-0 gap-2 overflow-x-auto xl:flex-col xl:overflow-x-visible">
            {resultDefinitions.map((item) => {
              const count = resultsByKey[item.key]?.length ?? 0
              return (
                <Button
                  key={item.key}
                  type="button"
                  variant={activeResult?.key === item.key ? "secondary" : "ghost"}
                  className="h-auto min-w-32 justify-between px-2 py-2 xl:w-full"
                  onClick={() => setActiveKey(item.key)}
                >
                  <span className="truncate">{item.label}</span>
                  <Badge variant="secondary">{count}</Badge>
                </Button>
              )
            })}
          </nav>

          <div className="min-w-0 rounded-lg border p-4">
            {activeResult ? (
              <ResultPanel
                definition={activeResult}
                results={resultsByKey[activeResult.key] ?? []}
                artifacts={resultArtifacts}
                artifactRecords={artifacts.filter((artifact) => artifact.key === activeResult.key)}
              />
            ) : (
              <Alert>
                <AlertTitle>暂无结果面板</AlertTitle>
                <AlertDescription>当前任务没有声明结果。</AlertDescription>
              </Alert>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ResultPanel({
  definition,
  results,
  artifacts,
  artifactRecords,
}: {
  definition: TaskResultDefinition
  results: TaskResult[]
  artifacts: TaskArtifactDefinition[]
  artifactRecords: TaskArtifact[]
}) {
  const artifactCount = artifacts.length

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="text-base font-medium">{definition.label}</div>
          <div className="text-sm text-muted-foreground">{definition.description || "结构化结果记录。"}</div>
        </div>
        <Badge variant="secondary">{results.length} 条</Badge>
      </div>

      {results.length === 0 ? (
        <Alert>
          <AlertTitle>暂无结果</AlertTitle>
          <AlertDescription>任务执行后会在这里显示最近的结构化结果。</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          {groupResultsByRun(results).map((group) => (
            <ResultTableBlock
              key={group.runId}
              definition={definition}
              runId={group.runId}
              results={group.results}
            />
          ))}
        </div>
      )}

      {artifactCount > 0 ? (
        <div className="rounded-lg border p-3">
          <div className="mb-2 text-sm font-medium">附件</div>
          <div className="text-sm text-muted-foreground">
            已声明 {artifactCount} 类附件，当前运行已保存 {artifactRecords.length} 个文件。
          </div>
          {artifactRecords.length > 0 ? (
            <div className="mt-3 grid gap-2">
              {artifactRecords.slice(0, 20).map((artifact) => (
                <div key={artifact.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{artifact.name || artifact.filename}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(artifact.size_bytes)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function ResultTableBlock({
  definition,
  runId,
  results,
}: {
  definition: TaskResultDefinition
  runId: string
  results: TaskResult[]
}) {
  return (
    <section className="rounded-lg border">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-sm font-medium">运行 {runId.slice(0, 8)}</div>
          <div className="text-xs text-muted-foreground">{results.length} 条结果</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => exportResultTable(definition, runId, results)}
        >
          <DownloadIcon data-icon="inline-start" />
          导出
        </Button>
      </div>

      <div className="p-3">
        <TooltipProvider>
          <Table className="min-w-[880px] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-64">消息</TableHead>
                <TableHead className="w-44">创建时间</TableHead>
                <TableHead>数据</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((result) => (
                <TableRow key={result.id}>
                  <TableCell>
                    <ResultTableCellText value={result.status}>
                      <StatusBadge status={result.status} />
                    </ResultTableCellText>
                  </TableCell>
                  <TableCell>
                    <ResultTableCellText value={formatResultValue(result.message)} />
                  </TableCell>
                  <TableCell>
                    <ResultTableCellText
                      value={formatDateTime(result.created_at)}
                      className="text-xs text-muted-foreground"
                    />
                  </TableCell>
                  <TableCell>
                    <ResultTableCellText
                      value={formatResultData(result.data)}
                      className="font-mono text-xs"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TooltipProvider>
      </div>
    </section>
  )
}

function TaskRuntimePanel({ logs }: { logs: TaskRunLog[] }) {
  return (
    <section className="min-h-0">
      <RunLogViewer logs={logs} fill />
    </section>
  )
}

function RunLogViewer({
  logs,
  fill = false,
  maxHeight,
}: {
  logs: TaskRunLog[]
  fill?: boolean
  maxHeight?: number
}) {
  return (
    <LogViewerTerminal
      title="任务运行"
      filterable
      fill={fill}
      maxHeight={maxHeight}
      className={fill ? "h-full" : undefined}
      entries={logs.map((log) => ({
        level: log.level,
        message: log.message,
        timestamp: log.timestamp,
      }))}
    />
  )
}

function RunRecords({
  runs,
  runLogs,
  onRefresh,
  onSelectRun,
}: {
  runs: TaskRun[]
  runLogs: Record<string, TaskRunLog[]>
  onRefresh: () => void
  onSelectRun: (runId: string) => void
}) {
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">运行记录</div>
          <div className="text-sm text-muted-foreground">只展示最近历史，日志默认最多 1000 条。</div>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCwIcon data-icon="inline-start" />
          刷新
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4">
          {runs.length === 0 ? (
            <Alert>
              <Rows3Icon />
              <AlertTitle>暂无运行记录</AlertTitle>
              <AlertDescription>启动任务后会在这里看到持久化的运行记录。</AlertDescription>
            </Alert>
          ) : (
            runs.map((run) => (
              <section key={run.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{run.task_name}</span>
                      <StatusBadge status={run.status} />
                      <Badge variant="secondary">{run.vendor}</Badge>
                    </div>
                    <span className="truncate text-sm text-muted-foreground">{run.id}</span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => onSelectRun(run.id)}>
                    查看日志
                  </Button>
                </div>
                <div className="mt-3 text-sm text-muted-foreground">
                  已完成 {run.completed}/{run.total} · 失败 {run.failed} · 取消 {run.cancelled} · 并发 {run.concurrency}
                </div>
                <div className="mt-3">
                  <RunLogViewer logs={runLogs[run.id] ?? []} maxHeight={260} />
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </section>
  )
}

function PluginModulesPanel({
  modules,
  repositoryUrl,
  repositoryModules,
  isUploading,
  isReloading,
  isCheckingRepository,
  installingRepositoryPluginKey,
  onRepositoryUrlChange,
  onCheckRepository,
  onInstallRepositoryPlugin,
  onUpload,
  onReloadAll,
  onReload,
  onDelete,
}: {
  modules: PluginModule[]
  repositoryUrl: string
  repositoryModules: PluginRepositoryModule[]
  isUploading: boolean
  isReloading: boolean
  isCheckingRepository: boolean
  installingRepositoryPluginKey: string | null
  onRepositoryUrlChange: (value: string) => void
  onCheckRepository: () => void
  onInstallRepositoryPlugin: (plugin: PluginRepositoryModule) => void
  onUpload: (file: File) => void
  onReloadAll: () => void
  onReload: (key: string) => void
  onDelete: (key: string) => void
}) {
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const busy = isUploading || isReloading || isCheckingRepository || installingRepositoryPluginKey !== null

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 rounded-lg border p-4">
      <div className="flex shrink-0 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="font-medium">任务插件</div>
          <div className="text-sm text-muted-foreground">从仓库安装、升级，或上传本地插件包。</div>
        </div>

        <div className="rounded-lg border p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <Field className="min-w-0 flex-1">
              <FieldLabel>插件仓库</FieldLabel>
              <Input
                value={repositoryUrl}
                placeholder="https://pub-xxxx.r2.dev/plugin-repo/index.json"
                onChange={(event) => onRepositoryUrlChange(event.currentTarget.value)}
              />
            </Field>
            <Button variant="outline" onClick={onCheckRepository} disabled={busy}>
              <RefreshCwIcon data-icon="inline-start" />
              {isCheckingRepository ? "检查中" : "检查仓库"}
            </Button>
          </div>

          {repositoryModules.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>插件</TableHead>
                    <TableHead>本地版本</TableHead>
                    <TableHead>仓库版本</TableHead>
                    <TableHead>大小</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {repositoryModules.map((plugin) => {
                    const installing = installingRepositoryPluginKey === plugin.key
                    const actionLabel = plugin.installed
                      ? plugin.has_update
                        ? "升级"
                        : "已安装"
                      : "安装"
                    return (
                      <TableRow key={plugin.key}>
                        <TableCell>
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="font-medium">{plugin.name || plugin.key}</span>
                            <span className="font-mono text-xs text-muted-foreground">{plugin.key}</span>
                            {plugin.description ? (
                              <span className="max-w-96 truncate text-xs text-muted-foreground">
                                {plugin.description}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>{plugin.local_version || "-"}</TableCell>
                        <TableCell>{plugin.version || "-"}</TableCell>
                        <TableCell>{formatFileSize(plugin.size)}</TableCell>
                        <TableCell>
                          {plugin.has_update ? (
                            <Badge variant="default">可升级</Badge>
                          ) : plugin.installed ? (
                            <Badge variant="secondary">最新</Badge>
                          ) : (
                            <Badge variant="outline">未安装</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end">
                            <Button
                              variant={plugin.has_update || !plugin.installed ? "default" : "outline"}
                              size="sm"
                              onClick={() => onInstallRepositoryPlugin(plugin)}
                              disabled={busy || (plugin.installed && !plugin.has_update) || !plugin.url}
                            >
                              <DownloadIcon data-icon="inline-start" />
                              {installing ? "处理中" : actionLabel}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onReloadAll} disabled={busy}>
            <RefreshCwIcon data-icon="inline-start" />
            {isReloading ? "处理中" : "重载全部"}
          </Button>
          <Button variant="outline" onClick={() => uploadInputRef.current?.click()} disabled={busy}>
            <UploadIcon data-icon="inline-start" />
            上传
          </Button>
        </div>
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        accept=".zip"
        className="sr-only"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file) {
            onUpload(file)
          }
        }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {modules.length === 0 ? (
          <Alert>
            <PackageIcon />
            <AlertTitle>暂无插件</AlertTitle>
            <AlertDescription>上传插件包后会显示在这里。</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-3">
            {modules.map((module) => (
              <section key={module.key} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{module.name}</span>
                      <StatusBadge status={module.status} />
                      <Badge variant="secondary">{module.version || "-"}</Badge>
                    </div>
                    <span className="text-sm text-muted-foreground">{module.description || module.key}</span>
                    {module.error ? <span className="text-sm text-destructive">{module.error}</span> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => onReload(module.key)} disabled={busy}>
                      重载
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => onDelete(module.key)} disabled={busy}>
                      删除
                    </Button>
                  </div>
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function ResultTableCellText({
  value,
  className,
  children,
}: {
  value: string
  className?: string
  children?: ReactNode
}) {
  const displayValue = value || "-"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className={cn("min-w-0 truncate", className)} />
        }
      >
        {children ?? displayValue}
      </TooltipTrigger>
      <TooltipContent className="max-w-md whitespace-pre-wrap break-words">
        {displayValue}
      </TooltipContent>
    </Tooltip>
  )
}

function UpdateDialog({
  open,
  appVersion,
  checkRequestId,
  isChecking,
  message,
  onOpenChange,
  onManualCheckComplete,
  onRequestCheck,
}: {
  open: boolean
  appVersion: string
  checkRequestId: number
  isChecking: boolean
  message: string | null
  onOpenChange: (value: boolean) => void
  onManualCheckComplete: (result: UpdateCheckResult, message: string) => void
  onRequestCheck: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>在线升级</DialogTitle>
          <DialogDescription>检测新版本、下载升级包并重启应用。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">当前版本：{appVersion}</div>
          <div className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
            点击“检测更新”后，系统会自动比对并在有新版本时允许下载安装。
          </div>
          {message ? (
            <Alert>
              <AlertTitle>检测结果</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <DialogButton variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </DialogButton>
          <DialogButton onClick={onRequestCheck} disabled={isChecking}>
            {isChecking ? "检测中..." : "检测更新"}
          </DialogButton>
        </DialogFooter>
      </DialogContent>
      <AutoUpdateDialog
        checkRequestId={checkRequestId}
        onManualCheckComplete={onManualCheckComplete}
      />
    </Dialog>
  )
}

function TaskConfigControl({
  taskKey,
  field,
  value,
  onChange,
}: {
  taskKey: string
  field: TaskConfigField
  value: unknown
  onChange: (value: unknown) => void
}) {
  if (field.resource_type) {
    return <TaskResourceConfigControl taskKey={taskKey} field={field} resources={normalizeTaskResources(value)} onChange={onChange} />
  }

  const id = `task-config-${field.key}`
  const stringValue = value === undefined || value === null ? "" : String(value)
  const lineCount = ["cards", "profile_phone", "profile_email"].includes(field.key)
    ? countNonEmptyLines(stringValue)
    : null

  return (
    <Field className="min-w-0">
      <FieldLabel htmlFor={id} className="flex-wrap">
        <span className="min-w-0 break-words">{field.label}</span>
        {lineCount !== null ? <Badge variant="secondary">{lineCount} 行</Badge> : null}
        {field.required ? <Badge variant="outline">必填</Badge> : null}
      </FieldLabel>
      {field.field_type === "textarea" ? (
        <Textarea
          id={id}
          value={stringValue}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="min-h-24 resize-y"
        />
      ) : field.field_type === "table" ? (
        <ProfileTableConfigControl field={field} value={value} onChange={onChange} />
      ) : field.field_type === "toggle-group" ? (
        <ToggleGroup
          value={stringValue ? [stringValue] : []}
          onValueChange={(values) => {
            const selected = values[0]
            if (selected) {
              onChange(selected)
            }
          }}
          spacing={0}
          variant="outline"
        >
          {field.options.map((option) => (
            <ToggleGroupItem key={option} value={option} aria-label={option}>
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : field.field_type === "select" ? (
        <SingleSelect
          id={id}
          value={stringValue}
          options={field.options.map((option) => ({ label: option, value: option }))}
          placeholder={field.placeholder || "请选择"}
          onChange={onChange}
        />
      ) : field.field_type === "multi-select" ? (
        <TaskConfigMultiSelect field={field} value={value} onChange={onChange} />
      ) : field.field_type === "checkbox" ? (
        <div className="flex items-center gap-3">
          <Switch
            id={id}
            checked={normalizeBooleanValue(value)}
            onCheckedChange={(checked) => onChange(Boolean(checked))}
          />
          <span className="text-sm text-muted-foreground">
            {normalizeBooleanValue(value) ? "开启" : "关闭"}
          </span>
        </div>
      ) : (
        <Input
          id={id}
          type={field.field_type === "password" ? "password" : field.field_type === "number" ? "number" : "text"}
          value={stringValue}
          placeholder={field.placeholder}
          onChange={(event) =>
            onChange(field.field_type === "number" ? Number(event.currentTarget.value) : event.currentTarget.value)
          }
        />
      )}
      {field.description ? <FieldDescription className="break-words">{field.description}</FieldDescription> : null}
    </Field>
  )
}

function TaskResourceConfigControl({
  taskKey,
  field,
  resources,
  onChange,
}: {
  taskKey: string
  field: TaskConfigField
  resources: TaskResourceRecord[]
  onChange: (value: TaskResourceRecord[]) => void
}) {
  return field.field_type === "table" ? (
    <ResourceTableConfigControl taskKey={taskKey} field={field} resources={resources} onChange={onChange} />
  ) : (
    <ResourceTextareaConfigControl taskKey={taskKey} field={field} resources={resources} onChange={onChange} />
  )
}

function ResourceTextareaConfigControl({
  taskKey,
  field,
  resources,
  onChange,
}: {
  taskKey: string
  field: TaskConfigField
  resources: TaskResourceRecord[]
  onChange: (value: TaskResourceRecord[]) => void
}) {
  const [draft, setDraft] = useState("")
  const [isAdding, setIsAdding] = useState(false)

  async function addResources() {
    const sourceValues = draft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (sourceValues.length === 0) {
      toast.error("没有可导入的资料")
      return
    }

    const values = field.resource_type === "phone"
      ? sourceValues.map(normalizeUsPhoneNumber).filter((value): value is string => Boolean(value))
      : sourceValues
    const invalidCount = sourceValues.length - values.length
    if (values.length === 0) {
      toast.error("没有可导入的有效资料", {
        description: formatImportSummary(sourceValues.length, 0, invalidCount),
      })
      return
    }

    setIsAdding(true)
    try {
      const savedResources = await api.appendTaskResources(
        taskKey,
        field.resource_type,
        values.map((value) => ({ payload: { value } })),
      )
      onChange(savedResources)
      setDraft("")
      toast.success("资料已导入", {
        description: formatImportSummary(sourceValues.length, values.length, invalidCount),
      })
    } catch (caught) {
      toast.error("资料导入失败", { description: getErrorMessage(caught) })
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <Field className="min-w-0">
      <FieldLabel htmlFor={`task-config-${field.key}`} className="flex-wrap">
        <span className="min-w-0 break-words">{field.label}</span>
        <Badge variant="secondary">{resources.length} 行</Badge>
        {field.required ? <Badge variant="outline">必填</Badge> : null}
      </FieldLabel>
      <Textarea
        id={`task-config-${field.key}`}
        value={draft}
        placeholder={field.placeholder}
        onChange={(event) => setDraft(event.currentTarget.value)}
        className="min-h-24 resize-y"
      />
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={() => void addResources()} disabled={isAdding || !taskKey}>
          {isAdding ? "正在导入" : "添加资料"}
        </Button>
      </div>
      <ResourceUsageTable resources={resources} valueColumn={field.label} />
      {field.description ? <FieldDescription className="break-words">{field.description}</FieldDescription> : null}
    </Field>
  )
}

function ResourceTableConfigControl({
  taskKey,
  field,
  resources,
  onChange,
}: {
  taskKey: string
  field: TaskConfigField
  resources: TaskResourceRecord[]
  onChange: (value: TaskResourceRecord[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [importError, setImportError] = useState("")
  const [isImporting, setIsImporting] = useState(false)
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const columns = field.table_columns.length > 0 ? field.table_columns : [...REQUIRED_PROFILE_USER_COLUMNS]

  async function importFile(file: File) {
    setImportError("")
    setIsImporting(true)
    try {
      const parsedRows = await parseProfileUserFile(file, columns)
      const { rows, totalCount, invalidCount } = normalizeProfileUserImportRows(parsedRows, columns)
      if (rows.length === 0) {
        toast.error("没有可导入的有效资料", {
          description: formatImportSummary(totalCount, 0, invalidCount),
        })
        return
      }
      const savedResources = await api.appendTaskResources(
        taskKey,
        field.resource_type,
        rows.map((payload) => ({ payload })),
      )
      onChange(savedResources)
      toast.success("资料已导入", {
        description: formatImportSummary(totalCount, rows.length, invalidCount),
      })
    } catch (caught) {
      const message = getErrorMessage(caught)
      setImportError(message)
      toast.error("资料导入失败", { description: message })
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <TooltipProvider>
      <Field className="min-w-0">
        <FieldLabel className="flex-wrap">
          <span className="min-w-0 break-words">{field.label}</span>
          <Badge variant="secondary">{resources.length} 条资料</Badge>
          {field.required ? <Badge variant="outline">必填</Badge> : null}
        </FieldLabel>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv,.tsv"
          className="sr-only"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (file) void importFile(file)
          }}
        />
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center",
            isDragging && "border-ring bg-muted/50",
          )}
          onDragEnter={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault()
            setIsDragging(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            setIsDragging(false)
            const file = event.dataTransfer.files[0]
            if (file) void importFile(file)
          }}
        >
          <div className="text-sm text-muted-foreground">拖入资料文件，或从本地选择文件。</div>
          <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={isImporting || !taskKey}>
            <UploadIcon data-icon="inline-start" />
            {isImporting ? "正在导入" : "导入资料"}
          </Button>
        </div>
        {importError ? (
          <Alert variant="destructive">
            <AlertTitle>资料导入失败</AlertTitle>
            <AlertDescription>{importError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="rounded-lg border">
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <div className="text-sm text-muted-foreground">{resources.length} 条资料</div>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={downloadProfileUserTemplate}>
                <DownloadIcon data-icon="inline-start" />
                下载模板
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onChange([...resources, createDraftResource(field.resource_type, emptyProfileUserRow(columns))])
                  setEditingRow(resources.length)
                }}
              >
                <PlusIcon data-icon="inline-start" />
                添加资料
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[880px] table-fixed">
              <TableHeader>
                <TableRow>
                  {columns.map((column) => <TableHead key={column}>{column}</TableHead>)}
                  <TableHead>状态</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
              {resources.map((resource, rowIndex) => (
                <TableRow key={resource.id || `draft-${rowIndex}`}>
                  {columns.map((column) => (
                    <TableCell key={column}>
                      {editingRow === rowIndex ? (
                        <Input
                          aria-label={`${column} 第 ${rowIndex + 1} 行`}
                          value={stringifyProfileValue(resource.payload[column])}
                          disabled={resource.state === "reserved"}
                          onChange={(event) => onChange(updateResourcePayload(resources, rowIndex, column, event.currentTarget.value))}
                        />
                      ) : (
                        <ResultTableCellText value={stringifyProfileValue(resource.payload[column])} className="max-w-48" />
                      )}
                    </TableCell>
                  ))}
                  <TableCell><ResourceStateBadge resource={resource} /></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`编辑第 ${rowIndex + 1} 行资料`} disabled={resource.state === "reserved"} onClick={() => setEditingRow(editingRow === rowIndex ? null : rowIndex)}>{editingRow === rowIndex ? <CheckIcon /> : <PencilIcon />}</Button>} />
                        <TooltipContent>{editingRow === rowIndex ? "完成编辑" : "编辑资料"}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`删除第 ${rowIndex + 1} 行资料`} disabled={resource.state === "reserved"} onClick={() => onChange(resources.filter((_, index) => index !== rowIndex))}><Trash2Icon /></Button>} />
                        <TooltipContent>删除资料</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {resources.length === 0 ? <TableRow><TableCell colSpan={columns.length + 2} className="py-8 text-center text-muted-foreground">暂无资料。</TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </div>
        </div>
        {field.description ? <FieldDescription className="break-words">{field.description}</FieldDescription> : null}
      </Field>
    </TooltipProvider>
  )
}

function ResourceUsageTable({ resources, valueColumn }: { resources: TaskResourceRecord[]; valueColumn: string }) {
  return (
    <TooltipProvider>
      <div className="overflow-x-auto rounded-lg border">
        <Table className="table-fixed">
          <TableHeader><TableRow><TableHead>{valueColumn}</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
          <TableBody>
            {resources.map((resource, index) => <TableRow key={resource.id || `draft-${index}`}><TableCell><ResultTableCellText value={stringifyProfileValue(resource.payload.value)} /></TableCell><TableCell><ResourceStateBadge resource={resource} /></TableCell></TableRow>)}
            {resources.length === 0 ? <TableRow><TableCell colSpan={2} className="py-4 text-center text-muted-foreground">暂无资料。</TableCell></TableRow> : null}
          </TableBody>
        </Table>
      </div>
    </TooltipProvider>
  )
}

function ResourceStateBadge({ resource }: { resource: TaskResourceRecord }) {
  const label = resource.state === "used" ? "已使用" : resource.state === "reserved" ? "使用中" : "可用"
  return <Badge variant={resource.state === "used" ? "secondary" : resource.state === "reserved" ? "outline" : "secondary"}>{label}</Badge>
}

function normalizeTaskResources(value: unknown): TaskResourceRecord[] {
  return Array.isArray(value) ? value.filter(isTaskResourceRecord) : []
}

function isTaskResourceRecord(value: unknown): value is TaskResourceRecord {
  return isRecord(value) && typeof value.id === "string" && isRecord(value.payload) && typeof value.resource_type === "string" && typeof value.state === "string"
}

function createDraftResource(resourceType: string, payload: Record<string, unknown>): TaskResourceRecord {
  return { id: "", resource_type: resourceType, payload, state: "available", used: false, created_at: "", updated_at: "", used_at: null }
}

function updateResourcePayload(resources: TaskResourceRecord[], rowIndex: number, key: string, value: string) {
  return resources.map((resource, index) => index === rowIndex ? { ...resource, payload: { ...resource.payload, [key]: value } } : resource)
}

const REQUIRED_PROFILE_USER_COLUMNS = ["name", "address", "city", "state", "zipcode", "phone"] as const

type ProfileUserRow = Record<string, string>

function ProfileTableConfigControl({
  field,
  value,
  onChange,
}: {
  field: TaskConfigField
  value: unknown
  onChange: (value: unknown) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [importError, setImportError] = useState("")
  const columns = field.table_columns.length > 0 ? field.table_columns : [...REQUIRED_PROFILE_USER_COLUMNS]
  const rows = normalizeProfileUserRows(value, columns)

  async function importFile(file: File) {
    setImportError("")
    try {
      onChange(await parseProfileUserFile(file, columns))
    } catch (caught) {
      setImportError(getErrorMessage(caught))
    }
  }

  function updateCell(rowIndex: number, column: string, nextValue: string) {
    onChange(
      rows.map((row, index) => (index === rowIndex ? { ...row, [column]: nextValue } : row)),
    )
  }

  function addRow() {
    onChange([...rows, emptyProfileUserRow(columns)])
  }

  function removeRow(rowIndex: number) {
    onChange(rows.filter((_, index) => index !== rowIndex))
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv,.tsv"
          className="sr-only"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (file) {
              void importFile(file)
            }
          }}
        />
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center",
            isDragging && "border-ring bg-muted/50",
          )}
          onDragEnter={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault()
            setIsDragging(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            setIsDragging(false)
            const file = event.dataTransfer.files[0]
            if (file) {
              void importFile(file)
            }
          }}
        >
          <div className="text-sm text-muted-foreground">拖入资料文件，或从本地选择文件。</div>
          <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
            <UploadIcon data-icon="inline-start" />
            选择资料文件
          </Button>
        </div>
        {importError ? (
          <Alert variant="destructive">
            <AlertTitle>资料导入失败</AlertTitle>
            <AlertDescription>{importError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="rounded-lg border">
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <div className="text-sm text-muted-foreground">{rows.length} 条资料</div>
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              <PlusIcon data-icon="inline-start" />
              添加资料
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead key={column}>{column}</TableHead>
                ))}
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={`profile-row-${rowIndex}`}>
                  {columns.map((column) => (
                    <TableCell key={column}>
                      <Input
                        aria-label={`${column} 第 ${rowIndex + 1} 行`}
                        value={row[column] ?? ""}
                        onChange={(event) => updateCell(rowIndex, column, event.currentTarget.value)}
                      />
                    </TableCell>
                  ))}
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`删除第 ${rowIndex + 1} 行资料`}
                            onClick={() => removeRow(rowIndex)}
                          >
                            <Trash2Icon />
                          </Button>
                        }
                      />
                      <TooltipContent>删除资料</TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length + 1} className="py-8 text-center text-muted-foreground">
                    暂无资料。
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </div>
    </TooltipProvider>
  )
}

function emptyProfileUserRow(columns: string[]): ProfileUserRow {
  return Object.fromEntries(columns.map((column) => [column, ""]))
}

function normalizeProfileUserRows(value: unknown, columns: string[]): ProfileUserRow[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter(isRecord)
    .map((row) =>
      Object.fromEntries(columns.map((column) => [column, stringifyProfileValue(row[column])])),
    )
}

async function parseProfileUserFile(file: File, columns: string[]): Promise<ProfileUserRow[]> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", raw: false })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) {
    throw new Error("资料文件不包含工作表。")
  }

  const worksheet = workbook.Sheets[firstSheetName]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: "",
    raw: false,
  })
  const headerRow = rows[0]
  if (!Array.isArray(headerRow)) {
    throw new Error("资料文件缺少表头行。")
  }

  const columnIndexes = new Map(
    headerRow.map((header, index) => [String(header).trim().toLowerCase(), index]),
  )
  const missingColumns = columns.filter((column) => !columnIndexes.has(column.toLowerCase()))
  if (missingColumns.length > 0) {
    throw new Error(`资料表缺少列头：${missingColumns.join(", ")}。`)
  }

  const profileRows = rows.slice(1).map((sourceRow) => {
    const cells = Array.isArray(sourceRow) ? sourceRow : []
    return Object.fromEntries(
      columns.map((column) => [
        column,
        stringifyProfileValue(cells[columnIndexes.get(column.toLowerCase()) ?? -1]),
      ]),
    )
  })
  const nonEmptyRows = profileRows.filter((row) => columns.some((column) => row[column].trim()))
  if (nonEmptyRows.length === 0) {
    throw new Error("资料表没有可用的数据行。")
  }
  return nonEmptyRows
}

function normalizeProfileUserImportRows(rows: ProfileUserRow[], columns: string[]) {
  const normalizedRows: ProfileUserRow[] = []
  let invalidCount = 0

  for (const row of rows) {
    const normalized = normalizeProfileUserRow(row, columns)
    if (normalized) {
      normalizedRows.push(normalized)
    } else {
      invalidCount += 1
    }
  }

  return { rows: normalizedRows, totalCount: rows.length, invalidCount }
}

function resourcesForPersistence(
  task: TaskModule,
  resourceType: string,
  resources: TaskResourceRecord[],
) {
  if (task.key !== "overchargedforpork" || resourceType !== "user") {
    return resources
  }

  const columns = task.config_fields.find((field) => field.resource_type === resourceType)?.table_columns
    ?? [...REQUIRED_PROFILE_USER_COLUMNS]
  return resources.flatMap((resource) => {
    if (resource.id) {
      return [resource]
    }
    const payload = normalizeProfileUserRow(
      Object.fromEntries(Object.entries(resource.payload).map(([key, value]) => [key, stringifyProfileValue(value)])),
      columns,
    )
    return payload ? [{ ...resource, payload }] : []
  })
}

function normalizeProfileUserRow(row: ProfileUserRow, columns: string[]): ProfileUserRow | null {
  const values = Object.fromEntries(columns.map((column) => [column, stringifyProfileValue(row[column])]))
  if (!REQUIRED_PROFILE_USER_COLUMNS.every((column) => values[column])) {
    return null
  }

  const name = values.name.replace(/\s+/g, " ").trim()
  const state = normalizeUsState(values.state)
  const zipcode = normalizeUsZipcode(values.zipcode)
  const phone = normalizeUsPhoneNumber(values.phone)
  if (name.split(" ").length < 2 || !state || !zipcode || !phone) {
    return null
  }

  return { ...values, name, state, zipcode, phone }
}

function normalizeUsState(value: string): string | null {
  return US_STATE_CODES[value.toUpperCase().replace(/[^A-Z]/g, "")] ?? null
}

function normalizeUsZipcode(value: string): string | null {
  const match = value.trim().match(/^(\d{4,5})(?:\.0+)?$/)
  if (!match) {
    return null
  }
  return match[1].padStart(5, "0")
}

function normalizeUsPhoneNumber(value: string): string | null {
  const digits = value.replace(/\D/g, "")
  const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
  return /^\d{10}$/.test(normalized) ? normalized : null
}

function formatImportSummary(totalCount: number, availableCount: number, invalidCount: number) {
  return `总计 ${totalCount} 条；可用 ${availableCount} 条；无效 ${invalidCount} 条。`
}

function downloadProfileUserTemplate() {
  downloadTextFile("user-profile-template.csv", `${REQUIRED_PROFILE_USER_COLUMNS.join(",")}\n`, "text/csv;charset=utf-8")
}

const US_STATE_CODES: Record<string, string> = {
  AL: "AL", ALABAMA: "AL", AK: "AK", ALASKA: "AK", AZ: "AZ", ARIZONA: "AZ", AR: "AR", ARKANSAS: "AR",
  CA: "CA", CALIFORNIA: "CA", CO: "CO", COLORADO: "CO", CT: "CT", CONNECTICUT: "CT", DE: "DE", DELAWARE: "DE",
  FL: "FL", FLORIDA: "FL", GA: "GA", GEORGIA: "GA", HI: "HI", HAWAII: "HI", ID: "ID", IDAHO: "ID",
  IL: "IL", ILLINOIS: "IL", IN: "IN", INDIANA: "IN", IA: "IA", IOWA: "IA", KS: "KS", KANSAS: "KS",
  KY: "KY", KENTUCKY: "KY", LA: "LA", LOUISIANA: "LA", ME: "ME", MAINE: "ME", MD: "MD", MARYLAND: "MD",
  MA: "MA", MASSACHUSETTS: "MA", MI: "MI", MICHIGAN: "MI", MN: "MN", MINNESOTA: "MN", MS: "MS", MISSISSIPPI: "MS",
  MO: "MO", MISSOURI: "MO", MT: "MT", MONTANA: "MT", NE: "NE", NEBRASKA: "NE", NV: "NV", NEVADA: "NV",
  NH: "NH", NEWHAMPSHIRE: "NH", NJ: "NJ", NEWJERSEY: "NJ", NM: "NM", NEWMEXICO: "NM", NY: "NY", NEWYORK: "NY",
  NC: "NC", NORTHCAROLINA: "NC", ND: "ND", NORTHDAKOTA: "ND", OH: "OH", OHIO: "OH", OK: "OK", OKLAHOMA: "OK",
  OR: "OR", OREGON: "OR", PA: "PA", PENNSYLVANIA: "PA", RI: "RI", RHODEISLAND: "RI", SC: "SC", SOUTHCAROLINA: "SC",
  SD: "SD", SOUTHDAKOTA: "SD", TN: "TN", TENNESSEE: "TN", TX: "TX", TEXAS: "TX", UT: "UT", UTAH: "UT",
  VT: "VT", VERMONT: "VT", VA: "VA", VIRGINIA: "VA", WA: "WA", WASHINGTON: "WA", WV: "WV", WESTVIRGINIA: "WV",
  WI: "WI", WISCONSIN: "WI", WY: "WY", WYOMING: "WY", DC: "DC", DISTRICTOFCOLUMBIA: "DC",
}

function stringifyProfileValue(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim()
}

function TaskConfigMultiSelect({
  field,
  value,
  onChange,
}: {
  field: TaskConfigField
  value: unknown
  onChange: (value: unknown) => void
}) {
  const selectedValues = normalizeMultiSelectValue(value)
  return (
    <MultiSelect
      id={`task-config-${field.key}`}
      value={selectedValues}
      options={field.options.map((option) => ({ label: option, value: option }))}
      placeholder={field.placeholder || "请选择"}
      onChange={onChange}
    />
  )
}

type AppSelectOption = {
  label: string
  value: string
}

function SingleSelect({
  id,
  value,
  options,
  placeholder = "请选择",
  disabled = false,
  onChange,
}: {
  id?: string
  value: string
  options: AppSelectOption[]
  placeholder?: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const collection = createListCollection({ items: options })

  return (
    <Select
      collection={collection}
      ids={id ? { trigger: id } : undefined}
      value={value ? [value] : []}
      disabled={disabled}
      onValueChange={(details) => onChange(details.value[0] ?? "")}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {collection.items.map((option) => (
          <SelectItem key={option.value} item={option}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MultiSelect({
  id,
  value,
  options,
  placeholder = "请选择",
  disabled = false,
  onChange,
}: {
  id?: string
  value: string[]
  options: AppSelectOption[]
  placeholder?: string
  disabled?: boolean
  onChange: (value: string[]) => void
}) {
  const collection = createListCollection({ items: options })

  return (
    <Select
      collection={collection}
      ids={id ? { trigger: id } : undefined}
      value={value}
      multiple
      disabled={disabled}
      onValueChange={(details) => onChange(details.value)}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder}>
          <SelectContext>{({ value: selected }) => formatSelectedOptions(selected, options, placeholder)}</SelectContext>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {collection.items.map((option) => (
          <SelectItem key={option.value} item={option}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function loadWindowArrangeSettings() {
  try {
    const rawValue = window.localStorage.getItem("nexus-flow.windowArrangeSettings")
    if (!rawValue) {
      return { startX: 0, startY: 0, width: 500, height: 950, col: 3, spaceX: -200, spaceY: 0 }
    }
    const parsed = JSON.parse(rawValue) as Record<string, unknown>
    return sanitizeWindowArrangeSettings({
      startX: normalizeWindowArrangeNumber(parsed.startX),
      startY: normalizeWindowArrangeNumber(parsed.startY),
      width: normalizeWindowArrangeNumber(parsed.width),
      height: normalizeWindowArrangeNumber(parsed.height),
      col: normalizeWindowArrangeNumber(parsed.col),
      spaceX: normalizeWindowArrangeNumber(parsed.spaceX),
      spaceY: normalizeWindowArrangeNumber(parsed.spaceY),
    })
  } catch {
    return { startX: 0, startY: 0, width: 500, height: 950, col: 3, spaceX: -200, spaceY: 0 }
  }
}

function loadPluginRepositoryUrl() {
  try {
    return window.localStorage.getItem(PLUGIN_REPOSITORY_URL_STORAGE_KEY) || DEFAULT_PLUGIN_REPOSITORY_URL
  } catch {
    return DEFAULT_PLUGIN_REPOSITORY_URL
  }
}

function sanitizeWindowArrangeSettings(settings: {
  startX: number
  startY: number
  width: number
  height: number
  col: number
  spaceX: number
  spaceY: number
}) {
  return {
    startX: normalizeWindowArrangeNumber(settings.startX),
    startY: normalizeWindowArrangeNumber(settings.startY),
    width: Math.max(normalizeWindowArrangeNumber(settings.width), 400),
    height: Math.max(normalizeWindowArrangeNumber(settings.height), 900),
    col: Math.max(normalizeWindowArrangeNumber(settings.col), 1),
    spaceX: normalizeWindowArrangeNumber(settings.spaceX),
    spaceY: normalizeWindowArrangeNumber(settings.spaceY),
  }
}

function normalizeWindowArrangeNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value)
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : 0
}

function downloadJsonFile(filename: string, data: unknown) {
  downloadBlob(filename, JSON.stringify(data, null, 2), "application/json")
}

function downloadTextFile(filename: string, content: string, type = "text/plain;charset=utf-8") {
  downloadBlob(filename, content, type)
}

function downloadBlob(filename: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function exportResultTable(definition: TaskResultDefinition, runId: string, results: TaskResult[]) {
  const exportedAt = new Date()
  const dataKeys = collectResultDataKeys(results)
  const headers = [
    "id",
    "run_id",
    "work_item_id",
    "task_key",
    "key",
    "status",
    "message",
    "created_at",
    ...dataKeys.map((key) => `data.${key}`),
    "data_json",
  ]
  const rows = results.map((result) => {
    const data = result.data ?? {}
    return [
      result.id,
      result.run_id,
      result.work_item_id,
      result.task_key,
      result.key,
      result.status,
      result.message,
      result.created_at,
      ...dataKeys.map((key) => formatResultValue(data[key])),
      formatResultData(data),
    ]
  })
  const csv = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n")
  downloadTextFile(
    `task-result-${definition.key}-${runId.slice(0, 8)}-${formatDateForFilename(exportedAt)}.csv`,
    csv,
    "text/csv;charset=utf-8",
  )
}

function groupResultsByRun(results: TaskResult[]) {
  const grouped = new Map<string, TaskResult[]>()
  for (const result of results) {
    const current = grouped.get(result.run_id) ?? []
    current.push(result)
    grouped.set(result.run_id, current)
  }

  return Array.from(grouped.entries())
    .map(([runId, groupedResults]) => ({
      runId,
      results: groupedResults.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)),
      latestCreatedAt: Math.max(...groupedResults.map((result) => Date.parse(result.created_at))),
    }))
    .sort((left, right) => right.latestCreatedAt - left.latestCreatedAt)
}

function collectResultDataKeys(results: TaskResult[]) {
  const keys = new Set<string>()
  for (const result of results) {
    for (const key of Object.keys(result.data ?? {})) {
      keys.add(key)
    }
  }
  return Array.from(keys).sort()
}

function escapeCsvCell(value: unknown) {
  const text = formatResultValue(value)
  return `"${text.replace(/"/g, '""')}"`
}

function parseTaskConfigImport(value: unknown, currentTaskKey: string) {
  if (!isRecord(value)) {
    throw new Error("导入的任务配置必须是 JSON 对象。")
  }

  if ("config" in value) {
    if (typeof value.task_key === "string" && value.task_key !== currentTaskKey) {
      throw new Error(`导入的配置属于任务 "${value.task_key}"，不是当前任务 "${currentTaskKey}"。`)
    }
    if (!isRecord(value.config)) {
      throw new Error("导入的任务配置缺少有效的 config 对象。")
    }
    return value.config
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatDateForFilename(date: Date) {
  return date.toISOString().replace(/[:.]/g, "-")
}

function groupFieldsByBlock(fields: TaskConfigField[]): TaskConfigBlock[] {
  const grouped = new Map<string, TaskConfigField[]>()
  for (const field of fields) {
    const block = field.block && field.block !== "general" ? field.block : normalizeBlockName(field)
    grouped.set(block, [...(grouped.get(block) ?? []), field])
  }
  return Array.from(grouped.entries()).map(([name, blockFields]) => ({
    name,
    fields: blockFields,
  }))
}

function normalizeBlockName(field: TaskConfigField) {
  if (field.key.startsWith("cloud_mail_")) return "邮箱"
  if (field.key.includes("proxy")) return "代理"
  if (field.key.includes("arrange")) return "窗口重排"
  if (field.key.includes("account")) return "账号"
  if (field.key === "cards" || field.key.includes("billing")) return "支付"
  return "任务"
}

function getBlockStats(
  block: TaskConfigBlock,
  config: Record<string, unknown>,
  resources: Record<string, TaskResourceRecord[]>,
) {
  const requiredFields = block.fields.filter((field) => field.required)
  const completedRequired = requiredFields.filter((field) =>
    field.resource_type
      ? (resources[field.resource_type] ?? []).some((resource) => resource.state === "available")
      : isFilled(config[field.key]),
  ).length
  return {
    required: requiredFields.length,
    completedRequired,
    missingRequired: requiredFields.length - completedRequired,
  }
}

function isFilled(value: unknown) {
  if (typeof value === "string") {
    return value.trim().length > 0
  }
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return value !== undefined && value !== null && value !== ""
}

function validateProfileConfigForRun(task: TaskModule, resources: Record<string, TaskResourceRecord[]>) {
  if (task.key !== "overchargedforpork") {
    return ""
  }

  const hasUsableUser = (resources.user ?? []).some((resource) =>
    resource.state === "available" && REQUIRED_PROFILE_USER_COLUMNS.every((column) => stringifyProfileValue(resource.payload[column]).length > 0),
  )
  if (!hasUsableUser) {
    return "资料 user 需要至少一条包含 name、address、city、state、zipcode、phone 的完整数据。"
  }

  if (!(resources.email ?? []).some((resource) => resource.state === "available" && stringifyProfileValue(resource.payload.value))) {
    return "资料 email 需要至少一条可用邮箱数据。"
  }

  return ""
}

function defaultConfigForTask(task: TaskModule) {
  const defaults: Record<string, unknown> = {}
  for (const field of task.config_fields) {
    if (!field.resource_type && field.default !== null && field.default !== undefined) {
      defaults[field.key] = field.default
    }
  }
  return defaults
}

function sanitizeTaskConfig(task: TaskModule, config: Record<string, unknown>) {
  const allowedKeys = new Set(task.config_fields.filter((field) => !field.resource_type).map((field) => field.key))
  return Object.fromEntries(Object.entries(config).filter(([key]) => allowedKeys.has(key)))
}

function resourceTypesForTask(task: TaskModule) {
  return Array.from(new Set(task.config_fields.map((field) => field.resource_type).filter(Boolean)))
}

function taskResourceStateKey(taskKey: string, resourceType: string) {
  return `${taskKey}:${resourceType}`
}

function legacyTaskResources(field: TaskConfigField, value: unknown): TaskResourceRecord[] {
  if (field.field_type === "table") {
    const columns = field.table_columns.length > 0 ? field.table_columns : [...REQUIRED_PROFILE_USER_COLUMNS]
    return normalizeProfileUserRows(value, columns).map((payload) => createDraftResource(field.resource_type, payload))
  }
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => createDraftResource(field.resource_type, { value: text }))
}

function normalizeMultiSelectValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item))
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean)
  }
  return []
}

function normalizeBooleanValue(value: unknown) {
  if (typeof value === "boolean") {
    return value
  }
  if (typeof value === "string") {
    return ["1", "true", "yes", "on", "y"].includes(value.trim().toLowerCase())
  }
  return Boolean(value)
}

function formatSelectedOptions(values: string[], options: AppSelectOption[], placeholder: string) {
  if (values.length === 0) {
    return placeholder
  }
  const labelsByValue = new Map(options.map((option) => [option.value, option.label]))
  const firstLabel = labelsByValue.get(values[0] ?? "") ?? values[0] ?? ""
  if (values.length === 1) {
    return firstLabel
  }
  return `${firstLabel}（另 ${values.length - 1} 项）`
}

function countNonEmptyLines(value: string) {
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0).length
}

function browserDotClassName(status: "checking" | "online" | "offline") {
  const baseClassName = "size-2 rounded-full"
  if (status === "online") {
    return `${baseClassName} bg-emerald-500`
  }
  if (status === "offline") {
    return `${baseClassName} bg-destructive`
  }
  return `${baseClassName} bg-muted-foreground`
}

function isRunActive(run: TaskRun) {
  return ["pending", "running", "stopping"].includes(run.status)
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function formatFileSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) {
    return "-"
  }
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatResultValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-"
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return JSON.stringify(value)
}

function formatResultData(value: Record<string, unknown>) {
  return JSON.stringify(value ?? {})
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B"
  }
  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** index
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function collectTaskResults(results: TaskResult[], definitions: { key: string }[]) {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.key,
      results
        .filter((result) => result.key === definition.key)
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)),
    ]),
  )
}

function upsertRun(runs: TaskRun[], run: TaskRun) {
  const next = runs.some((item) => item.id === run.id)
    ? runs.map((item) => (item.id === run.id ? run : item))
    : [run, ...runs]
  return next.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
}

function mergeRunLogs(logsByRunId: Record<string, TaskRunLog[]>, runId: string, logs: TaskRunLog[]) {
  const current = logsByRunId[runId] ?? []
  const indexById = new Map(current.map((log, index) => [log.id, index]))
  const nextLogs = [...current]

  for (const log of logs) {
    const existingIndex = indexById.get(log.id)
    if (existingIndex === undefined) {
      indexById.set(log.id, nextLogs.length)
      nextLogs.push(log)
    } else {
      nextLogs[existingIndex] = log
    }
  }

  const sortedLogs = nextLogs.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
  return {
    ...logsByRunId,
    [runId]: sortedLogs.slice(-MAX_LOGS_PER_RUN),
  }
}

function closeWebSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.onopen = () => socket.close()
    return
  }
  if (socket.readyState === WebSocket.OPEN) {
    socket.close()
  }
}

export default App
