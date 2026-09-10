# 03 · Paseo 接入与验证记录

> **目标 CLI 是 `command-code`（bin: `cmd` / `cmdc`，v1.51.3）。**
> 本文档中出现的 `codebuddy-code` 仅作为"Paseo 如何接入一个 ACP provider"的**现成样本**，
> 它是另一个产品（当前会话所运行的 agent），**不是**本次改造的目标。

---

## 1. 已确认：Paseo 是真正的 Human-in-the-loop ACP Client

三层证据。

### 1.1 静态：`session/request_permission` handler 已注册

`D:\Program Files\Paseo\resources\app.asar`（77 MB）：

```js
case schema.CLIENT_METHODS.session_request_permission: {
  const validatedParams = validate.zRequestPermissionRequest.parse(params);
  return client.requestPermission(validatedParams);
}
```

完整实现（不是 stub）：

```js
async requestPermission(params) {
  const canAutoAccept = isACPAutoAcceptEnabled(this.config) && !isACPChooserRequest(params.options);
  if (canAutoAccept) {
    const allowOption = selectPermissionOption(params.options, { behavior: "allow" });
    if (allowOption) return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
  }
  const requestId = randomUUID();
  let toolSnapshot = this.toolCalls.get(params.toolCall.toolCallId)
      ?? mergeToolSnapshot(params.toolCall.toolCallId, params.toolCall);
  if (this.toolSnapshotTransformer) toolSnapshot = this.toolSnapshotTransformer(toolSnapshot);
  const request = mapPermissionRequest(this.provider, requestId, params, toolSnapshot);
  const promise = new Promise((resolve, reject) => {
    this.pendingPermissions.set(requestId, { request, options: params.options,
                                             resolve, reject, turnId: this.activeForegroundTurnId });
  });
  this.pushEvent({ type: "permission_requested", provider: this.provider, request, ... });
  return promise;                       // 阻塞等用户，无超时
}
```

### 1.2 配置：auto_accept 默认关闭

`C:\Users\wucy0\.paseo\agents\<workspace>\<agentId>.json`：

```json
"features": [{
  "type": "toggle", "id": "auto_accept", "value": false,
  "description": "Automatically approves ACP permission prompts."
}],
"requiresAttention": false, "attentionReason": null, "attentionTimestamp": null
```

### 1.3 运行时：闭环真实发生过

`C:\Users\wucy0\.paseo\20260910-1435-01-daemon.log`（10 MB，19 处 `permission_requested`）：

```
inboundSessionRequestTypesTop:  [["client_heartbeat",3], ["agent_permission_response",1]]
outboundSessionMessageTypesTop: [["agent_stream",53], ["agent_permission_request",1],
                                 ["agent_attention_required",1], ["agent_permission_resolved",1]]
outboundAgentStreamTypesTop:    [["permission_requested",1], ["permission_resolved",1]]
```

```
permission_request → attention_required（弹窗）→ permission_response（用户点）→ permission_resolved
```

配套 `C:\Users\wucy0\.paseo\agent-requests\`：30 个 `completed` + 6 个 `pending`。

### 1.4 结论

**不是 headless policy gateway。** cmd-acp 不需要自己实现弹窗 / confirm / CLI 输入；
是否批准、是否记住，交给 Paseo。Paseo 还暴露 `respond_to_permission`（MCP），可程序化批准。

---

## 2. 接入路径：自定义 ACP provider（`extends: "acp"`）

> 本节推翻了早期"provider 白名单不含 command-code → 需要 shim / PR"的判断。
> 那个判断错在把 `ACP_PROVIDER_ICON_NAMES` 当成了 provider 白名单——它只是**图标名**列表。

### 2.1 配置位置

`C:\Users\wucy0\.paseo\config.json` → `agents.providers.<providerId>`

现成样本（本机正在使用）：

```json
"agents": {
  "providers": {
    "codebuddy-code": {
      "extends": "acp",
      "label": "Codebuddy Code",
      "description": "Tencent Cloud's official intelligent coding tool",
      "command": ["codebuddy", "--acp"],
      "env": {}
    },
    "claude":  { "enabled": false },
    "pi":      { "enabled": false },
    "copilot": { "enabled": false }
  }
}
```

### 2.2 校验规则（asar 实测）

zod schema：

```js
// extends 必须是已知 provider，否则：
`Provider "${providerId}" extends unknown provider "${provider.extends}".`

