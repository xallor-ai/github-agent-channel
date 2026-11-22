# 通用 Channel 实现纠偏

状态：按用户“那就修正”授权实施，基线 `6c51ead`。按用户明确要求直接采用新契约，不保留兼容层；不自动部署或创建开发 PR。

## 设计约束

- 核心负责 GitHub 身份、事件、任务、授权、持久性和受控发布。Runtime 负责模型、编辑、项目执行；不得在 Channel 中实现新的编码 Agent 循环。
- Runtime 工厂按 `runtime.type` 装配；type 必填，缺少或未知类型直接拒绝。新增 `acp` 适配器使用官方 `@agentclientprotocol/sdk@2.9.1`，通过受控主机配置启动已有 ACP Agent；不自研 JSON-RPC。
- ACP 使用管理员预配置的 repositoryId→本地 Git 工作区映射。命令、cwd、认证环境引用和验证命令来自本机配置，不接受事件中的替换。工作区必须干净且 origin 与任务仓库一致，调用前记录 HEAD，调用后收集文件变更。并发/多租户工作区管理不在本轮引入。
- Runtime 返回文本、结构化 artifacts 和必需的 publication。文本是说明，不是代码产物或测试通过证据；验证结果来自受控验证命令。发布请求的 owner/repo/actor 永远从任务获取。
- 目标对象为 issue、pull_request 或 repository；来源为事件/action。target/source 必填；删除根级 commentId/issueNumber/result/commentUrl 字段。只建立新的 SQLite schema v2，旧库拒绝打开，不迁移、不删除。
- 默认仍仅响应显式评论提及。bindings.events 可显式启用 issues.opened（提及）、issues.labeled（配置标签）、PR opened/synchronize、push；未配置事件忽略。每次领取和发布仍重查人类发起人权限。
- 发布类型是 comment、none、pull_request。代码 PR 必须有 binding.writePolicy 显式启用；固定 baseBranch、允许路径、数量/大小约束。服务端派生任务分支，不写默认分支、不自动合并、不允许修改 workflow/.git。
- 复用 Octokit Git Data/PR API 实现最小发布适配，不复制 GitHub SDK。结果不明→unknown；不自动重放外部写入。GitHub 官方 MCP 的 push_files schema 不包含期望 base SHA，不能原样替代本项目发布策略。
- 运行事件记录 Runtime run/session handle；适配器能力如 cancel/resume 必须如实声明。发送 cancel 不等于已停止；不支持断线恢复的 Runtime 仍保守 unknown。

## 共享接口

`RuntimeResult` 必须有 `text: string`、`artifacts: Artifact[]` 和 `publication: PublicationRequest`；可含适配器的 `responseId`。成功结果在传输/存储中统一为 `{status:"succeeded", outcome}`。

```ts
type ChangedFile = { path: string; content: string | null };
type Artifact =
  | { kind: "text"; name: string; text: string }
  | { kind: "link"; name: string; url: string }
  | {
      kind: "test_report";
      name: string;
      command: string;
      exitCode: number | null;
      summary: string;
    }
  | { kind: "change_set"; name: string; baseSha: string; files: ChangedFile[] };
type PublicationRequest =
  | { kind: "comment" }
  | { kind: "none" }
  | {
      kind: "pull_request";
      title: string;
      body: string;
      baseBranch: string;
      baseSha: string;
      files: ChangedFile[];
    };
type RuntimeEvent = { kind: "started"; runId: string; provider: string };
```

`RuntimeConnector.run(task, invoke, signal?, onEvent?)` 接受规范 Task 并返回规范 outcome，onEvent 必须 await 落盘。`capabilities` 描述 provider、readTools、workspace、cancel、resume；不支持的恢复能力不伪造。

`GitHubClient.publishPullRequest(task, request)` 返回 `{id,url}`；只有显式 PR publication 才调用。评论使用明确的 `publishComment(task,text)`。每个适配器必须显式选择 publication，不允许缺失字段或服务端回退推断。产物可独立保存，不要求总是发评论。

`Binding.writePolicy` 为 `{baseBranch:string, allowedPaths:string[], maxFiles?:number, maxBytes?:number}`。没有 policy 就拒绝 PR。检查基线等于远端指定分支 HEAD；每次外部写入前重新授权。

## 复用证据与取舍

| 来源                                                                                                                                                | 已核对实现                                                                | 本轮使用方式                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)                                                                         | npm 2.9.1 的 app API、session/new、prompt、更新与取消                     | 直接依赖官方 SDK；已有 harness 执行编码                                      |
| [GitHub MCP repositories.go](https://github.com/github/github-mcp-server/blob/9a72d8d38fec18c207cd924b33aa0eb3e186252c/pkg/github/repositories.go)  | push_files→tree/commit/ref，参数由调用方传 repo/branch，未带期望 base SHA | 借鉴 API 路径；本轮保留任务级 scope 与基线校验，不直接暴露广泛工具           |
| [Claude file ops](https://github.com/anthropics/claude-code-action/blob/acfe7992852970efb4fee683d63d628e3e52df67/src/mcp/github-file-ops-server.ts) | 仓库/分支来自进程上下文，文件来自工作区                                   | 采用“编辑归 Runtime，发布有独立上下文”的边界                                 |
| [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk/blob/74f198df3650da6399c6a0a2dff6272a667bbace/README.md)                            | 工作区、会话、Agent Server 与 automation 分工                             | 不复制工作区平台/模型循环；本轮只做已有工作区的接入约束                      |
| [create-pull-request](https://github.com/peter-evans/create-pull-request/blob/3ffccacd46053766916f087ce41d627c0b8cf2d1/src/create-pull-request.ts)  | Actions 工作区变化→提交/分支→创建/更新 PR                                 | 可作为未来 Actions backend；当前服务端不具有 Actions runner 环境，不强行套用 |

这是实现所需的窄范围选型；更广泛的产品比较仍需单独报告，不声称已运行上述产品。
