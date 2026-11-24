# OpenClaw 部署与联调记录

> 状态：历史验证证据。保留 2026-11-16 当时的成功、失败和待办；配置以[当前适配器教程](setup.md)为准，后续 GitHub 实测见[主动连接验证](outbound-validation-20261122.md)。

验证日期：2026-11-16。本记录区分实际运行证据、模板与尚未完成的 GitHub 联调。

## 实际运行环境

- OpenClaw `2026.11.3 (847611d)`，Node.js `24.22.1`；CLI 版本命令及 `config validate` 已通过。
- 使用独立容器 `github-channel-openclaw`、独立 Compose 网络、状态与缓存目录、专用 Gateway token。没有宿主端口映射。
- Provider 经部署者授权从既有实例配置复制，仅在服务器内处理。旧实例的配置、状态及容器未修改。
- `agents.entries.github` 是唯一业务 Agent；禁用内置工具、Skills、浏览器、自动任务和 memory 插件。Responses 请求携带 Channel 的 client function tools。
- 原始配置的 `agents.list/default` 被新版拒绝，已改为 keyed `entries`；临时缓存目录按容器 UID 独立挂载。

官方 GHCR 镜像层多次重试、Docker Hub 连接重置，因此本轮**实际采用官方 npm 包安装**，没有部署成功的官方镜像 digest 可以报告。隔离容器复用服务器已有基础镜像和只读 Node 安装，OpenClaw 安装到全新的 npm 目录；这不是复用旧 OpenClaw 进程。服务由服务器本地 `compose.local.json` 管理。

锁定包 `openclaw@2026.11.3` 的 npm integrity：

```text
sha512-FBq/q0TCaoA2b7qfdV0q81fHhI6RBB1zAQfJQREc1u2TlK5khVgCUsAlXskLWthyVqRz5PWEj+oOmfYgK58dHg==
```

当时的 `deploy/compose.yaml`（现已删除）使用官方 `slim` 镜像；它与这次 npm 备用部署不是同一个镜像构建路径。本轮只完成 Compose/Dockerfile 静态复核，尚未证明官方镜像构建及 Channel 容器联调通过。

## 已验证

1. 首次真实请求返回 `400 input: Invalid input`；已对照已安装源码的 `MessageItemSchema`，补齐 `type: "message"`。回归断言先失败、修复后通过。
2. 真实模型返回指定文本。
3. 真实模型发出 `read_issue`，Channel 回调返回合成 Issue，再通过 `previous_response_id` 继续请求并取得预期回答。`tools.deny: ["*"]` 没有妨碍该 client tool 路径。
4. 无 Gateway token 的 Responses 请求返回 HTTP 401。
5. 直接工具模式下，会话的 `systemPromptReport` 内置工具列表为空，两个 client tools 的实际回调成功；这是当前配置的运行证据，不将 Gateway token 本身误称为只读 token。
6. Docker 检查确认无宿主端口映射，实例只加入专用 bridge 网络；token 仍是 Gateway 级权限，不能将它描述为细粒度工具授权凭据。

重启后的双读取工具探针曾在 180 秒后超时，Connector 抛出 `AmbiguousExecution`，Gateway 日志记录 client disconnect。会话中的实际工具定义当时是 Tool Search 控制面。针对仅有两个 client tools 的场景，改为 `tools.toolSearch: false` 提供直接定义；该设置减少发现环节，不代表已经证明超时的唯一原因。修正后完整探针通过：指定文本、`read_issue`、`read_file` 与最终回答均成功；仍使用原 Provider 和 180 秒超时，没有靠放宽工具权限通过。

## 验证边界

真实模型测试的工具数据为合成 fixture，不是实际 GitHub Issue 或文件。用户尚未创建 GitHub App，完整签名 Webhook、installation/actor 权限、真实文件读取、评论回写和失权测试仍未验收。首版不支持写仓、创建 PR 或模型直接持有 GitHub token。

公开文档不保存服务器登录信息、Provider key、Gateway token 或本地私钥；后续复现使用自己的私网实例和凭据。运行方法见 [运行与恢复](operations.md)。
