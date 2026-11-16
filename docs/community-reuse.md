# 社区源码借鉴与选型

这里记录固定源码快照中的可复用机制，以及它们对本项目的适用边界。下列三个仓库均在本机已有真实 Git clone，本轮重新核对了 HEAD 和对应源文件；没有运行这些项目，也没有把其源码复制进本仓库。这是源码审阅证据，不是兼容性或生产验证。

## PR-Agent

复核提交：[`The-PR-Agent/pr-agent@62380ee26e628495861a1bd82d67609f2da495e9`](https://github.com/The-PR-Agent/pr-agent/tree/62380ee26e628495861a1bd82d67609f2da495e9)。

[`pr_agent/servers/github_app.py`](https://github.com/The-PR-Agent/pr-agent/blob/62380ee26e628495861a1bd82d67609f2da495e9/pr_agent/servers/github_app.py) 的 `get_body` 先获取原始 bytes、检查 secret、验证签名，再解析 JSON；入口记录 installation 上下文，通过后台任务或 Lambda handoff 分发。`handle_request` 使用 delivery ID 和带 TTL 的状态进行可配置去重。可以借鉴其入口职责拆分、签名前不信任正文、以 delivery ID 识别投递的设计。

本项目需要在返回受理前完成 SQLite 持久化，不能把该入口的后台任务及 TTL 内存状态直接当成持久 Inbox。PR-Agent 的 [`pr_agent/agent/pr_agent.py`](https://github.com/The-PR-Agent/pr-agent/blob/62380ee26e628495861a1bd82d67609f2da495e9/pr_agent/agent/pr_agent.py) 直接装配评论审查、描述、代码建议等命令及 AI handler，适合其 PR 产品；Channel 将推理交给用户已有 Runtime，因而没有引入这套命令与模型执行层。

## Probot

复核提交：[`probot/probot@7682a9ae49fca9ae8b1f7df06f4a201815be1e69`](https://github.com/probot/probot/tree/7682a9ae49fca9ae8b1f7df06f4a201815be1e69)。

[`src/create-node-middleware.ts`](https://github.com/probot/probot/blob/7682a9ae49fca9ae8b1f7df06f4a201815be1e69/src/create-node-middleware.ts) 装配应用和 Webhook handler；[`src/octokit/octokit-webhooks-transform.ts`](https://github.com/probot/probot/blob/7682a9ae49fca9ae8b1f7df06f4a201815be1e69/src/octokit/octokit-webhooks-transform.ts) 按事件生成认证 Octokit 与 Context。可以借鉴“认证后的事件上下文”这一装配方式，但 Channel 还要加入固定 repository ID、actor ID 和目标 Issue 的任务上下文。

[`src/octokit/probot-octokit.ts`](https://github.com/probot/probot/blob/7682a9ae49fca9ae8b1f7df06f4a201815be1e69/src/octokit/probot-octokit.ts) 明确组合 retry、throttling、分页及其他插件。对于常驻 App 很方便，但本项目最终评论写入不能在结果不明时自动重放，因此没有照搬整套默认客户端，也没有同时叠加 Probot 和 Octokit App 两层装配。持久任务、调用者授权与未知结果处理仍由 Channel 实现。

## Claude Code Action

复核提交：[`anthropics/claude-code-action@9fa68854da5fadef4ed3dce240325a0dfe251880`](https://github.com/anthropics/claude-code-action/tree/9fa68854da5fadef4ed3dce240325a0dfe251880)。

[`src/github/validation/permissions.ts`](https://github.com/anthropics/claude-code-action/blob/9fa68854da5fadef4ed3dce240325a0dfe251880/src/github/validation/permissions.ts) 中的 `checkWritePermissions` 通过 collaborator permission API 检查调用者权限；实现还包含特定 Bot 和显式配置的非写权限用户例外。它支持“事件触发”和“调用者是否有权启动执行”分开检查的设计。本项目只接收人类用户，未实现这些例外，并增加 API 用户 ID 与任务 actor ID 一致性核验。

[`src/github/token.ts`](https://github.com/anthropics/claude-code-action/blob/9fa68854da5fadef4ed3dce240325a0dfe251880/src/github/token.ts) 处理 Actions 环境中的 OIDC/提供的 token，权限需求包含 contents write。其 Actions runner 内执行方式与本项目的常驻 Channel 加外部 Runtime 不同，不能直接搬过来作为凭据隔离层；首版 Channel 的 contents 权限仅 read，Runtime 不获得 GitHub token。

## 本项目采用的基础设施

GitHub 接入直接依赖 `@octokit/app`、`@octokit/webhooks` 和 `@octokit/core`。使用官方 SDK 完成 App JWT、installation token 与 Webhook 验签，不自行实现这些协议。版本由仓库 lockfile 固定。

当前 App SDK 的 `getInstallationOctokit` 仅接受 installation ID；实现另外调用 installation `auth`，显式传入 `repositoryIds` 和 permissions，再构造持有收窄 token 的 core 客户端。最终写评论路径没有 retry 插件，也避开 App auth hook 自行刷新 token 后重发请求。fake transport 测试检查实际 token 请求参数及写入次数；这不能代替真实 App 权限与安装测试。

三个项目提供了具体机制参考，但 Channel 的持久 Inbox、固定任务范围、工具级重新授权、结果先落盘和 unknown 人工核对，是本仓库自己的实现与验收责任。长期写仓、PR 创建、更多 Runtime 和管理控制台仍按后续里程碑推进。
