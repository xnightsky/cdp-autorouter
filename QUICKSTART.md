# Quick Start

## 前置安装

```bash
cd <项目根目录>
npm install                    # 安装依赖
npm run install:global         # build + 全局安装 cdp-autorouter-server / cdp-autorouter-cli
```

如果只做本地开发：

```bash
npm install && npm run build && npm test
npm run dev                    # 启动开发服务
```

## 启动服务

```bash
npm start                      # 端口由 .env SERVER_PORT 决定（默认 3100）
# 或全局命令
cdp-autorouter-server          # 等效，支持 --force 抢占端口
```

---

## 三种玩法

### ⭐ 玩法 1：CLI + agent-browser（推荐）

```bash
# 连接到 autorouter
cdp-autorouter-cli connect <port>

# 创建并启动实例
cdp-autorouter-cli create --id dev --mode attached --browser-url http://localhost:9222
cdp-autorouter-cli start dev

# agent-browser 消费
agent-browser --cdp $(cdp-autorouter-cli get-ws dev)

# 或 chrome-devtools-mcp
chrome-devtools-mcp --wsEndpoint=$(cdp-autorouter-cli get-ws dev)
```

### 玩法 2：纯 curl / 脚本集成

```bash
curl -X POST http://localhost:<port>/api/instances \
  -H 'Content-Type: application/json' \
  -d '{"instanceId":"dev","mode":"attached","browserUrl":"http://localhost:9222"}'

curl -X POST http://localhost:<port>/api/instances/dev/start

# 提取 wsEndpoint
curl -s http://localhost:<port>/instances/dev/json/version | jq -r .webSocketDebuggerUrl
```

### 玩法 3：Skill 自动化（agent 无人工干预）

```bash
# 安装 skill
npx skills add cdp-autorouter

# agent 加载 skill 后自动执行：
#   POST /api/instances → start → get-ws → 传给 agent-browser

# 已装 CLI 时 agent 也可直接用：
cdp-autorouter-cli skills get cdp-autorouter-cli
```

三种玩法是同一套 Admin API 的三种消费形态：CLI 给人用，curl 给脚本用，Skill 给 agent 用。

---

## ⚠️ 已知坑

### agent-browser connect 后 open 创建新 tab 而非复用已有 tab

**现象**：`agent-browser connect <port>` 后执行 `open <url>`，远端 Chrome 会新开一个 tab，而不是在已有的可见 tab 中导航。

**根因**：agent-browser 的 `connect` 建立 browser-level CDP 连接后，`open` 通过 `Target.createTarget` 创建新 page。这是 Playwright 系工具的标准行为——不复用已有 tab。

**影响**：
- 如果 Chrome 是 headed 模式且在默认 BrowserContext 中创建，新 tab GUI 可见（正常情况）
- 如果 Chrome 是 headless 或 agent-browser 创建了隔离 BrowserContext，新 page 可能不可见

**解决方案**：

```bash
# 方案 A：接受新 tab 行为（推荐，大多数场景够用）
agent-browser connect 9223
agent-browser open https://example.com   # 新 tab，headed 模式下 GUI 可见

# 方案 B：如需在已有 tab 中导航，connect 后切到该 tab
agent-browser connect 9223
agent-browser tab list                   # 查看已有 tab
agent-browser tab t1                     # 切到目标 tab
agent-browser navigate https://example.com  # 在该 tab 中导航（非 open）
```

### autorouter 不是问题来源

autorouter 的 WS 代理是透明双向 message pump，不拦截、不修改任何 CDP 消息内容。`Target.createTarget` 等 CDP 命令原样转发到下游 Chrome。

