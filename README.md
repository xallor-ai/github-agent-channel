# GitHub Agent Channel

把 GitHub Issue / PR 普通评论中的明确 `@mention` 交给用户已有的 Agent Runtime 分析，再由 Channel 受控回帖。OpenClaw 是第一个 Connector；GitHub 接入、授权和任务状态由 Channel 管理。

当前版本是**读取、分析、回帖的基础实现**。模型只能调用 `read_issue` 和 `read_file`，最终评论由 Channel 发布。它尚不能修改文件、创建分支或 PR、运行 Git/Shell、合并代码，也不提供管理控制台或远端任务恢复。

## 工作方式

```text
GitHub 签名事件 → binding 与 mention 校验 → SQLite 持久任务 → 快速返回 202
  → 调用者仓库权限校验 → OpenClaw Responses → 受限读取 → 持久结果 → GitHub 回帖
```

- 仅处理 `issue_comment.created`，包括 PR 会话区普通评论；编辑、Bot、自身评论和 PR 行内 review comment 不触发。
- Binding 同时固定 installation ID、repository ID、owner 和 repo；调用者必须是评论作者，且当前拥有 `admin`、`maintain` 或 `write` 权限。
- 每次工具调用和回帖都会重新授权；模型参数不能覆盖仓库、调用者或目标 Issue。
- 按 delivery 与原评论去重。一个 binding 有运行中或结果不明的任务时，后续任务等待；当前单 worker 实际逐个处理全局任务。
- 仓库正文作为不可信数据返回。GitHub token 留在 Channel 内，Runtime 不接收它。
- 超时或进程中断可能留下 `unknown`，需要人工核对；没有“恰好一次”外部执行保证。

## 启动

需要 Node.js 24、GitHub App 安装，以及可用的 OpenClaw Responses 服务。

1. 按[运行与恢复说明](docs/operations.md)配置 GitHub App、密钥环境变量和私网 Runtime。
2. 将 [deploy/channel.example.yaml](deploy/channel.example.yaml) 复制为仓库外或 Git 忽略的 `config.local.yaml`，填写真实的 App、binding 和 Runtime 信息。示例使用容器路径和服务名；直接运行 Node 时，把 `dataFile` 改为本机可写路径（如 `./data/channel.db`），`runtime.baseUrl` 改为本机可达的 Gateway 地址，`server.host` 优先改为 `127.0.0.1`。
3. 在仓库根目录执行：

```sh
npm ci
npm test
npm run typecheck
npm run build
npm start
```

默认读取当前目录的 `config.local.yaml`；可通过 `CHANNEL_CONFIG` 指定其他配置文件。配置里的 `*Env` 字段是环境变量名称，不是密钥值。容器入口见 [deploy/compose.yaml](deploy/compose.yaml)：默认仅启动 OpenClaw，Channel 需要显式启用 `channel` profile；部署前先阅读私网与持久卷要求。

GitHub App Webhook 指向 `https://<your-domain>/webhooks/github`。公网反向代理只转发该路径；`/tasks/*` 管理接口仅供回环或私网访问。`GET /healthz` 只证明进程存活。

## 验证与边界

本地 41 项测试及 Linux CI 已通过，覆盖真实 SDK、SQLite、签名 HTTP、权限、去重、恢复与回帖歧义；GitHub API 使用 fake transport。另已在隔离 OpenClaw 2026.11.3 上通过真实模型文本与 client tool 续调用验证，详情见[部署与联调记录](docs/deployment-validation.md)。尚未创建 GitHub App，因此真实 GitHub 到回帖的完整闭环仍未验收。测试结果与待完成项见[进度记录](docs/progress.md)。

[长期架构](docs/architecture.md)描述未来的 Connector、Policy、Git Executor 和管理面；当前交付范围以本 README、[实施计划](docs/implementation-plan.md)及实际代码为准。[社区源码复用说明](docs/community-reuse.md)记录基础库选择与未直接采用的产品机制。
