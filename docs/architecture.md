# 架构说明

## 总体结构

```text
React / Tauri Desktop
  ├─ HTTP：任务、资料、插件、浏览器会话
  └─ WebSocket：运行状态、日志、人工处理通知
             │
             ▼
FastAPI Local API
  ├─ task_control / task_runner：创建、调度、停止运行
  ├─ runtime_store / sqlite_store：运行状态与持久化记录
  ├─ browser_session_service：BitBrowser / AdsPower 会话
  ├─ plugin_registry：ZIP 插件安装与加载
  └─ runtime_event_hub：进程内实时事件分发
             │
             ▼
AutomationTaskModule
  ├─ TaskExecutionContext：日志、资料、结果、附件、浏览器、通知
  └─ DrissionPage / 其他自动化库：实际页面操作
```

## 运行生命周期

1. 前端提交任务配置、浏览器供应商、并发数和清理策略。
2. `POST /api/tasks/runs` 校验配置与必需资料，模块生成 `WorkItemSpec`。
3. `task_runner` 根据并发数执行工作项，并为每个工作项创建 `TaskExecutionContext`。
4. 模块领取资料、打开浏览器、执行自动化、写入结果或附件。
5. 工作项结束时释放其运行时资源，并依照 `keep_open`、`close`、`delete` 清理浏览器。
6. 运行结束时清理未解决通知、清理剩余浏览器会话并写入最终状态。

## 插件边界

任务模块继承 `AutomationTaskModule`，其 `TaskModuleManifest` 用于声明：

- 前端配置字段及资料类型；
- 结果和附件定义；
- 是否需要浏览器与最大会话数。

运行器将业务模块与基础设施隔离。模块只应通过 `TaskExecutionContext` 使用日志、资料、结果、附件、浏览器及通知能力，不应直接依赖前端实现或 SQLite 表结构。

## 实时事件

日志、运行状态和通知走不同的事件主题。通知端点为：

```text
ws://<api>/api/tasks/runs/{run_id}/notifications/ws
```

通知事件结构为：

```json
{
  "type": "notification",
  "event": "raised | resolved",
  "notification": {
    "id": "...",
    "kind": "manual_action",
    "title": "需要人机验证",
    "message": "窗口 1 正在等待 Turnstile 人机验证。",
    "speech": "窗口 1 需要处理人机验证。",
    "sound": "ding"
  }
}
```

后端只保存当前进程的未解决通知，并在新客户端连接时重放；前端按通知 ID 去重，避免 WebSocket 重连后重复朗读。当前实现不将通知写入 SQLite。

## 浏览器自动化

浏览器服务负责创建或打开浏览器 profile，并向模块提供调试地址。业务模块使用 DrissionPage 连接该地址后，负责元素等待、点击、逐字输入、页面状态校验及异常处理。页面成功标识应以 DOM 状态为准，不能仅以“已调用 click”为完成依据。

## 数据与安全边界

- 运行记录、资料、结果、附件元数据和浏览器会话由本地 SQLite 管理。
- 任务资料可能包含个人信息，应限制在本地数据目录与可信插件范围内使用。
- ZIP 插件中的 Python 代码具备本地执行权限；只安装可信来源的包。
- 通知音频是前端静态资源，位于 `apps/desktop/public/sounds/ding.wav`；TTS 使用操作系统 / 浏览器提供的语音能力。
