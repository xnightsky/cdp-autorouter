# chrome-devtools-mcp-autorouter 路线图

本文档定义 `chrome-devtools-mcp-autorouter` 从当前 `v0.1.0` 向目标版本演进的完整路线图。

对照基线是 `chrome-cdp-autorouter`（`D:\workspace\project\gwm\projtmpl\ai\browser\chrome-devtools\autorouter`），版本 `1.0.0`，以下简称"对照 repo"。

## 1. 已完成清单（v0.1.0）

以下是当前 repo 已经实现且质量高于对照 repo 的能力：

| # | 能力 | 当前状态 | 相比对照 repo 的优势 |
|---|------|---------|---------------------|
| 1 | TypeScript 工程骨架 | ✅ 已实现 | 对照为 JS + JSDoc，当前有完整类型系统 |
| 2 | `.env` 配置解析 | ✅ 已实现 | 对照为 YAML，当前方案更轻量 |
| 3 | Runtime Registry（内存实例注册表） | ✅ 已实现 | 分离 env-bootstrap / api-runtime 来源 |
| 4 | Default Instance Resolver | ✅ 已实现 | 清晰的懒注入语义，策略开关控制 |
| 5 | HTTP Compat Proxy（/json/version, /json/list, /json/protocol） | ✅ 已实现 | 手动 fetch + 精确 JSON rewrite |
| 6 | webSocketDebuggerUrl 改写 | ✅ 已实现 | **使用 token 映射（RouteBindingStore），真实 Chrome WS 地址永不对外暴露** |
| 7 | WS CDP Proxy（/devtools/browser/*, /devtools/page/*） | ✅ 已实现 | token 验证 + 消息缓冲 + 生命周期管理 |
| 8 | 显式实例路由（/instances/{id}/json/*, /instances/{id}/devtools/*） | ✅ 已实现 | 路径模板规范，不依赖正则数字匹配 |
| 9 | Admin API CRUD（GET/POST/PATCH/DELETE /api/instances） | ✅ 已实现 | 完整的 REST 风格 CRUD |
| 10 | Admin API 操作（start/stop/refresh/health/extensions） | ✅ 已实现 | 实例生命周期细粒度控制 |
| 11 | Managed 模式（autorouter 启动并回收子进程） | ✅ 已实现 | SIGTERM → SIGKILL fallback，优雅关闭 |
| 12 | Attached 模式（只代理外部浏览器） | ✅ 已实现 | Managed/Attached 回收边界干净 |
| 13 | reclaim-managed 批量回收 | ✅ 已实现 | +进程退出自动清理 |
| 14 | 进程退出钩子（SIGINT/SIGTERM/beforeExit） | ✅ 已实现 | 覆盖主要退出路径 |
| 15 | 元数据采集（version/protocolVersion/extensionsSummary） | ✅ 已实现 | 健康检查与状态同步 |
| 16 | vitest 测试框架 | ✅ 已实现 | config.test.ts + http-compat.test.ts + MockChromeServer |
| 17 | 架构文档（autorouter-architecture.md, api-design.md, chrome-devtools-mcp-architecture.md） | ✅ 已实现 | 完整设计稿 + 数据流转 + 时序图 |

## 2. 待实现清单

以下按优先级分层，每层内的条目建议按序号推进。

### P0 — 基础设施与工程化（对标对照 repo 的 CLI + 日志体系）

这些能力是让项目从"能跑"走向"可运维"的基础。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P0-1 | **Logger 系统** | `src/logger.js`：文件 + 控制台双写，ANSI 颜色，level 过滤，调用方透明注入 | 重写为 TypeScript，保持文件 + 控制台双通道；增加 `--log-level` 环境变量控制（silent/error/warn/info/debug）；支持结构化 JSON 输出模式供日志采集；SIGINT/SIGTERM 时确保 flush 最后日志 |
| P0-2 | **CLI 启动入口** | `src/cli/start.js`：参数解析 → 配置加载 → 启动服务 | 统一 CLI 参数模型（`--config`、`--port`、`--host`、`--log-level`）；命令行参数优先级 > `.env`；打印启动摘要（监听地址、默认实例、compat 模式状态） |
| P0-3 | **CLI 配置初始化** | `src/cli/config-init.js`：从模板创建 `.env.yaml` | 生成 `.env.example` 模板文件；`--force` 覆盖已有配置；交互式引导（可选） |
| P0-4 | **CLI 验证脚本** | `src/cli/verify.js` + `src/verify.js`：5 步健康检查 | 增强为 7 步：增加 WS 代理连通性检查、默认实例懒加载验证；验证结果以结构化 JSON 输出；支持 `--json` 输出模式；失败时给出修复建议 |
| P0-5 | **YAML 配置支持**（可选） | `.env.yaml` + `yaml` 依赖 | 当前 `.env` 已足够 v1，作为可选增强：若检测到 `.env.yaml` 存在则优先使用 YAML；YAML 支持嵌套结构（server/autorouter/verify 分层）；配置校验给出字段级错误提示 |

### P1 — HTTP 代理增强（对标对照 repo 的 router.js 能力）

这些能力让 HTTP 兼容层更健壮、更符合标准。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P1-1 | **HOP-by-HOP Header 过滤** | 过滤 `connection/keep-alive/proxy-*` 等 8 个头 | 按 RFC 2616 Section 13.5.1 标准过滤；同时处理 `te`、`trailer`、`transfer-encoding`、`upgrade`；确保不影响 `/json/*` 响应 |
| P1-2 | **反向代理头支持** | `x-forwarded-host`、`x-forwarded-proto` 解析 | 增加 `x-forwarded-port` 解析；ws/wss scheme 自动推导；生成的外部 URL 优先使用反代头；配置 `TRUST_PROXY` 开关控制是否信任反代头 |
| P1-3 | **devtoolsFrontendUrl 改写** | 递归重写 JSON 中所有 `devtoolsFrontendUrl` 字段 | 与 `webSocketDebuggerUrl` 改写同层处理；支持 absolute/relative 两种格式；追加实例前缀 |
| P1-4 | **/json/version 附加 AutoRouter 元数据** | 注入 `AutoRouter: { name, multiInstance, capabilitiesEndpoint }` | 字段名改为 `autorouter`（小写）；增加 `version` 字段；增加 `defaultInstanceId` 字段；MCP client 通过此字段可自动感知多实例能力 |
| P1-5 | **非 JSON 路径透明代理** | 使用 `http-proxy` 库转发非 `/json/*` 请求 | 不使用 `http-proxy` 依赖，改为手动 `fetch` + stream pipe；保持依赖最小化；非 JSON 路径做 chunked transfer 转发 |
| P1-6 | **/json/list 页面数缓存** | 无 | 首次 /json/list 后缓存页面数，后续 `/api/instances` 响应可附带 `pageCount`；缓存 TTL 可配置；实例状态变更时主动失效 |