// extends === "acp" 必须带 command，否则：
`Provider "${providerId}" extending "acp" must declare command.`
```

运行时：

```js
if (BUILTIN_PROVIDER_IDS.has(providerId) || ...) continue;      // 内置 provider 跳过
if (!override.extends) throw new Error(`Custom provider '${providerId}' requires an extends value`);
if (override.extends === "acp") {
  if (!override.command || !isNonEmptyStringArray(override.command))
    throw new Error(`ACP provider '${providerId}' requires a command`);
}
```

要点：

- `command` 必须是**非空字符串数组**
- 自定义 provider id 不得与 `BUILTIN_PROVIDER_IDS` 冲突
- **不要求** id 出现在 `ACP_PROVIDER_ICON_NAMES` 里（那只影响图标）

### 2.3 cmd-acp 的接入配置

```json
"command-code": {
  "extends": "acp",
  "label": "Command Code",
  "description": "Command Code via cmd-acp ACP adapter",
  "command": ["cmd-acp"],
  "env": {
    "CMD_BIN": "cmd"
  }
}
```

若未全局安装，可用 npx：

```json
"command": ["npx", "-y", "cmd-acp"]
```

### 2.4 结论

**不需要 PATH shim，不需要给 Paseo 提 PR，不需要改 Paseo 任何代码。**
接入成本 = 一段配置。

注意事项：

- 改 `config.json` 后需要**重启 Paseo daemon** 才加载
- 该文件是 Paseo 的用户配置，改动前建议备份
- 新增 provider 不影响现有 provider

---

## 3. spawn 机制

运行时进程树（`Get-CimInstance Win32_Process`）——对应上面 `codebuddy-code` 的配置：

```
cmd.exe /d /s /c "codebuddy --acp"
  └─ node.exe "D:\Program Files\nvm\nodejs\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy" --acp
```

可得出的结论：

1. `command` 数组被 join 后经 **shell** 执行（Windows 上是 `cmd.exe /d /s /c`）
   → 数组里的 binary 走 **PATH 查找**，不是绝对路径
2. `--acp` 是**配置里写死的**，不是 Paseo 自动加的
   → cmd-acp 不需要支持任何 flag（它本来就是纯 stdio）
3. daemon 日志**不记录** agent 的 spawn 命令行（55 处 `spawn` 全是 daemon worker）
   → 排查只能靠进程树

---

## 4. Trace 抓包方案

因为 `command` 完全可配置，抓 trace **不需要劫持任何现有 provider**——
把 command 直接指向 probe，由 probe 转发到真实 cmd-acp：

```json
"command-code-probe": {
  "extends": "acp",
  "label": "Command Code (trace)",
  "command": ["node", "C:/acp-probe/probe.js"],
  "env": {}
}
```

```
Paseo
  │ spawn（shell + command 数组）
  ▼
probe.js ──记录──▶ logs/trace.jsonl
  │ 原样转发 stdin/stdout
  ▼
