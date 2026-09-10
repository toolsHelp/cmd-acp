# 02 · cmd-acp 端改造设计

> 原则：**不修改 ACP 核心协议**，只增加一个 Permission Broker 层，
> 把 command-code 的权限请求转换成 ACP Client 的 `session/request_permission`。
>
> 本协议侧的类型定义见 `01-permission-broker.md`。

---

## 0. 当前代码结构（实测于 `f90b5ce`）

```
src
├── index.ts       ACP Server 启动（ndJsonStream + agent + connect）
├── agent.ts       全部 ACP handler（initialize / session/* ）
├── cmd-runner.ts  spawn `cmd -p --output-format json`，解析 NDJSON
├── sessions.ts    SessionStore（内存 Map）
├── mcp.ts         MCP 注入 → .mcp.json
└── models.ts      cmd --list-models
```

关键现状（**与早期假设不同，已核对代码**）：

| 事项 | 实际 |
|---|---|
| spawn 时机 | **在 `session/prompt`**（`agent.ts:134`），不是 `session/new` |
| `session/new` 做什么 | 建 session + 落 `.mcp.json` + 返回 `configOptions`（`agent.ts:97-103`） |
| 权限相关代码 | **无**。`agent.ts` 全文没有 `requestPermission` 调用 |
| tool 上报 | `toolCallId = \`cmd-${tool.toolName}\``（`agent.ts:143`），同 turn 内同名工具会撞 ID |
| tool 状态 | `pending` 与 `completed` 紧挨着发（`agent.ts:142-169`），等于没有 pending |
| tool kind | 硬编码 `"read"`（`agent.ts:150`） |
| session 持久化 | 无，`loadSession: false`（`agent.ts:95`），`SessionStore` 是进程内 Map |

---

## 1. 修正：ACP 权限调用入口

### 1.1 错误写法（已实测失败）

```ts
// 编译错误
await ctx.client.requestPermission({ ... })
// error TS2339: Property 'requestPermission' does not exist on type 'AgentContext'.
```

`requestPermission()` 只存在于 `AgentSideConnection`（`acp.d.ts:800`），
而该类被标记为 `@deprecated`（`acp.d.ts:754`："Prefer `agent({ name }).connect(stream)`"）。

### 1.2 不要改用 `AgentSideConnection`

有一种修法是"让 adapter 内部持有 `AgentSideConnection` 而不是 `AgentContext`"。**不采用**，原因：

1. `AgentSideConnection` 已 deprecated，用它等于把新代码建在废弃 API 上
2. 它是连接层对象，`AgentApp` 的 handler 里拿不到它；cmd-acp 用 `acp.agent().connect(stream)`，
   连接建立后只有 `AgentContext`
3. 两者底层是同一条 JSON-RPC 连接，换过去没有任何能力增益

### 1.3 正确写法

`AgentContext`（`acp.d.ts:164-182`）只有两个泛型方法：`request()` / `notify()`。
用方法名常量触发字面量类型推断：

```ts
// src/permission/acp-adapter.ts
import * as acp from "@agentclientprotocol/sdk"
import type {
  AgentContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk"

export interface ACPPermissionAdapter {
  request(input: {
    sessionId: string
    toolCall: ToolCallUpdate
    options: RequestPermissionRequest["options"]
    signal?: AbortSignal
  }): Promise<{ decision: "allow" | "deny"; scope: "once" | "always"; optionId?: string } | { decision: "cancelled" }>
}

export class ACPPermissionAdapterImpl implements ACPPermissionAdapter {
  constructor(private readonly client: AgentContext) {}

  async request(input: {
    sessionId: string
    toolCall: ToolCallUpdate
    options: RequestPermissionRequest["options"]
    signal?: AbortSignal
  }) {
    // params 必须显式标注类型，见 1.4
    const params: RequestPermissionRequest = {
      sessionId: input.sessionId,
      toolCall: input.toolCall,
      options: input.options,
    }

    const res: RequestPermissionResponse = await this.client.request(
      acp.methods.client.session.requestPermission,   // "session/request_permission"
      params,
      { cancellationSignal: input.signal },
    )

    return mapACPResponse(res)
  }
}
```

