# 浏览器操作（cdp-autorouter 9223）

## 架构

```
[agent-browser / AI CLI]  ──CDP──▶  [autorouter :9223]  ──CDP──▶  [远端 headed Chrome]
```

- **9223 端口**：cdp-autorouter 代理层，SSH 转发到远端 Windows
- **远端 Chrome**：headed 模式，GUI 可见
- autorouter 支持多实例，每个实例对应一个独立 Chrome 进程

---

## 前置：一次性全局连接（默认做法）

```bash
# 把 9223 写入 ~/.autorouter（--global）：此后任意目录下的 cdp-autorouter-cli
# 都能自动发现端口，免去每条命令带 --port。
# ⚠️ 不做这步的后果：CLI 内置默认 3100 ≠ 本环境 9223，所有命令直接连错端口。
cdp-autorouter-cli connect 9223 --global
```

端口发现优先级：`--port` > `AUTOROUTER_URL` env > `./.autorouter`（cwd 向上查找） > `~/.autorouter` > 默认 3100。

---

## 两种连接方式（二选一，不混用）

### 方式 A：default 实例快捷模式

适用：只有一个实例，或你明确只操作 default 实例。

```bash
agent-browser connect 9223
agent-browser tab list
agent-browser navigate "http://..."
agent-browser snapshot -i
agent-browser screenshot
```

`connect 9223` 建立持久会话，后续命令复用该连接，始终操作 default 实例。

### 方式 B：指定实例模式（多实例场景）

适用：存在多个实例，需要精确控制操作哪个。

```bash
# 先查看有哪些实例
cdp-autorouter-cli list

# 直连指定实例（每条命令独立，无副作用）
agent-browser --cdp $(cdp-autorouter-cli get-ws <实例ID>) tab list
agent-browser --cdp $(cdp-autorouter-cli get-ws <实例ID>) navigate "http://..."
agent-browser --cdp $(cdp-autorouter-cli get-ws <实例ID>) snapshot -i
```

`--cdp` 模式不依赖 default 指向，不改变任何全局状态。

### ⚠️ 不要混用

选定一种方式后保持一致。不要用 `switch` 在两种模式间切换。

---

## ⚠️ switch 的正确理解

```bash
cdp-autorouter-cli switch <id>
```

**用途**：一次性设定 autorouter 的全局 default 指向（决定方式 A 连到哪个实例）。

**合理场景**：管理员决定"哪个实例是主力"，设定后不再频繁改动。

**禁止用法**：把 switch 当临时切换来回用。

```bash
# ❌ 切过去操作一下再切回来——这会搞乱全局状态
cdp-autorouter-cli switch e2e-1
agent-browser connect 9223
# ...操作...
cdp-autorouter-cli switch default   # default 可能已被 self-heal 重启，页面丢了
```

要临时操作非 default 实例，直接用方式 B：

```bash
# ✅ 不动全局状态，直连目标
agent-browser --cdp $(cdp-autorouter-cli get-ws e2e-1) tab list
```

---

## 常用操作

```bash
# 查看实例列表
cdp-autorouter-cli list

# 获取指定实例的 ws 地址（可直接喂给 --cdp）
cdp-autorouter-cli get-ws <id>
cdp-autorouter-cli get-ws          # 省略 id = 获取 default 实例

# 在指定实例上操作
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) tab list
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) navigate "http://target.com"
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) snapshot -i
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) screenshot
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) click @e3
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) fill @e1 "text"
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) eval "document.title"
```

### Tab 管理

```bash
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) tab list
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) tab t2      # 切到 t2
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) tab new [url]
agent-browser --cdp $(cdp-autorouter-cli get-ws myinst) tab close
```

---

## 错误写法

```bash
# ❌ --cdp 后面跟端口号（不是 ws URL）
agent-browser --cdp 9223 open https://example.com

# ❌ 会尝试启动本地 Chrome，远端无 X server 必失败
agent-browser open --headed https://example.com

# ❌ 用 switch 临时切实例（改全局状态，影响所有方式 A 客户端）
cdp-autorouter-cli switch task1 && agent-browser connect 9223
```

---

## 实例生命周期（按需）

```bash
# 创建新实例
cdp-autorouter-cli create --id task1 --mode managed
cdp-autorouter-cli create --id ext1 --mode attached --browser-url http://10.0.0.5:9222

# 启动 / 停止 / 重启
cdp-autorouter-cli start task1
cdp-autorouter-cli stop task1
cdp-autorouter-cli restart task1

# 删除
cdp-autorouter-cli delete task1
```

---

## 语义区分

| API | 返回内容 |
|-----|----------|
| `cdp-autorouter-cli list` | autorouter 管理的实例列表（每个实例 = 一个 Chrome 进程） |
| `/json/list`（或 `tab list`） | 某个 Chrome 实例内的 page targets（tabs） |

两者不互换。

---

## 冲突避免

- agent-browser 和 chrome-devtools MCP 不可同时操作同一实例
- 多 agent 操作不同实例互不干扰（各自用 `--cdp $(get-ws <各自实例>)`）
