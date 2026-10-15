# coopanion-connector-dsh

DeepSeek Harness（DSH）bundle 插件：Coopanion 桌宠桥接的 Host 半区。它在 DSH 已有的 web 服务器上挂一个回环 WebSocket，桌宠连上来获知 DSH 正在做什么；你说的话也走同一条线路，被提交进拥有该桌宠的那段对话。

另一半（桌宠侧）是 Coopanion 的 [`cortico-world-fatfish`](https://github.com/Pal-AI-Lab/Coopanion/tree/main/packages/cortico-world-fatfish) 扩展，两个包分开装、分开演进。

## 工作方式

| 方向 | 帧 |
|---|---|
| Host → 桌宠 | `ready`、`turn-start`、`turn-end`、`reply`、`tool`、`approval`、`question`、`error` |
| 桌宠 → Host | `hello`、`say`、`ping`；Host 对 `say` 回 `accepted` 或 `refused` |

- 没有桌宠在线时通知直接丢弃、不排队：DSH 的活不等桌宠，重放的回合只会在你已经在控制台读完之后才冒泡。`say` 有回执，桌宠能如实报告"没转交"而不是猜。
- 文本里已带本 Host 前缀（`…（通过桌宠）说：`）的 `say` 会被拒收：再提交一次就会套两层前缀。
- `tool` 通知只带工具名和参数名、不带值：到达桌宠的东西会进模型的上下文和事件流，秘密收不回来。
- 接收 `say` 的对话是"最新的、非子代理的活跃 agent"——回答气泡的子代理是你没打开过的说话人。

## 安装与导入（DSH 侧）

前置：Node ≥ 22、pnpm、DSH 本体。

```sh
# 1) 克隆并构建
git clone https://github.com/blacksunshy/coopanion-connector-dsh.git
cd coopanion-connector-dsh
pnpm install
pnpm run build          # 产出 dist/index.cjs

# 2) 挂进 DSH profile（web 与 desktop 两种 profile 都可以）
dsh plugin --profile desktop add link:<本仓库克隆目录的绝对路径>

# 3) 重启 DSH，然后手工验证
#    GET http://127.0.0.1:<dsh端口>/coopanion/status 应返回 {"ok":true,...,"pet":...}
```

`link:` 方式是开发模式：DSH 直接引用克隆目录（构建一次即可，改完代码重新 `pnpm run build` 并重启 DSH）。要从构建产物安装，用 `dsh plugin --profile desktop add <目录>`。

要点：

- **产物必须是 CommonJS（`.cjs`）**。DSH 经自己的模块表加载 profile 插件，没有 `"type"` 字段的包按 CommonJS 解析——ESM 产物会在 `apply` 跑起来之前静默失败：bundle 在列表里、文件 require 不出来、路由不出现、也没有报错。`.cjs` 两个方向都明确。
- **`ws` 不打进包里**。构建把 Node 内置模块和 `ws` 留作 external，`ws` 由 profile 的依赖树提供（pnpm 会 hoist 到插件旁边）。
- **`cordis.patch.yml` 是挂载声明，不能删**。`package.json` 的 `dsh.bundle.patch` 指着它，DSH 按它把桥接路由插进 profile 的配置树；DSH 安装插件时按 `package.json` 的 `name` 解析构建产物 `dist/index.cjs`。

### 排查

- 每次插件被加载，都会往 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\coopanion-bridge.jsonl` 追加一行，写明加载它的进程——用这一行区分"插件没加载"和"加载了但桌宠没连上"。
- `GET /coopanion/status` 返回 `{ ok, v, pet, session }`：桥在、协议版本、桌宠是否在线、归属会话。
- 桌宠连接的地址默认 `ws://127.0.0.1:19387/coopanion/pet`（端口跟随 `dsh web` 或桌面应用实际监听的端口）。

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
