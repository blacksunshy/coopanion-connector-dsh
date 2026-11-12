# 更新说明

## 0.2.22 — 未发布

- **新增：会话清单里带会话标题**（由桌宠侧提出：只给 id 和目录，桌宠认不出哪条是"修 bug 的那个"、哪条是"聊另一个仓库的那个"，只能猜；猜就是发错的起点）。`SessionSummary` 增加可选字段 `title`，`listSessions()` 每行都带它：
  - 标题不在 `SessionHeader` 里——DSH 把标题写成日志里的一条 `session/title` 事件（第一条用户消息之后追加），所以这里折一遍日志取最后一条，与 DSH 自己的 `foldSessionTitle` 等价
  - 折叠结果按 session 缓存，之后由 `session/event` 的 `session/title` 分支增量更新（`rememberTitle`），不会每问一次清单就把长会话扫一遍
  - 还没起名的会话给空串，桌宠据此知道"这条还没名字"，而不是"不认识它"
  - `session/title` 到达时顺带 push 一帧 `session-list`：名字变了就是菜单变了，桌宠不必等下次自己问
- 只**追加**字段，旧桌宠忽略它照常工作；`PROTOCOL_VERSION` 仍是 1
- 测试：`tsc --noEmit` 通过；`vitest` **109 passed**（新增 5 条：带标题、未起名为空、改名取最后一条、增量更新不重复折叠、agent 无法提供日志时安全退化）；`node scripts/smoke.mjs` 全通过；`dist/index.cjs` 已重建

## 0.2.21 — 未发布

- **修复：模型自己的输出会抢走归属，把刚固定好的会话冲掉**（0.2.20 装机实测发现）。自动跟随此前只要看到"这个会话里有活动"就把 owner 挪过去，而 `assistant/message`、`turn/start`、`turn/end`、`tool/call` 全算活动——于是桌宠刚 `pick` 到 A，模型在 B 里继续回几条，owner 就被抢回 B 并连带清掉 pin：`dsh_sessions` 的「默认送到这里」标错、下一句话跟着发错，正是 0.2.20 想修掉的那个毛病的残留路径。现在只有**人**的动作才触发跟随：
  - `user/message`（人真的在那里打字/说话）
  - `approval/decided`（人给出的批准结论；`approval/asked` 只是系统在问，不算）
  - 模型在哪干活不等于人在哪看——这条界线由 `src/session-watch.ts` 的 `isPersonActionEvent` 一处守住，`isActiveSessionEvent` 随之移除
  - `forceOwner` 的语义不变：判定「人此刻在别处说话」时仍清掉旧 pin，因为那比一个几小时前的固定更强；变的只是谁能进这道门
- 桌宠侧配套：`cortico-world-fatfish` ≥ 0.6.23 把 `dsh_sessions` 的标记拆成「你就指着这里」（桌宠自己的固定）与「默认送到这里」（Host 的 owner），两者分开显示——否则人在别处说话后，桌宠会把 Host 的落点当成自己的目标
- 测试：`tsc --noEmit` 通过；`vitest` **104 passed**（新增「模型自己的输出不算人的动作」：`assistant/message` / `turn/start` / `turn/end` / `tool/call` / `approval/asked` 全部为否，`user/message` 与 `approval/decided` 为是）；`node scripts/smoke.mjs` 7 组端到端场景全通过；`dist/index.cjs` 已重建

## 0.2.20 — 未发布

- **修复"桌宠把消息发错会话"**：根因不在桌宠乱发，而在**两边都只能猜**。DSH 没有"当前聚焦会话"这个信号——在 DSH 里只是切标签页、不说话，一条 `session/event` 都不会发出（fatfish 0.6.11 的注释也记着同一件事）。于是 Host 只能把 `say` 投给它根据历史事件挑出的 newest-owner，那是个可能几小时没更新过的推测；桌宠按本地记住的目标发，两边一旦不同步，话就落进了 DSH 最后碰过的那个会话。这次把目标**显式化**，并在**说话那一刻**校验，而不是在瞄准那一刻：
  - **`say` 可带 `session`（目标会话 id）**：带了就照办。Host 每次 `say` 都重新读实时列表，目标不在其中（已归档 / 已销毁 / 是子代理）就回 `refused` + `code: 'stale-session'` + 当前完整列表，**绝不悄悄回退到 owner**——静默改投正是发错会话的机制。不带 `session` 的旧桌宠行为完全不变（仍落 owner），所以**只升 Host 不会坏**
  - **`accepted` 回执带落点**：`session`（这句话进了哪个会话）+ `sessions`（当时所有打开的会话）+ `pinned`。桌宠可以把落点显示给人看，发错了当场看得见，而不是靠事后翻会话
  - **`refused` 带机器可读的 `code`**：`empty` / `nested-prefix` / `forwarding-off` / `no-session` / `stale-session` / `cannot-deliver` / `host-error`。桌宠不用解析英文句子就能决定下一步：`stale-session` → 从回执的列表里重选；`no-session` → `new`
  - **`ready` 与会话开关时 push 完整列表**：`ready` 现在带 `sessions` / `pinned`，并且 `agent/created` 与 `session/disposed` 都会主动 push 一帧 `session-list`（带顶层 `owner`）。桌宠**一连上就知道**有哪些会话可选，不必先问一次；会话开了或关了，菜单也会自己更新——"发之前先确认会话列表"因此不再是一次额外往返
  - **`list-sessions` 回帧顶层带 `owner`**：目标 `say` 会落进哪个会话，一眼可见，不用在数组里找 `owner: true`
  - **Host 异常也会回执**：`say` 抛错时不再让桌宠干等满超时，而是回 `refused` 并说明原因
