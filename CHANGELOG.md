# 更新说明

## 0.2.16 — 修复：发布包里的 `dist` 是旧构建（[#11](https://github.com/blacksunshy/coopanion-connector-dsh/issues/11) / [#12](https://github.com/blacksunshy/coopanion-connector-dsh/issues/12)）

0.2.14 修了 `apply()` 开头「未 inject 就访问 `root.webServer`」导致的崩溃（issue #9），但那次**只推了源码，没有重新构建并提交 `dist/index.cjs`**；0.2.15 又沿用了同一份旧产物。结果是 0.2.14 与 0.2.15 从 GitHub 安装后一启用就在 `apply()` 第一行抛 `cannot get property "webServer" without inject`，所有路由都没注册、`/coopanion/status` 返回 404。issue #11（dsh web）与 #12（桌面端）是同一根因的两种表现。

- **重新构建并提交 `dist/index.cjs`**：产物与源码 `src/plugin.ts` 的 `Boolean(root.get('webServer'))` 同步，从 `github:blacksunshy/coopanion-connector-dsh` 安装后可直接启用
- 已核对产物中不再出现 `Boolean(root.webServer)`；`node scripts/build.mjs` 重建后字节一致（`pnpm run typecheck` 通过、`vitest` 81 passed / 1 skipped）
- 无功能、协议与桌宠侧契约改动：fatfish 侧原有的会话能力（≥ 0.2.12 新建会话、≥ 0.2.14 指定工作区）行为不变
- **临时绕过**（暂时不便升级时）：把安装目录 `dist/index.cjs` 里 `logLine("apply-started", { hasWebServer: Boolean(root.webServer) })` 改成 `Boolean(root.get("webServer"))`，重启 DSH 即可
- 后续防回归：发版前断言产物不含越权访问，或 CI 跑 `pnpm build && git diff --exit-code dist`

## 0.2.15 — 已发布（GitHub Release）

修 issue [#8](https://github.com/blacksunshy/coopanion-connector-dsh/issues/8) 评论里指出的第二个回归（0.2.12 起就有，不是 0.2.14 引入的）：

- **升级路由不再每 5 秒误判"丢失"并重新认领**：桌面端 `registerUpgrade` 存的是 `{ ...route, handler: wrapped }`（副本，不是原对象），而 `holdsUpgrade()` 用对象身份比较，永远不相等 → 每 5 秒 2 条 warn（`went missing` + `took over a stale upgrade route`），一天约 3.5 万行。改为在 route 上带一个本实例独有的 `owner` 标记（副本展开时会被一起复制），按标记判断归属；热重载接管陈旧 handler 的能力保留
- 新增回归测试：模拟宿主存副本的行为，等一个 5s 自检周期后确认没有重复认领
- 与 0.2.14 一并作为 issue #9 / #8 的完整修复；升级自更新会取 `releases/latest`，停在 0.2.13 的用户重启即可收到本版

## 0.2.14 — 已发布（GitHub Release）

修复 + 功能各一：

- **修复 issue [#9](https://github.com/blacksunshy/coopanion-fatfish/issues/9)（桥故障复盘 2026-10-29）**：`apply()` 开头用 `Boolean(root.webServer)` 探测服务——cordis 里未 inject 的服务属性是会抛错的访问器，异常在 try/catch 之外抛出，整个 `apply()` 中止，所有路由（`/coopanion/pet` 升级、`/coopanion/status` 等）都没注册，而 `cordis.patch.yml` 的 `required: false` 让 DSH 安静地跳过它。改为 `root.get('webServer')` 安全读取，并新增 cordis 行为冒烟测试（服务属性抛错时 `apply()` 必须存活）
- **新建会话可指定工作区（PR [#9](https://github.com/blacksunshy/coopanion-connector-dsh/pull/9)，致谢 @allisera）**：`new` 帧接受可选 `workspace`（id 或路径，路径做归一化匹配），匹配不上直接拒回并列出可用路径，绝不静默落到别的工作区；`created` 回执带上实际落点 `workspace`，旧桌宠不受影响；新增 `list-workspaces` 帧返回各工作区 id / 路径 / 打开的会话数 / 是否当前
- 与桌宠侧配对：指定工作区需要 `cortico-world-fatfish ≥ 0.6.14`；旧桌宠 + 新 Host 行为完全不变

## 0.2.13 — 已发布（GitHub Release）

桌面端可诊断性 + 已有会话补扫（针对 issue #5）：

- 生命周期日志默认常开（无需 `DEBUG_BRIDGE`）：`apply-started`、`routes-registered`（附监听地址）、`listening-address`（首个请求的 Host 头）、`agent-created-skipped`（带 rawPayload，直接判断桌面端是否发了结构不对的 `agent/created`）、`rescan-existing`（启动时扫到的已有会话数）
- 启动时探测 `sessionController` / `workspaceRegistry` 枚举已有会话并注册（best-effort，未知结构不报错）：桌面端有时不重发已打开会话的 `agent/created`，此前会导致 `facts()` 一直为 null、桌宠收到 "no conversation is open"
- `inject(['webServer'])` 失败时写 `webserver-missing`，不再只剩一行 prove-load 让用户无从判断
- README 修正日志路径（桌面端通常是 `%USERPROFILE%\.dsh\logs\coopanion-bridge.jsonl`）并补充 `DEBUG_BRIDGE` 桌面端开启方式

## 0.2.12 — 已发布（GitHub Release）

主要内容来自 PR #7，致谢 @ink1453（静墨）。

- **没有打开的会话时，桌宠可以在 DSH 侧开一个新会话**：新 `new` 帧 → Host 用 `sessionController.commands.create` 建会话（落在当前会话所属 Workspace，没有则用最近见过的目录、再退到第一个 Workspace），建好即成为 owner 并回 `created`，桌宠随后收到 `ready` 自动接上
- **已归档的会话不再被当成桌宠的说话对象**：归档只把会话挡在模型调用之外，agent 仍然活着，此前桌宠会"连着"一个已归档会话，话递进去整轮以 `blocked` 结束、没有任何回复。现在 owner 只在未归档的活跃会话里选，全都归档了就等于没有会话，拒绝文案指向 `dsh_new_session`
- `say` 在没有 owner 时的拒绝文案带上 `dsh_new_session` 提示，桌宠模型能自己补齐这一步
- 建会话成功但挂到 Workspace 失败时仍回 `created`（会话确实存在并已绑定），不再报"新建失败"让桌宠去找一个已经存在的会话
- **升级路由自愈**：DSH 桌面端热重载可能让旧实例仍占着 `/coopanion/pet` 升级路由——重复注册抛异常后两边都丢掉它，桌宠的 WS 升级静默死连接。现在本实例会接管陈旧路由，并每 5s 自检一次，丢了就重新认领
- `/coopanion/status` 增加 `bound` / `route` / `pid` 字段，方便排查"连上但没绑定"与路由归属
- 桥接日志改为按平台落盘：macOS 写 `~/.dsh/logs/coopanion-bridge.jsonl`，Windows 保持原来两处；此前在 macOS 上会生成名为 `\.dsh\logs\coopanion-bridge.jsonl` 的怪文件
- 与桌宠侧配对：`cortico-world-fatfish ≥ 0.6.12`（`dsh_new_session` 工具与面板「新建会话」按钮）

注：PR 中的本机名称定制（按平台给桥接行署名麦麦/墨墨、`COOPANION_HOST_NAME` 覆盖、status 的 `speaker` 字段）经与作者确认**未合入**——桥接行保持 `${from}（通过桌宠）说：` 不变。

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
