# cdp-autorouter-cli Skill

> 控制面客户端完整指令集。当 agent 需要管理 autorouter 实例时加载此 skill。

## 触发词

autorouter, 实例管理, browser instance, get-ws, wsEndpoint, CDP proxy

## 前置条件

- autorouter 服务已运行（默认端口 3100）
- 已执行 `cdp-autorouter-cli connect <port>` 或设置 `AUTOROUTER_URL` 环境变量

## 端口解析优先级

`--port` flag > `AUTOROUTER_URL` 环境变量 > `.autorouter` 文件（cwd 向上查找） > `~/.autorouter`（全局兜底） > 默认 3100

> 全局档案适合「一台机器一个 server」的常态：cwd 在别的盘符/目录树时向上查找走不到 home，靠它兜底。

## 命令参考

### 连接管理

```bash
# 持久化端口（写入 ./.autorouter，目录级、就近优先）
cdp-autorouter-cli connect 9300

# 持久化到全局 ~/.autorouter（--global / -g；任意目录树下都能兜底发现）
cdp-autorouter-cli connect 9223 --global

# 清除持久化连接（删发现逻辑命中的那份：本地优先，本地全无时删全局）
cdp-autorouter-cli disconnect
```

### 实例管理

```bash
# 列出所有实例
cdp-autorouter-cli list
cdp-autorouter-cli list --json

# 创建实例
cdp-autorouter-cli create --id dev --mode attached --browser-url http://localhost:9222
cdp-autorouter-cli create --id managed1 --mode managed

# 启动/停止/重启
cdp-autorouter-cli start <id>
cdp-autorouter-cli stop <id>
cdp-autorouter-cli restart <id>

# 切换默认实例
cdp-autorouter-cli switch <id>

# 查看状态
cdp-autorouter-cli status <id>

# 删除实例
cdp-autorouter-cli delete <id>
```

### 获取 WebSocket 端点

```bash
# 获取默认实例的 wsEndpoint
cdp-autorouter-cli get-ws

# 获取指定实例的 wsEndpoint
cdp-autorouter-cli get-ws dev

# 给工具消费（$() 模式）
chrome-devtools-mcp --wsEndpoint=$(cdp-autorouter-cli get-ws dev)
agent-browser --cdp $(cdp-autorouter-cli get-ws dev)
```

### 一次性指定端口

```bash
cdp-autorouter-cli --port 9300 list
cdp-autorouter-cli --port 9300 get-ws dev
```

## 输出格式

- 默认：human-friendly 表格/文本
- `--json`：JSON 输出（供脚本消费）
- `get-ws`：始终只输出一行 `ws://` 地址
- 错误输出到 stderr，exit code 非零

## 典型工作流

```bash
# 1. 连接到 autorouter
cdp-autorouter-cli connect 3100

# 2. 创建并启动实例
cdp-autorouter-cli create --id dev --mode attached --browser-url http://localhost:9222
cdp-autorouter-cli start dev

# 3. 验证状态
cdp-autorouter-cli status dev

# 4. 获取 ws 地址给 MCP 使用
chrome-devtools-mcp --wsEndpoint=$(cdp-autorouter-cli get-ws dev)
```

## 动态加载

```bash
cdp-autorouter-cli skills                        # 列出可用 skills
cdp-autorouter-cli skills get cdp-autorouter-cli     # 输出本 skill 完整内容
cdp-autorouter-cli skills get autorouter-mcp     # 输出 MCP 包装器 skill
cdp-autorouter-cli skills get --all              # 输出所有
```
