# 实施与验证记录

2026-11-16：创建公开仓库，开发分支为 `codex/v1-foundation`。当前交付 M1–M3 的分析与回帖基础；Git 写仓、创建 PR、多实例和异步恢复属于后续工作。

## 本地验证

- 配置、SQLite、Webhook、GitHub client、Connector、Worker 和 HTTP 管理接口已实现。
- `npm run format:check`、`npm run typecheck`、`npm run build` 通过。
- `npm test`：41 项通过，0 失败。使用真实 SDK 和 SQLite；GitHub/Runtime 使用 fake transport 或 fake client。签名 Webhook 与管理接口测试使用本地 HTTP 服务。
- 先写缺失实现/回归测试，观察失败，再实现或修复并观察通过。
- 独立评审发现并修复：回帖 unknown 未锁住 binding；HTTP 408/仍在运行被误记终态。补充 pending/sending/unknown 回帖阻塞、人工对账、PR 评论 URL 以及非终态 Runtime 回归。
- 独立复核：store/connector/server/worker 27 项定向测试通过，没有再发现上述提前放行路径。

## 远端验证

服务器隔离部署进行中：独立容器、状态目录、Gateway token 和网络。经用户明确授权，仅在服务器内复制现有模型 Provider 配置；不把凭据同步到仓库。

官方 GitHub Release 与 npm `latest` 均核验为 OpenClaw `2026.11.3`。镜像下载遇到连接重置和层重试，另用官方 npm 包尝试在隔离容器安装该版本。最终部署版本、验证结果和安装路径待实际完成后补充，不能将下载或容器存活等同于可用。

真实 GitHub App 尚未创建。用户已明确本轮先完成 OpenClaw 联调，并准备 App 配置步骤。因此真实 GitHub Webhook → Runtime → 评论的闭环未验收；不会以 fake 测试替代。

## 下一步验收

1. 验证隔离 Gateway 配置和实际版本。
2. 运行 `scripts/smoke-openclaw.mjs` 验证真实模型文本与 client function tool 续调用；工具返回合成数据，不访问 GitHub。
3. 用户创建并安装 App、提供 HTTPS Webhook 入口后，按 [运行说明](operations.md)接入并验证真实 GitHub 路径。