### P2 — Admin API 补全（对标对照 repo 的 api.js 能力）

这些 API 端点是当前 Admin API 缺失的能力。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P2-1 | **GET /api/capabilities** | 返回 name/version/capabilities/endpoints/runtime | 增加 `wsTokenMode: true` 声明安全特性；增加 `supportedModes: ["managed", "attached"]`；增加 `serverVersion`（从 package.json 读取） |
| P2-2 | **GET /api/instances/{id}/status** | 返回 status + pages 数 | 当前已有 `/health`，合并两者语义：`/status` 返回 status + pages + version + protocolVersion + lastHeartbeatAt；`/health` 保留为精简版 |
| P2-3 | **POST /api/instances/{id}/switch** | 切换默认实例（仅限 running 实例） | 实现 `RuntimeRegistry.setDefaultInstance()`；仅 running 实例可切换；旧默认实例状态不丢失；`GET /api/instances` 响应中标记 `isDefault` |
| P2-4 | **POST /api/instances/{id}/restart** | 同 ID 重启实例（保留 port/userDataDir） | 实现 stop → wait → start 流程；保留配置但刷新进程；port 占用冲突时自动换端口 + 更新 registry；超时保护 |
| P2-5 | **实例连接元数据** | `instanceVersionUrl` + `browserWebSocketDebuggerUrl` 稳定对外暴露 | 每次 `/api/instances` 列表响应附带 `instanceVersionUrl` 和 `browserWebSocketDebuggerUrl`；URL 基于当前请求 host 动态构建，支持反代 |

