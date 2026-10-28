# 更新说明

## 0.2.11 — 未发布

- **没有打开的会话时，桌宠可以在 DSH 侧开一个新会话**：新 `new` 帧 → Host 用 `sessionController.commands.create` 建会话（落在当前会话所属 Workspace，没有则用最近见过的目录、再退到第一个 Workspace），建好即成为 owner 并回 `created`，桌宠随后收到 `ready` 自动接上
- **已归档的会话不再被当成桌宠的说话对象**：归档只把会话挡在模型调用之外，agent 仍然活着，此前桌宠会"连着"一个已归档会话，话递进去整轮以 `blocked` 结束、没有任何回复。现在 owner 只在未归档的活跃会话里选，全都归档了就等于没有会话，拒绝文案指向 `dsh_new_session`
- `say` 在没有 owner 时的拒绝文案带上 `dsh_new_session` 提示，桌宠模型能自己补齐这一步
- 建会话成功但挂到 Workspace 失败时仍回 `created`（会话确实存在并已绑定），不再报"新建失败"让桌宠去找一个已经存在的会话
- 与桌宠侧配对：`cortico-world-fatfish ≥ 0.6.11`（`dsh_new_session` 工具与「新建会话」按钮）
- 桥接日志改为按平台落盘：macOS 写 `~/.dsh/logs/coopanion-bridge.jsonl`，Windows 保持原来两处；此前在 macOS 上会生成名为 `\.dsh\logs\coopanion-bridge.jsonl` 的怪文件
- 本地定制保留：桥接行仍写作 `<本机名>说：…`（macOS `麦麦`、Windows `墨墨`，可用 `COOPANION_HOST_NAME` 覆盖），`/coopanion/status` 带 `speaker`

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
