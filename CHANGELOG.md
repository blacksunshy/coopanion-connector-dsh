# 更新说明

## 0.2.11 — 已发布（GitHub Release）

### 会话列表与「解除固定」真正生效（配合桌宠 0.6.11）

DSH 只在真的有活动（`agent/created`、`session/event`）时才告诉插件，**只切 tab 不说话时一条事件都没有**。所以"自动跟随当前会话"猜不出来，必须让桌宠能主动问、主动选：

- 新增 `list-sessions` 帧（回 `session-list`）：给出全部 live 会话的 `id / cwd / model / owner / pinned / subagent`，桌宠据此渲染会话选择器
- 新增 `unpin` 帧（回 `unpinned`）：调用 `AgentRegistry.clearPin()`，把 owner 交还给 auto-follow。此前桌宠的「解除固定」只清自己那份状态，Host 的 pin 还在，于是 DSH 仍把消息送进"已经放开"的会话
- 新增 `GET /coopanion/sessions` 与 `POST /coopanion/owner`（body `{id, pin?}`），便于调试和外部调用
- 协议版本仍为 1：只增加帧类型，旧版桌宠会忽略不认识的帧

### 清理

- 删除 0.2.9 排查"桌宠连上但收不到话"时加的临时调试写盘（`[coopanion-debug]` 行不再写入 `coopanion-bridge.jsonl`）。插件加载探针保留，用于确认当前进程加载的是哪份构建

### 与桌宠侧的配对

桌宠侧请用 `cortico-world-fatfish` **≥ 0.6.11**。低于 0.6.11 的桌宠没有会话选择器，而且会把 `session-list` 帧当成未知帧丢掉 → 面板显示"DSH 没有打开的会话"。

## 0.2.10 — 已发布（GitHub Release）

**补记**（发版时漏写这一段）：

- 自动转发（auto-forward）恢复默认开；用户手动关掉的开关写入 `coopanion-forward.json`，插件重启不丢。修复升级后"桥明明连着、桌宠的话却递不进 DSH"
- 与桌宠 0.6.9 / 0.6.10 配对

## 0.2.9 — 已发布（GitHub Release）

### ⚠️ 安全修复（issue #6）—— **CSWSH 跨站 WebSocket 劫持**

WebSocket upgrade guard 只校验了 `Host` 头，**完全没有校验 `Origin`**。

**攻击路径**：任意网页可以静默 `new WebSocket("ws://127.0.0.1:<port>/coopanion/pet")` → 握手通过（Host 是回环 ✔）→ 发 `{t:"hello"}` 读出 DSH 会话事实 → 发 `{t:"say"}` 注入台词，冒充桌宠。典型的 Cross-Site WebSocket Hijack。

**修复**：`allowed()` 函数拒绝一切带 `Origin` 头的 WS upgrade。浏览器发 WS 必带 Origin，原生 Node `ws` 客户端（桌宠 fatfish）不带，所以真实连接不受影响、攻击路径被封死。这是纵深防御的第一道，后续计划在 hello 阶段加 token 校验作为第二道。

### 默认关闭加固

- **后台自动更新检查**：之前每 30 分钟跑一次，现在默认关闭，设 `AUTO_UPDATE_CHECK=1` 才启用。手动检查（POST `/coopanion/check-update`）和 `/coopanion/update` 页面不受影响。
- **auto-forward**：自 v0.2.7 起就默认关（诚实认识论：基础设施不替模型说话）。

### 保持默认开启（以及为什么）

- **auto-follow owner 切换**：跟踪用户当前活跃的会话。只改变量指针，不干涉模型。原则：状态变化自己会宣告。
- **reply / tool / approval 通知**：DSH 的事实，桌宠应该能听到。不是第二张嘴。

### 与桌宠侧的配对

桌宠侧 `cortico-world-fatfish` 同步发布了 **v0.6.6**：把「转发人物的话」(`relayPerson`) 也改成默认关闭。**两边都建议升到最新版**，安全加固一起生效。

## 0.2.8 — 已发布（GitHub Release）

- 加 `DEBUG_BRIDGE=1` 调试日志（为 issue #5 排查"桌宠连上但 Host 始终无会话"）。日志 tag 清单：`apply-done`、`agent-created`、`agent-created-skipped`（含 rawPayload）、`session-disposed`、`session-event`、`welcome-ok`、`welcome-null`、`say-refused-no-owner`、`auto-follow-check`、`auto-follow-moved`。运行：`set DEBUG_BRIDGE=1 && dsh web` 或桌面端启动前设环境变量
- 没改协议、没改默认值，纯调试版本

## 0.2.7 — 已发布（GitHub Release）

- auto-forward 默认关闭（诚实认识论原则：基础设施不替模型说话）
- forceOwner 成功时清 pinned：切换默认 owner 后桌宠不再被旧 pin 锁死

## 更早的版本

v0.2.0 ~ v0.2.6 的改动已在 GitHub Release 里有记录，这里从用户能稳定记得的 v0.2.7 开始。
