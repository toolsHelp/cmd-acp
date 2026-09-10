基于你已经完成的源码审计，`cmd-acp` 端改造目标非常明确：

**不修改 ACP 核心协议，只增加一个 Permission Broker 层，把 command-code 的权限请求转换成 ACP Client 的 `session/request_permission`。**

目标：

```
command-code
     |
     | permission_request
     |
     v
cmd-acp
     |
     | session/request_permission
     |
     v
Paseo / Zed

     |
     | allow / deny
     |
     v

cmd-acp
     |
     | permission_response
     |
     v

command-code
```

---

# 1. 当前 cmd-acp 代码结构（根据你的审计）

目前：

```
src
├── index.ts
├── agent.ts
├── cmd-runner.ts
├── sessions.ts
├── mcp.ts
```

职责：

| 文件            | 当前职责         | 改造                    |
| ------------- | ------------ | --------------------- |
| index.ts      | ACP Server启动 | 增加 Broker 初始化         |
| agent.ts      | ACP handler  | 增加 permission handler |
| sessions.ts   | session状态    | 增加 pending permission |
| cmd-runner.ts | spawn cmd    | 增加 permission event解析 |
| mcp.ts        | MCP配置        | 不动                    |

---

# 2. 新增目录设计

建议：

```
src
├── permission
│
│   ├── protocol.ts
│   ├── broker-server.ts
│   ├── pending-store.ts
│   ├── acp-permission.ts
│
├── agent.ts
├── sessions.ts
├── cmd-runner.ts
└── index.ts
```

---

# 3. protocol.ts

定义 Broker 协议。

职责：

> cmd-acp 和 command-code 双方共享。

```ts
// src/permission/protocol.ts


export interface PermissionRequest {

    type:
      "permission_request";


    version:
      "1.0";


    requestId:
      string;


    sessionId:
      string;


    tool:{
        name:string;

        input:any;

        risk?:
        "low" |
        "medium" |
        "high";
    };


    timestamp:number;
}



export interface PermissionResponse {


    type:
      "permission_response";


    requestId:
      string;


    sessionId:
      string;


    decision:
       "allow" |
       "deny" |
       "timeout";


    scope?:
       "once" |
       "session" |
       "always";
}

```

这个文件以后可以独立成：

```
@command-code/permission-protocol
```

---

# 4. pending-store.ts

这是最关键的新模块。

作用：

保存：

```
command-code request
        |
        |
等待 ACP 返回
```

设计：

```ts
export interface PendingPermission {


    requestId:string;


    sessionId:string;


    resolve:
       (response:PermissionResponse)
       =>void;


    createdAt:number;


    timeout:
       NodeJS.Timeout;
}


```

实现：

```ts
export class PendingPermissionStore {


private store =
 new Map<
 string,
 PendingPermission
 >;



add(
 item:PendingPermission
){

 this.store.set(
    item.requestId,
    item
 );

}



resolve(
 response:PermissionResponse
){

 const item =
 this.store.get(
    response.requestId
 );


 if(!item)
    return;


 clearTimeout(
    item.timeout
 );


 item.resolve(
    response
 );


 this.store.delete(
    response.requestId
 );


}


}

```

---

# 5. broker-server.ts

负责：

```
command-code
     |
     |
permission_request
     |
     |
cmd-acp
```

通信方式：

建议第一版：

Unix socket / Windows Named Pipe。

抽象：

```ts
interface PermissionTransport {


 start():

 Promise<void>;



 onRequest(
 callback:
 (
 request:PermissionRequest
 )
 =>
 Promise<PermissionResponse>
 );

}
```

---

实现：

```ts
export class PipePermissionBroker {


constructor(
 private store:
 PendingPermissionStore
){}



async handleRequest(
 request:
 PermissionRequest
){


return new Promise(
(resolve)=>{


this.store.add({

 requestId:
 request.requestId,


 sessionId:
 request.sessionId,


 resolve,


 createdAt:
 Date.now(),


 timeout:
 setTimeout(()=>{


 resolve({

  type:
  "permission_response",

  requestId:
  request.requestId,

  sessionId:
  request.sessionId,


  decision:
  "timeout"


 });


 },30000)

});


});


}

}

```

---

# 6. agent.ts 改造

这是核心。

现在：

