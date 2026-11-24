# GitHub Agent Channel

面向不同 Agent Runtime 的通用 GitHub 协作通道：负责 GitHub 事件接入、授权、任务传递与结果发布，执行由用户选择的 Runtime 承担。OpenClaw 是第一个适配器。

当前实现通过 Channel 服务端接收并保存 Webhook，内网连接器主动 HTTPS 领取任务，再调用显式选择的 OpenClaw 或 ACP Runtime。GitHub App 私钥保留在服务端。服务端可以自建于 ECS，也可以由已有部署提供；内网无需开放入站端口。

```text
GitHub ──签名Webhook──▶ Channel服务 ──评论/PR──▶ GitHub
                             ▲
                             │ 内网主动HTTPS：领取 / 工具请求 / 结果
                             │
                      本仓库连接器 ──适配器──▶ Runtime（OpenClaw / ACP）
```

当前提供独立出站 bridge。OpenClaw 适配器用于读取分析；ACP 适配器复用现有编码 harness，收集实际文件变更和验证结果，服务端按显式策略创建 draft PR。配置、任务和结果使用严格 v2 契约，不兼容旧版。真实编码建 PR 已验收；同一 PR 续改仍是[产品契约](docs/product-contract.md)中的目标。

## 配置文档

完整入口见 **[文档索引与维护规则](docs/README.md)**；阅读代码前先看 [实现地图](docs/implementation-map.md)，架构偏差及修正状态见 [治理记录](docs/governance-review-20261122.md)。

功能范围、缺口和逐项验证结果见 **[Channel 能力与验收台账](docs/capabilities.md)**。当前已实现对应的协议、ACP 接入和受控 PR 发布代码；本地测试不能替代真实编码项目验收。

| 文档                                     | 什么时候读                                        |
| ---------------------------------------- | ------------------------------------------------- |
| **[配对与仓库自助接入](docs/agent-self-service.md)** | 领取邀请、在本地设置规则、查看生效修订、停用仓库 |
| **[OpenClaw 适配器接入](docs/setup.md)** | 当前已实现适配器：从配置到真实 GitHub 回帖验收    |
| [ECS自建部署（可选）](docs/ecs-setup.md) | 没有现成Channel服务，或需要自己维护公网入口时     |
| [运行与恢复](docs/operations.md)         | 日志排错、secret权限、更新回滚、备份与unknown对账 |
| [架构与边界](docs/architecture.md)       | 理解云端/内网职责、身份和幂等保证                 |

GitHub App的注册、权限、安装与事件订阅引用配套书稿[附录 B](https://github.com/xallor-ai/modern-github-book/blob/main/%E7%AC%94%E8%AE%B0/%E7%8E%B0%E4%BB%A3%20GitHub%EF%BC%9A%E9%99%84%E5%BD%95%20B%20GitHub%20CLI%E3%80%81API%20%E5%92%8C%20GitHub%20App.md)，Webhook验签与事件接收引用[附录 C](https://github.com/xallor-ai/modern-github-book/blob/main/%E7%AC%94%E8%AE%B0/%E7%8E%B0%E4%BB%A3%20GitHub%EF%BC%9A%E9%99%84%E5%BD%95%20C%20Webhook%20%E4%B8%8E%E4%BA%8B%E4%BB%B6%E6%8E%A5%E6%94%B6.md)。配置主线保留本服务所需的交接参数，不重复维护注册教程。

[v2 契约与新状态库要求](docs/protocol-v2.md) · [ACP 编码接入](docs/acp-setup.md) · [本轮验证记录](docs/runtime-neutral-validation-20261122.md)

## 从哪里开始

需要Node.js 24；容器方式需要Compose插件2.20+。OpenClaw已验证版本为2026.11.3。两端使用同一支持设备配对的发布版本：

```sh
git clone https://github.com/xallor-ai/github-agent-channel.git
cd github-agent-channel
npm ci --ignore-scripts
```

**已有Channel服务**：取得服务 origin 和一次性配对邀请，从[主线](docs/setup.md)准备OpenClaw，然后：

```sh
npm run channel -- agent init ./agent-data
# 填写配置后，先按自助接入指南完成配对、显式启用仓库，再校验并启动：
npm run channel -- agent check ./agent-data/agent.local.yaml
npm run channel -- agent run ./agent-data/agent.local.yaml
```

**需要自建**：先按[可选ECS文档](docs/ecs-setup.md)启动 Channel 与 HTTPS 入口，再回到适配器教程。内网不持有 GitHub PEM，Channel 服务端不需要访问内网 Runtime。

配置示例：[云端 YAML](deploy/channel.example.yaml)、[内网 YAML](deploy/agent.example.yaml)、[OpenClaw完整实例模板](deploy/openclaw.example.json)、[已有专用实例的合并片段](deploy/openclaw.channel.patch.json)。占位符必须替换，不能把示例当作已安装环境。

## 开发与验证

修改通过 Channel 的真实评审流程与证据见[评审闭环](docs/channel-review-validation-20261123.md)。OpenClaw 读取差异并回帖、OpenCode ACP 实际编码→验证→PR→Channel 评审均已有[真实验收记录](docs/acp-live-validation-20261124.md)。

```sh
npm test
npm run typecheck
npm run build
npm run format:check
npm run smoke:deployment
```

模型探针 `npm run smoke:openclaw` 会实际调用Provider，应先按主线配置本地Gateway token；它使用合成工具数据，不访问真实GitHub。容器冒烟和单元测试同样不能替代公网验收。

已完成一个绑定仓库的真实GitHub → ECS → 内网OpenClaw → 回帖和重投去重验收，见[记录](docs/outbound-validation-20261122.md)。这是早期版本的验收。当前版本由设备显式登记仓库和事件，只有已配对设备才能领取其绑定任务；PR 发布另需管理员配置 writeProfiles。同机双设备、双仓的[真实验收记录](https://github.com/xallor-ai/github-agent-channel/issues/14#issuecomment-7130728427)已列入[能力台账](docs/capabilities.md)。
