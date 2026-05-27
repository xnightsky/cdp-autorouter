# API 设计

## 兼容调试接口

`autorouter` 对外维持所有 Chrome Remote Debugging 的标准 HTTP + WS 接口，行为上以“默认兼容实例”作为根路径语义。

- 根路径（`/json/version`、`/json/list`、`/json/protocol`）始终反映 `.env` 定义或由 Admin API 注册表中 `DEFAULT_INSTANCE_ID` 解析出的默认实例，且默认实例会按需懒加载，第一次命中这些接口时才会触发 Child Browser Supervisor 启动或连接真正的 Chrome；无论真实地址如何，代理会把 `webSocketDebuggerUrl` 重写为指向 `autorouter` 自身的 WS 路径，让 `chrome-devtools-mcp` 不会看到真实 Chrome 地址。
- 当需要多实例调试时，可以通过 `/instances/{instanceId}/json/*` 和对应的 `/instances/{instanceId}/devtools/...` 路径显式指定目标实例，所有路由直接映射到注册表里对应的 `browserUrl`/`wsEndpoint`，其它行为与单实例兼容链路一致。

兼容链路的关键约束：

1. 根路径只表示默认实例，从不聚合多个实例的 targets；  
2. HTTP 层负责发现并 rewrite `webSocketDebuggerUrl`，WS 层负责中转 `/devtools/browser/*` 与 `/devtools/page/*`；  
3. 不管是默认实例还是显式实例，所有 CDP 连接都在 `autorouter` 内部转发，真实 Chrome 的 WS 地址从不暴露给外部；
4. **默认路径双触发器自愈**：根路径 `/json/*` 采用双触发器架构保证“端口可用”语义——触发器 A（`resolveInstance` 检测到 managed default 非 healthy 时主动交 `supervisor.start`）+ 触发器 B（fetch 失败后兜底，attached 返 503，managed retry）；**显式实例路径 `/instances/{id}/json/*` 不享受任一触发器**，开发者手动调 `POST /api/instances/{id}/restart`；
5. **attached 不自愈**：连默认实例上 attached 不可达也仅返回 503 诊断信息，autorouter 不擅自启动外部 chrome；
6. **响应码分路径语义**：

   | 路径 | 200 | 503 | 500 |
   |------|----|----|----|----|
   | 根路径 + managed default | 链路通畅（含触发器 A 自愈后） | 启动超时（`DEFAULT_INSTANCE_RESTART_TIMEOUT_MS`）或触发器 B retry 失败 | autorouter 自身 bug |
   | 根路径 + attached default | 链路通畅 | 触发器 B 检测到上游不可达 | autorouter 自身 bug |
   | 显式路径 `/instances/{id}/json/*` | 链路通畅 | 不使用 | 上游不可达 或 autorouter 自身 bug |

## Admin API

`/api/instances` 系列接口只记录运行时的内存实例，主要职责是创建/更新/查询/控制实例的生命周期，而不做落盘。核心字段包括 `instanceId`、`mode`（`managed`/`attached`）、`status`、`browserUrl`、`wsEndpoint`、`userDataDir`、`managedProcess` 等。

- `GET /api/instances`：列出 autorouter 自己管理的实例（Default + API 生成），配置来自 `.env` 或运行期操作，响应代表的是“autorouter 眼中的实例注册表”，便于调度、健康检查与回收；  
- `GET /json/list`：代表某个实例（默认或显式）对应的真实 Chrome 下的 targets/pages，返回的是标准的 DevTools target 列表，与 Admin API 的实例登记无关，只依赖当前页面/目标的 `wsEndpoint`；其内容会被 upstream 如 `chrome-devtools-mcp` 继续消费。  
- `POST /api/instances` / `PATCH` / `DELETE`：在注册表里新增/修改/删除实例定义，但不直接操纵 Chrome 进程，实际的启动与停止通过 `POST /api/instances/{instanceId}/start` / `stop` 实现；
- **`instanceId` 由调用方在 POST body 中显式指定**（任意字符串，如 `"my-chrome"`、`"prod-instance"`），不采用服务端自增计数器。这是与对照 repo（`chrome-cdp-autorouter`）的关键设计差异：对照 repo 使用 `nextInstanceId++` 强制递增（`instance1 → 2 → 3`），调用方无法自定义 ID，且可预测的自增序列存在 IDOR 枚举风险。当前设计遵循 ADP-314 建议（`SHOULD NOT use incrementing integers as id generation logic`），将 ID 控制权完全交给调用方；  
- `POST /api/instances/reclaim-managed`：统一回收当前所有 `mode=managed` 的浏览器，走 `reclaiming -> stop -> kill -> cleanup` 流程，期间会拒绝新的 HTTP/WS 请求；  
- `GET /api/instances/{instanceId}/health`、`/refresh`、`/extensions`：提供运行时健康、协议元数据与扩展摘要，所有数据都是从对应实例的 `wsEndpoint` 上游采集的，不写盘。

与兼容接口配合使用时的工程要点：

1. `Admin API` 与 `.env` 构建的是“autorouter 内部的实例心智图”，组件间以 `instanceId` 互相传递；  
2. `chrome-devtools-mcp` 只关心兼容接口，无需感知 `Admin API` 的存在；  
3. `managed` 模式下 autorouter 会启动并登记真正的 Chrome 进程，便于统一回收；`attached` 模式只完成代理转发，不干预外部浏览器；  
4. `GET /api/instances` 与 `GET /json/list` 的语义绝对不同：前者是 autorouter 管理的“实例”，后者是某个真实 Chrome 实例下暴露的 target 列表，两者不能互换。