### P3 — MCP 集成（对标对照 repo 的 mcp-launch-options.js + CLI MCP wrapper）

这些能力让 chrome-devtools-mcp 与 autorouter 无缝对接。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P3-1 | **chrome-devtools-mcp 启动参数自动升级** | `browserUrl=/instance2` → 自动解析为 `wsEndpoint=ws://...` | 作为独立导出函数 `resolveMcpArgs()`；支持 stdin JSON 输入（MCP 进程调用）；超时与重试控制；错误时回退到原始参数而非静默失败 |
| P3-2 | **MCP 包装器 CLI** | `chrome-cdp-autorouter-mcp` bin 入口，内部 `spawn('npx', ['chrome-devtools-mcp@latest', ...])` | 作为 `bin` 字段独立可执行；支持 `--autorouter-url` 指定 autorouter 地址；自动检测 autorouter 版本与能力；透传所有 chrome-devtools-mcp 参数 |
| P3-3 | **autorouter skill 感知端点** | 无 | 在 `/json/version` 附加字段让 chrome-devtools-ext-autorouter skill 自动检测；支持 `OPTIONS /api/capabilities` 返回允许的操作集合 |

### P4 — 安全性增强（当前 repo 已有 WS token 隔离，继续加固）

这些是在对照 repo 基础上"做得更好"的核心差异点。

| # | 能力 | 对照 repo 现状 | 当前要做得更好的方向 |
|---|------|--------------|---------------------|
| P4-1 | **WS Token 过期与轮换** | 无 token 层 | Token 支持 TTL（默认 5 分钟），过期后拒绝连接；token 使用一次后标记为 consumed；定期清理过期 token（每 60s） |
| P4-2 | **WS 并发连接限流** | 无 | 单实例最大并发 WS 连接数（默认 20）；超出返回 429；Admin API 可查看当前连接数 |
| P4-3 | **Admin API 鉴权**（可选） | 无 | 可选 `ADMIN_API_KEY` 环境变量；Bearer Token 鉴权；无鉴权时仅监听 127.0.0.1（默认行为） |
| P4-4 | **禁止实例间 WS 跨访** | 无 | 显式实例路径与 bindings 中的 instanceId 双向校验已完成；增加审计日志记录拒绝的跨访尝试 |

### P5 — 可观测性（对照 repo 无此能力，属于增值）

| # | 能力 | 说明 |
|---|------|------|
| P5-1 | **结构化日志** | Logger 支持 JSON 输出模式（`--log-format=json`），每条日志包含 timestamp/level/message/instanceId/requestId |
| P5-2 | **请求追踪** | 每个 HTTP/WS 请求分配 `x-request-id`，贯穿日志与错误响应；Admin API 响应头回显 |
| P5-3 | **健康检查端点** | `GET /health` 返回 autorouter 自身健康状态（不依赖 Chrome），供负载均衡/监控使用 |
| P5-4 | **Prometheus metrics**（可选） | 暴露 `GET /metrics`：instance_count、ws_connections_active、request_duration_seconds、managed_process_count 等 |
| P5-5 | **实例事件 hook** | 实例状态变更时 emit 事件（starting → healthy → stopped），支持外部监听；可用于通知系统或自动告警 |

### P6 — 开发体验（让贡献者更容易上手）

| # | 能力 | 说明 |
|---|------|------|
| P6-1 | **ESLint + Prettier** | 当前无 lint 工具；引入 ESLint（TypeScript rules）+ Prettier 格式化 |
| P6-2 | **pre-commit hook** | husky + lint-staged：提交前自动 lint + format + test |
| P6-3 | **Docker 支持** | Dockerfile：多阶段构建，生产镜像仅包含 dist + node_modules；支持 `docker-compose.yml` 快速启动 |
| P6-4 | **集成测试** | 增加 E2E 测试：真实 Chrome 实例启动 → autorouter 代理 → MCP client 调用完整链路；CI 可用 Chromium headless |
| P6-5 | **CHANGELOG.md** | 基于 conventional commits 自动生成 |

## 3. 实现计划

### Phase 1：工程化基础（预计 P0 + P6 部分）

**目标**：让项目有 CLI 可启动、有日志可排查、有 lint 可约束。

