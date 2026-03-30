# AGENTS.md

本文件定义在 `chrome-devtools-mcp-autorouter` 仓库内工作的 agent 约束与项目上下文。

## 1. 项目定位

当前项目不是 `chrome-devtools-mcp` 的替代品，而是插在它与真实 Chrome 实例之间的一层 `HTTP + WS` 代理。

固定主链：

`chrome-devtools-mcp -> autorouter(HTTP+WS) -> real Chrome instance`

这条主链是本仓库最重要的架构前提。后续所有实现都必须围绕它展开，不能退化成“只做 HTTP”或者“只做 Admin API”的项目。

## 2. 设计与实现的事实来源

在修改代码前，优先以这些文件为准：

- `README.md`
- `docs/chrome-devtools-mcp-architecture.md`
- `docs/autorouter-architecture.md`
- `docs/api-design.md`

如果实现与文档冲突，先判断：

1. 是实现落后于已确认设计
2. 还是文档已经过期

不要在没有说明的情况下静默偏离设计稿。

## 3. 当前 v1 已确定的硬规则

### 3.1 HTTP + WS 都必须由 autorouter 接管

- `autorouter` 必须同时提供 HTTP 兼容层和 WS/CDP 转发层
- `webSocketDebuggerUrl` 必须由 autorouter 改写并对外签发
- 真实 Chrome 的 WS 地址不得直接暴露给调用方

### 3.2 根路径只表示默认兼容实例

- `/json/version`
- `/json/list`
- `/json`
- `/json/protocol`

这些根路径接口始终只表示默认实例，不做多实例聚合。

### 3.3 显式实例路径是多实例入口

显式实例路径固定为：

- `/instances/{instanceId}/json/*`
- `/instances/{instanceId}/devtools/*`

所有显式实例路由都必须只命中对应实例，不能回落到默认实例。

### 3.4 `.env` 只存策略和默认实例模板

`.env` 第一版不是实例数据库。

它只负责：

- compat 开关
- lazy-load 开关
- 默认实例 ID
- 默认实例启动/连接模板

运行期实例数据由内存注册表维护，不做落盘。

### 3.5 Admin API 管理的是“实例”，不是 Chrome 页面

必须始终区分：

- `GET /api/instances`
  - 返回 autorouter 管理的实例列表
- `GET /json/list`
  - 返回某个真实 Chrome 实例下的 targets/pages

不要混淆两者语义。

### 3.6 只有 `managed` 实例允许被 autorouter 回收

- `managed`
  - autorouter 启动、登记、停止、回收
- `attached`
  - autorouter 只连接和代理，不杀外部浏览器

退出钩子和 `reclaim-managed` 只能影响 `managed` 实例。

## 4. 代码结构约定

当前核心模块职责如下：

- `src/config.ts`
  - 解析 `.env` 策略和默认实例模板
- `src/runtime-registry.ts`
  - 内存实例注册表
- `src/default-instance-resolver.ts`
  - 根路径默认实例解析与懒注入
- `src/child-browser-supervisor.ts`
  - `managed`/`attached` 实例启动、刷新、停止、回收
- `src/route-bindings.ts`
  - 外部 WS token 到下游真实 WS 的映射
- `src/index.ts`
  - HTTP server、compat routes、Admin API、WS upgrade 入口

新增功能时优先扩展现有边界，不要把所有逻辑继续堆进 `src/index.ts`。

## 5. 编码约束

### 5.1 注释语言

- 代码注释统一使用英文
- 文档和与用户的说明统一使用简体中文

### 5.2 改动风格

- 优先最小可验证改动
- 保持 KISS
- 不预埋未被当前设计需要的抽象
- 不把 v1 的运行期内存模型过早升级成数据库模型

### 5.3 错误处理

- Compat 层报错要明确
- 不要在路由失败时静默 fallback 到别的实例
- 对默认实例缺失、实例不存在、实例不健康、WS token 无效等情况，返回可诊断错误

## 6. 测试约定

当前测试框架：

- `vitest`

当前关键测试文件：

- `tests/config.test.ts`
- `tests/http-compat.test.ts`

在修改以下能力时，必须补或改测试：

- `.env` 加载逻辑
- 默认实例懒加载
- `/json/version` 改写
- `/json/list` 与 `GET /api/instances` 语义边界
- WS 代理行为
- `managed` 浏览器回收

常用命令：

```bash
npm test
npm run build
```

在声称“完成”之前，至少重新跑：

```bash
npm test
npm run build
```

## 7. 当前已知缺口

以下能力目前还不完整，后续 agent 修改时要有心理预期：

- `extensions` 目前还是占位返回
- `wsEndpoint-only` 的完整健康检查和 metadata 刷新还没补齐
- `uncaughtException` / `unhandledRejection` 的回收钩子还没接
- 还没有真实 `chrome-devtools-mcp` 对接的集成脚本

如果要补这些能力，先保持现有测试继续通过，再新增测试覆盖。

## 8. 提交前检查

如果你改了实现代码，结束前至少确认：

1. `npm test` 通过
2. `npm run build` 通过
3. 根路径 compat 语义没有被破坏
4. `GET /api/instances` 没有被做成 Chrome target list
5. `managed` 和 `attached` 的回收边界没有混掉

如果你改了文档，也要确保文档描述与当前代码行为一致。