cmd-acp（绝对路径，避免递归）
```

约束：

- **stdout 只能输出 JSON-RPC**，日志一律走文件，否则协议被污染
- probe 只转发不改帧
- probe 内部 spawn cmd-acp 用**绝对路径**（PATH 里可能又有自己）
- trace 每行 `{ time, direction, payload }`

### 待抓取的四个节点

| 节点 | 要确认什么 |
|---|---|
| `initialize` | Paseo 发来的 `clientCapabilities`（`fs.*` / `terminal` 是否开启）——**仍未拿到** |
| `session/new` | 是否传 `cwd` / `mcpServers` / `configOptions`，格式如何 |
| `session/update` | `tool_call` 通知的字段与顺序 |
| `session/request_permission` | 请求结构；响应的 `optionId` 回显行为 |

第 4 项按 SDK 类型已可确定（见 `02` §2），但实测能确认 Paseo 的实际回包。

### 4.1 首次实测结果（2026-09-10）

来源：`C:\Users\wucy0\acp-probe\logs\trace.jsonl`（26 帧）。

#### initialize（目标达成）

```json
{
  "jsonrpc": "2.0", "id": 0, "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": false, "writeTextFile": false },
      "terminal": true
    },
    "clientInfo": { "name": "Paseo", "version": "dev" }
  }
}
```

结论：

- `fs.readTextFile` / `fs.writeTextFile` **都是 false** → cmd-acp **不能**使用 `fs/*` 方法
- `terminal: true` → 可以使用 `terminal/*`
- **capabilities 里没有 permission 字段**——再次印证 permission 是 client 隐式能力
  （实现了 `session/request_permission` handler 即可），不需要在 capabilities 声明

#### session/new

```json
{
  "cwd": "D:\\work\\github\\cmd-acp",
  "mcpServers": [{
    "type": "http",
    "name": "paseo",
    "url": "http://127.0.0.1:6767/mcp/agents?callerAgentId=7188287e-...",
    "headers": [{ "name": "Authorization", "value": "Bearer 704b5e31-..." }]
  }]
}
```

**问题**：Paseo 注入的是 **http 类型** MCP server，而 `mcp.ts:16-20` 里
`if ("type" in server) return null` 会**把所有带 type 的（即 http/sse）全部丢弃**，
只支持 stdio。即：Paseo 注入的 MCP 对 cmd-acp **完全无效**。

#### session/prompt

```json
{
  "sessionId": "8578bbe5-...",
  "messageId": "msg_1789025904170_ty2cbfc76",
  "prompt": [{ "type": "text", "text": "你是什么模型" }]
}
```

比 `agent.ts:115-117` 当前处理的多了 `messageId` 字段（目前被忽略）。

#### 探测行为

Paseo 会 spawn **多次** agent 进程（本次 4 次）：前几次是 `listFeatures` 的能力探测
（asar: `listFeatures(config) { ... const probe = await this.spawnProcess(PROBE_ENV) ... }`），
cwd 为 Paseo 安装目录，`mcpServers: []`；最后一次才是真实会话（带 cwd 与 http MCP）。

因此 trace 里会看到多组 `initialize` / `session/new`，读取时注意区分。

#### 阻塞性 bug：Windows 上 spawn 命中系统 cmd.exe

实测：

```
spawn("cmd", ["-p", "hi", "--output-format", "json"])
→ STDOUT: "Microsoft Windows [Version 10.0.26200.8037]"
```

`resolveCmdBinary()`（`cmd-runner.ts:63-67`）默认返回 `"cmd"`，
在 Windows 上被 `C:\Windows\System32\cmd.exe` 抢先命中（`.exe` 扩展名优先），
**Command Code 从未被执行**。由于 Windows cmd 退出码为 0、输出被
`handleLine` 的 `catch { return }` 当作非 JSON 静默丢弃，
表现为：`session/prompt` 返回 `{"stopReason":"end_turn"}` 且**无任何报错**。

换用 `cmdc` 也不行——npm 只生成了 `cmdc.cmd` shim，
Node 非 shell 的 `spawn` 无法 `CreateProcess` 执行 `.cmd` → `ENOENT`。

已排除其他可能：直接用 `node <command-code>/dist/index.mjs -p hi --output-format json`
能正常输出完整 NDJSON 事件流（`run_start` / `turn_start` / `model_request_start` /
`thinking_start`，模型 `meituan/LongCat-2.0:free`），说明 Command Code 已安装且已登录。

修复方向（可 upstream，`cmd-runner.ts`）：

```ts
// Windows: 裸 "cmd" 命中 system32\cmd.exe；.cmd shim 又无法 CreateProcess
// → 用 process.execPath 直接跑 mjs 入口（数组传参，不经 shell，无注入风险）
function resolveCmdSpawn(): { command: string; argsPrefix: string[] } {
  const override = process.env.CMD_BIN?.trim()
  if (override) {
    if (/\.m?js$/.test(override)) return { command: process.execPath, argsPrefix: [override] }
    return { command: override, argsPrefix: [] }
  }
  if (process.platform === "win32") {
    const entry = findCommandCodeEntry()   // <node_dir>/node_modules/command-code/dist/index.mjs
    if (entry) return { command: process.execPath, argsPrefix: [entry] }
  }
  return { command: "cmd", argsPrefix: [] }
}
```

不要用 `shell: true` 绕过——prompt 是用户文本，拼接命令行会引入命令注入。

#### 顺带发现：NDJSON 事件远比当前解析的丰富

实测输出包含 `run_start` / `turn_start` / `message_start` / `model_request_start` /
`model_trace` / `thinking_start` / `thinking_delta` 等事件类型，
而 `cmd-runner.ts:123-141` 只处理 `tool_running` 与 `result`，其余全部丢弃。
后续可考虑映射 `thinking_*` → ACP `agent_thought_chunk`（当前未发）。

---

## 5. 不在当前目标内：provider metadata 层

Paseo 源码里有 provider 抽象层（`provider-manifest.ts` / `generic-acp-agent.ts`），
可扩展出"provider 详情展示"：CLI 路径、版本号、登录态、模型列表、能力标签、API endpoint 等。

**本次不做。** 理由：

- 当前目标是 **Command Code 的权限闭环**（HITL），不是"让 Paseo 展示 ACP agent 能力卡片"
- metadata 层属于 Paseo 侧的展示增强，是**独立的 PR**，与 cmd-acp / command-code 的改造无依赖
- 混在一起会稀释 upstream PR 的聚焦度

如后续要做，建议单独开议题，顺序是：
`generic-acp-agent 保存 initialize 元数据` → `ProviderRuntimeInfo` → `API endpoint` → `UI card`。

---

## 6. 优先级（阻塞已解除）

| 级别 | 项 | 状态 |
|---|---|---|
| P0 | cmd-acp：toolCall 生命周期 / toolCallId 稳定化 / permission bridge | 见 `02` |
| P0 | command-code：permission broker client + gate 改造 | 见 `01` |
| P1 | 加 `extends:"acp"` 配置 → 跑通 cmd-acp 在 Paseo 中的基本会话 | 配置改动，需重启 daemon |
| P1 | `initialize` capability 探测 / trace 抓取 | 不阻塞代码设计 |
| P2 | `loadSession` / pending permission 持久化 | 当前 `loadSession:false` |

---

## 7. 历史结论（保留）

- 早期"在 `cmd-runner.ts` 解析 NDJSON `permission_request`"已废弃（见 `01` §3）
- 早期"Paseo 可能没注册 permission handler，需要降级"**不成立**；
  降级仅在 client 不识别 `session/request_permission` 时（`RequestError` method-not-found）才需要
- 早期"Paseo provider 白名单不含 command-code，需 shim / PR"**不成立**，见 §2
