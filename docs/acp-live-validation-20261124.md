# v2 真实编码与事件验收（2026-11-24）

本次使用实际 GitHub App、HTTPS 服务端、内网出站 bridge 和已安装的编码 harness。日期为北京时间，GitHub 投递日志使用 UTC。不是 fixture 或合成模型验收。

## Issue → 代码 → 验证 → PR → Channel 评审

| 环节 | 实际证据 |
| --- | --- |
| 需求 | [Issue #3](https://github.com/xallor-ai/github-agent-channel/issues/3)，限定补充两个工具序列回归测试 |
| 输入基线 | `9592d8c9c5e7ba35b40b04f3ff01e30489f1f4fc`，正常独立 clone，工作区初始干净 |
| harness | 已安装 OpenCode 1.3.17，`opencode acp --pure`，官方 ACP SDK；模型 `mtcode/gpt-5.6-terra` |
| 授权 | 仅 `tests/connector.test.ts`，最多 1 文件；固定 baseBranch `codex/outbound-connector`；临时显式启用 writePolicy |
| 任务 | `7dd476e7-a059-4e04-8fd5-4807f6874347`，真实 ACP session `ses_df6dbbaedffek8xxRBVlO0f5fp` |
| 实际产物 | harness 修改测试文件，Channel 收集真实内容；+63 行，未修改生产代码/依赖/工作流 |
| 独立验证 | Channel 在 harness 完成后运行管理员验证脚本：typecheck、format:check、完整 npm test；观察到 exit 0，验证前后候选内容一致 |
| GitHub 发布 | Channel 以 App 身份创建 [PR #4](https://github.com/xallor-ai/github-agent-channel/pull/4)，head `ccf672dd941dda06268e598c491a13993d64ae14`，任务分支由服务端生成 |
| CI | [push 检查](https://github.com/xallor-ai/github-agent-channel/actions/runs/45212178584) 与 [PR 检查](https://github.com/xallor-ai/github-agent-channel/actions/runs/45212196844) 均成功，包括 Docker smoke |
| Channel 复核 | PR 会话评论提供明确 head/base 与完整 diff；任务 `d57f4394-92a4-4930-822c-b84365665769`；[机器人评审](https://github.com/xallor-ai/github-agent-channel/pull/4#issuecomment-7106616292) 未报告确认问题 |
| 最终状态 | 编码与评审任务均 succeeded/sent，本地 journal 均 reported；真实投递重投未创建第二个 PR |

两个新增测试调用实际 Connector，只替换模型 transport：第一次合法读取已发生后，重复 call ID/未知工具导致失败，非法第二次调用未执行。审查结果经人工核对，不把模型评价当作测试结果。验证日志有长度限制，保存的片段不是完整运行日志；exit code 和外部 CI 分别记录。

## 已实现事件逐项检查

临时启用全部六个已实现的 binding 事件，不代表支持全部 GitHub events。Issue/PR 使用只读 OpenClaw；push 成果保存到 outcome，不发布无目标评论。

| 事件 | 任务 | 结果 |
| --- | --- | --- |
| issue_comment.created（Issue） | `7dd476e7-a059-4e04-8fd5-4807f6874347` | 真实编码并发布 PR #4 |
| issue_comment.created（PR） | `d57f4394-92a4-4930-822c-b84365665769` | PR #4 评审回帖 |
| issues.opened | `24157dbc-bb29-4ad3-be21-77b473b7eaf9` | Issue #5 succeeded/sent |
| issues.labeled | `f0ad7577-c785-43cb-9169-a09e68d88d3e` | 指定标签触发，Issue #5 succeeded/sent |
| pull_request.opened | `146edc35-bfaa-4a66-8ee2-0df603cda153` | 临时 PR #6 succeeded/sent |
| pull_request.synchronize | `b7be4f44-97d7-452f-9fb4-9fa902699afc` | 实际推进临时分支，PR #6 succeeded/sent |
| push | `a42e7b32-98c3-44a4-a5d9-0a6a044165a7` | 修复版 5af232e 的真实推送，succeeded/skipped，outcome 保留分析、publication none |

## 验收发现与修正

两条原始 push 任务 `ef603303-c4aa-4239-aa6e-886d187c787a`、`ce38ca15-0800-438c-b139-780afd7408ec` 失败，不能记为通过。Webhook 正确建 repository 任务，但 OpenClaw 适配器仍提供 `read_issue`；真实模型选择该工具，服务端因不存在 Issue scope 返回 403。单独真实模型探针再次观察到 `read_issue`，证实原因。

修正直接按 target 限制可见工具与调用校验：repository 仅提供 read_file；Issue/PR 保持两种读取。明确仓库分析不发评论、read_file 仍读取默认分支。不存在兼容别名、重试失败任务或伪造 Issue scope。两个回归用例先失败后通过，覆盖多轮工具列表、结果 none 和模型自造 read_issue 的本地拒绝。

修复提交 `5af232e`：Windows 全量串行测试 155/155，类型、构建、格式通过；[Linux CI](https://github.com/xallor-ai/github-agent-channel/actions/runs/45216005258) 包含 Docker smoke。部署后真实 push 已通过。

随后通过 Channel 发送准确 diff 进行评审，任务 `77fc0076-d0c6-42ef-8686-56042c7cf1f5` succeeded/sent；[评审回帖](https://github.com/xallor-ai/github-agent-channel/issues/2#issuecomment-7107097150) 同时验证真实 read_file 成功读取 package.json。模型建议 repository 使用明确 read_file 白名单，已在 `4476a4d` 采纳（相同工具集合下行为不变），11 项 Connector 测试通过。模型声称未测试额外工具暴露并不准确：回归用例精确比较每一轮工具列表，多暴露工具会导致断言失败。[复核回帖](https://github.com/xallor-ai/github-agent-channel/issues/2#issuecomment-7107193084) 已纠正此项，并确认未发现阻塞问题；任务 `57c37f98-0218-4c9f-a56b-89fb87a13bb7` succeeded/sent。最终代码 `4476a4d` 的 [CI](https://github.com/xallor-ai/github-agent-channel/actions/runs/45216730083) 独立验证全量检查。该版本再次真实 push，任务 `fbceef0f-5fa7-4dd2-94af-077545b4daf8` succeeded/skipped，没有复跑原失败任务。

## 部署清理与范围

两台主机的旧 v1 容器、outbound-b458603 镜像和 b458603 发布目录均已删除。旧状态卷作为隔离历史数据保留，没有旧服务、迁移代码或回退入口；共享密钥仍被 v2 使用。专用 OpenClaw 容器继承的无关 MCP /sse 健康检查被替换为实际 Gateway /healthz，实际检查 healthy。被替代的 dd8111c/5af232e 部署目录和镜像也已移除；当前两端运行 4476a4d，原生 ACP CLI 同步为该版本。

临时 PR #6 已关闭、临时分支已删除；Issue #5 已关闭、测试标签已删除。PR #4 保留真实编码成果与评审证据，已从 draft 标为 ready for review，未合并。

原生 ACP 不是 OS sandbox，模型和 harness 的行为仍由既有工具承担。单可信 worker、独立准备工作区、无自动重放未知执行等边界保持不变。本次只验收明确实现的范围；PR review API、行内建议、自动 merge、多租户等未实现功能没有冒充通过。

## 验收后的运行状态

恢复测试前配置：binding 未显式启用 events，因此只处理符合条件的评论；writePolicy 关闭，常驻 bridge 为 OpenClaw。临时 ACP bridge 已停止，ACP 工作区保留实际变更供检查；下次编码需按 ACP 指南准备干净工作区并显式启用两端 PR 策略。验收通过不等于长期开放自动写仓。

已实现范围的事件路由、两种 runtime、真实编码/验证/PR、Channel 评审和重投去重均有上述证据。权限撤销、网络丢响应、重启未知执行等故障路径通过自动化测试，未在真实服务上破坏性注入。未实现能力继续在台账标记未实现；不声称所有 GitHub 场景或所有 ACP harness 均已验收。

最终部署检查：云端 schema 2、0 个 queued/running/unknown 或发送中任务；10 个 succeeded/sent、2 个 succeeded/skipped，保留最初 2 个失败 push 记录。OpenClaw journal 13 项全部 reported，ACP journal 的编码任务单独 reported。未签名 webhook 返回 400、未认证 v2 claim 返回 401、旧 v1 claim 返回 404。当前 Channel 镜像只保留 v2-4476a4d。开发分支与默认分支的 merge-tree 检查无冲突；PR #4 为 MERGEABLE/CLEAN，未执行合并。
