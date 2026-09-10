# 01 · Permission Broker Protocol v1

> 目标不是"给 Command Code 增加 ACP 支持"（官方已有 `command-code-acp`），而是：
>
> **为 headless coding agent 增加可插拔 human-in-the-loop permission broker**
>
> 本文档只定义 **command-code ↔ cmd-acp** 之间的协议。ACP 侧的类型与调用约定见 `02-cmd-acp-mod.md`。

适用版本基线（均已实测）：

| 组件 | 版本 | 证据来源 |
|---|---|---|
| `command-code` | 1.51.3 | `D:\Program Files\nvm\nodejs\node_modules\command-code\dist\cli.mjs` |
| `@agentclientprotocol/sdk` | 1.3.0 | `cmd-acp/node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` |
| `cmd-acp` | 0.2.0 | 本仓库 `f90b5ce` |

---

## 0. 边界

```
command-code   —— 不知道 ACP 存在
cmd-acp        —— 不知道具体工具的权限逻辑
ACP Client     —— 只负责 UI 决策
broker         —— 负责同步阻塞授权
```

任何一方都不允许把对方的概念泄漏进来：
- command-code 不得出现 `session/request_permission`、`optionId`
- cmd-acp 不得出现 `tool_running`、`--yolo` 之外的 command-code 内部概念
- broker 协议里不得出现 ACP 术语

---

## 1. 决定本协议的硬约束（实测）

这些不是设计偏好，是被实现逼出来的：

| # | 事实 | 证据 | 对协议的约束 |
|---|---|---|---|
| F1 | `cmd -p` 在 print 模式下**不产生**权限事件，危险工具被 `print-permission-gate` 直接 `block` + `additionalContext` | `cli.mjs`: `createPrintPermissionGateMod` / `OE = new Set(["edit_file","write_file","shell_command","monitor_command","kill_shell"])` | 权限请求**不可能**走 NDJSON stdout |
| F2 | `cmd -p` 的 `stdio[0]` 是 `ignore` | `cmd-runner.ts:90-94` | 即使收到事件也**无法回写**；必须走独立双向通道 |
| F3 | ACP `RequestPermissionRequest` **没有 `requestId` 字段** | `types.gen.d.ts:108`（只有 `sessionId` / `toolCall` / `options` / `_meta`） | `requestId` 是 broker 私有概念，不能映射到 ACP |
| F4 | ACP 只有 4 种 option kind：`allow_once` / `allow_always` / `reject_once` / `reject_always` | `types.gen.d.ts:637` | **没有 session 级**；session 作用域必须由 cmd-acp 自己实现 |
| F5 | Paseo 的 `requestPermission` 返回**无超时**的 Promise | `app.asar`: `pendingPermissions.set(requestId, {...resolve...})` + `return promise` | broker 默认不应硬超时；超时必须显式取消 |
| F6 | ACP SDK v1.3.0 的 `AgentContext` **没有** `requestPermission()` 方法 | 实测 `TS2339` | cmd-acp 必须用 `ctx.client.request(method, params)`（见 02） |

---

## 2. 设计原则

### 2.1 request 必须可恢复

用户可能 30 秒后才点。因此请求必须有稳定标识 `requestId`，**不能依赖连接顺序或到达顺序**。

### 2.2 request 必须绑定 session

```
Session A: 删除文件
Session B: 执行 shell
```

两个响应同时回来会串。因此 key 是二元组：

```
sessionId + requestId
```

### 2.3 response 必须幂等

用户可能双击、UI 可能重发、连接可能重连。同一个 `requestId` 只能有一个最终状态。

### 2.4 失败默认拒绝

任何异常路径（连接断开、解析失败、broker 未启动）一律 `deny`。绝不 fail-open。

---

## 3. Transport

协议与传输无关。第一版实现 **Named Pipe（Windows）/ Unix Socket**，抽象成：

```ts
interface PermissionTransport {
  start(): Promise<void>
  stop(): Promise<void>
  onRequest(
    handler: (req: PermissionRequest) => Promise<PermissionResponse>
  ): void
}
```

> 为什么不走 stdio：见 F1 / F2。command-code 的 stdout 是单向 NDJSON 事件流，stdin 是 `ignore`，
> 没有任何办法在不改 command-code 传输模型的前提下完成"请求—等待—响应"。
> 独立 pipe/socket 只需要 command-code 侧新增一个 client（约 50 行），不触碰现有 harness。

安全：

| 平台 | 要求 |
|---|---|
| Windows | Named Pipe，ACL 仅允许当前用户 SID |
| Linux / macOS | `0600` unix socket |

---

## 4. Request Schema（command-code → cmd-acp）

