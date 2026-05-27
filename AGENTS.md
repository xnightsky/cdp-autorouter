**始终使用简体中文回答**
**输出标记（canary）**：每次回复末尾必须附带一行 `[by=cdp-autorouter]`。

# AGENTS.md

本文件定义 agent 在 `cdp-autorouter` 仓库内工作的约束与上下文。

## 顶层通用规则

### 输出与沟通

- 探索、编码、验证前先说目标；完成后说已验证、未验证及剩余风险。
- 发现边界/设计/阶段冲突或全局一致性风险，第一时间用 `**[冲突提示]**` 高亮，写清冲突点、影响范围、建议停点、是否需更新计划。禁止积压。

### 执行与风险控制

- 子命令用 `(cd dir && command)`；Windows 下 Git Bash 失败时切 PowerShell 或 `cmd /c`。
- 先搜索缩小范围再展开；Git Bash 用 `grep -rn`，PowerShell 用 `Select-String`。
- 未知代码不碰：只处理本会话负责的改动。
- 禁止空 `catch {}`；TS 用 `catch (err: unknown)` 收窄后处理。
- 注释写"为什么"，不复述代码；代码注释英文，文档说明用简体中文。
- 对外接口变更同步维护 JSDoc。

### Git 限制

- 未经允许禁止 `git add/commit/push`。
- 禁止全仓回滚（`restore .`、`reset --hard`、`clean -fd*`），只允许逐文件逐块回滚且明确范围。
- 未知 `??` 文件只汇报不删，确认来源后才逐文件处理。

### 搜索与文档感知

- 会话开始时，先搜索并读取所有 `AGENTS.*.md` 文档。
- 文件发现命令优先级：
  - 首选：`(cd repo && rg --files -uu -L -g 'AGENTS.*.md' .)`
  - 备选：`(cd repo && fd -HI 'AGENTS\\..*\\.md' .)`
  - 兜底：`(cd repo && find . \\( -type f -o -type l \\) -name 'AGENTS.*.md')`

### 修改后质量检查

- 改 `src/` 或 `tests/` 下的 `.ts` 后：先 `npm run build`（tsc strict），再 `npm test`（vitest）。
- `.md`/`.json`/`.env` 不触发。项目无 Prettier/ESLint，风格自保持。

### 计划与工作区

- 遇到跨前后端、多阶段、高风险或预计超过 30 分钟的任务时，先按 `PLANS.md` 编写执行计划，再开始实施。
- 任务计划默认写入 `.tmp/plans/<topic>.md`（若用户显式指定路径，则按用户输入执行），执行过程中持续回写进度、新发现、决策记录、结果与复盘。
- `.tmp/plans` 视为临时计划目录，不要提交到 git，也不要在提交内容中引用为正式托管文档。
- 新建 worktree 后 `npm install` 确保环境就绪。

---

## 项目特定规则

### 1. 项目定位

`chrome-devtools-mcp -> autorouter(HTTP+WS) -> real Chrome instance`

本仓库是 HTTP+WS 代理层，不是 chrome-devtools-mcp 替代品。所有实现围绕这条主链展开。

### 2. 设计事实来源

设计稿优先于代码：`README.md`、`docs/chrome-devtools-mcp-architecture.md`、`docs/autorouter-architecture.md`、`docs/api-design.md`、`docs/roadmap.md`。偏离需明确说明。

### 3. v1 硬规则

**HTTP + WS 接管**：autorouter 同时提供 HTTP 兼容层和 WS/CDP 转发；`webSocketDebuggerUrl` 必须改写；真实 Chrome WS 地址不直接暴露。

**根路径 = 默认实例**：`/json/version`、`/json/list`、`/json`、`/json/protocol` 只表示默认实例，不做多实例聚合。

**显式路径 = 多实例入口**：`/instances/{id}/json/*`、`/instances/{id}/devtools/*`，不回落默认实例。

**`.env` 是模板不是数据库**：仅存 compat/lazy-load 开关、默认实例 ID 及启动模板。运行期数据在内存注册表。

**Admin API vs Chrome list**：`GET /api/instances` 返回 autorouter 管理的实例；`GET /json/list` 返回某 Chrome 下的 targets。不混淆。

**回收边界**：只有 `managed` 实例允许 autorouter 启动/停止/回收；`attached` 只连接代理，不杀外部浏览器。

### 4. 代码结构

| 模块 | 职责 |
|------|------|
| `src/server/config.ts` | `.env` 解析、策略与模板 |
| `src/server/runtime-registry.ts` | 内存实例注册表 |
| `src/server/default-instance-resolver.ts` | 根路径默认实例解析与懒注入 |
| `src/server/child-browser-supervisor.ts` | managed/attached 启动、刷新、停止、回收 |
| `src/server/route-bindings.ts` | 外部 WS token → 下游真实 WS 映射 |
| `src/server/routing/pattern.ts` | 路径模板编译与匹配（`:name` / `:name?` / `*`） |
| `src/server/routing/route.ts` | Route/RouteContext/HttpError 类型定义 |
| `src/server/routing/dispatch-http.ts` | HTTP 请求分派（顺序匹配 + 错误兜底） |
| `src/server/routing/dispatch-ws.ts` | WS upgrade 分派 |
| `src/server/routes/capabilities.ts` | GET /api/capabilities |
| `src/server/routes/admin-instances.ts` | /api/instances CRUD + 生命周期 action |
| `src/server/routes/json-compat.ts` | /json/* 兼容层 + 默认路径 self-heal |
| `src/server/routes/devtools-proxy.ts` | /devtools/* 透明 HTTP 反代 |
| `src/server/routes/ws-upgrade.ts` | WS CDP 双向 proxy（token 校验 + message pump） |
| `src/server/routes/rewriters.ts` | webSocketDebuggerUrl / devtoolsFrontendUrl 改写 |
| `src/server/index.ts` | Composition root：装配 ctx、注册 routes、listen、shutdown |

新增功能优先在 `routes/` 或 `routing/` 下扩展，`index.ts` 只做装配。

### 5. 编码约束

- 优先最小可验证改动，保持 KISS，不预埋多余抽象。
- 不把 v1 内存模型过早升级为数据库模型。
- Compat 层报错明确；不在路由失败时静默 fallback；对默认实例缺失/实例不存在/不健康/WS token 无效等返回可诊断错误。

### 6. 测试约定

框架：`vitest`。关键测试：`tests/config.test.ts`、`tests/http-compat.test.ts`。

改以下能力时必须补/改测试：`.env` 加载、默认实例懒加载、`/json/version` 改写、`/json/list` 与 `GET /api/instances` 边界、WS 代理、managed 回收。

常用命令：

```bash
npm test
npm run build
```

### 7. 提交信息规范

前缀：`feat:` `fix:` `docs:` `style:` `refactor:` `perf:` `test:` `chore:` `revert:`；按需 `unfinish:` `deprecated:`。不混入无关改动。

### 8. 提交前检查

改实现代码后确认：

1. `npm test` 通过
2. `npm run build` 通过
3. 根路径 compat 语义完好
4. `GET /api/instances` 未被做成 Chrome target list
5. `managed` / `attached` 回收边界未混淆

改文档后确保描述与代码行为一致。

### 9. 路线图与已知缺口

完整路线图见 `docs/roadmap.md`（P0-P6）。当前缺口：

- `extensions` 占位返回
- `wsEndpoint-only` 健康检查/metadata 刷新未补齐
- 未接 `uncaughtException`/`unhandledRejection` 回收钩子
- 无真实 chrome-devtools-mcp 集成脚本

补能力时先保持已有测试通过，再新增覆盖。