### 1.4 陷阱：必须显式标注 `params` 类型

`AgentContext.request` 有两个重载（`acp.d.ts:172` / `173`）：

```ts
request<Method extends ClientRequestMethod>(method, params: ClientRequestParamsByMethod[Method], options?): Promise<...>
request<Response = unknown, Params = unknown>(method: string, params?: Params, options?): Promise<Response>
```

**实测**：内联传参且字段写错时，TS 会静默 fallback 到第二个重载，不报错，返回值退化成 `unknown`。

```ts
// 不报错（危险）——kind: "allow_forever" 是非法值
await ctx.client.request(acp.methods.client.session.requestPermission, {
  sessionId, toolCall: {...}, options: [{ optionId: "a", name: "A", kind: "allow_forever" }],
})

// 报错（正确）——显式标注后结构校验生效
const params: RequestPermissionRequest = { /* ... kind: "allow_forever" ... */ }
// error TS2322: Type '"allow_forever"' is not assignable to type 'PermissionOptionKind'
```

因此：`params` 一律声明为 `RequestPermissionRequest`，返回值声明为 `RequestPermissionResponse`。

### 1.5 类型从哪里 import

`acp.d.ts:3` 有 `export type * from "./schema/types.gen.js"`，所以全部 schema 类型从包根导出：

```ts
import type {
  RequestPermissionRequest, RequestPermissionResponse,
  PermissionOption, PermissionOptionKind, ToolCallUpdate, ToolKind, ToolCallStatus,
} from "@agentclientprotocol/sdk"
```

---

## 2. 修正：Response 映射

### 2.1 真实响应结构（`types.gen.d.ts:5568` / `5587`）

```ts
type RequestPermissionResponse = { outcome: RequestPermissionOutcome; _meta? }
type RequestPermissionOutcome =
  | { outcome: "cancelled" }
  | ({ outcome: "selected" } & { optionId: PermissionOptionId })
```

即：**`optionId` 在 `outcome` 里面**，且要判断 `outcome.outcome` 判别式。

### 2.2 错误写法

```ts
response.optionId === "allow"   // undefined，永远判成 deny
```

### 2.3 正确映射

```ts
export function mapACPResponse(res: RequestPermissionResponse): BrokerDecision {
  if (res.outcome.outcome === "cancelled") {
    return { decision: "cancelled" }
  }
  // 判别式之后 TS 才允许访问 optionId
  switch (res.outcome.optionId) {
    case "allow_once":   return { decision: "allow", scope: "once" }
    case "allow_always": return { decision: "allow", scope: "always" }
    case "reject_once":  return { decision: "deny",  scope: "once" }
    case "reject_always":return { decision: "deny",  scope: "always" }
  }
}
```

> `optionId` 是 client 回显**我们下发**的值。cmd-acp 下发时用固定 ID
> （`allow-once` / `allow-always` / `reject-once` / `reject-always`），
> 而 `kind` 承担语义。未知 `optionId` 一律按 deny 处理（fail-closed）。

---

## 3. 修正：删除 cmd-runner 的 NDJSON permission 路径

早期设计里有"在 `cmd-runner.ts` 解析 `permission_request` 事件"。**废弃**，原因见 `01-permission-broker.md` F1 / F2：

- `cmd -p` 的 print gate 直接 `block` + `additionalContext`，**不产出**权限事件
- `stdio: ["ignore", "pipe", "pipe"]`（`cmd-runner.ts:93`），**stdin 被丢弃**，没有回写通道

因此 `cmd-runner.ts` **不增加** permission 解析，只增加：

```ts
env: {
  ...process.env,
  COMMAND_CODE_SESSION: session.id,
  COMMAND_CODE_PERMISSION_BROKER: brokerAddress,
  COMMAND_CODE_PERMISSION_TOKEN: brokerToken,
}
```

（注意 `cmd-runner.ts:92` 现在是 `env: process.env`，需改为对象展开，不要覆盖全局 env。）

权限请求改由独立的 `permission/broker-server.ts` 监听 pipe/socket 接收。

---

## 4. 新增：两个 Store（不是一个）

