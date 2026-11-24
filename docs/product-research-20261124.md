# 选型依据：GitHub Agent Channel（2026-11-24）

结论已纳入[产品契约](product-contract.md)。以下是官方资料与固定版本源码的比较；没有部署或测评竞品。

| 对照对象 | 可复核的观察 | 对 Channel 意味着什么 |
| --- | --- | --- |
| [OpenCode 1.3.17 GitHub 实现](https://github.com/anomalyco/opencode/blob/517e6c9aa4c61dbc125e7654fc596f1d529f20d9/packages/opencode/src/cli/cmd/github.ts#L569)及[行内上下文](https://github.com/anomalyco/opencode/blob/517e6c9aa4c61dbc125e7654fc596f1d529f20d9/packages/opencode/src/cli/cmd/github.ts#L755) | 按入口区分：Issue 走新分支，PR 上区分同仓和 fork；行内评论取路径与 diff hunk。与本项目已验收的 harness 版本相同，运行路径不同 | 可直接使用的单运行时替代品。借鉴“同一 PR 上继续工作”和行上下文；不要把 Action 的写权限和推送环节再叠加到 ACP 发布器上 |
| [OpenClaw 固定提交的路由文档](https://github.com/openclaw/openclaw/blob/862c71e4cda9538927c678535b955b819aa9716b/docs/channels/channel-routing.md#L64) | 回复与来源频道关联，Slack/Discord 线程有独立会话键，路由有绑定规则 | GitHub 也需要可信回复地址。仓库 A 的 #12 不是 B 的 #12，PR 总讨论不是行内线程；不能让模型选回写地址 |
| [Linear Agent Interaction](https://linear.app/developers/agent-interaction) | 新指令可进入已有 Agent Session；提问和用户回答是显式活动，能区分主指令线程与其他上下文 | 引用说明、用户新指令、Agent 等待澄清应区分。借行为而非照搬 Linear 对象；GitHub 评论中引用的文字不能自动成为命令 |
| [GitHub Agentic Workflows：Safe Outputs](https://github.github.com/gh-aw/reference/safe-outputs/)及[分支策略 ADR](https://github.com/github/gh-aw/blob/b1c6690e5a0869383946c6f82d7a97aecefe983d/docs/adr/33610-allowed-branches-enforcement-for-create-pull-request.md) | 独立作业执行声明允许的写入；ADR 区分源分支与目标分支授权。ADR 是设计依据，不是部署证明 | 佐证现有 outcome → 策略 → receipt 设计。完全以 Actions 为环境的团队应比较直接采用 gh-aw；内网出站通道不必引入其工作流编译器 |
| [GitHub Reviews](https://docs.github.com/en/rest/pulls/reviews) 与 [Checks](https://docs.github.com/en/rest/checks/runs) | 原生 review 有独立对象与状态；check run 对应具体提交；fork 的 check suite 可能没有关联 PR | 普通评论、本地验证和 GitHub Checks 分开显示。无法确认关联 PR 时不自动修复，更不能将历史绿灯归给新提交 |
| [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) | 新会话、更新、取消与可选的加载会话是不同能力 | 保存 GitHub 工作记录；不强制所有 Runtime 能透明恢复，也不把发出取消当作进程已退出 |

本仓对照：在 `e9361f2` 的[真实验收](acp-live-validation-20261124.md)中，OpenCode 经 ACP 完成编码并创建 PR；评审仍需手贴 diff，且测试期间手动切换了 worker。因此优先补版本上下文和同一 PR 续改，不以新增事件数量衡量进展。
