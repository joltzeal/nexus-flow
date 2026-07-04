# Nexus Flow

Nexus Flow 是一个桌面端自动化任务控制台，使用 Tauri + React 构建桌面前端，FastAPI 提供本地后端服务。它面向需要长期运行、观察、记录和复用的自动化任务：任务模块可以内置在应用中，也可以作为 ZIP 插件包安装、升级和分发。

## 功能概览

- 桌面任务启动器：选择任务模块、填写配置、设置并发数并启动任务。
- 动态配置表单：任务模块声明字段后，前端自动渲染输入控件。
- 实时日志：通过 WebSocket 观察运行过程。
- 运行记录：持久化每次任务的状态、工作项、浏览器窗口、结果和附件。
- 结果与附件：任务可以写入结构化结果，也可以保存截图、文本或文件。
- 指纹浏览器集成：任务可以申请、排列、关闭或保留浏览器窗口。
- 动态插件：支持上传 ZIP 插件包，或从插件仓库安装、升级。
- 插件仓库：支持 Cloudflare R2 / S3 兼容对象存储上的 `index.json` 仓库。
- 桌面端发布：支持把后端作为 Tauri sidecar 打进 macOS / Windows 应用。

## 技术栈

- Desktop: Tauri 2
- Frontend: React 19, TypeScript, Vite, Tailwind CSS, shadcn-style components
- Backend: FastAPI, Pydantic, WebSocket
- Python runtime: uv, Python 3.13+
- Plugin package: ZIP + `manifest.json`
- Plugin repository: static `index.json` + plugin zip files on R2/S3

## 本地开发

安装 Python 依赖：

```bash
uv sync --group dev
```

安装前端依赖：

```bash
cd apps/desktop
pnpm install
```

启动桌面开发环境：

```bash
cd apps/desktop
pnpm tauri dev
```

只构建前端：

```bash
cd apps/desktop
pnpm build
```

后端语法检查：

```bash
uv run python -m compileall backend/app
```

## 桌面端构建

项目已配置 GitHub Actions。推送 `v*` tag 或手动触发 workflow 会构建 macOS / Windows 桌面端并发布 Release。

本地构建时需要先生成后端 sidecar，再运行 Tauri build。CI 配置见：

```text
.github/workflows/release-desktop.yml
```

## 目录结构

```text
backend/app
  api/                    FastAPI 路由
  services/               任务运行、插件加载、浏览器会话、持久化
  task_modules/           内置任务模块与开发模式任务模块
  task_modules/base.py    插件任务接口定义

apps/desktop
  src/                    React 桌面前端
  src-tauri/              Tauri 配置和 sidecar 配置

scripts/
  publish_plugin_r2.sh    Cloudflare R2 插件发布脚本
```

## 插件系统

Nexus Flow 的任务插件是一个 ZIP 包。上传或从仓库安装后，插件会被解压到 Nexus Flow 用户数据目录下的 `plugins` 目录。

默认插件目录：

- macOS: `~/Library/Application Support/Nexus Flow/plugins`
- Windows: `%APPDATA%/Nexus Flow/plugins`
- Linux: `~/.local/share/nexus-flow/plugins`

也可以用环境变量覆盖：

```bash
NEXUS_FLOW_DATA_DIR=/path/to/data
```

### 插件包结构

插件 ZIP 可以包含一个根目录，安装时会自动剥离单一根目录：

```text
sample-0.1.0.plugin.zip
  sample/
    manifest.json
    module.py
```

也可以直接把文件放在 ZIP 根目录：

```text
sample-0.1.0.plugin.zip
  manifest.json
  module.py
```

安装后目录形态：

```text
plugins/
  sample/
    manifest.json
    module.py
```

### manifest.json

每个插件必须包含 `manifest.json`：

```json
{
  "key": "sample",
  "name": "Sample",
  "version": "0.1.0",
  "description": "示例任务插件",
  "entry": "module:SampleTaskModule"
}
```

字段说明：

