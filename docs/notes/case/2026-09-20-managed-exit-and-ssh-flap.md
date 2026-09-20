# 案例：managed 双实例同时退出 + 远端 CLI fetch failed（2026-09-20）

> 本文已脱敏：主机名、用户名、内网地址、业务目录均以占位符代替。

## 拓扑

```
Linux (<remote-host>)
  agent-browser / cdp-autorouter-cli → 127.0.0.1:9223（SSH RemoteForward，随交互会话存活）
    → Windows cdp-autorouter-server（全局安装，符号链接到开发仓库）
      → managed Chrome 实例（aiui-polish / default）
```

## 症状

- `curl http://127.0.0.1:9223/health` 有响应（route-not-found JSON）→ 转发与 HTTP 服务活着。
- `cli list`：aiui-polish=unhealthy、default=error。
- `cli get-ws aiui-polish` / `cli down` / `cli up` → `Error: fetch failed`。

## 根因（两个独立问题叠加）

1. **两个 managed 浏览器同时退出**：server 日志同一秒两条 `instance:exit code=0`。
   code=0 且同时退出 = 被正常关闭（有头窗口被关/会话事件），非崩溃。实例注册表进入 error/unhealthy 属预期标记。
   **放大因素**：实例以 `chrome.exe headless:false`（有头）拉起，桌面可见窗口天然暴露给误关。
2. **CLI 的 `fetch failed` 来自 SSH 转发瞬断，不是 server 半死**：
   - 远端 CLI 日志：`down`/`up` 在 3~9ms 内失败，且 **server 日志中无对应请求记录** → TCP 层被拒（转发窗口期）。
   - 同期 `list`/`get-ws` 能到达 server 并获得响应 → autorouter HTTP 服务全程健康。
   - `get-ws` 的 exit 1 是请求到达后 server 返回的可诊断错误（实例已死），与 `fetch failed` 是两类失败。

## 恢复动作（人工）

- server 本机 `POST /api/instances/{id}/stop` → `start`：两实例恢复 healthy。
- 无孤儿进程（恢复前按命令行过滤查询确认）。

## 暴露的短板与对策

| 短板 | 对策 | 状态 |
|------|------|------|
| 显式实例无自愈，只能靠人工 up | server 端低频巡检 + managed 自动恢复（HealthMonitor） | 本次实现 |
| `unhealthy` 是请求时懒标记，无主动探测 | 巡检 tick 内 refresh 所有实例 | 本次实现 |
| 有头 chrome.exe 易被误关 | ~~managed 实例切 chrome-headless-shell~~ **已回滚**：用户拍板保持有头；误关后的恢复由请求路径即时自愈 + 巡检兜底，不靠 headless 规避 | 已回滚 |
| CLI `fetch failed` 混淆 TCP 层失败与实例错误 | CLI 错误分流（ECONNREFUSED 提示检查转发） | 未做，backlog |
| server 异常退出时 managed 浏览器变孤儿 | uncaughtException/unhandledRejection 回收钩子 | 未做，roadmap 已有 |

## 取证索引

- server 操作日志：`data/logs/server-operations.log`（`instance:exit` / `instance:self-heal` / `instance:spawn` 对账）。
- 远端 CLI 日志：`<remote-host>:<repo>/data/logs/cli-operations.log`。
- 判别口诀：**请求没出现在 server 日志 = 转发层问题；出现在日志但报错 = 实例层问题**。