```
P0-1  Logger 系统
P0-2  CLI 启动入口
P0-3  CLI 配置初始化
P6-1  ESLint + Prettier
P6-2  pre-commit hook
P0-4  CLI 验证脚本
```

### Phase 2：HTTP 代理增强（预计 P1）

**目标**：HTTP 兼容层达到生产级标准。

```
P1-1  HOP-by-HOP Header 过滤
P1-4  /json/version AutoRouter 元数据
P1-2  反向代理头支持
P1-3  devtoolsFrontendUrl 改写
P1-5  非 JSON 路径透明代理
P1-6  /json/list 页面数缓存
```

### Phase 3：Admin API 补全（预计 P2 + P4 部分）

**目标**：Admin API 功能完整 + 安全加固。

```
P2-1  GET /api/capabilities
P2-2  GET /api/instances/{id}/status
P2-3  POST /api/instances/{id}/switch
P2-4  POST /api/instances/{id}/restart
P2-5  实例连接元数据
P4-1  WS Token 过期与轮换
P4-2  WS 并发连接限流
```

### Phase 4：MCP 集成 + 可观测性（预计 P3 + P5）

**目标**：与 chrome-devtools-mcp 无缝对接，可运维。

```
P3-1  chrome-devtools-mcp 启动参数自动升级
P3-2  MCP 包装器 CLI
P3-3  autorouter skill 感知端点
P5-1  结构化日志
P5-2  请求追踪
P5-3  健康检查端点
```

### Phase 5：可选增强

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

| 维度 | 对照 repo（chrome-cdp-autorouter v1.0.0） | 当前 repo（chrome-devtools-mcp-autorouter v0.1.0） |
|------|------------------------------------------|---------------------------------------------------|
| **WS 安全性** | URL 改写但无 token 隔离 | ✅ **Token 映射，真实地址永不对外暴露** |
| **实例模式** | 仅 managed 模式 | ✅ **managed + attached 双模式** |
| **实例生命周期** | start / stop | ✅ **create / start / stop / refresh / health / reclaim** |
| **类型安全** | JS + JSDoc | ✅ **TypeScript strict mode** |
| **测试** | 无可见测试 | ✅ **vitest + MockChromeServer** |
| **架构文档** | README 草图 | ✅ **3 份设计稿 + Mermaid 图** |
| **CLI 工具链** | ✅ start/mcp/config-init/verify | ❌ 缺失 |
| **日志系统** | ✅ 文件 + 控制台 + ANSI | ❌ 缺失 |
| **反代支持** | ✅ x-forwarded-* | ❌ 缺失 |
| **能力发现** | ✅ /api/capabilities | ❌ 缺失 |
| **MCP 适配器** | ✅ browserUrl → wsEndpoint 升级 | ❌ 缺失 |
| **devtoolsFrontendUrl 重写** | ✅ | ❌ 缺失 |
| **实例切换** | ✅ switch API | ❌ 缺失 |
| **实例重启** | ✅ restart API | ❌ 缺失 |

## 5. 技术债务（当前已知，不分 phase，择机修复）

| # | 问题 | 说明 |
|---|------|------|
| D-1 | `extensions` 占位返回 | 当前始终返回空数组，需要从下游 Chrome `/json/version` 提取真实扩展列表 |
| D-2 | `wsEndpoint-only` 健康检查不完整 | 纯 WS 端点连接的实例缺少 HTTP /json/version 兜底，metadata 刷新依赖 WS 连通性 |
| D-3 | `uncaughtException` / `unhandledRejection` 回收钩子 | 未注册全局异常处理，进程 crash 时 managed 浏览器可能泄露 |
| D-4 | 缺少真实 chrome-devtools-mcp 集成测试 | 没有自动化脚本验证完整主链 |
| D-5 | `src/index.ts` 过大 | 当前单文件包含 HTTP server + WS upgrade + Admin API + compat routes + normalize 逻辑，应拆分 |

## 6. 提交前检查清单（不变）

每次改代码后至少确认：

1. `npm test` 通过
2. `npm run build` 通过
3. 根路径 compat 语义没有被破坏
4. `GET /api/instances` 没有被做成 Chrome target list
5. `managed` 和 `attached` 的回收边界没有混掉
6. 新增功能补充对应测试
7. 文档描述与代码行为一致
