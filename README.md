# GitHub Agent Channel

让内网Agent参与GitHub协作，无需为内网开放端口。ECS接收并保存GitHub Webhook，内网连接器主动HTTPS领取任务，调用本机OpenClaw，再把结果交给ECS受控回帖。GitHub私钥始终留在ECS。

```text
GitHub ──签名Webhook──▶ Channel服务 ──受控回帖──▶ GitHub
                             ▲
                             │ 内网主动HTTPS：领取 / 工具请求 / 结果
                             │
                      本仓库连接器 ──本地请求──▶ OpenClaw
```

OpenClaw是第一个Runtime适配器。本仓库提供独立连接器进程，并非OpenClaw内置GitHub插件。当前支持读取Issue/同仓文件与分析回帖，不支持修改代码、创建PR或merge。

## 配置文档

| 文档                                     | 什么时候读                                                 |
| ---------------------------------------- | ---------------------------------------------------------- |
| **[完整接入主线](docs/setup.md)**        | 从准备OpenClaw、配置连接器到真实GitHub回帖，按顺序完成闭环 |
| [ECS自建部署（可选）](docs/ecs-setup.md) | 没有现成Channel服务，或需要自己维护公网入口时              |
| [运行与恢复](docs/operations.md)         | 日志排错、secret权限、更新回滚、备份与unknown对账          |
| [架构与边界](docs/architecture.md)       | 理解云端/内网职责、身份和幂等保证                          |

GitHub App的注册、权限、安装与事件订阅引用配套书稿[附录 B](https://github.com/xallor-ai/modern-github-book/blob/main/%E7%AC%94%E8%AE%B0/%E7%8E%B0%E4%BB%A3%20GitHub%EF%BC%9A%E9%99%84%E5%BD%95%20B%20GitHub%20CLI%E3%80%81API%20%E5%92%8C%20GitHub%20App.md)，Webhook验签与事件接收引用[附录 C](https://github.com/xallor-ai/modern-github-book/blob/main/%E7%AC%94%E8%AE%B0/%E7%8E%B0%E4%BB%A3%20GitHub%EF%BC%9A%E9%99%84%E5%BD%95%20C%20Webhook%20%E4%B8%8E%E4%BA%8B%E4%BB%B6%E6%8E%A5%E6%94%B6.md)。配置主线保留本服务所需的交接参数，不重复维护注册教程。

## 从哪里开始

需要Node.js 24；容器方式需要Compose插件2.20+。OpenClaw已验证版本为2026.11.3。当前主动连接实现位于 `codex/outbound-connector` 分支，尚未自动合并到默认分支：

```sh
git clone --branch codex/outbound-connector --single-branch https://github.com/xallor-ai/github-agent-channel.git
cd github-agent-channel
npm ci --ignore-scripts
```

**已有Channel服务**：取得服务origin和connector token，从[主线](docs/setup.md)准备OpenClaw，然后：

```sh
npm run channel -- agent init ./agent-data
# 按主线编辑YAML、放置secret并完成模型探针后：
npm run channel -- agent check ./agent-data/agent.local.yaml
npm run channel -- agent run ./agent-data/agent.local.yaml
```

**需要自建**：先按[可选ECS文档](docs/ecs-setup.md)启动Channel与HTTPS入口，再回到主线。内网不持有GitHub PEM，ECS不需要访问内网OpenClaw。

配置示例：[云端 YAML](deploy/channel.example.yaml)、[内网 YAML](deploy/agent.example.yaml)、[OpenClaw完整实例模板](deploy/openclaw.example.json)、[已有专用实例的合并片段](deploy/openclaw.channel.patch.json)。占位符必须替换，不能把示例当作已安装环境。

## 开发与验证

```sh
npm test
npm run typecheck
npm run build
npm run format:check
npm run smoke:deployment
```

模型探针 `npm run smoke:openclaw` 会实际调用Provider，应先按主线配置本地Gateway token；它使用合成工具数据，不访问真实GitHub。容器冒烟和单元测试同样不能替代公网验收。

已完成一个绑定仓库的真实GitHub → ECS → 内网OpenClaw → 回帖和重投去重验收，见[记录](docs/outbound-validation-20261122.md)。只有符合规则的 `issue_comment.created` 会启动任务，其他订阅事件不会自动激活能力。当前单云实例对应单可信连接器身份；不宣称多租户隔离、任意写仓或外部执行恰好一次。
