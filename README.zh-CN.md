# dsh-codebuddy-auth

[English](README.md) | 简体中文

[ kuops/opencode-codebuddy-auth ](https://github.com/kuops/opencode-codebuddy-auth) 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH)移植版——在 DSH 里直接使用腾讯 CodeBuddy(IOA)的对话模型:浏览器 OAuth 登录、token 自动续期、模型列表自动同步。登录一次,模型选择器里即可选用 `deepseek-v4-pro`、`glm-5.2`、`kimi-k3-1`、`minimax-m3` 等 craft agent 模型。

## 工作原理

原 OpenCode 插件靠三个 hook 工作;本包把它们分别落到 DSH 的原生接缝上,请求路径零拦截(DSH 的 pi-ai 适配器原生说 OpenAI-completions 协议,凭据值自动作为 `Authorization: Bearer` 发送,路由 `headers` 原样透传):

| OpenCode 插件 | DSH 等价物 |
| --- | --- |
| `config` hook:注册 provider + 从 `/v3/config` 发现模型 | `llm-pi-ai.providers.codebuddy` 路由——插件**首次启动时自动创建**,登录后把真实模型列表同步进去 |
| `auth` hook:IOA 浏览器 OAuth + 轮询 + 刷新 | 插件注册的 `codebuddy` 模型工具(`login` / `status` / `refresh` / `logout` / `sync-models`)+ 启动时自动续期 |
| token 存 `auth.json` | `ctx.credentials` 凭据服务(`~/.dsh/.credentials.yaml`,逐请求解析,热生效) |

## 安装

DSH 通过官方 `dsh plugin` CLI 安装 profile 插件(它是个精简的 `pnpm` 转发器:安装依赖、把包追加到 profile 的 `dsh.profile.bundles` 层栈、再经包内的 patch 挂载插件——全程无需手动改文件)。

**前置条件**:确保 `pnpm` 在 `PATH` 里,例如用 Homebrew 安装:

```bash
brew install pnpm
```

### 安装插件

```bash
dsh plugin --profile web add github:cainiao1992/dsh-codebuddy-auth
```

这一条命令即从 GitHub 解析依赖、安装,并自动把插件作为 profile 层激活。

### 重启 DSH

重启 DSH,安装即完成——首次启动时插件会**自动创建 `llm-pi-ai.providers.codebuddy` 路由**(带一个占位模型表),因此 CodeBuddy 未登录也会出现在模型页。

## 登录

可以用 agent 登录,也可以用命令行登录,二选一。

### 方式一:通过 agent

对 agent 说 **"用 codebuddy 登录"**。agent 调用 `codebuddy` 工具:浏览器打开 IOA 登录页,后台轮询;token 到手后自动写入凭据、把 JWT 派生的 `X-User-Id` 等身份头写进路由、并把占位模型替换成你账号在 `/v3/config` 的真实列表。

### 方式二:命令行(headless / 提前引导)

```bash
# 直接运行,无 npm 依赖,仅需 Node >= 18:
node ~/.dsh/profiles/web/node_modules/dsh-codebuddy-auth/bin/login-flow.mjs

# 或经 package.json 的 bin 字段从安装目录本地解析:
cd ~/.dsh/profiles/web && pnpm exec codebuddy-login

# 不想开浏览器(远程/服务器)加 --no-browser
```

CLI 会写入凭据**并确保** `settings.yaml` 里有 `llm-pi-ai.providers.codebuddy` 路由(默认国内版;`--international` 会预建国际版路由)。身份头与模型列表由已挂载的插件在下一次启动时(或调用 `codebuddy` 工具时)补齐。

## 卸载

```bash
dsh plugin --profile web remove dsh-codebuddy-auth
```

该命令会移除依赖,并把插件从 profile 层栈中摘除。重启 DSH 即完成卸载。

## 国际版

插件默认使用**国内版**(`copilot.tencent.com` / `www.codebuddy.cn`)。要切换到**国际版**(`www.codebuddy.ai`),用 CLI 的 `--international` 登录——它不只登录到 `codebuddy.ai`,还会把 `llm-pi-ai.providers.codebuddy` 路由指向国际版 API,因此全新安装(还没有路由)也能直接走国际版:

```bash
codebuddy-login --international   # 或 node bin/login-flow.mjs --international
```

其余全自动跟随:

- **聊天请求**走 `https://www.codebuddy.ai/v2`(路由的 `baseURL`)。
- **`X-Domain`** 自动跟随 `baseURL`——只要路由指向 `codebuddy.ai`,插件就把它改写成 `www.codebuddy.ai`。
- **登录 / 刷新 / 模型发现**(`/v3/config`)自动使用国际端点,因为插件从同一个 `baseURL` 反推 `serverUrl` / `domain`。

不加 `--international` 即登录国内版(默认)。

## 使用

- **切换模型**:模型选择器里选 CodeBuddy 下的任意模型(如 `deepseek-v4-pro`)
- **状态**:"看下 codebuddy 状态" → `codebuddy` 工具 `status`
- **续期(全自动,三层)**:① 每次启动时,token 剩余有效期不足 5 分钟(或已过期)即自动续;② 运行中每 30 分钟巡检,剩余不足 1 小时自动续——覆盖 dsh 长期不重启的场景;③ refresh token 失效(改密/吊销)时前两层会失败并留日志,此时说 "刷新 codebuddy" 确认,或重新登录
- **模型更新**:腾讯上新模型后,说 "同步 codebuddy 模型" → `sync-models`
- **退出**:"登出 codebuddy" → 清除凭据

### 推理

CodeBuddy 模型按真实推理能力声明,模型选择器里会显示每个模型支持的推理等级(支持关闭推理的模型还有 **off** 档):

- **推理等级**:在模型选择器里按模型选等级(如 `low` / `medium` / `high` / `xhigh`),按 `reasoning: { effort }` 发送。
- **关闭推理**:报告 `canDisableThinking` 的模型在选择器里有 `off` 选项。
- **全局覆盖**(可选):在路由上设 `reasoning`,可强制所有模型用同一等级,或设 `off` 全部声明为非推理:

```yaml
# ~/.dsh/settings.yaml → llm-pi-ai.providers.codebuddy
reasoning: high   # 或: off | low | medium | high | xhigh | auto(默认)
```

`auto`(默认)按各模型自身元数据;只在需要强制覆盖时才设置。改完重新 `sync-models`(或重启)。

## 文件

- `lib/index.js` — Cordis 宿主插件(host 组合行)。注册 `codebuddy` 工具,启动时自动刷新/同步。
- `lib/codebuddy-core.mjs` — OAuth、JWT 解码、`/v3/config` 发现的核心逻辑,无依赖。
- `bin/login-flow.mjs` — 独立登录 CLI,无 npm 依赖。
- `cordis.patch.yml` — 包内 patch(bundle 消费时的自挂载行)。

## 已知限制(均为实测结论)

- `POST /v2/chat/completions` **不校验 User-Agent**,任意 UA 均可;但必须 `stream: true`(非流式返回 `code 11101`)。DSH 的 pi-ai 适配器本来就是流式,无需处理。
- `GET /v3/config`(模型发现)**校验 User-Agent**,非 VSCode 形态的 UA 返回 400。插件的 `fetchRemoteModels` 是自己直接发请求(不经过 DSH 的 user-agent 归属覆盖),已显式携带 VSCode UA。
- CodeBuddy 对每个 craft 模型都报告 `supportsReasoning`。模型现按真实推理能力声明(按 `supportedEfforts` 列出等级、`canDisableThinking` 时加 `off` 档、并带 `compat` 以使用 `reasoning: { effort }` wire 格式),因此推理可在模型选择器里直接选用,而非被剥离。

## License

MIT
