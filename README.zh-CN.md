# dsh-codebuddy-auth

[English](README.md) | 简体中文

[ kuops/opencode-codebuddy-auth ](https://github.com/kuops/opencode-codebuddy-auth) 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH)移植版——在 DSH 里直接使用腾讯 CodeBuddy(IOA)的对话模型:浏览器 OAuth 登录、token 自动续期、模型列表自动同步。登录一次,模型选择器里即可选用 `deepseek-v4-pro`、`glm-5.2`、`kimi-k3-1`、`minimax-m3` 等 craft agent 模型。

## 工作原理

本插件注册一个**原生 ctx.llm 适配器**(移植自 [shatyuka/dsh-llm-codebuddy](https://github.com/shatyuka/dsh-llm-codebuddy),MIT),自己持有聊天请求:极简身份头 + CLI 客户端 User-Agent + 自有的 SSE 流式与消息序列化——不经共享 pi-ai 路由,因此没有归属 UA 覆盖、没有 IDE 身份块:

| OpenCode 插件 | DSH 等价物 |
| --- | --- |
| `config` hook:注册 provider + 从 `/v3/config` 发现模型 | 原生适配器直接在 `ctx.llm` 上注册 `codebuddy` 路由,模型目录实时读自 `/v3/config`(5 分钟缓存) |
| `auth` hook:IOA 浏览器 OAuth + 轮询 + 刷新 | `codebuddy` 模型工具(`login` / `status` / `refresh` / `logout` / `sync-models`)+ 启动及每 30 分钟自动续期 |
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

重启 DSH,安装即完成——插件启动时在 `ctx.llm` 上原生注册 `codebuddy` 路由(若存在旧版遗留的 `llm-pi-ai` settings 路由会自动移除),CodeBuddy 随即出现在模型页。

## 登录

可以用 agent 登录,也可以用命令行登录,二选一。

### 方式一:通过 agent

对 agent 说 **"用 codebuddy 登录"**。agent 调用 `codebuddy` 工具:浏览器打开 IOA 登录页,后台轮询;token 到手后写入凭据并预热模型目录,下一个请求即以 CLI 客户端身份直连聊天端点。

### 方式二:命令行(headless / 提前引导)

```bash
# 直接运行,无 npm 依赖,仅需 Node >= 18:
node ~/.dsh/profiles/web/node_modules/dsh-codebuddy-auth/bin/login-flow.mjs

# 或经 package.json 的 bin 字段从安装目录本地解析:
cd ~/.dsh/profiles/web && pnpm exec codebuddy-login

# 不想开浏览器(远程/服务器)加 --no-browser
```

CLI 只写凭据——原生适配器自己持有路由,没有 settings 路由需要管理;`--international` 仅选择登录走的 OAuth 端点。

## 卸载

```bash
dsh plugin --profile web remove dsh-codebuddy-auth
```

该命令会移除依赖,并把插件从 profile 层栈中摘除。重启 DSH 即完成卸载。

## 国际版

插件默认使用**国内版**(`copilot.tencent.com` / `www.codebuddy.cn`)。国际版(`www.codebuddy.ai`)通过挂载行的 `edition: intl` 配置选择:

```yaml
# 你的 cordis.patch.yml 挂载行:
- id: codebuddy-auth
  name: dsh-codebuddy-auth
  edition: intl          # 缺省即国内版
```

适配器与登录/模型发现随即全部使用 `www.codebuddy.ai` 端点。CLI 的 `--international` 仅为登录选择国际 OAuth 端点。

## 使用

- **切换模型**:模型选择器里选 CodeBuddy 下的任意模型(如 `deepseek-v4-pro`)
- **状态**:"看下 codebuddy 状态" → `codebuddy` 工具 `status`
- **续期(全自动,三层)**:① 每次启动时,token 剩余有效期不足 5 分钟(或已过期)即自动续;② 运行中每 30 分钟巡检,剩余不足 1 小时自动续——覆盖 dsh 长期不重启的场景;③ refresh token 失效(改密/吊销)时前两层会失败并留日志,此时说 "刷新 codebuddy" 确认,或重新登录
- **模型更新**:腾讯上新模型后,说 "同步 codebuddy 模型" → `sync-models`
- **退出**:"登出 codebuddy" → 清除凭据

### 推理

每个模型都按 `/v3/config` 报告的**完整真实推理能力**声明,模型选择器里展示该模型实际支持的等级——报告 `canDisableThinking` 的模型还有 **off** 档(如 `deepseek-v4-pro`、`glm-5.2`;`hy3` 只能推理,没有 off):

- **可选等级**(按模型):`supportedEfforts` 原样进选择器——`deepseek-v4-pro` 可选 `low` / `high` / `xhigh` / `off`,`hy3` 可选 `low` / `high`,固定等级模型(如 `glm-5.1`)只有 `medium` 一档。按 `reasoning: { effort }` 发送。
- **默认等级**:什么都不配时,请求不带 effort,每个模型回落到**自己服务端的默认值**(`auto` / `hy3` / `glm-5.2` / `deepseek-v4-*` 为 `high`,其余多为 `medium`)。
- **默认等级**:每模型直接采用 `/v3/config` 报告的 `defaultEffort`(如 glm-5.2 默认 High),选择器里所有已声明等级仍可自由选。

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
