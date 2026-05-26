# cdp-autorouter

`cdp-autorouter` 是一层本地 HTTP + WebSocket 代理，用于把
`chrome-devtools-mcp`、`agent-browser` 或其他 CDP 客户端稳定路由到真实 Chrome
实例。

它不是 `chrome-devtools-mcp` 的替代品，而是放在客户端和 Chrome 之间的可控入口：

```text
chrome-devtools-mcp -> autorouter (HTTP + WS) -> real Chrome instance
```

核心目标：

- 对上游暴露 Chrome DevTools 兼容的 `/json/*` 发现接口；
- 改写 `webSocketDebuggerUrl`，避免直接暴露真实 Chrome WS 地址；
- 通过 Admin API 管理 `managed` / `attached` 实例；
- 为多 agent、本地脚本和 CLI 提供同一套实例路由能力。

## 环境要求

- Node.js >= 20.19.0
- npm
- Chrome / Chromium（`managed` 模式需要可执行文件，`attached` 模式需要已有远程调试端点）

## Quick Start

所有玩法的共同前置（在项目根目录执行）：

```bash
# cd <项目根目录>
npm install                    # 安装依赖
npm run install:global         # 一条命令：build + 全局安装 cdp-autorouter-server / cdp-autorouter-cli
npm start                      # 启动服务，端口由 .env SERVER_PORT 决定（默认 3100）
```

> `npm install -g .` 不会自动触发 build（npm 不为本地目录安装走 pack 流程）。
> 必须先 `npm run build` 再 `npm install -g .`，或直接用 `npm run install:global` 一步到位。

如果只想本地开发，不需要全局安装 CLI：

```bash
npm install
npm run build
npm test
npm run dev
```

以下命令均为全局可用，任意目录执行：

---

### ⭐ 推荐玩法：autorouter + CLI + agent-browser

```bash
# 以下均为全局命令，任意目录执行

# 连接到 autorouter（端口与 SERVER_PORT 一致）
cdp-autorouter-cli connect <port>

# 创建并启动实例
cdp-autorouter-cli create --id dev --mode attached --browser-url http://localhost:9222
cdp-autorouter-cli start dev

# agent-browser 直接消费
agent-browser --cdp $(cdp-autorouter-cli get-ws dev)

# 或 chrome-devtools-mcp
chrome-devtools-mcp --wsEndpoint=$(cdp-autorouter-cli get-ws dev)
```

`cdp-autorouter-cli get-ws` 输出一行 ws:// 地址，可直接 `$()` 给任何工具消费。

---

### 玩法 2：纯 autorouter（curl / 脚本集成）

适合：无 CLI 环境、CI 脚本、快速验证。

```bash
curl -X POST http://localhost:<port>/api/instances \
  -H 'Content-Type: application/json' \
  -d '{"instanceId":"dev","mode":"attached","browserUrl":"http://localhost:9222"}'

curl -X POST http://localhost:<port>/api/instances/dev/start

# 提取 wsEndpoint
curl -s http://localhost:<port>/instances/dev/json/version | jq -r .webSocketDebuggerUrl
```

---

### 玩法 3：autorouter + Skill（agent 自动化）

适合：agent 无人工干预，通过 skill 自行操作 autorouter。

```bash
# 安装 skill 到 agent 环境（一次性）
npx skills add cdp-autorouter

# agent 加载 skill 后自动执行：
#   POST /api/instances → start → get-ws → 传给 agent-browser

# 如果已装 CLI，agent 也可以直接用：
cdp-autorouter-cli skills get cdp-autorouter-cli   # 动态加载完整指令集
```

---

三种玩法是同一套 Admin API 的三种消费形态：CLI 给人用，curl 给脚本用，Skill 给 agent 用。

---

## 项目定位

`cdp-autorouter` 的作用是把原本直接连向 Chrome 的 `chrome-devtools-mcp` 与真实浏览器实例之间插入一层可控的 HTTP + WS 代理，从而达成：

- `chrome-devtools-mcp -> autorouter (HTTP + WS) -> real Chrome instance` 的固定主链。
- 对上游保持接口兼容，对下游提供灵活的实例管理与路由策略。

## 架构要点

- **HTTP 兼容代理** 负责 `/json/version`、`/json/list`、`/json/protocol` 等调试发现接口，始终暴露默认兼容实例；
- **WS / CDP 代理** 在 `/devtools/browser/*` 和 `/devtools/page/*` 上中转所有 CDP 消息，使真实浏览器地址永远只在内网可见；
- **默认实例解析** 基于 `.env` 模板与运行时注册表按需构建或重连实例；
- **Admin API** 专注内存级实例注册、状态与生命周期操作，不写盘；
- **受管实例回收** 统一登记管理的浏览器进程，支持 stop / reclaim / 进程退出自动清理。

