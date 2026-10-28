# coopanion-connector-dsh

DeepSeek Harness（DSH）bundle 插件：Coopanion 桌宠桥接的 Host 半区。它在 DSH 已有的 web 服务器上挂一个回环 WebSocket，桌宠连上来获知 DSH 正在做什么；你说的话也走同一条线路，被提交进拥有该桌宠的那段对话。

另一半（桌宠侧）是独立仓库的 [`cortico-world-fatfish`](https://github.com/blacksunshy/coopanion-fatfish) 扩展，两个包分开装、分开演进。

## 工作方式

| 方向 | 帧 |
|---|---|
| Host → 桌宠 | `ready`、`turn-start`、`turn-end`、`reply`、`tool`、`approval`、`question`、`error`、`created` |
| 桌宠 → Host | `hello`、`say`、`new`、`ping`；Host 对 `say` 回 `accepted` 或 `refused`，对 `new` 回 `created` 或 `refused` |

- 没有桌宠在线时通知直接丢弃、不排队：DSH 的活不等桌宠，重放的回合只会在你已经在控制台读完之后才冒泡。`say` 有回执，桌宠能如实报告"没转交"而不是猜。
- 文本里已带本 Host 前缀（`…（通过桌宠）说：`）的 `say` 会被拒收：再提交一次就会套两层前缀。
- `tool` 通知只带工具名和参数名、不带值：到达桌宠的东西会进模型的上下文和事件流，秘密收不回来。
- 接收 `say` 的对话是"最新的、非子代理的活跃 agent"——回答气泡的子代理是你没打开过的说话人。
- 没有打开的会话时（例如把所有会话都归档了），`say` 会被拒回，`new` 让桌宠在 DSH 侧开一个新会话：走 `sessionController.commands.create`，落在当前会话所属的 Workspace，建好即成为 owner，桌宠随后收到 `ready`。
- 已归档的会话不算"打开的会话"：归档只挡住模型调用，agent 还在，所以 owner 只在未归档的活跃会话里挑；桌宠不会把一个已归档会话当成说话对象。

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
- `%APPDATA%\@deepseek-ai\dsh-desktop\logs\coopanion-bridge.jsonl` 多写一行，写明加载它的进程——这一行是"插件被加载"的证据；没有它说明没加载上，与"加载了但桌宠没连上"是两回事
- **Coopanion 侧还要装 [`cortico-world-fatfish`](https://github.com/blacksunshy/coopanion-fatfish)**，否则桥建起来但没有桌宠来连

### 与桌宠侧的版本配对

| 功能 | 本插件 | 桌宠侧 `cortico-world-fatfish` |
|---|---|---|
| 桥接 / 转交 / 语音触发 | ≥ 0.2.0 | ≥ 0.4.0 |
| 固定会话（桌宠侧「固定到当前会话」、`dsh_pick_session`） | **≥ 0.2.4** | **≥ 0.6.5** |
| 在线自更新（`/coopanion/check-update`、`/coopanion/update`） | ≥ 0.2.4 | 不涉及 |
| **CSWSH 安全修复**（`Origin` 拒绝，issue #6） | **≥ 0.2.9** | 不涉及（但 fatfish 0.6.6 起加了互引提醒） |
| `relayPerson` 默认 `true`（转发人物的话） | 不涉及（Host 侧不替桌宠做默认） | **≥ 0.6.9**（0.6.6 曾改默认关，0.6.9 改回 true——默认关 = 升级后主路径功能消失） |
| 没有会话时新建（`new` 帧、桌宠侧 `dsh_new_session` 与面板「新建会话」） | **≥ 0.2.11** | **≥ 0.6.11** |

桌宠侧的扩展市场说明与 CHANGELOG 写的是同一组版本要求，两边要一起改，改一边算漏项。

> ⚠️ **安全建议**：如果你同时在用桌宠侧 fatfish 扩展，请把两边都升到上表最新列——**本插件 v0.2.9 修复了 CSWSH 安全漏洞**（任意网页可构造 WS 升级劫持桥接）。fatfish 侧 `relayPerson` 0.6.6 曾改成默认关（升级后打字不自动转 DSH），0.6.9 已改回 `true`，`relayPet`（桌宠→DSH，容易形成两嘴互聊循环）仍默认关。

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