| 字段            | 必填 | 说明                                           |
| --------------- | ---- | ---------------------------------------------- |
| `key`         | 是   | 插件唯一标识，只能包含字母、数字、`-`、`_` |
| `name`        | 否   | 前端展示名称                                   |
| `version`     | 否   | 插件版本，用于仓库升级提示                     |
| `description` | 否   | 插件说明                                       |
| `entry`       | 是   | 入口，格式为`module.path:ClassName`          |

`entry` 示例：

```text
module:SampleTaskModule
package.module:TaskModule
```

插件代码里的 `TaskModuleManifest.key` 必须和 `manifest.json` 的 `key` 一致。

## 任务模块接口

插件入口类必须继承 `AutomationTaskModule`，并声明 `manifest`。

完整示例：

```python
import random
import string

from app.task_modules.base import (
    AutomationTaskModule,
    BrowserRequirement,
    TaskConfigField,
    TaskExecutionContext,
    TaskModuleManifest,
    TaskResult,
    TaskResultDefinition,
    WorkItemSpec,
)


class SampleTaskModule(AutomationTaskModule):
    manifest = TaskModuleManifest(
        key="sample",
        name="Sample",
        description="示例动态任务",
        config_fields=[
            TaskConfigField(
                key="email_domain",
                label="邮箱域名",
                block="任务",
                field_type="text",
                required=True,
                default="example.com",
                placeholder="example.com",
            ),
            TaskConfigField(
                key="count",
                label="数量",
                block="任务",
                field_type="number",
                required=True,
                default=1,
            ),
        ],
        results=[
            TaskResultDefinition(
                key="email",
                label="邮箱",
                description="生成的邮箱结果",
            )
        ],
        browser=BrowserRequirement(required=False),
    )

    def build_work_items(self, config: dict) -> list[WorkItemSpec]:
        count = max(int(config.get("count") or 1), 1)
        return [
            WorkItemSpec(
                key="email",
                label=f"邮箱 {index}",
                input={"email_domain": config.get("email_domain")},
            )
            for index in range(1, count + 1)
        ]

    async def run(self, context: TaskExecutionContext) -> TaskResult:
        context.raise_if_stopping()
        domain = str(context.input.get("email_domain") or "example.com").strip().lstrip("@")
        local_part = "".join(random.choices(string.ascii_lowercase + string.digits, k=12))
        email = f"{local_part}@{domain}"
        await context.log("info", f"Generated email: {email}")
        return TaskResult(
            key="email",
            data={"email": email},
            status="completed",
            message=f"Generated email: {email}",
        )
```

### TaskModuleManifest

`TaskModuleManifest` 控制前端展示和运行能力：

```python
TaskModuleManifest(
    key="sample",
    name="Sample",
    description="示例动态任务",
    config_fields=[],
    results=[],
    artifacts=[],
    browser=BrowserRequirement(required=False),
)
```

字段说明：

| 字段              | 说明                   |
| ----------------- | ---------------------- |
| `key`           | 任务模块唯一标识       |
| `name`          | 前端展示名称           |
| `description`   | 前端展示说明           |
| `config_fields` | 前端配置表单字段       |
| `results`       | 任务可能写入的结果类型 |
| `artifacts`     | 任务可能保存的附件类型 |
| `browser`       | 浏览器需求声明         |

### 配置字段

`TaskConfigField` 支持：

```python
TaskConfigField(
    key="message",
    label="消息",
    block="基础",
    field_type="text",
    required=False,
    default="Hello",
    description="表单说明",
    placeholder="Hello",
    options=[],
)
```

`field_type` 可选：

```text
text
password
number
textarea
select
multi-select
checkbox
```

`select` 和 `multi-select` 需要提供 `options`：

```python
TaskConfigField(
    key="mode",
    label="模式",
    field_type="select",
    default="fast",
    options=["fast", "safe"],
)
```

### 工作项调度

插件可以重写 `build_work_items(config)`，把一次任务拆成多个工作项。外层 runner 会按用户设置的并发数运行这些工作项。

```python
def build_work_items(self, config: dict) -> list[WorkItemSpec]:
    return [
        WorkItemSpec(key="item", label="Item 1", input={"index": 1}),
        WorkItemSpec(key="item", label="Item 2", input={"index": 2}),
    ]
```