```json
{
  "type": "permission_request",
  "version": "1.0",
  "requestId": "req_01J8X9ABCD",
  "sessionId": "sess_8f31d2",
  "timestamp": 1789000000000,

  "source": {
    "agent": "command-code",
    "version": "1.51.3"
  },

  "toolCall": {
    "toolCallId": "sess_8f31d2-tool-007",
    "kind": "execute",
    "title": "npm install lodash",
    "rawInput": {
      "command": "npm install lodash",
      "cwd": "D:\\workspace"
    }
  },

  "risk": "high",

  "options": {
    "canRemember": true,
    "timeoutMs": 0
  }
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `requestId` | 是 | `req_<uuid>`，**broker 私有**，永不复用，不映射到 ACP |
| `sessionId` | 是 | 由 cmd-acp 通过环境变量注入，映射到 ACP `session/new` 的 session |
| `toolCall.toolCallId` | 是 | **跨三层稳定**：command-code → broker → ACP `ToolCallUpdate.toolCallId` |
| `toolCall.kind` | 是 | 取 ACP `ToolKind` 子集：`read` / `edit` / `delete` / `move` / `search` / `execute` / `think` / `fetch` / `other` |
| `toolCall.title` | 是 | 给人看的一句话摘要，直接进 ACP `title` |
| `toolCall.rawInput` | 否 | 原始参数，进 ACP `rawInput`；可能含敏感内容，由 cmd-acp 决定是否脱敏 |
| `risk` | 否 | `low` / `medium` / `high` / `critical`，仅用于 UI 提示与策略，**不进 ACP** |
| `options.timeoutMs` | 否 | `0` = 不超时（默认，对齐 F5）；> 0 时超时按 `decision: "timeout"` 处理 |

**关于 `toolCallId`**：它必须与 cmd-acp 之前通过 `session/update` 发出的 `tool_call` 通知中的
`toolCallId` **完全一致**。Paseo 的 `requestPermission` 会先 `this.toolCalls.get(params.toolCall.toolCallId)`
查快照，查不到才用 `mergeToolSnapshot` 兜底——兜底会导致 UI 缺 title / content。

**关于 `tool.name` 用 string 而不是 enum**：未来会新增 browser / database / git / docker 等工具，
协议层不限制枚举，只把 `kind` 限制在 ACP `ToolKind` 内。

---

## 5. Response Schema（cmd-acp → command-code）

允许：

```json
{
  "type": "permission_response",
  "version": "1.0",
  "requestId": "req_01J8X9ABCD",
  "sessionId": "sess_8f31d2",
  "decision": {
    "result": "allow",
    "scope": "once"
  },
  "timestamp": 1789000010000
}
```

拒绝：

```json
{
  "type": "permission_response",
  "version": "1.0",
  "requestId": "req_01J8X9ABCD",
  "sessionId": "sess_8f31d2",
  "decision": {
    "result": "deny",
    "reason": "User rejected request",
    "scope": "once"
  },
  "timestamp": 1789000010000
}
```

---

## 6. 枚举

### 6.1 Decision

```ts
enum PermissionDecision {
  Allow     = "allow",
  Deny      = "deny",
  Timeout   = "timeout",
  Cancelled = "cancelled",
}
```

不用 `true` / `false`——扩展不了。

- `timeout`：broker 侧 `timeoutMs > 0` 且超时。**必须**同时向 ACP 发取消（见 7.2）
- `cancelled`：用户取消整个 prompt turn（ACP 回 `{outcome:"cancelled"}`），或 session 被 close

### 6.2 Scope（broker 层）

```ts
enum PermissionScope {
  Once    = "once",
  Session = "session",
  Always  = "always",
}
```

### 6.3 Scope 与 ACP 的映射（关键）

ACP **只有** 4 种 kind（F4），**没有 session 级**。因此：

| broker scope | ACP option kind | 由谁实现 |
|---|---|---|
| `once` | `allow_once` / `reject_once` | ACP Client 原生 |
| `always` | `allow_always` / `reject_always` | ACP Client 原生（持久化记忆） |
| `session` | **不发给 ACP** | **cmd-acp 自己维护 `PermissionCache`** |

`session` 作用域流程：

```
command-code 请求权限
      |
cmd-acp 查 PermissionCache（key: tool + 归一化的 rawInput，作用域 = 当前 ACP session）
      |
  命中 → 直接返回 allow，不发 ACP
      |
  未命中 → 发 session/request_permission
           用户选 allow_always → 写入 cache（session 作用域）+ 返回 allow
```

> 若 cmd-acp 想把 `session` 直接映射成 ACP 的 `allow_always`，等于把"本次会话"变成"永久记忆"，
> 属于权限放大，**不应默认这么做**。

`PermissionCache` 生命周期绑定 ACP session：`session/close` 时清空。

---

## 7. 超时与取消

### 7.1 默认不超时

因为 F5（Paseo 无超时），broker 默认 `timeoutMs = 0`（无限等待）。决定的时机交给用户。

### 7.2 若配置了 timeoutMs，必须取消 ACP 侧请求

否则会出现"cmdc 已 deny 并继续，Paseo 弹窗还挂着"的幽灵弹窗。必须：

1. 触发 `AbortSignal`（即 `ctx.client.request(..., { cancellationSignal })`）
2. SDK 发 `$/cancel_request`
3. Paseo 侧 pending 被 reject / 清理

### 7.3 session/cancel

ACP Client 发 `session/cancel` 时，该 session 下所有 pending 请求一律以 `cancelled` 结束。

---

## 8. 并发模型

支持同 session 多请求、跨 session 并行：

```
session A → req001（shell）
         → req002（edit_file）

