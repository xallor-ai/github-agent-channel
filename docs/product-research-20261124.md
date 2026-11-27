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

## 2026-11-25 补充：评审是否要在执行端同步仓库

| 官方证据 | 观察 | 采用的决定 |
| --- | --- | --- |
| [PR-Agent GitHub provider（固定提交）](https://github.com/The-PR-Agent/pr-agent/blob/711199823081f9951b8e97181fefff078e434f82/pr_agent/git_providers/github_provider.py#L639-L681) | 从 PR 文件、patch 和变更前后内容准备材料，必要时解析共同祖先。 | 普通差异评审用授权 API 即可，不强制所有运行时 clone。 |
| [CodeRabbit 沙箱](https://www.coderabbit.ai/blog/our-security-posture-how-we-safeguard-your-repositories) · [评审上下文](https://www.coderabbit.ai/blog/explainable-reviews-coderabbit-review-context-engine) | 厂商说明每次评审在隔离环境克隆源码，结合差异追查跨文件影响。 | 深度评审默认有任务专属的只读源码视图；不照搬其代码图或商业平台。 |
| [Claude Code Action 综合评审示例（固定提交）](https://github.com/anthropics/claude-code-action/blob/4411a9e9b0283becf4b924f7bce360fd7756c78c/examples/pr-review-comprehensive.yml#L4-L31) | opened/synchronize 等触发后，runner 先浅检出再运行 Agent。 | 一棵完整源码树不要求完整历史；检出引用仍须与任务 SHA 独立核对。 |
| [GitHub Copilot Code Review](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review) | 官方将全项目上下文列为依赖 runner 的增强能力；runner 不可用时评审范围受限。 | 告知用户实际覆盖范围，不从公开产品描述推定其内部同步方式。 |

上述材料是公开实现或厂商说明，不是本仓的运行证据。[OpenClaw workspace](https://docs.openclaw.ai/agent-workspace) 是工作目录，本身不是硬隔离边界。因此不为每个绑定仓库在 OpenClaw 默认目录中维护一份可写副本；具体交付见[实施方案](superpowers/plans/2026-11-25-pr-review-context.md)。