### 4.1 为什么需要 ToolCallStore

Paseo 的 `requestPermission` 实现：

```js
let toolSnapshot = this.toolCalls.get(params.toolCall.toolCallId)
    ?? mergeToolSnapshot(params.toolCall.toolCallId, params.toolCall)
```

**先查本地 toolCall 快照**。若 cmd-acp 未发过同 ID 的 `tool_call` 通知，UI 只能拿到兜底快照
（缺 title / content）。因此 toolCall 生命周期是权限 UI 正确渲染的**前提**。

### 4.2 ToolCallStore

```ts
// src/toolcalls.ts
export type ToolCallState =
  | "created" | "pending" | "in_progress"
  | "awaiting_permission" | "completed" | "failed"

export interface ToolCallEntry {
  toolCallId: string
  sessionId: string
  kind: ToolKind
  title: string
  rawInput?: unknown
  status: ToolCallStatus     // ACP 侧：pending | in_progress | completed | failed
  state: ToolCallState       // cmd-acp 内部状态机
}

export class ToolCallStore {
  private readonly byId = new Map<string, ToolCallEntry>()
  private seq = 0

  /** toolCallId 必须稳定且唯一：`${sessionId}-tool-${seq}` */
  create(sessionId: string, kind: ToolKind, title: string, rawInput?: unknown): ToolCallEntry {
    const toolCallId = `${sessionId}-tool-${++this.seq}`
    const e: ToolCallEntry = {
      toolCallId, sessionId, kind, title, rawInput,
      status: "pending", state: "created",
    }
    this.byId.set(toolCallId, e)
    return e
  }

  get(toolCallId: string) { return this.byId.get(toolCallId) }
  clearSession(sessionId: string) { /* ... */ }
}
```

**toolCallId 生成规则**：`${sessionId}-tool-${递增序号}`。
当前 `cmd-${tool.toolName}`（`agent.ts:143`）有两个问题：同 turn 同名工具撞 ID；
不带 session 前缀，跨 session 无法隔离。

### 4.3 状态机

```
created
   |
pending ──发 tool_call(status:pending)
   |
in_progress ──发 tool_call_update(status:in_progress)
   |
   +── (需要授权) ──> awaiting_permission ──> 发 session/request_permission
   |                        |
   |                   allow ──> in_progress
   |                   deny  ──> failed
   |
completed / failed ──发 tool_call_update(status:completed|failed)
```

**顺序必须是：tool_call(pending) → 需要时 request_permission → 最终 update**。
不能反过来（先 permission 再 tool_call），否则 Paseo 无法渲染。

### 4.4 PermissionStore

```ts
// Map<sessionId, Map<requestId, PendingPermission>> —— 两层，见 01 §8
export class PermissionStore {
  add(sessionId: string, p: PendingPermission): void
  resolve(sessionId: string, requestId: string, res: PermissionResponse): boolean  // 幂等
  cancelSession(sessionId: string): PendingPermission[]   // session/close、session/cancel
  pendingForSession(sessionId: string): PendingPermission[]
}
```

`resolve` 必须幂等：第二次调用直接返回 `false`，不重复 resolve。

---

## 5. sessions.ts 改造

```ts
export interface Session {
  id: string
  cwd: string
  config: CmdConfig
  promptAbort: AbortController | null
  cmdSessionId?: string
  hasPrompted: boolean
  cleanupMcp?: () => void

  // 新增
  toolCalls: ToolCallStore          // 或全局单例，按 sessionId 分桶
  pendingPermissions: Map<string, PendingPermission>
  permissionCache: PermissionCache  // session 作用域的 allow 记忆
  brokerToken: string               // 校验 command-code 连接来源
}
```

`close()` / `cancelPrompt()` 必须顺带 `cancelSession()`，把所有 pending 以 `cancelled` 结束，
否则 command-code 侧会永久挂起在 `await` 上。

---

## 6. agent.ts 改造要点

1. `session/prompt` 里把 `ctx.client` 和 `ctx.signal` 交给 adapter：
   ```ts
   const adapter = new ACPPermissionAdapterImpl(ctx.client)
   ```