如果不重写，默认只有一个工作项：

```python
WorkItemSpec(key="default", input=dict(config), label="默认任务项")
```

### 运行上下文

`run(context)` 会收到 `TaskExecutionContext`：

| 属性或方法                                           | 说明               |
| ---------------------------------------------------- | ------------------ |
| `context.run_id`                                   | 当前运行 ID        |
| `context.work_item_id`                             | 当前工作项 ID      |
| `context.work_item_index` / `context.item_index` | 当前工作项序号     |
| `context.work_item_key`                            | 当前工作项 key     |
| `context.vendor`                                   | 当前浏览器供应商   |
| `context.config`                                   | 任务配置           |
| `context.input`                                    | 当前工作项输入     |
| `await context.log(level, message)`                | 写入日志           |
| `context.is_stopping()`                            | 是否正在停止       |
| `context.raise_if_stopping()`                      | 停止时抛出取消异常 |
| `context.results.add(...)`                         | 写入结构化结果     |
| `context.artifacts.save_bytes(...)`                | 保存二进制附件     |
| `context.artifacts.save_text(...)`                 | 保存文本附件       |
| `context.browser`                                  | 浏览器会话管理器   |

日志级别：

```text
info
warn
error
debug
verbose
```

## 结果与附件

### 返回 TaskResult

最简单的写结果方式是在 `run` 里返回 `TaskResult`：

```python
return TaskResult(
    key="email",
    data={"email": email},
    status="completed",
    message="Generated email",
)
```

也可以返回普通字典。字典会被写入默认结果 key：

```python
return {
    "status": "ok",
    "message": "任务完成",
    "value": 123,
}
```

### 主动写入多条结果

```python
await context.results.add(
    "email",
    {"email": email},
    status="completed",
    message="Generated email",
)
```

### 保存附件

```python
await context.artifacts.save_text(
    "report",
    "report.txt",
    "Hello Nexus Flow",
    kind="text",
    mime_type="text/plain",
    name="运行报告",
)
```

```python
await context.artifacts.save_bytes(
    "screenshot",
    "page.png",
    png_bytes,
    kind="screenshot",
    mime_type="image/png",
    name="页面截图",
)
```

在 manifest 里声明附件类型：

```python
from app.task_modules.base import TaskArtifactDefinition

artifacts=[
    TaskArtifactDefinition(
        key="screenshot",
        label="截图",
        kind="screenshot",
        description="任务运行截图",
    )
]
```

## 浏览器插件能力

需要浏览器窗口的任务可以声明：

```python
browser=BrowserRequirement(required=True, max_sessions=1)
```

运行时申请窗口：

```python
from app.task_modules.base import BrowserOpenOptions

session = await context.browser.open(
    BrowserOpenOptions(
        create_payload={
            "name": "Sample Browser",
            "proxyMethod": 2,
            "proxyType": "noproxy",
        },
        launch_args=[],
    )
)
```

可用方法：

| 方法                                                      | 说明                         |
| --------------------------------------------------------- | ---------------------------- |
| `await context.browser.open(options)`                   | 创建或打开浏览器窗口         |
| `await context.browser.close(session_id, delete=False)` | 关闭窗口，可选择删除 profile |
| `await context.browser.keep_open(session_id)`           | 标记窗口保留，不被自动清理   |
| `await context.browser.arrange(session_ids, options)`   | 重排窗口                     |

窗口清理由运行参数 `cleanup_policy` 控制：

```text
delete
close
keep_open
```

如果插件遇到需要人工处理的未知状态，可以调用：

```python
await context.browser.keep_open(session.id)
```

这样本次工作项结束后的清理流程会跳过该窗口。

## 插件安装与升级

Nexus Flow 支持三种插件安装方式：

1. 前端上传本地 ZIP。
2. 前端填写插件仓库 `index.json` URL，检查仓库后安装。
3. 前端检查仓库后，对已安装插件显示升级提示并升级。

### 仓库 index.json

插件仓库是一个静态 JSON 文件，可以放在 Cloudflare R2、S3、OSS 或任何 HTTP 静态文件服务上。

推荐结构：