## .env 策略

.env 只提供兼容路径需要的策略与默认实例引导模板，不承担运行时实例数据：

- `COMPAT_MODE_ENABLED`、`COMPAT_LAZY_LOAD_ENABLED` 控制根路径兼容链路是否打开与是否延迟加载；
- `DEFAULT_INSTANCE_*` 系列字段（如 `DEFAULT_INSTANCE_ID`、`DEFAULT_INSTANCE_MODE`、`DEFAULT_INSTANCE_BROWSER_URL`、`DEFAULT_INSTANCE_WS_ENDPOINT`、`DEFAULT_INSTANCE_USER_DATA_DIR`、`DEFAULT_INSTANCE_CHROME_ARGS` 等）仅描述默认兼容实例的引导配置；
- 同时提供浏览器地址与 WS 端点时以 WS 优先；字段缺失则抛配置错误，避免向 chrome-devtools-mcp 返还半成品响应。

## 默认实例与懒加载

- 只有当 chrome-devtools-mcp 首次命中兼容接口（比如 `GET /json/version`）时才触发默认实例解析，避免服务启动时预热；
- 默认实例会在注册表中查找 `DEFAULT_INSTANCE_ID`，不存在则用 .env 模板在内存中创建 `env-bootstrap` 实例；
- 若实例存在但处于 `unhealthy`，立刻由 Child Browser Supervisor 启动或重新连接，并更新 metadata；
- 解析完成后代理会把真实 Chrome 的 `webSocketDebuggerUrl` 改写为指向 autorouter 的地址，保持 external client 一致的入口。

## Admin API 与实例管理

- 所有运行中的实例都由 Admin API（`/api/instances` 系列）登记在内存注册表中，`GET /api/instances` 只列 autorouter 管理的实例，风格上区别于 `/json/list` 列出的实际 Chrome target；
- `POST /api/instances` / `PATCH` / `DELETE` / `start` / `stop` / `health` / `refresh` / `extensions` 等接口直接映射注册表状态，`instanceId`、`mode`（`managed` 或 `attached`）、`status`、`browserUrl`、`wsEndpoint`、`userDataDir` 等在内存中维持；
- `.env` 均由 Admin API 读取策略，但实例本身不会写回 .env，也不会落盘；
- `attached` 模式允许接入外部浏览器，仅代理请求；`managed` 模式由 autorouter 启动并负责后续回收与状态跟踪。

## 受管浏览器的回收

- 受管实例在 `managed` 模式下启动时会登记启动参数、进程句柄及临时目录，便于后续统一清理；
- 回收路径包括 `POST /api/instances/{instanceId}/stop`、`POST /api/instances/reclaim-managed`、服务进程退出或遇到致命错误时的 cleanup 钩子；
- 回收流程按 `reclaiming -> stop -> kill -> cleanup` 顺序执行，期间拒绝新的 HTTP/WS 请求，优先发起优雅关闭并在超时后强制 kill；
- 只对 `managed` 实例执行回收，`attached` 模式的浏览器，以及 chrome-devtools-mcp 侧自行管理的实例由外部负责清理。

## 开发与验证

常用命令：

```bash
npm run build
npm test
```

仓库目前没有统一 Prettier / ESLint 配置，提交前请保持周边 TypeScript 与 Markdown 风格一致。

## 贡献指南

欢迎提交 Issue 和 Pull Request。为了让变更更容易 review，请遵守以下约定：

- 先阅读 `AGENTS.md`、`docs/autorouter-architecture.md`、`docs/api-design.md` 和 `docs/roadmap.md`，确认变更没有偏离 v1 设计边界。
- 实现代码变更后运行 `npm run build` 与 `npm test`。
- 涉及 `.env` 加载、默认实例懒加载、`/json/version` 改写、`/json/list`、`GET /api/instances`、WS 代理或 managed 回收时，同步补充测试。
- 不把真实 API Key、密码、私钥、数据库连接串、内网地址或个人浏览器 profile 路径提交到仓库。
- 提交信息建议使用 `feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:` 等前缀。

## 安全

请不要在公开 Issue 中披露可利用细节、真实凭证或私有环境信息。漏洞报告方式见 `SECURITY.md`。

以上内容应足以让新成员快速把本项目定位为“兼容型代理 + 实例管理”，并明确如何在 `.env` 与 Admin API 之间权衡配置与运行状态。
