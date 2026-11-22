# 实施与验证记录

> 状态：历史进度日志。以下“尚未创建 App”、测试数与“下一步”只适用于其记录阶段，不是当前状态。后续真实回帖证据见[主动连接验证记录](outbound-validation-20261122.md)，当前功能见[能力台账](capabilities.md)。

## 2026-11-22 配置与部署升级

新增 File/Env 密钥引用、统一 CLI、配置驱动的 external/Caddy 部署生成、生成目录保护及 Nginx 路由片段。Docker 构建上下文改为源码白名单。CLI 支持 Compose 插件版本检查、后台健康等待、保留卷停止。

单元与原有集成测试已跑通；真实隔离容器验收新增 `scripts/smoke-deployment.mjs` 并纳入 CI。隔离容器验收已通过，见 [验证记录](deployment-validation-20261122.md)；不能从本段推断真实 GitHub App 回帖已通过。

用户已安装 App 并选定复用现有 HTTPS 网关；此前“尚未创建 App”的陈述属于下面 11 月 16 日的历史状态。具体服务器部署资料保留在 Git 忽略的本机文件中。

## 2026-11-16 基础实现记录

2026-11-16：创建公开仓库，开发分支为 `codex/v1-foundation`。当前交付 M1–M3 的分析与回帖基础；Git 写仓、创建 PR、多实例和异步恢复属于后续工作。

## 本地验证

- 配置、SQLite、Webhook、GitHub client、Connector、Worker 和 HTTP 管理接口已实现。
- `npm run format:check`、`npm run typecheck`、`npm run build` 通过。
- `npm test`：41 项通过，0 失败。使用真实 SDK 和 SQLite；GitHub/Runtime 使用 fake transport 或 fake client。签名 Webhook 与管理接口测试使用本地 HTTP 服务。
- 先写缺失实现/回归测试，观察失败，再实现或修复并观察通过。
- 独立评审发现并修复：回帖 unknown 未锁住 binding；HTTP 408/仍在运行被误记终态。补充 pending/sending/unknown 回帖阻塞、人工对账、PR 评论 URL 以及非终态 Runtime 回归。
- 独立复核：store/connector/server/worker 27 项定向测试通过，没有再发现上述提前放行路径。

## 远端验证

已隔离部署 OpenClaw `2026.11.3 (847611d)`，Node `24.22.1`。因官方镜像拉取失败，实际采用官方 npm 包在独立容器安装；不能宣称官方镜像部署已验证。Provider 经授权仅在服务器复制，旧实例未修改。

真实模型文本、`read_issue` 和 `read_file` 多轮续调用已通过；无 token 请求返回 401，Gateway 无宿主端口映射。联调发现并修复输入消息缺少 `type: "message"` 以及新版 `agents.entries` 配置兼容问题。详见 [部署与联调记录](deployment-validation.md)。

真实 GitHub App 尚未创建。用户已明确本轮先完成 OpenClaw 联调，并准备 App 配置步骤。因此真实 GitHub Webhook → Runtime → 评论的闭环未验收；不会以 fake 测试替代。

## 下一步验收

1. 已验证隔离 Gateway 配置和实际版本。
2. 已运行 `scripts/smoke-openclaw.mjs`，真实模型文本与两个 client function tools 的多轮续调用通过；工具返回合成数据，不访问 GitHub。
3. 用户创建并安装 App、提供 HTTPS Webhook 入口后，按 [运行说明](operations.md)接入并验证真实 GitHub 路径。