```text
plugin-repo/
  index.json
  plugins/
    sample/
      sample-0.1.0.plugin.zip
      sample-0.1.1.plugin.zip
```

`index.json` 示例：

```json
{
  "schema_version": 1,
  "name": "default",
  "updated_at": "2026-06-02T00:00:00Z",
  "plugins": [
    {
      "key": "sample",
      "name": "Sample",
      "version": "0.1.1",
      "description": "示例任务插件",
      "file": "plugin-repo/plugins/sample/sample-0.1.1.plugin.zip",
      "url": "https://example.com/plugin-repo/plugins/sample/sample-0.1.1.plugin.zip",
      "sha256": "abc...",
      "size": 12345,
      "updated_at": "2026-06-02T00:00:00Z",
      "versions": [
        {
          "key": "sample",
          "name": "Sample",
          "version": "0.1.1",
          "file": "plugin-repo/plugins/sample/sample-0.1.1.plugin.zip",
          "url": "https://example.com/plugin-repo/plugins/sample/sample-0.1.1.plugin.zip",
          "sha256": "abc...",
          "size": 12345
        }
      ]
    }
  ]
}
```

前端升级提示逻辑：

- 本地未安装：显示“安装”。
- 本地已安装且远程版本更高：显示“可升级”。
- 本地已安装且远程版本不高于本地：显示“最新”。

安装或升级时，后端会：

1. 下载插件 ZIP。
2. 校验 `sha256`。
3. 解压并验证 `manifest.json`。
4. 覆盖安装到插件目录。
5. 重新加载插件模块。

## 发布插件到 Cloudflare R2

项目提供脚本：

```text
scripts/publish_plugin_r2.sh
```

脚本会：

1. 读取插件 `manifest.json`。
2. 打包为 `<key>-<version>.plugin.zip`。
3. 计算 `sha256` 和文件大小。
4. 上传 ZIP 到 R2。
5. 下载并更新 R2 上的 `index.json`。
6. 上传新的 `index.json`。

使用 Wrangler：

```bash
wrangler login

R2_BUCKET=nexus-flow-plugins \
PLUGIN_R2_UPLOADER=wrangler \
PLUGIN_PUBLIC_BASE_URL=https://pub-xxxxx.r2.dev/plugin-repo \
scripts/publish_plugin_r2.sh backend/app/task_modules/uber 0.1.40
```

不传版本号时会使用插件 `manifest.json` 里的 `version`：

```bash
R2_BUCKET=nexus-flow-plugins \
PLUGIN_R2_UPLOADER=wrangler \
PLUGIN_PUBLIC_BASE_URL=https://pub-xxxxx.r2.dev/plugin-repo \
scripts/publish_plugin_r2.sh backend/app/task_modules/uber
```

使用 AWS CLI 的 S3 兼容方式：

```bash
R2_BUCKET=nexus-flow-plugins \
R2_ACCOUNT_ID=your_cloudflare_account_id \
R2_ACCESS_KEY_ID=your_access_key \
R2_SECRET_ACCESS_KEY=your_secret_key \
PLUGIN_PUBLIC_BASE_URL=https://pub-xxxx.r2.dev/plugin-repo \
scripts/publish_plugin_r2.sh backend/app/task_modules/uber 0.1.40
```

本地 dry run：

```bash
R2_BUCKET=dummy \
PLUGIN_DRY_RUN=1 \
PLUGIN_PUBLIC_BASE_URL=https://example.com/plugin-repo \
scripts/publish_plugin_r2.sh backend/app/task_modules/uber 0.1.40
```

## 插件代码保护

如果插件 ZIP 中直接包含 `.py`，代码就是明文。生产分发时可以使用以下方案提高保护强度：

- PyArmor：发布前混淆 Python 代码，改动小，适合第一版。
- Nuitka / Cython：把核心逻辑编译为 native extension，保护更强，但需要分别构建不同平台。

推荐初期方案：

```text
源码插件目录 -> PyArmor 混淆输出目录 -> ZIP -> R2 插件仓库
```

注意：混淆不是绝对安全，只能提高逆向成本。敏感密钥、账号、支付凭证不要写入插件代码或仓库索引。