```ts
session/prompt

↓

runCmdPrompt()

↓

返回文本
```

增加：

```
permission callback
```

---

## 原来：

```ts
const result =
 await runCmdPrompt(
   prompt
 )
```

改：

```ts
const result =
 await runCmdPrompt({

    prompt,


    onPermissionRequest:

      async(req)=>{

          return await requestPermission(
             req
          );

      }

});

```

---

# 7. 增加 ACP Permission 映射

新增：

```
src/permission/acp-permission.ts
```

职责：

Broker Request:

↓

ACP:

```
session/request_permission
```

代码：

```ts
export async function requestACPPermission(
 ctx,
 request
){


const response =
 await ctx.client
 .requestPermission({

    sessionId:
    request.sessionId,


    toolCall:{

       name:
       request.tool.name,


       input:
       request.tool.input

    },


    options:[

     {
       optionId:"allow",
       name:"Allow",
       kind:"allow_once"
     },


     {
       optionId:"deny",
       name:"Deny",
       kind:"reject_once"
     }

    ]

 });


return {

 decision:
 response.optionId==="allow"
 ?
 "allow"
 :
 "deny"

};


}

```

---

# 8. sessions.ts 改造

现在：

```ts
Map<string,Session>
```

扩展：

```ts
interface Session {


 id:string;


 cmdSessionId:string;



 pendingPermissions:

 Map<
 string,
 PendingPermission
 >;

}

```

为什么？

因为：

```
session A

 permission request 001


session B

 permission request 002
```

必须隔离。

---

# 9. cmd-runner.ts 改造

现在：

```ts
spawn(
"cmd",
[
 "-p",
 prompt,
 "--output-format",
 "json"
]
)
```

增加环境变量：

```ts
spawn(
"cmd",
args,
{

env:{

 ...process.env,


 COMMAND_CODE_SESSION:
 session.id,


 COMMAND_CODE_PERMISSION_BROKER:
 brokerAddress

}

}
)
```

---

# 10. NDJSON 增加解析

现在：

```
tool_running
message
usage
result
```

增加：

```
permission_request
```

例如：

command-code 输出：

```json
{
"type":
"permission_request",

"requestId":
"req001",

"tool":
{
"name":
"shell_command"
}

}
```

cmd-runner:

```ts
if(
 event.type===
 "permission_request"
){

 return await broker.handleRequest(
    event
 );

}

```

---

# 11. index.ts 初始化

现在：

```ts
const sessions =
new SessionStore();


const agent =
acp.agent();


connect();

```

改：

```ts
const sessions =
new SessionStore();



const permissionBroker =
new PermissionBroker();



await permissionBroker.start();



const agent =
createAgent({

 sessions,


 permissionBroker

});



connect();

```

---

# 12. 改造后的完整调用链

```
index.ts

启动

 |
 |
 +-- SessionStore

 |
 |
 +-- PermissionBroker


 |
 v


agent.ts


session/prompt


 |
 |
 v


cmd-runner.ts


spawn cmd


 |
 |
 v


command-code


beforeToolCall


 |
 |
 v


permission_request


 |
 |
 v


broker-server.ts


 |
 |
 v


pending-store


 |
 |
 v


ACP


session/request_permission


 |
 |
 v


Paseo


 |
 |
 v


response


 |
 |
 v


pending.resolve()


 |
 |
 v


command-code继续执行

```

---

# 13. Git Commit 拆分建议（方便 upstream）

不要一次提交。

建议：

## Commit 1

```
feat:
add ACP permission request abstraction
```

只包含：

```
permission/protocol.ts
pending-store.ts
```

容易合并。

---

## Commit 2

```
feat:
support client permission requests
```

包含：

```
agent.ts
```

---

## Commit 3

```
feat:
add external permission broker transport
```

这个可能不上游。

---

## Commit 4

```
feat:
command-code permission adapter
```

留 fork。

---

# 14. 第一版 MVP 实际修改量

预计：

| 文件               |   增量 |
| ---------------- | ---: |
| protocol.ts      |  80行 |
| pending-store.ts |  60行 |
| broker-server.ts | 120行 |
| agent.ts         |  50行 |
| sessions.ts      |  20行 |
| cmd-runner.ts    |  40行 |

总量：

**约 350 行。**

其中真正影响 ACP upstream 的：

约 120 行。

---
 