- **「要不要新建会话」有了明确依据**：列表里没有任何一个可以指向的会话时（`no-session`，或列表为空）就该 `new`，而不是发一个指望 fallback 的 `say`。完整判断流程写在 `src/protocol.ts` 的 `SayOutcome` 上方注释里，是两边都要照着实现的契约
- **去掉了两帧死代码**：`say` 成功/失败时发的 `notice`（`kind: 'forwarded'` / `forward-failed'`）桌宠侧从来没解析过（`parseHostFrame` 没有 `notice` 分支），落点信息现在由 `accepted` 回执承担，比多推一帧更靠得住
- 兼容性：协议只做**追加**，`PROTOCOL_VERSION` 仍是 1；所有新字段可选，旧桌宠忽略它们照常工作
- 桌宠侧对应改动：`cortico-world-fatfish` ≥ 0.6.22（`say` 带目标、发前核对列表、按 `code` 决定 `new`/重选/停止）。只升本插件不会坏，但要真正修掉发错会话，两边都要升
- 测试：`tsc --noEmit` 通过；`vitest` **103 passed**（新增 13 项，涵盖"按名字投递而不是投给 owner"、"目标没了就拒收且不投递"、"无目标时仍投 owner"、"无会话时拒收并回空列表"、"首个 `ready` 带全量列表"、"会话开关 push 列表"、"`list-sessions` 顶层 owner"、Host 抛错仍回执）；`node scripts/smoke.mjs` 对**构建产物**跑 7 组端到端场景全通过；`dist/index.cjs` 已重建

## 0.2.19 — 已发布（GitHub Release）

