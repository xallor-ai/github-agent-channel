# 配置化部署验收（2026-11-22）

> 状态：旧部署里程碑的历史证据，不是当前操作教程。下文“Channel 到 OpenClaw 可达”属于旧直连假设；当前连接方向为内网主动访问 Channel。后续验收见[主动连接记录](outbound-validation-20261122.md)。

> 当前网络方向已修正为内网主动连接ECS；云端直连Runtime不再支持。部署与协议以 [主动连接计划](https://github.com/xallor-ai/github-agent-channel/blob/6c51ead/docs/outbound-connector-plan.md) 和 [运维说明](operations.md) 为准。本文早期设计/验收保留作历史记录。

本次交付是仓库的配置与部署产品化：一份业务 YAML、文件/环境 secret 引用、CLI、可选 Caddy、现有 Nginx 路由片段、可复现 Docker 冒烟与 CI。它不代表用户的生产 GitHub App 已上线。

## 需求与证据

| 要求                                 | 实现/证据                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| 用户只维护业务配置，部署文件自动生成 | `channel init`、`config check`、`deploy render`，CLI 临时目录回归                    |
| 旧 Env 配置兼容，新增 File 引用      | 配置/secret 测试；实际 Docker external 使用 Env secrets，Caddy 使用 File secrets     |
| 凭据不写入镜像和生成 YAML            | 构建上下文白名单；Compose secret source；生成物秘密扫描测试                          |
| 独立 HTTPS 入口与既有网关共存        | external/Caddy 两种模式；独立 Caddy 与实际 Nginx 精确路由测试                        |
| 外部配置目录、容器 UID/路径可用      | 仓库固定 build context；UID1000 读取挂载配置；容器参数规范化；File 权限见 operations |
| 管理路径保持私有                     | HTTPS 入口访问 `/tasks/*`、`/healthz`、无关路径返回404；本机管理接口未授权401        |
| 存储持久性与任务幂等                 | SQLite 容器强制重建后数据保留；重复 delivery 返回相同任务，合成回帖计数1             |
| 运维命令与失败诊断                   | Compose版本检查；up后台健康等待；status映射ps；down保留卷；命令参数/错误码回归       |
| 文档、开发和持续验证                 | README/operations；原生Node路径；CI执行单元测试和Docker smoke                        |

本机最终检查：60 项测试通过，类型检查、构建和格式检查均通过。

## 实际 Docker 结果

在隔离 Linux Docker 主机执行 `node scripts/smoke-deployment.mjs`，退出码 **0**。Node.js 24.22.1，Docker Compose v5.1.1。未使用生产密钥、现有线上容器或真实仓库 binding。

```json
{"mode":"external","result":"passed","nonrootUid":"1000","composeValidated":true,"signedWebhook":true,"sqliteSurvivesRecreate":true,"tls":"not-applicable"}
{"syntheticWorkerE2E":"passed","signedIssueComment":true,"duplicatePublicationCount":1}
{"mode":"caddy","result":"passed","nonrootUid":"1000","composeValidated":true,"signedWebhook":true,"sqliteSurvivesRecreate":true,"tls":"verified-local-ca"}
```

external：真实 Node 镜像、Env secret 挂载、Nginx 配置校验和实际 HTTP 路由。额外强制 Channel 更换容器 IP，Nginx 容器保持不变，签名请求在 Docker DNS 刷新期限内恢复；生成片段使用 Docker resolver 与变量上游，避免升级后固定到旧 IP。
Caddy：原始生成配置经过 Caddy validate，隔离 localhost fixture 使用内部 CA；客户端显式信任该 CA，没有关闭证书验证。File secrets、错误签名、路径限制和数据库持久性通过。
任务：真实 Channel Server/TaskStore/Worker，Runtime/GitHub 是合成实现；测试通过 Edge 投递 issue_comment，确认 succeeded/sent，并验证重复投递只产生一条合成回帖。

最初 Docker Hub 拉取连接重置。随后经官方镜像镜像源取得相同镜像并缓存，未改变 Dockerfile 的基础镜像声明。最后一轮验证使用源码白名单版 `.dockerignore`。测试结束清理其创建的容器、网络、卷和镜像。

## 生产边界

- 未执行公网 ACME 申请与续期、真实 GitHub Webhook → 真实模型 → GitHub 评论闭环。
- 已有域名证书、App安装和具体服务器配置单独核对；本机部署记录不进入公共仓库。
- 生产接入需要 App PEM 文件与对应 secret、实际 installation/repository binding、Channel 到 OpenClaw 可达的受保护通道。
- 只支持单 Channel worker 与持久卷；没有多实例或自动恢复未知外部执行的承诺。

## 重现

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run format:check
node scripts/smoke-deployment.mjs
```

最后一条需本机 Linux Docker Engine、Compose插件2.20+及镜像网络。测试仅绑定随机回环端口，不申请公网证书，不向 GitHub 发消息。CI已加入该步骤，远端流水线结果需与具体提交对应查看。
