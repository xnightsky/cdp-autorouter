# 浏览器操作（cdp-autorouter 9223）

## 架构

```
[AI CLI / agent-browser]  ──CDP──▶  [autorouter :9223]  ──CDP──▶  [远端 headed Chrome]
```

- **9223 端口**：cdp-autorouter 代理层，SSH 转发到远端
- **远端 Chrome**：headed 模式，GUI 可见（Windows 远程桌面可观察）
- autorouter 透明转发 CDP，不修改消息内容

---

## agent-browser 操作

### 连接

```bash
agent-browser connect 9223
```

### 打开页面（新 tab）

```bash
agent-browser open https://example.com
agent-browser snapshot -i
agent-browser screenshot
```

### ⚠️ 已知行为：open 创建新 tab

`connect` 后 `open` 会在 Chrome 中**新建一个 tab**，不会复用已有 tab。
这是 agent-browser 的标准行为（Playwright `Target.createTarget`）。

如需在已有 tab 中导航：

```bash
agent-browser connect 9223
agent-browser tab list                   # 查看 tab 列表
agent-browser tab t1                     # 切到目标 tab
agent-browser navigate https://target.com  # 在该 tab 内导航
```

### 常用操作

```bash
agent-browser snapshot -i                # 交互元素快照
agent-browser screenshot [path]          # 截图
agent-browser click @e3                  # 点击元素
agent-browser fill @e1 "text"             # 填写输入框
agent-browser tab new [url]              # 新开 tab
agent-browser tab close                  # 关闭当前 tab
agent-browser close --all                # 关闭所有 session
```

### 错误写法

```bash
# ❌ 会尝试启动本地 Chrome，本机无 X server 必失败
agent-browser --cdp 9223 open https://example.com

# ❌ --headed 也是启动本地 Chrome，与远端无关
agent-browser open --headed https://example.com
```

---

## chrome-devtools MCP

MCP 已配置连接 9223 端口，直接使用 DevTools 工具即可。

> ⚠️ **冲突避免**：agent-browser 和 chrome-devtools MCP 不可同时操作同一浏览器实例。

---

## 多实例管理（需要时）

```bash
# 查看实例
cdp-autorouter-cli list

# 创建实例
cdp-autorouter-cli create --id task1 --mode attached --browser-url http://10.0.0.5:9222

# 启动 / 切换默认 / 停止
cdp-autorouter-cli start task1
cdp-autorouter-cli switch task1
cdp-autorouter-cli stop task1

# agent-browser 连接指定实例
agent-browser --cdp $(cdp-autorouter-cli get-ws task1)
```

---

## 语义区分

| API | 返回内容 |
|-----|----------|
| `GET /api/instances` | autorouter 管理的实例列表 |
| `GET /json/list` | 某 Chrome 下的 page targets |

两者不互换。
