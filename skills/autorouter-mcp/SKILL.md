# autorouter-mcp Skill

> MCP 包装器 skill。当 agent 需要通过 MCP 协议连接 autorouter 管理的浏览器时加载此 skill。

## 触发词

autorouter-mcp, MCP wrapper, browserUrl upgrade, chrome-devtools-mcp spawn

## 概述

`autorouter-mcp` 是 `chrome-devtools-mcp` 的透明包装器，自动将 `--browserUrl` 参数升级为 `--wsEndpoint`。

## 使用方式

```bash
# 直接指定 autorouter 实例路径
autorouter-mcp --browserUrl http://localhost:3100/instances/dev

# 等价于手动解析后执行：
chrome-devtools-mcp --wsEndpoint=ws://127.0.0.1:3100/devtools/browser/<token>
```

## 参数

- `--browserUrl <url>`：指向 autorouter 实例的 URL（会自动升级为 wsEndpoint）
- `--wsEndpoint <url>`：直接指定 WebSocket 端点（跳过升级逻辑）
- 其他参数透传给 `chrome-devtools-mcp`

## 与 autorouter-cli 配合

```bash
# 先用 CLI 获取 ws 地址
WS=$(autorouter-cli get-ws dev)

# 方式 1：直接传 wsEndpoint
chrome-devtools-mcp --wsEndpoint=$WS

# 方式 2：用 autorouter-mcp 自动升级
autorouter-mcp --browserUrl http://localhost:3100/instances/dev
```

## MCP 配置示例（claude_desktop_config.json）

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["chrome-devtools-mcp-autorouter", "--browserUrl", "http://localhost:3100/instances/dev"]
    }
  }
}
```