- **新建会话不再无限等待**：`createConversation` 对 `sessionController.commands.create` 加了 8 秒上限。此前这个调用没有任何超时，若 DSH 把新建排在正在跑的回合之后、或该版本命令形状变了而永不 resolve，插件就一直不回帧，桌宠干等 20 秒只能报「DSH did not answer in time」（讨论 [#19](https://github.com/Pal-AI-Lab/cortico-extensions/discussions/19) 里 YuYinDaJiang 的「开新会话接口超时」）。现在 8 秒即带原因失败，桌宠能把原因念出来，自动交接也不会被卡死
- **失败原因写进 Host 日志**：新建失败时除了回 `refused` 帧，还在 Host 日志里记一条 `could not create a conversation: <原因>`，排查不用靠桌宠转述
- **列会话超时在桌宠侧修正（需 fatfish ≥ 0.6.21）**：Host 不支持 `list-sessions` 时回的是 `error` 帧，旧桌宠只认 `session-list`，于是白等满超时；新桌宠把 `error` 当答案立即返回并记下 Host 原话
- 测试：`tsc --noEmit` 通过，`vitest` 89 passed / 1 skipped（新增「create 永不返回时 8 秒放弃并给出原因」）；`dist/index.cjs` 已重建并提交

## 0.2.18 — 已发布（GitHub Release）

- **`turn-end` 带上上下文用量（used / size），供桌宠在接近满上下文时自动交接（PR [#16](https://github.com/blacksunshy/coopanion-connector-dsh/pull/16)，致谢 @yuwanyou）**：DSH 能报时，`turn-end` 帧多两个可选字段 `used` / `size`（已用量 / 上下文窗口）；桌宠（fatfish ≥ 0.6.19）在用量到 90% 时自动切到新会话。读不到时这两个字段缺失，桌宠回退到 400 轮兜底。读取用 try/catch + 类型检查全兜底，`tokenMeter` / `requestContext` 不存在也不会崩
- **修复 issue [#17](https://github.com/blacksunshy/coopanion-connector-dsh/issues/17)：Windows 上桌宠连接/重连期间 DSH 宿主进程 `exit(1)`**：根因在 `dsh-host-webserver` 的 socket 生命周期——`close` 先摘掉 `error` 监听，随后投递的 `ECONNRESET` 没人接，冒泡成未捕获异常被 `dsh-app-boot` 当致命错误退出。本仓加兜底：`process.setUncaughtExceptionCaptureCallback` 接管，`ECONNRESET` / `EPIPE` / `ECONNABORTED` / `ERR_STREAM_PREMATURE_CLOSE` 这类 socket 错误打 warn 不退出，其它异常原样 re-throw（仍带原始堆栈崩溃）。根因仍需 DSH 主仓修，这里只是避免每一次重连都拉挂宿主
- 测试：`tsc --noEmit` 通过，`vitest` 88 passed / 1 skipped；产物已重建并提交

## 0.2.17 — 已发布（GitHub Release）

- **修复 issue [#13](https://github.com/blacksunshy/coopanion-connector-dsh/issues/13)：DSH 0.2.1-rc.5 上发现不到已经打开的会话**：新版本的 `sessionController.agents` 是 `ApiSessionAgentController` 实例（不是 Map、也不是数组），唯一入口 `resolveAgent(sessionId)` 返回 **Promise**，而启动补扫原本全是同步探测，于是日志停在 `rescan-existing { sessionIds: 2, registered: 0 }`，桌宠收不到 `ready`。补扫增加异步探测分支（`await agents.resolveAgent(id)`，兼容 `{ agent }` 与直接返回 agent 两种形状），并在桌宠 `hello` 时若仍无 owner 再补扫一次；扫到 owner 立刻 `notifyBound`，桌宠不需要重连
- **选择框提醒的数据通路（PR [#14](https://github.com/blacksunshy/coopanion-connector-dsh/pull/14)，致谢 @ink1453）**：用户在选择框里点选时，桌宠可以只念一句固定短句、不叫醒桌面 AI。为此：`ask_user_question` 一开始调用就发 `question` 帧（`text` = 第一道题的题面，`callId` = 这次调用的 id），结果回来（选中/取消/超时）再发 `question-end` 帧（带同一个 `callId`）。此前 `question` 帧只在协议里声明过，Host 从没发过；`turn-end` 时若问句还开着也会补一次 `question-end`，避免提醒一直响
- 帧是**追加**的：旧桌宠忽略未知的 `question-end`，`question` 仍按原来的通知路径走，行为不变；新桌宠（`cortico-world-fatfish` ≥ 0.6.17）可用它做「请选择」提醒
- 测试：新增 `resolveAgent` 异步路径（含 `{ agent }` 包装与直接返回两种形状）、`question` / `question-end` 帧（含 `turn-end` 兜底）、`questionTextOf` 边界；`tsc --noEmit` 通过，`vitest` 88 passed / 1 skipped

## 0.2.16 — 修复：发布包里的 `dist` 是旧构建（[#11](https://github.com/blacksunshy/coopanion-connector-dsh/issues/11) / [#12](https://github.com/blacksunshy/coopanion-connector-dsh/issues/12)）

0.2.14 修了 `apply()` 开头「未 inject 就访问 `root.webServer`」导致的崩溃（issue #9），但那次**只推了源码，没有重新构建并提交 `dist/index.cjs`**；0.2.15 又沿用了同一份旧产物。结果是 0.2.14 与 0.2.15 从 GitHub 安装后一启用就在 `apply()` 第一行抛 `cannot get property "webServer" without inject`，所有路由都没注册、`/coopanion/status` 返回 404。issue #11（dsh web）与 #12（桌面端）是同一根因的两种表现。

- **重新构建并提交 `dist/index.cjs`**：产物与源码 `src/plugin.ts` 的 `Boolean(root.get('webServer'))` 同步，从 `github:blacksunshy/coopanion-connector-dsh` 安装后可直接启用
- 已核对产物中不再出现 `Boolean(root.webServer)`；`node scripts/build.mjs` 重建后字节一致（`pnpm run typecheck` 通过、`vitest` 81 passed / 1 skipped）
- 无功能、协议与桌宠侧契约改动：fatfish 侧原有的会话能力（≥ 0.2.12 新建会话、≥ 0.2.14 指定工作区）行为不变
- **临时绕过**（暂时不便升级时）：把安装目录 `dist/index.cjs` 里 `logLine("apply-started", { hasWebServer: Boolean(root.webServer) })` 改成 `Boolean(root.get("webServer"))`，重启 DSH 即可
- 后续防回归（已落地）：`pnpm run verify:dist`（即 `node scripts/build.mjs --check`）把源码重新打一遍并与仓库里的 `dist/index.cjs` 逐字节比对，不一致就失败；构建时还会断言产物里没有裸 `root.webServer` 这类越权访问。`prepublishOnly` 也改成了这条校验

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
