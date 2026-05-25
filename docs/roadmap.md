# chrome-devtools-mcp-autorouter 路线图

本文档定义 `chrome-devtools-mcp-autorouter` 从当前 `v0.1.0` 向目标版本演进的完整路线图。

对照基线是 `chrome-cdp-autorouter-=`(`D:\workspace\project\gwm\projtmpl\ai\browser\chrome-devtools\autorouter`),版本 `1.0.0`,以下简称"对照 repo"。

## 1. 已完成清单(v0.1.0)

以下是当前 repo 已经实现且质量高于对照 repo 的能力:

| # | 能力 | 当前状态 | 相比对照 repo 的优势 |
|---|------|---------|---------------------|
| 1 | TypeScript 工程骨架 | ✅ 已实现 | 对照为 JS + JSDoc,当前有完整类型系统 |
| 2 | `.env` 配置解析 | ✅ 已实现 | 对照为 YAML,当前方案更轻量 |
| 3 | Runtime Registry(内存实例注册表) | ✅ 已实现 | 分离 env-bootstrap / api-runtime 来源 |
| 4 | Default Instance Resolver | ✅ 已实现 | 清晰的懒注入语义,策略开关控制 |
| 5 | HTTP Compat Proxy(/json/version, /json/list, /json/protocol) | ✅ 已实现 | 手动 fetch + 精确 JSON rewrite |
| 6 | webSocketDebuggerUrl 改写 | ✅ 已实现 | **使用 token 映射(RouteBindingStore),真实 Chrome WS 地址永不对外暴露** |
| 7 | WS CDP Proxy(/devtools/browser/*, /devtools/page/*) | ✅ 已实现 | token 验证 + 消息缓冲 + 生命周期管理 |
| 8 | 显式实例路由(/instances/{id_or_name}/json/*, /instances/{id_or_name}/devtools/*) | ✅ 已实现 | 路径支持任意字符串实例标识,不依赖数字后缀;对照 repo 只能 `/instance(\d+)` 且须从 1 顺序创建 |
| 9 | 声明式实例 ID(调用方自定义 instanceId) | ✅ 已实现 | 无自增序号坑;支持语义化命名如 `staging`/`dev-flow`;对照 repo 必须从 instance1 开始递增到目标编号 |
| 10 | Admin API CRUD(GET/POST/PATCH/DELETE /api/instances) | ✅ 已实现 | 完整的 REST 风格 CRUD |
| 10 | Admin API 操作(start/stop/refresh/health/extensions) | ✅ 已实现 | 实例生命周期细粒度控制 |
| 11 | Managed 模式(autorouter 启动并回收子进程) | ✅ 已实现 | SIGTERM → SIGKILL fallback,优雅关闭 |
| 12 | Attached 模式(只代理外部浏览器) | ✅ 已实现 | Managed/Attached 回收边界干净 |
| 13 | reclaim-managed 批量回收 | ✅ 已实现 | +进程退出自动清理 |
| 14 | 进程退出钩子(SIGINT/SIGTERM/beforeExit) | ✅ 已实现 | 覆盖主要退出路径 |
| 15 | 元数据采集(version/protocolVersion/extensionsSummary) | ✅ 已实现 | 健康检查与状态同步 |
| 16 | vitest 测试框架 | ✅ 已实现 | config.test.ts + http-compat.test.ts + MockChromeServer |
| 17 | 架构文档(autorouter-architecture.md, api-design.md, chrome-devtools-mcp-architecture.md) | ✅ 已实现 | 完整设计稿 + 数据流转 + 时序图 |
| 18 | Agent-Browser 主链设计(agent → MCP → autorouter → Chrome) | ✅ 已实现 | 对照 repo 无明确 agent 接入设计,仅做 CDP 路由;当前项目从架构层保证 agent 永远只连 autorouter,不感知真实 Chrome |
| 19 | 多 Agent 隔离(binding 校验 instanceId 一致性) | ✅ 已实现 | 对照 repo 所有客户端共享同一路由空间无隔离;当前项目 WS token 绑定 instanceId,跨实例访问被拒绝 |
| 20 | 按需懒加载(agent 首次 CDP 请求触发实例启动) | ✅ 已实现 | 对照 repo 的 autoStart=false 仍需手动 curl 创建;当前项目 agent 首次 GET /json/version 即自动 bootstrap + start |
| 21 | `/json/version` 注入 autorouter 元数据 | ✅ 已实现(P1-4) | 注入 `autorouter` 字段:name/version/multiInstance/defaultInstanceId/capabilitiesEndpoint;agent 一次 GET 即可感知多实例能力 |
| 22 | `devtoolsFrontendUrl` 改写 | ✅ 已实现(P1-3) | ws query param 指向 tokenized autorouter 地址,真实 Chrome 地址不暴露 |
| 23 | 反向代理头支持 | ✅ 已实现(P1-2) | `TRUST_PROXY` 开关 + `x-forwarded-host`/`x-forwarded-port` 解析;URL 生成统一走 `resolvePublicHost` |
| 24 | `/json/list` 页面数缓存 | ✅ 已实现(P1-6) | 请求 `/json/list` 后自动缓存 `pageCount`,`/api/instances` 响应附带 |
| 25 | `GET /api/capabilities` 能力发现 | ✅ 已实现(P2-1) | 返回 name/version/capabilities/endpoints/runtime,MCP client 可自动检测 |
| 26 | `GET /api/instances/{id}/status` | ✅ 已实现(P2-2) | 返回 status + version + protocolVersion + lastHeartbeatAt + lastError |
| 27 | `POST /api/instances/{id}/switch` 默认实例切换 | ✅ 已实现(P2-3) | 运行时切换默认实例,仅 healthy 实例可切换 |
| 28 | `POST /api/instances/{id}/restart` | ✅ 已实现(P2-4) | stop → start 组合重启,保留配置刷新进程 |
| 29 | 实例连接元数据 | ✅ 已实现(P2-5) | 每个实例响应附带 `instanceVersionUrl` + `browserWebSocketDebuggerUrl`,基于请求 host 动态构建 |
| 30 | MCP 启动参数自动升级 | ✅ 已实现(P3-1) | `resolveChromeDevToolsMcpLaunchArgs()` 导出函数;browserUrl→wsEndpoint 自动解析;超时控制 + graceful fallback |

## 2. 待实现清单

以下按优先级分层,每层内的条目建议按序号推进。

### P0 - 基础设施与工程化(对标对照 repo 的 CLI + 日志体系)

这些能力是让项目从"能跑"走向"可运维"的基础。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P0-1 | **Logger 系统** | `src/logger.js`:文件 + 控制台双写,ANSI 颜色,level 过滤,调用方透明注入 | ✅ 已实现(logger.ts):文件 + 控制台双通道;支持 LOG_LEVEL/LOG_FORMAT/LOG_FILE 环境变量 |
| ~~P0-2~~ | ~~CLI 启动入口~~ | - | **已取消**:直接用 `npm start` 或包装 shell 脚本启动,不需额外 CLI 入口 |
| ~~P0-3~~ | ~~CLI 配置初始化~~ | - | **已取消**:`.env` 模板已足够 |
| ~~P0-4~~ | ~~CLI 验证脚本~~ | - | **已取消**:健康检查通过 `autorouter-cli status` 实现 |
| P0-5 | **YAML 配置支持**(可选) | `.env.yaml` + `yaml` 依赖 | 当前 `.env` 已足够 v1,作为可选增强 |

### P1 - HTTP 代理增强(对标对照 repo 的 router.js 能力)

这些能力让 HTTP 兼容层更健壮、更符合标准。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P1-1 | **HOP-by-HOP Header 过滤** | 过滤 `connection/keep-alive/proxy-*` 等 8 个头 | 当前架构不透传下游响应头(JSON 路由完全重构响应),已隐式满足;待 P1-5 透明代理时一并实现 |
| P1-2 | **反向代理头支持** | `x-forwarded-host`、`x-forwarded-proto` 解析 | ✅ **已实现**:增加 `x-forwarded-port` 解析;配置 `TRUST_PROXY` 开关控制是否信任反代头;`resolvePublicHost` 统一 URL 生成 |
| P1-3 | **devtoolsFrontendUrl 改写** | 递归重写 JSON 中所有 `devtoolsFrontendUrl` 字段 | ✅ **已实现**:与 `webSocketDebuggerUrl` 改写同层处理;支持 absolute/relative 两种格式;追加实例前缀 |
| P1-4 | **/json/version 附加 AutoRouter 元数据** | 注入 `AutoRouter: { name, multiInstance, capabilitiesEndpoint }` | ✅ **已实现**:字段名改为 `autorouter`(小写);增加 `version`/`defaultInstanceId` 字段 |
| P1-5 | **非 JSON 路径透明代理** | 使用 `http-proxy` 库转发非 `/json/*` 请求 | 不使用 `http-proxy` 依赖,改为手动 `fetch` + stream pipe;保持依赖最小化;非 JSON 路径做 chunked transfer 转发 |
| P1-6 | **/json/list 页面数缓存** | 无 | ✅ **已实现**:首次 /json/list 后缓存页面数,`/api/instances` 响应附带 `pageCount` |

### P2 - Admin API 补全(对标对照 repo 的 api.js 能力)

这些 API 端点是当前 Admin API 缺失的能力。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P2-1 | **GET /api/capabilities** | 返回 name/version/capabilities/endpoints/runtime | ✅ **已实现**:增加 `wsTokenIsolation`、`supportedModes`、`serverVersion`(从 package.json 读取) |
| P2-2 | **GET /api/instances/{id}/status** | 返回 status + pages 数 | ✅ **已实现**:`/status` 返回 status + version + protocolVersion + lastHeartbeatAt + lastError;`/health` 保留为精简版 |
| P2-3 | **POST /api/instances/{id}/switch** | 切换默认实例(仅限 running 实例) | ✅ **已实现**:仅 healthy 实例可切换;`currentDefaultInstanceId` 运行时可变;`isDefault` 标记联动 |
| P2-4 | **POST /api/instances/{id}/restart** | 同 ID 重启实例(保留 port/userDataDir) | ✅ **已实现**:stop → start 组合流程,保留配置刷新进程 |
| P2-5 | **实例连接元数据** | `instanceVersionUrl` + `browserWebSocketDebuggerUrl` 稳定对外暴露 | ✅ **已实现**:每次响应附带,URL 基于请求 host 动态构建,支持反代 |

### P3 - MCP 集成(对标对照 repo 的 mcp-launch-options.js + CLI MCP wrapper)

这些能力让 chrome-devtools-mcp 与 autorouter 无缝对接。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P3-1 | **chrome-devtools-mcp 启动参数自动升级** | `browserUrl=/instance2` → 自动解析为 `wsEndpoint=ws://...` | ✅ **已实现**:独立导出函数 `resolveChromeDevToolsMcpLaunchArgs()`;支持 `/instances/{id}` + legacy `/instanceN`;超时控制;失败时 graceful fallback |
| P3-2 | **MCP 包装器 CLI** | `chrome-cdp-autorouter-mcp` bin 入口,内部 `spawn('npx', ['chrome-devtools-mcp@latest', ...])` | 作为 `bin` 字段独立可执行;支持 `--autorouter-url` 指定 autorouter 地址;自动检测 autorouter 版本与能力;透传所有 chrome-devtools-mcp 参数 |
| P3-3 | **autorouter skill 感知端点** | 无 | 在 `/json/version` 附加字段让 chrome-devtools-ext-autorouter skill 自动检测;支持 `OPTIONS /api/capabilities` 返回允许的操作集合 |

### P3.5 - CLI 控制面 + Skill 一体化(新增,对标对照 repo 的 CLI 体系 + Skill 设计)

对照 repo 有 CLI 但只管启动/验证,控制面操作仍靠 `curl` 手动拼 JSON。当前 Skill 文件(`chrome-devtools-ext-autorouter`)写的是对照 repo 的旧 API 路径和端口,与当前实现不一致。

这一层把 CLI 和 Skill 作为"同一份控制面能力的两种消费形态"一并设计:CLI 给人用,Skill 给 agent 用,底层共享同一套 Admin API 语义。

**架构决策(ADR-CLI-001)**:

- `autorouter-cli` 是纯控制面客户端,不管服务启动(那是 `npm start` / P0 的事)
- `autorouter-mcp` 是数据面桥接,负责 browserUrl→wsEndpoint 升级并 spawn chrome-devtools-mcp
- CLI 通过 `connect [port]` 持久化连接信息,后续命令无需重复指定端口
- `get-ws [id]` 命令输出实例的 wsEndpoint,可直接 `$()` 给 mcp/agent-browser 消费

**端口解析优先级**:`--port` flag > `AUTOROUTER_URL` 环境变量 > `.autorouter` 文件 > 默认 3100

**Skill 加载机制(仿 agent-browser 三层架构)**:

| 层 | 内容 | 加载时机 |
|---|------|--------|
| 1 薄引导 SKILL.md | 触发词 + "先运行 `autorouter-cli skills get`" | `npx skills add` 安装到 `~/.agents/skills/` |
| 2 `autorouter-cli skills get <name>` | 完整命令用法、参数、典型流程 | agent 运行时动态调用 |
| 3 skill-data/ 目录 | 完整 skill 内容源文件 | 打包在 npm 包内,随版本更新 |

```bash
# 安装薄引导(一次性)
npx skills add <our-repo>

# agent 运行时动态加载完整指令
autorouter-cli skills                        # 列出可用 skills
autorouter-cli skills get autorouter-cli     # 输出控制面 skill
autorouter-cli skills get autorouter-mcp     # 输出 MCP 包装器 skill
autorouter-cli skills get --all              # 输出所有
```

**与 `chrome-devtools-ext-autorouter` skill 的关系**:不互斥。有 CLI 时 agent 直接用 CLI(不需读 skill);无 CLI 时 skill 提供 bash+curl 降级方案。两者是同一控制面的两种消费形态。

**bin 布局**:

| bin 名 | 职责 |
|--------|------|
| `autorouter-cli` | 纯控制面客户端:连接管理 + 实例 CRUD + get-ws |
| `autorouter-mcp` | MCP 包装器:自动升级参数并 spawn chrome-devtools-mcp |

**`autorouter-cli` 命令表**:

```
autorouter-cli connect [port]          # 持久化端口到 .autorouter 文件
autorouter-cli disconnect               # 清除持久化连接
autorouter-cli list                     # 列出实例
autorouter-cli create --id <id> --mode <mode> [--browser-url <url>]  # 创建实例
autorouter-cli start <id>               # 启动实例
autorouter-cli stop <id>                # 停止实例
autorouter-cli restart <id>             # 重启实例
autorouter-cli switch <id>              # 切换默认实例
autorouter-cli status <id>              # 查看实例状态
autorouter-cli delete <id>              # 删除实例
autorouter-cli get-ws [id]              # 输出实例的 wsEndpoint(可 $() 消费)
```

**典型用法**:

```bash
# 首次连接
autorouter-cli connect 9300

# 控制面操作
autorouter-cli create --id dev --mode attached --browser-url http://localhost:9222
autorouter-cli start dev
autorouter-cli list

# 获取 ws 地址给工具消费
chrome-devtools-mcp --wsEndpoint=$(autorouter-cli get-ws dev)
agent-browser --cdp $(autorouter-cli get-ws dev)

# 一次性指定端口(不持久化)
autorouter-cli --port 9300 list
```

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P3.5-1 | **autorouter-cli 控制面客户端** | 无,控制面靠手动 curl | `connect`/`disconnect` 持久化连接;实例 CRUD 子命令;`--json` 输出模式供脚本消费;命令失败时返回结构化错误信息和修复建议 |
| P3.5-2 | **get-ws 快速获取 wsEndpoint** | 无 | `autorouter-cli get-ws [id]` 输出实例的 wsEndpoint 到 stdout;可直接 `$()` 给 chrome-devtools-mcp 或 agent-browser 消费;无 id 时返回默认实例 |
| P3.5-3 | **Skill 重写对齐当前 API** | Skill 引用旧端口 9223、旧路径 `/instanceN`、旧响应格式 | 重写 `chrome-devtools-ext-autorouter` skill 对齐当前 API(端口 3100、路径 `/instances/{id}`)。**与 `autorouter-cli` 不互斥**:有 CLI 时 agent 直接用 CLI 不需读 skill;无 CLI 时 skill 提供 bash+curl 降级方案。两者是同一控制面的两种消费形态,不是二选一 |
| P3.5-4 | **Skill 自动感知 + CLI 发现** | 无 | `/json/version` 已注入 `autorouter` 元数据字段(P1-4 已实现);Skill 首次调用即可判断 autorouter 版本并选择对应操作路径 |
| P3.5-5 | **`autorouter-cli skills` 子命令** | 无 | 仿 agent-browser 三层 skill 架构:1 薄引导 SKILL.md(`npx skills add` 安装,只含触发词 + "先 `autorouter-cli skills get`")2 `autorouter-cli skills get <name>` 运行时输出完整 skill(打包在 CLI 二进制中,版本永远一致)3 skill-data/ 目录存储完整内容 |
| P3.5-6 | **CLI 作为 MCP tool 暴露**(可选) | 无 | 将 CLI 实例管理能力封装为 MCP tool,让 agent 通过 MCP 协议直接调用 |

### P4 - 安全性增强(当前 repo 已有 WS token 隔离,继续加固)

这些是在对照 repo 基础上"做得更好"的核心差异点。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P4-1 | **WS Token 过期与轮换** | 无 token 层 | Token 支持 TTL(默认 5 分钟),过期后拒绝连接;token 使用一次后标记为 consumed;定期清理过期 token(每 60s) |
| P4-2 | **WS 并发连接限流** | 无 | 单实例最大并发 WS 连接数(默认 20);超出返回 429;Admin API 可查看当前连接数 |
| P4-3 | **Admin API 鉴权**(可选) | 无 | 可选 `ADMIN_API_KEY` 环境变量;Bearer Token 鉴权;无鉴权时仅监听 127.0.0.1(默认行为) |
| P4-4 | **禁止实例间 WS 跨访** | 无 | 显式实例路径与 bindings 中的 instanceId 双向校验已完成;增加审计日志记录拒绝的跨访尝试 |

### P5 - 可观测性(对照 repo 无此能力,属于增值)

| # | 能力 | 说明 |
|---|------|------|
| P5-1 | **结构化日志** | Logger 支持 JSON 输出模式(`--log-format=json`),每条日志包含 timestamp/level/message/instanceId/requestId |
| P5-2 | **请求追踪** | 每个 HTTP/WS 请求分配 `x-request-id`,贯穿日志与错误响应;Admin API 响应头回显 |
| P5-3 | **健康检查端点** | `GET /health` 返回 autorouter 自身健康状态(不依赖 Chrome),供负载均衡/监控使用 |
| P5-4 | **Prometheus metrics**(可选) | 暴露 `GET /metrics`:instance_count、ws_connections_active、request_duration_seconds、managed_process_count 等 |
| P5-5 | **实例事件 hook** | 实例状态变更时 emit 事件(starting → healthy → stopped),支持外部监听;可用于通知系统或自动告警 |

### P6 - 开发体验(让贡献者更容易上手)

| # | 能力 | 说明 |
|---|------|------|
| P6-1 | **ESLint + Prettier** | 当前无 lint 工具;引入 ESLint(TypeScript rules)+ Prettier 格式化 |
| P6-2 | **pre-commit hook** | husky + lint-staged:提交前自动 lint + format + test |
| P6-3 | **Docker 支持** | Dockerfile:多阶段构建,生产镜像仅包含 dist + node_modules;支持 `docker-compose.yml` 快速启动 |
| P6-4 | **集成测试** | 增加 E2E 测试:真实 Chrome 实例启动 → autorouter 代理 → MCP client 调用完整链路;CI 可用 Chromium headless |
| P6-5 | **CHANGELOG.md** | 基于 conventional commits 自动生成 |

## 3. 实现计划

### Phase 1：工程化基础（P0 + P6 部分）

**目标**：有日志可排查、有 lint 可约束。启动直接 `npm start`。

```
P0-1  Logger 系统 ✅
P6-1  ESLint + Prettier
P6-2  pre-commit hook
```

### Phase 2:HTTP 代理增强(预计 P1)

**目标**:HTTP 兼容层达到生产级标准。

```
P1-1  HOP-by-HOP Header 过滤
P1-4  /json/version AutoRouter 元数据
P1-2  反向代理头支持
P1-3  devtoolsFrontendUrl 改写
P1-5  非 JSON 路径透明代理
P1-6  /json/list 页面数缓存
```

### Phase 3:Admin API 补全(预计 P2 + P4 部分)

**目标**:Admin API 功能完整 + 安全加固。

```
P2-1  GET /api/capabilities
P2-2  GET /api/instances/{id}/status
P2-3  POST /api/instances/{id}/switch
P2-4  POST /api/instances/{id}/restart
P2-5  实例连接元数据
P4-1  WS Token 过期与轮换
P4-2  WS 并发连接限流
```

### Phase 3.5:CLI 控制面 + Skill 一体化(新增 P3.5)

**目标**:让人和 agent 都能高效操作 autorouter 控制面,不再依赖手动 curl。

```
P3.5-1  autorouter-cli 控制面客户端(connect/disconnect/list/create/start/stop/restart/switch/status/delete)
P3.5-2  get-ws 快速获取 wsEndpoint
P3.5-3  Skill 重写对齐当前 API
P3.5-4  Skill 自动感知 + CLI 发现
P3.5-5  autorouter-cli skills 子命令(仿 agent-browser 三层架构)
```

### Phase 4:MCP 集成 + 可观测性(预计 P3 + P5)

**目标**:与 chrome-devtools-mcp 无缝对接,可运维。

```
P3-1  chrome-devtools-mcp 启动参数自动升级 ✅
P3-2  autorouter-mcp 包装器 CLI ✅
P3-3  autorouter skill 感知端点
P5-1  结构化日志
P5-2  请求追踪
P5-3  健康检查端点
```

### Phase 5:可选增强

```
P0-5  YAML 配置支持
P4-3  Admin API 鉴权
P5-4  Prometheus metrics
P5-5  实例事件 hook
P6-3  Docker 支持
P6-4  集成测试
P6-5  CHANGELOG.md
```

## 4. 当前 repo 相比对照 repo 的核心差异总结

| 维度 | 对照 repo(chrome-cdp-autorouter v1.0.0) | 当前 repo(chrome-devtools-mcp-autorouter v0.1.0) |
|------|------------------------------------------|---------------------------------------------------|
| **Agent-Browser 主链** | 无明确 agent 接入设计,仅做 CDP 路由 | ✅ **完整 `agent → MCP → autorouter → Chrome` 主链设计**;agent 永远只连 autorouter,不感知真实 Chrome |
| **多 Agent 隔离** | 无隔离机制,所有客户端共享同一路由空间 | ✅ **不同 agent 通过不同 instanceId 隔离操作**;binding 校验 instanceId 一致性,禁止跨实例访问 |
| **WS 安全性** | URL 改写但无 token 隔离 | ✅ **Token 映射,真实地址永不对外暴露**;agent 拿到的 wsUrl 是一次性 token,不可猜测 |
| **懒加载语义** | autoStart 开关,但无 agent 首次请求触发机制 | ✅ **agent 首次 CDP 请求时才触发默认实例启动**;零预热成本,按需分配资源 |
| **实例路由寻址** | 仅支持 `/instance(\d+)` 数字后缀路由 | ✅ **`/instances/{id_or_name}` 任意字符串路由**,支持 ID 和语义化名称混用 |
| **实例模式** | 仅 managed 模式 | ✅ **managed + attached 双模式**;agent 可接入人工已打开的浏览器(attached),也可让 autorouter 代管(managed) |
| **实例生命周期** | start / stop | ✅ **create / start / stop / refresh / health / reclaim** 完整状态机 |
| **类型安全** | JS + JSDoc | ✅ **TypeScript strict mode** |
| **测试** | node:test(10 文件) | ✅ **vitest + MockChromeServer**(6 文件,覆盖核心链路) |
| **架构文档** | README + QUICKSTART + IMPLEMENTATION | ✅ **3 份设计稿 + Mermaid 时序图 + 数据流转图** |
| **CLI + Skill 控制面** | ⚠️ CLI 只管启动,控制面靠 curl;Skill 与当前 API 不一致 | ✅ **新增 P3.5:CLI 实例管理子命令 + Skill 重写对齐 + agent 自动感知** |
| **日志系统** | ✅ 文件 + 控制台 + ANSI | ✅ **已实现**(logger.ts):文件 + 控制台双通道,支持 level/format/file 配置 |
| **反代支持** | ✅ x-forwarded-* | ✅ **已实现**(P1-2):`TRUST_PROXY` 开关 + `x-forwarded-host`/`x-forwarded-port` |
| **能力发现** | ✅ /api/capabilities | ✅ **已实现**(P2-1):返回 capabilities/endpoints/runtime,含 wsTokenIsolation 声明 |
| **MCP 适配器** | ✅ browserUrl → wsEndpoint 升级 | ✅ **已实现**(P3-1):`resolveChromeDevToolsMcpLaunchArgs()` + 超时控制 + graceful fallback |
| **实例 ID 控制权** | ❌ `nextInstanceId++` 强制递增,调用方无法自定义;想要 instance3 必须从 1 开始循环创建到 3;删除后 ID 不回收 | ✅ **调用方在 POST body 中指定任意字符串 `instanceId`(支持 `:id_or_name`)**,无顺序约束,可用语义化名称如 `staging`/`test-flow`,符合 ADP-314 规范 |
| **devtoolsFrontendUrl 重写** | ✅ | ✅ **已实现**(P1-3):ws param 指向 tokenized 地址,支持实例前缀 |
| **实例切换** | ✅ switch API | ✅ **已实现**(P2-3):`POST /api/instances/{id}/switch`,仅 healthy 可切换 |
| **实例重启** | ✅ restart API | ✅ **已实现**(P2-4):`POST /api/instances/{id}/restart`,stop→start 组合 |

## 5. 技术债务(当前已知,不分 phase,择机修复)

| # | 问题 | 说明 |
|---|------|------|
| D-1 | `extensions` 占位返回 | 当前始终返回空数组,需要从下游 Chrome `/json/version` 提取真实扩展列表 |
| D-2 | `wsEndpoint-only` 健康检查不完整 | 纯 WS 端点连接的实例缺少 HTTP /json/version 兜底,metadata 刷新依赖 WS 连通性 |
| D-3 | `uncaughtException` / `unhandledRejection` 回收钩子 | 未注册全局异常处理,进程 crash 时 managed 浏览器可能泄露 |
| D-4 | 缺少真实 chrome-devtools-mcp 集成测试 | 没有自动化脚本验证完整主链 |
| D-5 | `src/index.ts` 过大 | 当前单文件包含 HTTP server + WS upgrade + Admin API + compat routes + normalize 逻辑,应拆分 |

## 6. 提交前检查清单(不变)

每次改代码后至少确认:

1. `npm test` 通过
2. `npm run build` 通过
3. 根路径 compat 语义没有被破坏
4. `GET /api/instances` 没有被做成 Chrome target list
5. `managed` 和 `attached` 的回收边界没有混掉
6. 新增功能补充对应测试
7. 文档描述与代码行为一致
