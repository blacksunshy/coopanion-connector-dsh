# coopanion-connector-dsh

DeepSeek Harness（DSH）bundle 插件：Coopanion 桌宠桥接的 Host 半区。它在 DSH 已有的 web 服务器上挂一个回环 WebSocket，桌宠连上来获知 DSH 正在做什么；你说的话也走同一条线路，被提交进拥有该桌宠的那段对话。

另一半（桌宠侧）是独立仓库的 [`cortico-world-fatfish`](https://github.com/blacksunshy/coopanion-fatfish) 扩展，两个包分开装、分开演进。

## 工作方式

| 方向 | 帧 |
|---|---|
| Host → 桌宠 | `ready`、`turn-start`、`turn-end`、`reply`、`tool`、`approval`、`question`、`question-end`、`error`、`created`、`session-list`、`unpinned` |
| 桌宠 → Host | `hello`、`say`、`pick`、`list-sessions`、`unpin`、`new`、`ping`；Host 对 `say` 回 `accepted` 或 `refused`，对 `new` 回 `created` 或 `refused` |

- 没有桌宠在线时通知直接丢弃、不排队：DSH 的活不等桌宠，重放的回合只会在你已经在控制台读完之后才冒泡。`say` 有回执，桌宠能如实报告"没转交"而不是猜。
- 文本里已带本 Host 前缀（`…（通过桌宠）说：`）的 `say` 会被拒收：再提交一次就会套两层前缀。
- `tool` 通知只带工具名和参数名、不带值：到达桌宠的东西会进模型的上下文和事件流，秘密收不回来。
- 接收没有指明会话的 `say` 的是"最新的、非子代理的活跃 agent"——回答气泡的子代理是你没打开过的说话人。
- 已归档的会话不算"打开的会话"：归档只挡住模型调用，agent 还在，所以 owner 只在未归档的活跃会话里挑；桌宠不会把一个已归档会话当成说话对象。

### 发错会话是怎么发生的，以及现在的约束

DSH **没有"当前聚焦会话"这个信号**：只是切标签页、不说话，一条 `session/event` 都不会发出（这也是桌宠侧 0.6.11 的老注释）。于是"接收 `say` 的会话"只能是 Host 这一侧根据它收到过的事件**猜**出来的 newest-owner，一个可能几小时没变过的推测。桌宠如果照着本地记住的目标发，迟早会把一句话丢进 DSH 最后碰过的那个会话——这就是发错会话。

所以现在的做法是把目标**显式化**，并且在**说话那一刻**校验，而不是在"瞄准那一刻"校验：

- 桌宠的 `say` 可以带 `session`（目标会话 id）。带了就照办：Host 每次 `say` 都重新读一遍实时列表，目标不在列表里（已归档、已销毁、是子代理）就**拒收**并附上当前列表，**绝不**悄悄回退到 owner。
- 不带 `session` 的老桌宠不受影响，仍然落在 owner 上。
- `accepted` 回执里带 `session`（这句话到底进了哪个会话）和 `sessions`（当时所有打开的会话），桌宠可以把"落点"显示给人看，发错了人自己会发现。
- `refused` 回执里带 `code`（`stale-session` / `no-session` / `forwarding-off` / `cannot-deliver` / `host-error` / `empty` / `nested-prefix`）和同一份 `sessions`，桌宠据此决定下一步：`stale-session` → 从列表里重选；`no-session` → `new`。
- `ready` 和每次会话开关时 push 的 `session-list` 都带完整列表，所以桌宠**一开始就知道**有哪些会话可选，不必先问一次。
- 「要不要新建会话」的判断因此有明确依据：**列表里没有任何一个可以指向的会话时，就该 `new`**，而不是发一个指望 fallback 的 `say`。

完整的判断流程写在 `src/protocol.ts` 的 `SayOutcome` 上方注释里，那是两边都要照着实现的契约。

## 安装

前置：Node ≥ 22、DSH 本体；从源码构建时另需 pnpm。

### 桌面端（官方 Electron 客户端）

`dsh plugin` 命令行按设计**不碰 `desktop` profile**：

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以桌面端在**插件市场**里装，来源填本仓库地址：

```
https://github.com/blacksunshy/coopanion-connector-dsh
```

插件市场实际执行的是 `pnpm add https://github.com/blacksunshy/coopanion-connector-dsh`：包取到当前 profile 的 `node_modules` 下（默认 `%USERPROFILE%\.dsh\profiles\desktop`），同时被加进 `dsh.profile.bundles`。这个落点由 DSH 的 profile 决定，不是插件能选的。

**安装期不会执行任何构建脚本**：`dist/index.cjs` 随仓库分发，所以 pnpm 的构建脚本审批（`allowBuilds`）不会介入。遇到这个错误码，说明取到的是带 `prepare` 的早期提交，升级到最新 `main` 再装即可：

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] … needs to execute build scripts but is not in the "allowBuilds" allowlist
```

它给出的 `allowBuilds` 键里带着具体 commit 的 tar.gz 地址（`…/tar.gz/<commit>`），每次提交都会变，所以不是一个能长期沿用的配置。

装完若界面里没有出现，完全退出客户端（含系统托盘）后重新打开。

### Web（`dsh web`）

两种来源任选一种，**别混用**：同一包名先后从两种来源装会并存冲突，换来源前先 `remove`。

| 来源 | 命令 |
|---|---|
| GitHub（推荐，装的是 main 当前状态） | `dsh plugin --profile web add github:blacksunshy/coopanion-connector-dsh` |
| 本地目录（开发用） | `dsh plugin --profile web add link:<克隆目录的绝对路径>` |

**本包只在 GitHub 分发，没有发布到 npm**：registry 里查不到 `coopanion-connector-dsh`，别用 npm 包名安装。

装完重启 `dsh web`，再按 `Ctrl+F5` 刷新浏览器。

从源码构建：

```sh
git clone https://github.com/blacksunshy/coopanion-connector-dsh.git
cd coopanion-connector-dsh
pnpm install
pnpm run build          # 产出 dist/index.cjs
```

`link:` 是软链安装：DSH 直接引用该目录，改完代码重新 `pnpm run build` 并重启 DSH 即可；**装完不能移动或重命名该目录**，移动后要重新 `add` 一次。想改成拷贝安装用 `file:<目录>`，此后源目录的改动不再同步。

### 装完怎么确认

- `GET http://127.0.0.1:<DSH 端口>/coopanion/status` → `{"ok":true,"v":1,"pet":…,"session":…}`
- 桥接日志写在两处（取存在的那个）：`%USERPROFILE%\.dsh\logs\coopanion-bridge.jsonl` 与 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\coopanion-bridge.jsonl`。桌面端通常只有前者存在
- 日志里默认就有带 `"tag"` 的生命周期行，**不需要设环境变量**：`apply-started`（插件已加载）、`routes-registered`（路由已注册，附带监听地址）、`listening-address`（从首个请求的 Host 头拿到的 `host:port`）、`agent-created-skipped`（DSH 发了 `agent/created` 但结构对不上，会带 rawPayload）、`rescan-existing`（启动时扫到的已有会话数）。`Select-String -Path <jsonl> -Pattern '"tag"'` 只看这些信号
- 想看更详细的事件轨迹（每个 `session/event`、auto-follow 等），设 `DEBUG_BRIDGE=1` 再启动 DSH：桌面端要在同一个 PowerShell 里 `$env:DEBUG_BRIDGE="1"` 后从那里启动 `DeepSeek Harness.exe`，否则环境变量传不进去
- **Coopanion 侧还要装 [`cortico-world-fatfish`](https://github.com/blacksunshy/coopanion-fatfish)**，否则桥建起来但没有桌宠来连

### 与桌宠侧的版本配对

| 功能 | 本插件 | 桌宠侧 `cortico-world-fatfish` |
|---|---|---|
| 桥接 / 转交 / 语音触发 | ≥ 0.2.0 | ≥ 0.4.0 |
| 固定会话（桌宠侧「固定到当前会话」、`dsh_pick_session`） | **≥ 0.2.4** | **≥ 0.6.5** |
| 在线自更新（`/coopanion/check-update`、`/coopanion/update`） | ≥ 0.2.4 | 不涉及 |
| **CSWSH 安全修复**（`Origin` 拒绝，issue #6） | **≥ 0.2.9** | 不涉及（但 fatfish 0.6.6 起加了互引提醒） |
| `relayPerson` 默认 `true`（转发人物的话） | 不涉及（Host 侧不替桌宠做默认） | **≥ 0.6.9**（0.6.6 曾改默认关，0.6.9 改回 true——默认关 = 升级后主路径功能消失） |
| 会话选择器（`list-sessions` / `pick`）与「解除固定」（`unpin` / `clearPin`） | **≥ 0.2.11** | **≥ 0.6.11**（0.6.10 及更早会把 `session-list` 帧丢掉 → 面板显示"没有打开的会话"） |
| 没有会话时新建（`new` 帧、桌宠侧 `dsh_new_session` 与面板「新建会话」）；已归档会话不再作为 owner | **≥ 0.2.12** | **≥ 0.6.12** |
| 新建会话可指定工作区（`new.workspace` / `list-workspaces`，`created.workspace` 回执） | **≥ 0.2.14** | **≥ 0.6.14**（旧 Host 静默忽略 `workspace` 时桌宠报「无法确认」而非假装成功） |
| `turn-end` 上报上下文用量（`used` / `size`），桌宠侧用量到 90% 自动新建会话并交接 | **≥ 0.2.18** | **≥ 0.6.19**（Host 不报用量时回退 400 轮兜底，每会话最多交接一次） |
| **发错会话修复**：`say` 可带目标 `session`；每次 `say` 重新校验实时列表并对失效目标拒收（不回退到 owner）；`accepted` / `refused` 带 `session` + `sessions` + `code`；`ready` 与会话开关时 push 完整列表；`list-sessions` 顶层带 `owner` | **≥ 0.2.20** | **≥ 0.6.22**（旧桌宠不带 `session` 时 Host 保持旧的 owner 行为，所以**只升 Host 不会坏**；但要真正修掉发错会话，桌宠也必须升） |
| **自动跟随只认人的动作**：`assistant/message`、`turn/start`、`turn/end`、`tool/call` 不再抢走归属，只有 `user/message` 与 `approval/decided` 会 | **≥ 0.2.21** | **≥ 0.6.23**（桌宠侧同时把「你就指着这里」与「默认送到这里」拆成两个标记） |
| **会话清单带标题**：`SessionSummary.title` 可选项，`listSessions()` 折 `session/title` 事件并缓存；`session/title` 到达时 push `session-list` | **≥ 0.2.22** | **≥ 0.6.24**（旧桌宠忽略该字段照常工作；没有它桌宠只能凭 id 与目录猜） |

桌宠侧的扩展市场说明与 CHANGELOG 写的是同一组版本要求，两边要一起改，改一边算漏项。

> ⚠️ **安全建议**：如果你同时在用桌宠侧 fatfish 扩展，请把两边都升到上表最新列——**本插件 v0.2.9 修复了 CSWSH 安全漏洞**（任意网页可构造 WS 升级劫持桥接）。fatfish 侧 `relayPerson` 0.6.6 曾改成默认关（升级后打字不自动转 DSH），0.6.9 已改回 `true`，`relayPet`（桌宠→DSH，容易形成两嘴互聊循环）仍默认关。
>
> **0.2.11 起**还提供了会话列表与"解除固定"：DSH 只切 tab 不说话时不发任何事件，插件猜不到你在看哪个会话，所以由桌宠主动拉列表、显式选择；「解除固定」也会真正清掉 Host 侧 pin（0.2.10 及更早只改桌宠本地状态）。
>
> **0.2.12 起**桌宠可以在没有打开的会话时让 DSH 新建一个（PR #7，致谢 @ink1453），并且升级路由带自愈：DSH 桌面端热重载导致 `/coopanion/pet` 被陈旧实例占用时，本实例会接管并每 5s 自检重认领。
>
> **0.2.20 起**修掉"桌宠把消息发错会话"：DSH 只在真有活动时才发事件，静默切标签页一条都不会来，所以 Host 猜的 owner 随时可能是陈的。现在桌宠可以在 `say` 里带上目标会话 id，Host 每次说话前重新核对实时列表——目标没了就拒收并回传列表，**不再**悄悄改投 owner；回执里也带"这句话进了哪个会话"，发错了看得见。
>
> **0.2.21 起**自动跟随只认人的动作：只有人在某个会话里`user/message`或给出`approval/decided`，归属才会跟过去。此前模型自己跑（`assistant/message`、工具调用、回合起止）也算"有活动"，于是桌宠刚固定好的会话会被模型在别处的输出抢走，pin 一并清掉——那正是"发错会话"在指名投递之外的残留路径。
>
> **0.2.22 起**清单里带会话标题：`SessionSummary` 多了可选 `title`，取自会话日志里最后一条 `session/title`（标题不在 `SessionHeader` 里）。有了标题，桌宠才分得清「修桌宠发错会话的」和「整理鱼语料的那份」——只给 id 和目录时它只能猜，猜就是发错的起点。还没起名的会话给空串，桌宠显示「（还没起名）」。只追加字段，`PROTOCOL_VERSION` 仍是 1。

### 发布到 npm 的要点

- **产物必须是 CommonJS（`.cjs`）**。DSH 经自己的模块表加载 profile 插件，没有 `"type"` 字段的包按 CommonJS 解析——ESM 产物会在 `apply` 跑起来之前静默失败：bundle 在列表里、文件 require 不出来、路由不出现、也没有报错。`.cjs` 两个方向都明确。
- **`ws` 不打进包里**。构建把 Node 内置模块和 `ws` 留作 external，`ws` 由 profile 的依赖树提供（pnpm 会 hoist 到插件旁边）。
- **`cordis.patch.yml` 是挂载声明，不能删**。`package.json` 的 `dsh.bundle.patch` 指着它，DSH 按它把桥接路由插进 profile 的配置树；DSH 安装插件时按 `package.json` 的 `name` 解析构建产物 `dist/index.cjs`。
- `dist/` 不入库（`.gitignore`），发布时由 `prepublishOnly` 自动重建。

### 排查

- 桌宠连接地址默认 `ws://127.0.0.1:19387/coopanion/pet`，端口跟随 `dsh web` 或桌面应用实际监听的那个。桌宠连不上时先核这里，再核 Coopanion 侧 fatfish 扩展配置里填的地址是否一致。

## 协议与两边同步

`src/protocol.ts` 声明两个方向的帧。修订号 `PROTOCOL_VERSION`（当前 `1`）随 `ready` 和桌宠的 `hello` 发送，任一侧不匹配就断开。**Coopanion 侧的 `cortico-world-fatfish` 存着同一份字面量的拷贝**——两个包分开发货，一边改了版本号或帧名，另一边必须跟，否则握手被拒或字段丢失。

## Coopanion 侧要装什么

桌宠侧装 `cortico-world-fatfish` 扩展（Coopanion 控制台的扩展页），它把桌宠接到本插件暴露的 WebSocket 上。只有本插件、没有 fatfish 扩展，桥会建起来但没有桌宠来连；反之亦然。

## 开发

```sh
pnpm test        # vitest：pet-hub.test.ts 起真实 ws 服务、protocol.test.ts 覆盖帧拒收与归属规则
pnpm run typecheck
pnpm run build
```

`tests/pet-hub.test.ts` 在回环端口上跑真实的 `ws` 服务器：被测的协商过程就是插件依赖的那个过程。

## License

AGPL-3.0-or-later
