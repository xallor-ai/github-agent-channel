---
name: github-agent-channel
description: 在 GitHub Agent Channel 中委派仓库任务、发起指定版本的评审或核验机器人回执时使用。
---

# 使用 GitHub Agent Channel

1. **选对任务与能力。** 确认目标仓库、Issue/PR 编号、已启用的触发事件和绑定的 Runtime。分析和编码是不同能力；不要向只读适配器委派改代码，也不要把普通回帖当作 GitHub Review。参见[能力台账](../../../docs/capabilities.md)。
2. **以 GitHub 当前状态为准。** 有 Git 工作区时先执行 `git fetch --prune origin`。对已有 PR，用 `gh pr view NUMBER --repo OWNER/REPO --json state,baseRefName,baseRefOid,headRefName,headRefOid,headRepositoryOwner` 或等效 API 核对双方仓库、分支和版本。只有目标 PR 仍为 OPEN 才能续办。提交或发布前重新检查；远端发生变化时先重看差异、保留维护者提交。已关闭、已合并或无法核实时，不向旧分支推送、不在旧 PR 触发评审或回帖。新工作从最新授权基线开始。
3. **把版本交给评审者。** 在已获授权的开放线程中，提供仓库、base/head SHA、评审问题和这两个版本的实际差异。先确认推送后的远端 head；适配器无法读取差异时，附相关 diff 并明确覆盖范围。不要用默认分支文件代替目标版本，不要自行扩大线程或发布权限。
4. **核验交付。** 用 GitHub 投递或触发评论定位 Channel 任务，核对其 Runtime、发布回执与实际 GitHub 评论或 Draft PR。分清执行成功、发布成功与代码验证通过。结果未知时按[运维对账步骤](../../../docs/operations.md)核查，不要再次 @ 或重发。未取得证据时注明缺少哪一环。
