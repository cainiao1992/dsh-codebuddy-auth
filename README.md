# dsh-codebuddy-auth

[ kuops/opencode-codebuddy-auth ](https://github.com/kuops/opencode-codebuddy-auth) 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH)移植版——在 DSH 里直接使用腾讯 CodeBuddy(IOA)的对话模型:浏览器 OAuth 登录、token 自动续期、模型列表自动同步。登录一次,模型选择器里即可选用 `deepseek-v4-pro`、`glm-5.2`、`kimi-k3-1`、`minimax-m3` 等 craft agent 模型。

## 工作原理

原 OpenCode 插件靠三个 hook 工作;本包把它们分别落到 DSH 的原生接缝上,请求路径零拦截(DSH 的 pi-ai 适配器原生说 OpenAI-completions 协议,凭据值自动作为 `Authorization: Bearer` 发送,路由 `headers` 原样透传):

| OpenCode 插件 | DSH 等价物 |
| --- | --- |
| `config` hook:注册 provider + 从 `/v3/config` 发现模型 | `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.codebuddy` 路由;登录后由本插件把真实模型列表同步进去 |
| `auth` hook:IOA 浏览器 OAuth + 轮询 + 刷新 | 本插件注册的 `codebuddy` 模型工具(`login` / `status` / `refresh` / `logout` / `sync-models`)+ 启动时自动续期 |
| token 存 `auth.json` | `ctx.credentials` 凭据服务(`~/.dsh/.credentials.yaml`,逐请求解析,热生效) |

## 安装

### 1. 安装包

```bash
cd ~/.dsh/profiles/web
npm install github:cainiao1992/dsh-codebuddy-auth
```

### 2. 挂载插件

在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `insert` 列表里加一行:

```yaml
- insert:
    - id: codebuddy-auth
      name: dsh-codebuddy-auth
```

### 3. 添加模型路由

在 `~/.dsh/settings.yaml` 顶层加入(模型表先用最小占位,登录后插件会同步成你账号的真实列表):

```yaml
llm-pi-ai:
  providers:
    codebuddy:
      displayName: CodeBuddy
      api: openai-completions
      baseURL: https://copilot.tencent.com/v2
      apiKeyEnv: CODEBUDDY_ACCESS_TOKEN
      headers:
        X-Requested-With: XMLHttpRequest
        X-Agent-Intent: craft
        X-IDE-Type: VSCode
        X-IDE-Name: VSCode
        X-IDE-Version: 1.119.0
        X-Product-Version: 4.9.29177644
        X-Env-ID: production
        X-Domain: www.codebuddy.cn
        X-Product: SaaS
      models:
        - id: auto
          name: Auto
          contextWindow: 168000
```

> 已有其他 `llm-pi-ai.providers` 条目的,只需把 `codebuddy` 追加进同一字典。

### 4. 登录

重启 DSH 后,对 agent 说 **"用 codebuddy 登录"**,agent 会调用 `codebuddy` 工具:浏览器打开 IOA 登录页,后台每 3 秒轮询,token 到手后自动写入凭据、把 JWT 派生的 `X-User-Id` 等身份头写进路由、并从 `/v3/config` 同步真实模型列表。

也可以在 DSH 外用 CLI(headless / 提前引导):

```bash
# 按第 1 步装进 profile 后直接运行(无 npm 依赖,仅需 Node >= 18):
node ~/.dsh/profiles/web/node_modules/dsh-codebuddy-auth/bin/login-flow.mjs

# 或经 package.json 的 bin 字段从安装目录本地解析:
cd ~/.dsh/profiles/web && npm exec codebuddy-login

# 不想开浏览器(远程/服务器)加 --no-browser
```

CLI 只写凭据;身份头与模型列表由已挂载的插件在下一次启动时(或调用 `codebuddy` 工具时)补齐。

## 使用

- **切换模型**:模型选择器里选 CodeBuddy 下的任意模型(如 `deepseek-v4-pro`)
- **状态**:"看下 codebuddy 状态" → `codebuddy` 工具 `status`
- **续期(全自动,三层)**:① 每次启动时,token 剩余有效期不足 5 分钟(或已过期)即自动续;② 运行中每 30 分钟巡检,剩余不足 1 小时自动续——覆盖 dsh 长期不重启的场景;③ refresh token 失效(改密/吊销)时前两层会失败并留日志,此时说 "刷新 codebuddy" 确认,或重新登录
- **模型更新**:腾讯上新模型后,说 "同步 codebuddy 模型" → `sync-models`
- **退出**:"登出 codebuddy" → 清除凭据

## 文件

- `lib/index.js` — Cordis 宿主插件(host 组合行)。注册 `codebuddy` 工具,启动时自动刷新/同步。
- `lib/codebuddy-core.mjs` — OAuth、JWT 解码、`/v3/config` 发现的核心逻辑,无依赖。
- `bin/login-flow.mjs` — 独立登录 CLI,无 npm 依赖。
- `cordis.patch.yml` — 包内 patch(bundle 消费时的自挂载行)。

## 已知限制(均为实测结论)

- `POST /v2/chat/completions` **不校验 User-Agent**,任意 UA 均可;但必须 `stream: true`(非流式返回 `code 11101`)。DSH 的 pi-ai 适配器本来就是流式,无需处理。
- `GET /v3/config`(模型发现)**校验 User-Agent**,非 VSCode 形态的 UA 返回 400。插件的 `fetchRemoteModels` 是自己直接发请求(不经过 DSH 的 user-agent 归属覆盖),已显式携带 VSCode UA。
- 模型按非推理模型声明(不发送 reasoning 参数),与原 OpenCode 插件行为一致;接口显示全部模型 supportsReasoning,需要的话可在路由加 `compat`。
- 国际版:把 `baseURL` 换成 `https://www.codebuddy.ai/v2`、`X-Domain` 换成 `www.codebuddy.ai`。

## License

MIT
