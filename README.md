# GitHub Agent Channel

让内网 Agent 参与 GitHub 协作，无需为内网开放端口。ECS 接收 GitHub Webhook，连接器主动通过 HTTPS 领取任务，调用本机 OpenClaw，再回传结果。GitHub 私钥和写入权限始终留在 ECS。

```text
GitHub ──Webhook──▶ ECS Channel ──受控回帖──▶ GitHub
                         ▲
                         │ 内网主动 HTTPS：领取 / 工具请求 / 结果
                         │
                  Agent 连接器 ──本地请求──▶ OpenClaw
```

OpenClaw 是第一个 Runtime 适配器，连接器是本仓库的独立进程；不是把 URL 填进 OpenClaw 就会自动出现的原生能力。当前支持读取 Issue/同仓文件与分析回帖，不支持改代码、创建 PR 或 merge。

## 1. ECS：配置 Channel

需要 Node.js 24。容器部署需 Docker Compose 插件 2.20+。在源码目录执行：

```sh
npm ci --ignore-scripts
npm run channel -- init ./channel-data
```

编辑 `channel-data/config.local.yaml`：填写 App ID、bot login、仓库 binding；放置 App PEM、Webhook Secret、管理 token、**连接器 token** 的文件。配置只保存文件路径或环境变量名。ECS 不配置 OpenClaw 地址或模型 token。

```yaml
connector:
  workerId: local-openclaw
  tokenFile: secrets/connector-token
  timeoutMs: 300000
deployment:
  mode: external
  publicUrl: https://channel.example.com
```

- 已有 Nginx/HTTPS 网关：用 `external`。若网关也是 Docker 容器，设置 `deployment.network` 为共同网络。
- 没有入口、80/443 空闲：用 `caddy`，提供域名并完成 DNS/端口配置，自动处理证书。

```sh
npm run channel -- config check ./channel-data/config.local.yaml
npm run channel -- doctor ./channel-data/config.local.yaml
npm run channel -- deploy render ./channel-data/config.local.yaml ./channel-data/.channel
npm run channel -- deploy up ./channel-data/.channel
```

external 模式将生成 `nginx-webhook.conf`，审核后加入已有 HTTPS server。它包含 `/webhooks/github` 和受认证的 `/connector/v1/`，不会转发管理接口 `/tasks/*`。Caddy 模式自动配置这两类入口。

GitHub App 开启 **Issue comment**，Webhook URL：`https://channel.example.com/webhooks/github`。权限为 Metadata/Contents Read、Issues/Pull requests Read and write。填写准确的 installation/repository ID。对无仓库写权限的调用者默认拒绝。

## 2. 内网：配置主动连接器

在内网另一份源码安装依赖，然后：

```sh
npm run channel -- agent init ./agent-data
```

编辑 `agent-data/agent.local.yaml`：

```yaml
channel:
  baseUrl: https://channel.example.com
  tokenFile: secrets/connector-token
runtime:
  baseUrl: http://127.0.0.1:18789
  tokenFile: secrets/openclaw-gateway-token
  agentId: github
  timeoutMs: 180000
  maxToolRounds: 8
stateFile: ./data/agent.db
pollIntervalMs: 2000
requestTimeoutMs: 15000
```

两端的连接器 token 必须相同，且与 ECS 管理 token 不同。OpenClaw token 只在内网保存；此配置不接受 GitHub 私钥。OpenClaw 需启用 Responses API。

原生 Node 运行：

```sh
npm run channel -- agent check ./agent-data/agent.local.yaml
npm run channel -- agent run ./agent-data/agent.local.yaml
```

容器运行：将 agent 配置的 `deployment.network` 设为现有 OpenClaw 网络，并把 `runtime.baseUrl` 改成该网络可达的 OpenClaw 容器地址，然后执行：

```sh
npm run channel -- agent deploy render ./agent-data/agent.local.yaml ./agent-data/.channel-agent
npm run channel -- agent deploy up ./agent-data/.channel-agent
```

Agent 容器不发布任何端口。云端不需要知道内网 IP；不需要 SSH 反向隧道、NAT 映射或将 OpenClaw 暴露公网。

## 3. 验证与运维

先运行内网连接器，再由有仓库写权限的账号在绑定仓库的新评论中写 `@your-app 请分析这个 Issue`（同时兼容带 `[bot]` 的完整 botLogin）。检查 GitHub delivery 是否返回202，再查看原 Issue 的机器人回帖。

```sh
npm run channel -- deploy status ./channel-data/.channel
npm run channel -- agent deploy status ./agent-data/.channel-agent
npm run channel -- deploy down ./channel-data/.channel
```

`doctor` 为离线配置/Compose检查，不代表真实 GitHub 或模型成功。`up` 后台启动；`down` 保留数据卷。两端均为单进程，每个云实例配置一个可信连接器身份。遇到网络结果不明、租约过期或进程重启，任务进入 `unknown`，不会自动重跑模型。详见 [运行与恢复](docs/operations.md)。

```sh
npm test
npm run typecheck
npm run build
npm run format:check
npm run smoke:deployment
```

单元/HTTP测试及隔离 Docker 冒烟使用合成 GitHub/模型输出；不得据此声称生产已接入。架构与当前实施进度见 [主动连接计划](docs/outbound-connector-plan.md)。

已完成一个绑定仓库的真实GitHub → ECS → 内网OpenClaw → 回帖与重投去重验收，见 [验证记录](docs/outbound-validation-20261122.md)。这不代表订阅的其他事件已实现处理。