session B → req003（install）
```

存储结构（**两层 Map，不要用 requestId 单键**）：

```ts
Map<sessionId, Map<requestId, PendingPermission>>
```

```ts
interface PendingPermission {
  requestId: string
  sessionId: string
  toolCallId: string
  resolve(res: PermissionResponse): void
  createdAt: number
  timer?: NodeJS.Timeout      // 仅当 timeoutMs > 0
}
```

`requestId` 全局唯一即可，但**必须按 session 分组存**，否则 `session/close` 时无法批量清理。

---

## 9. 安全

| 项 | 做法 |
|---|---|
| Pipe 身份校验 | Windows Named Pipe ACL（仅当前用户 SID）；Unix `0600` |
| 防重放 | request 带 `nonce`，response 必须回显同一 `nonce`，不匹配则丢弃 |
| 进程校验 | cmd-acp 只接受自己 spawn 的 command-code 进程连接（启动时下发 token，通过环境变量传递） |
| 失败默认 | deny |

---

## 10. 完整生命周期

1. ACP Client `session/new` → cmd-acp 建 session，得到 `sessionId`
2. cmd-acp `session/prompt` → spawn `cmd -p`，通过环境变量注入
   `COMMAND_CODE_SESSION=<sessionId>` 与 `COMMAND_CODE_PERMISSION_BROKER=<pipe>`
3. command-code 触发危险工具 → `beforeToolCall`（本身是 async，天然可 await）
4. command-code 生成 `requestId`，经 broker 发 `permission_request`，进入 `pending`
5. cmd-acp 收请求，先发/确认对应的 `session/update` `tool_call`（保证 toolCallId 已存在），
   再存 `PendingPermission`
6. cmd-acp 调 ACP `session/request_permission`（`ctx.client.request(...)`，见 02）
7. 用户点 Allow → ACP 回 `{outcome:{outcome:"selected",optionId:"allow_once"}}`
8. cmd-acp 映射成 `PermissionResponse{result:"allow",scope:"once"}` 回写 broker
9. command-code 继续执行工具

---

## 11. MVP 最小协议

第一版只保留必要字段：

```ts
// request
{ type, requestId, sessionId, toolCall: { toolCallId, kind, title, rawInput? } }

// response
{ type, requestId, decision: { result: "allow" | "deny" | "timeout" | "cancelled", scope? } }
```

实现量估算：

| 侧 | 内容 | 行数 |
|---|---|---|
| command-code | permission gate 改造 + broker client | ≈ 50 |
| cmd-acp | broker server + ACP 映射 + pending store | ≈ 100–150 |

---

## 12. 与 ACP 的映射（修正版）

| Broker 字段 | ACP 字段 | 备注 |
|---|---|---|
| `sessionId` | `RequestPermissionRequest.sessionId` | 直接对应 |
| `requestId` | **无对应** | broker 私有；ACP 靠 `sessionId` + `toolCallId` 关联 |
| `toolCall.toolCallId` | `ToolCallUpdate.toolCallId` | 必填，跨三层一致 |
| `toolCall.kind` | `ToolCallUpdate.kind` | 必须是 ACP `ToolKind` 值 |
| `toolCall.title` | `ToolCallUpdate.title` | |
| `toolCall.rawInput` | `ToolCallUpdate.rawInput` | |
| `risk` | 无 | 仅 cmd-acp 内部/UI 提示用 |
| `options.canRemember` | 决定下发哪些 `PermissionOption` | |
| `decision.result=allow` | `selected` + `optionId ∈ {allow_once, allow_always}` | |
| `decision.result=deny` | `selected` + `optionId ∈ {reject_once, reject_always}` | |
| `decision.result=cancelled` | `outcome: "cancelled"` | |
| `decision.scope=session` | **不下发** | cmd-acp `PermissionCache` 实现 |

---

## 13. 代码结构

### command-code（fork）

```
permission/
  protocol.ts        // 与 cmd-acp 共享的类型定义
  client.ts          // broker client（pipe/socket）
print-harness/
  permission-gate.ts // 原 createPrintPermissionGateMod 改为可委托 broker
```

### cmd-acp

```
permission/
  protocol.ts        // 同上，可独立成 @command-code/permission-protocol
  broker-server.ts   // transport 监听
  pending-store.ts   // Map<sessionId, Map<requestId, PendingPermission>>
  permission-cache.ts// session 作用域记忆
  acp-adapter.ts     // broker request → ACP session/request_permission
```

---

## 14. 可 upstream 的部分

| 部分 | 能否 upstream | 原因 |
|---|---|---|
| `permission/protocol.ts` | 能 | 纯类型，与具体产品无关 |
| `pending-store.ts` | 能 | ACP 通用模式 |
| `acp-adapter.ts` | 能（需按 02 的正确 API 写） | 属于 ACP 能力封装 |
| `broker-server.ts` 的 Windows pipe 实现 | 不能 | 平台相关 + 只有我们知道 command-code 内部 |
| command-code 侧全部改动 | 不能 | 属于 Command Code Runtime |
