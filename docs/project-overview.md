# 项目概览

Nexus Flow 是一个本地优先的桌面自动化任务控制台。它将桌面界面、Python 任务模块、指纹浏览器和本地运行记录组合起来，用于执行需要持续观察、可复用资料和人工介入的浏览器自动化流程。

## 核心能力

- 以 manifest 驱动的动态任务配置表单。
- 将一次运行拆分为多个工作项，并控制并发执行。
- 通过 BitBrowser 或 AdsPower 管理指纹浏览器会话。
- 通过 DrissionPage 等库在浏览器页面执行自动化操作。
- 保存运行、日志、浏览器会话、结果、附件和任务资料。
- 支持内置开发模块、ZIP 插件安装和远程插件仓库。
- 以 WebSocket 推送实时日志、运行状态和人工处理通知。

## 主要组成

| 组成 | 技术与职责 |
| --- | --- |
| 桌面端 | Tauri 2、React、TypeScript；配置任务、观察进度、处理通知。 |
| 本地 API | FastAPI；提供任务、资料、浏览器和插件接口。 |
| 任务运行器 | 创建工作项上下文，调度并发，写入结果并清理资源。 |
| 任务模块 | Python `AutomationTaskModule`；定义 manifest、工作项和业务流程。 |
| 浏览器服务 | 对接 BitBrowser / AdsPower，管理 profile 和调试地址。 |
| 本地数据 | SQLite 保存持久记录；运行时事件通过进程内事件中心分发。 |

## 模块开发模式

`backend/app/task_modules/test_email.py` 是受版本控制的最小示例。开发环境会发现 `backend/app/task_modules/` 下的子包；这些具体业务模块默认不进入 Git。生产分发使用带 `manifest.json` 和入口模块的 ZIP 插件。

## 通知设计

当任务无法继续且需要人工处理时，模块调用 `context.notify.manual_action(...)`。后端为该运行广播独立通知事件；桌面端接收后播放音效、使用 TTS 朗读并显示提示条。任务恢复后调用 `resolve(...)`，任务结束时系统会清理该运行尚未解除的通知。
