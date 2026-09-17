# Scripts

## publish_plugin_r2.sh

发布 Nexus Flow 插件到 Cloudflare R2，并维护插件仓库 `index.json`。

### Wrangler 模式

```bash
wrangler login

R2_BUCKET=nexus-flow-plugins \
PLUGIN_R2_UPLOADER=wrangler \
PLUGIN_PUBLIC_BASE_URL=https://pub-7e6aa4dd253e41fe8e27bb09c951b192.r2.dev/plugin-repo \
scripts/publish_plugin_r2.sh backend/app/task_modules/uber 0.1.40
```

### AWS CLI 模式

```bash
R2_BUCKET=nexus-flow-plugins \
R2_ACCOUNT_ID=your_cloudflare_account_id \
R2_ACCESS_KEY_ID=your_access_key \
R2_SECRET_ACCESS_KEY=your_secret_key \
PLUGIN_PUBLIC_BASE_URL=https://pub-xxxx.r2.dev/plugin-repo \
scripts/publish_plugin_r2.sh backend/app/task_modules/uber 0.1.40
```

### Dry run

```bash
R2_BUCKET=dummy \
PLUGIN_DRY_RUN=1 \
PLUGIN_PUBLIC_BASE_URL=https://example.com/plugin-repo \
scripts/publish_plugin_r2.sh backend/app/task_modules/uber 0.1.40
```

### 输出结构

```text
plugin-repo/
  index.json
  plugins/
    uber/
      uber-0.1.40.plugin.zip
```

前端仓库地址填写：

```text
https://pub-7e6aa4dd253e41fe8e27bb09c951b192.r2.dev/plugin-repo/index.json
```
