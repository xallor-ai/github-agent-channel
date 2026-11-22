# 可选：在 ECS 自建 Channel 服务

状态：可选部署教程。ECS 不是产品必须依赖；其他具备等效网络、Docker 与 HTTPS 条件的 Linux 主机也可按同一服务职责部署。

已有管理员提供的Channel地址和连接器token时，无需执行本篇，直接回到[完整接入主线](setup.md)。本篇面向要自己运行服务端的人：ECS保存GitHub凭据、验签、任务和回帖，内网连接器主动连接它；ECS不配置内网OpenClaw地址或Gateway token。

当前服务使用 v2 协议和 schema；已有旧部署必须使用新状态库/数据卷，流程见[v2 契约](protocol-v2.md)。要启用 PR 发布，还需按该文配置 writePolicy 与 App Contents 写权限。

## 1. 前置条件与 GitHub App

准备一台可以访问GitHub API的Linux主机、Node.js 24、Docker Engine和Compose插件2.20+，以及指向该主机的域名。可按[Docker官方安装说明](https://docs.docker.com/engine/install/)准备容器环境，然后确认：

```sh
node --version
docker version
docker compose version
```

注册App、授权安装和事件订阅参考书稿[附录 B](https://github.com/xallor-ai/modern-github-book/blob/main/%E7%AC%94%E8%AE%B0/%E7%8E%B0%E4%BB%A3%20GitHub%EF%BC%9A%E9%99%84%E5%BD%95%20B%20GitHub%20CLI%E3%80%81API%20%E5%92%8C%20GitHub%20App.md)；Webhook验签与投递参考[附录 C](https://github.com/xallor-ai/modern-github-book/blob/main/%E7%AC%94%E8%AE%B0/%E7%8E%B0%E4%BB%A3%20GitHub%EF%BC%9A%E9%99%84%E5%BD%95%20C%20Webhook%20%E4%B8%8E%E4%BA%8B%E4%BB%B6%E6%8E%A5%E6%94%B6.md)。本服务所需交接信息为：

- App ID及PEM私钥（不是OAuth Client Secret）。
- installation ID，以及允许处理的owner/repo和repository ID。
- bot login；GitHub API身份通常形如 `your-app[bot]`，不要把显示名称当作login。
- App订阅 `Issue comment`，仓库权限至少Metadata/Contents Read、Issues/Pull requests Read and write。

安装管理页面URL中的 `/installations/<数字>` 可用于核对installation ID；它不是App ID。仓库数字ID可用已登录gh的只读命令取得：

```sh
gh api repos/YOUR_OWNER/YOUR_REPO --jq .id
```

App已安装到全部仓库，也不等于Channel自动处理全部仓库：仍须在下面的bindings中明确启用。

## 2. 准备代码与四类凭据

```sh
git clone --branch codex/outbound-connector --single-branch https://github.com/xallor-ai/github-agent-channel.git
cd github-agent-channel
npm ci --ignore-scripts
npm run channel -- init ./channel-data
```

`channel-data/`默认被Git忽略。把PEM安全保存为 `channel-data/secrets/github-app-private-key.pem`。其余三项首次生成如下；脚本遇到已有文件会失败，避免误轮换正在使用的密钥：

```sh
node --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
for (const name of ['github-webhook-secret','channel-admin-token','connector-token']) {
  writeFileSync('channel-data/secrets/'+name, randomBytes(32).toString('hex'), {flag:'wx',mode:0o600});
}
console.log('Secret files created; values were not printed.');
JS
```

| 文件                       | 使用位置                                              |
| -------------------------- | ----------------------------------------------------- |
| github-app-private-key.pem | 仅ECS，用于App身份认证                                |
| github-webhook-secret      | ECS和GitHub App的Webhook Secret输入框保持一致         |
| channel-admin-token        | 仅管理员查询/对账私网任务接口                         |
| connector-token            | 安全分发给内网连接器；与其 `channel.tokenFile` 值一致 |

为实际运行用户设置权限。默认镜像是UID/GID1000；例如保留文件owner为部署账号，把group设为1000并授予组读取：

```sh
sudo chgrp 1000 channel-data/secrets/github-app-private-key.pem channel-data/secrets/github-webhook-secret channel-data/secrets/channel-admin-token channel-data/secrets/connector-token
chmod 640 channel-data/secrets/github-app-private-key.pem channel-data/secrets/github-webhook-secret channel-data/secrets/channel-admin-token channel-data/secrets/connector-token
chmod 700 channel-data/secrets
```

私钥与token不放进Git、镜像或公开日志。不要把connector token设成admin token。`.gitignore`是防误提交措施，不能替代文件权限。

## 3. 填写一份云端配置

编辑 `channel-data/config.local.yaml`，下列ID、仓库和域名是示例，必须替换：

```yaml
server:
  host: 127.0.0.1
  port: 3000
  adminTokenFile: secrets/channel-admin-token
dataFile: ./data/channel.db
github:
  appId: "12345"
  privateKeyFile: secrets/github-app-private-key.pem
  webhookSecretFile: secrets/github-webhook-secret
  botLogin: your-app[bot]
connector:
  workerId: local-openclaw
  tokenFile: secrets/connector-token
  timeoutMs: 300000
bindings:
  - id: example-repo
    installationId: 123456
    repositoryId: 987654
    owner: YOUR_OWNER
    repo: YOUR_REPO
    enabled: true
deployment:
  mode: external
  publicUrl: https://channel.example.com
  projectName: github-agent-channel
  localPort: 18896
```

`workerId`是服务端连接器身份，和OpenClaw的 `agentId: github` 不是同一个概念。当前一个云实例对应一个可信连接器身份；不要把共享token当成多租户隔离。

```sh
npm run channel -- config check ./channel-data/config.local.yaml
npm run channel -- doctor ./channel-data/config.local.yaml
```

这两步校验本机结构、secret引用和Compose条件，不证明App ID与私钥匹配，也不证明GitHub安装范围正确；最终仍要做真实评论验收。

## 4. 选择 HTTPS 入口

### 已有 Nginx / HTTPS 网关：external

保留 `deployment.mode: external`。宿主机Nginx可通过回环 `127.0.0.1:18896` 访问Channel；网关若也是Docker容器，给配置增加 `deployment.network: <网关实际所在网络>`。生成器会加入该网络并为Channel设置稳定别名，网关不能用自己的127.0.0.1访问另一个容器。

```sh
npm run channel -- deploy render ./channel-data/config.local.yaml ./channel-data/.channel
npm run channel -- deploy up ./channel-data/.channel
npm run channel -- deploy status ./channel-data/.channel
curl --fail http://127.0.0.1:18896/healthz
```

预期health返回 `status:ok`，只代表进程存活。审核 `.channel/nginx-webhook.conf` 并加入已有HTTPS server，保留原站点配置：

- `POST /webhooks/github`：GitHub签名事件。
- `POST /connector/v2/…`：内网Agent的认证任务通道。
- 不把管理 `/tasks/*` 和健康 `/healthz` 反代到公网。

先备份配置，执行 `nginx -t`，通过后再reload。官方Nginx容器的templates文件只在启动流程中做envsubst；修改模板后直接reload不会重新展开，须按现有部署方式生成运行配置并验证。容器网关使用Docker DNS动态解析上游，以适应Channel重建换IP。

### 没有现成入口：caddy

把 `deployment.mode` 改为 `caddy`，填写实际 `publicUrl`。确认域名A/AAAA记录和ECS入口对应，安全组/防火墙允许TCP80/443，且这两个端口没有其他服务占用。然后运行同样的render/up/status命令。

生成的Caddy会申请并续期证书，只代理Webhook与connector协议，证书状态有独立持久卷。不要在已有80/443网关的服务器再启一个Caddy争用端口。

## 5. 验证入口，完成 App 交接

下面请求不会创建业务任务：

```sh
# 无签名应为400，说明请求已到达Channel而不是旧站点的404页面。
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://channel.example.com/webhooks/github -H 'Content-Type: application/json' -d '{}'
# 无connector认证应为401。
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://channel.example.com/connector/v2/claim -H 'Content-Type: application/json' -d '{}'
```

在GitHub App配置 `https://channel.example.com/webhooks/github`，Webhook Secret与前面文件一致，保持SSL verification开启，保存并确认Issue comment订阅。不要以API是否回显secret字段判断是否设置成功；检查真实delivery是否携带签名、接收端是否接受。

然后把以下资料安全交给连接器运行者：Channel origin、connector token、已启用仓库、机器人login、执行期限。不要交出PEM、Webhook Secret或管理token。尚未准备OpenClaw时，回到[主线第2步](setup.md#2-准备专用-openclaw-gateway)；已经完成Gateway配置时，从[主线第4步](setup.md#4-配置主动连接器)继续。

## 6. 真实闭环与维护

让内网连接器启动后，用有仓库写权限的账号新发一条 `@your-app` 评论。核对GitHub delivery202、后台任务succeeded/sent和机器人回帖；同delivery重投不应产生第二条回复。仅200/204或health正常都不构成闭环成功。

`deploy down`保留数据卷；v2 内部配置变更渲染新bundle，保留同一projectName以复用 v2 数据库。v1→v2 必须换新状态库/卷，不适用此复用步骤。等待任务结束，先停Agent再停Cloud并备份；启动时先Cloud后Agent。同名项目替换后不要再对旧bundle执行down。未知任务须人工对账，不能通过删库或重启盲目重试。完整命令和数据恢复见[运维文档](operations.md)。

可选的 `deployment.image` 允许使用你已构建并分发的镜像；项目当前没有承诺一个公共可拉取的发布镜像，不要照抄不存在的registry地址。目标机没有Node时，可用该镜像运行render：把配置与输出目录按同一绝对路径挂入一次性容器，随后在宿主运行Docker Compose。默认源码构建路径是本篇已给出的流程。