2. 权限回调通过 `runCmdPrompt` 的 opts 传入（与 `onTool` / `onText` 平级）：
   ```ts
   onPermissionRequest: async (req) => broker.handle(req, { sessionId, signal: ctx.signal })
   ```
3. `onTool` 回调改为：先 `ToolCallStore.create()`，再发 `tool_call` 通知（**pending**），
   最后才发 `tool_call_update`（`completed`）。当前代码把两步紧挨着发，需拆开。
4. `kind` 不能再硬编码 `"read"`（`agent.ts:150`），按 tool 名映射到 `ToolKind`：
   ```
   shell_command / monitor_command / kill_shell → "execute"
   edit_file / write_file                       → "edit"
   read_file / search                           → "read"
   ```
5. `session/close` 与 `session/cancel`（`agent.ts:104` / `211`）增加 pending 清理。

---

## 7. 超时与取消

- 默认 `timeoutMs = 0`（不超时），对齐 Paseo 无超时行为
- 若配置超时：超时后先 `resolve({decision:"timeout"})` 给 command-code，
  **再** abort `cancellationSignal` → SDK 发 `$/cancel_request` → Paseo 清理 pending。
  顺序反了会留下幽灵弹窗。
- `ctx.signal`（`agent.ts:138`）已传入 `runCmdPrompt`，直接复用给 `cancellationSignal`。

---

## 8. 目录结构

```
src
├── permission
│   ├── protocol.ts          # broker 协议类型（与 command-code 共享）
│   ├── broker-server.ts     # pipe/socket transport
│   ├── pending-store.ts     # Map<sessionId, Map<requestId, PendingPermission>>
│   ├── permission-cache.ts  # session 作用域记忆
│   └── acp-adapter.ts       # ctx.client.request(...) 封装 + outcome 映射
├── toolcalls.ts             # ToolCallStore + 状态机
├── agent.ts                 # 改
├── sessions.ts              # 改
├── cmd-runner.ts            # 只改 env 注入
├── index.ts                 # 启动 broker
└── mcp.ts                   # 不动
```

---

## 9. Commit 拆分（便于 upstream）

| Commit | 内容 | upstream 可能性 |
|---|---|---|
| 1 | `toolcalls.ts` + `agent.ts` tool_call 生命周期修正（稳定 ID、真 pending、正确 kind） | **高**——纯 ACP 正确性修复，与 broker 无关 |
| 2 | `permission/protocol.ts` + `pending-store.ts` | **高**——通用抽象 |
| 3 | `permission/acp-adapter.ts` | **高**——按 1.3 正确 API 写即可 |
| 4 | `permission/broker-server.ts` + Windows pipe | 低——平台相关 |
| 5 | command-code 适配（gate 改造 + broker client） | 无——留 fork |

Commit 1 建议**单独提前提 PR**：它不依赖任何 broker 工作，且能立刻改善 Paseo 里的工具展示。

---

## 10. 改动量

| 文件 | 增量 |
|---|---:|
| `permission/protocol.ts` | ~80 |
| `permission/pending-store.ts` | ~70 |
| `permission/permission-cache.ts` | ~50 |
| `permission/broker-server.ts` | ~120 |
| `permission/acp-adapter.ts` | ~80 |
| `toolcalls.ts` | ~90 |
| `agent.ts` | ~60 |
| `sessions.ts` | ~30 |
| `cmd-runner.ts` | ~15 |
| **合计** | **≈ 595** |

其中可 upstream 部分（Commit 1–3）约 **300 行**。

---

## 11. 测试策略

沿用现有 fake CLI 模式（`test/fake-cmd.mjs`）：

- broker 层：用内存 transport 替换 pipe，测并发 / 幂等 / 超时 / cancel
- ACP 层：用 `acp.client({}).onRequest(methods.client.session.requestPermission, ...)` 做 mock client，
  断言发出的 `RequestPermissionRequest` 结构（尤其 `toolCall.toolCallId` 与 `options`）
- 端到端：fake CLI 触发一次权限请求 → mock client 回 `allow_once` → 断言 fake CLI 收到 allow

不依赖真实 `cmd`、不依赖真实 Paseo。
