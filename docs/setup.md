# OpenClaw 适配器：完整配置与回帖验收

状态：当前已实现适配器的操作教程。GitHub Agent Channel 的产品定位是通用 GitHub 通道；本篇只讲 OpenClaw 的接入，不是所有 Runtime 的协议规范，编码与 PR 路径使用[ACP 适配器](acp-setup.md)，不是本 OpenClaw 读取适配器的能力。产品、实现和其他能力状态从[文档索引](README.md)进入。

本篇是使用入口，按顺序完成后应能在绑定仓库评论 `@机器人`，由内网 OpenClaw 分析并回帖。自建 ECS 不是每个使用者都要做的事：已有 Channel 服务时，拿到服务地址和连接器 token 即可；没有服务时，先完成[可选的 ECS 自建部署](ecs-setup.md)，再回到本文。

当前实现是本仓库的独立连接器进程，不是在 OpenClaw 的 channels 列表里填一个 GitHub Webhook URL。连接器只向公网发起 HTTPS 请求；OpenClaw 留在本机或内网。

当前 Channel 仅接受 v2 配置/协议和新状态库；从旧部署切换先读[v2 契约](protocol-v2.md)。

## 0. 准备资料并确认版本

本仓库需要 **Node.js 24**；容器方式需要 **Docker Compose 插件 2.20+**。OpenClaw 已实际验证的版本为 **2026.11.3**。其他版本先执行配置校验与后面的模型/工具探针，不把最新在线文档等同于已验证版本。

从 Channel 管理员取得以下资料；自己部署时由 ECS 文档生成：

| 资料                  | 示例与用途                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| Channel origin        | `https://channel.example.com`；不要带 `/webhooks/github` 或 `/connector/v2`    |
| 连接器 token          | 与 ECS 的 `connector.tokenFile/Env` 指向同一个值；安全传递为文件，不贴入 Issue |
| 已绑定仓库、bot login | 例如 `example-org/example-repo`、`example-robot[bot]`                          |
| 执行期限              | 云端 `connector.timeoutMs`，示例300秒；本地Runtime超时180秒，留出回传余量      |

还需要本地 OpenClaw 的模型 Provider/API凭据，以及 Gateway token。**模型 API key、OpenClaw Gateway token、Channel 连接器 token 是三件不同的东西**。GitHub PEM 私钥和Webhook Secret属于ECS，不放到内网连接器。

GitHub App 的注册、安装、权限和事件订阅请阅读书稿[附录 B：GitHub CLI、API 和 GitHub App](https://github.com/xallor-ai/modern-github-book/blob/main/%E7%AC%94%E8%AE%B0/%E7%8E%B0%E4%BB%A3%20GitHub%EF%BC%9A%E9%99%84%E5%BD%95%20B%20GitHub%20CLI%E3%80%81API%20%E5%92%8C%20GitHub%20App.md)，验签与投递概念见[附录 C：Webhook 与事件接收](https://github.com/xallor-ai/modern-github-book/blob/main/%E7%AC%94%E8%AE%B0/%E7%8E%B0%E4%BB%A3%20GitHub%EF%BC%9A%E9%99%84%E5%BD%95%20C%20Webhook%20%E4%B8%8E%E4%BA%8B%E4%BB%B6%E6%8E%A5%E6%94%B6.md)。本站使用契约是：App已安装到目标仓库，订阅 `Issue comment`，签名Secret与ECS一致；服务端binding允许目标仓库，发评论的人拥有write/maintain/admin权限。这里不重复注册教程。

下文命令以 Linux/macOS shell 或 WSL 为例，在运行OpenClaw或能私网访问它的机器上执行。PowerShell的环境变量示例在验证步骤另列。

## 1. 获取连接器源码

目前主动连接实现位于开发分支；在合入默认分支前，请明确检出它：

```sh
git clone --branch codex/outbound-connector --single-branch https://github.com/xallor-ai/github-agent-channel.git
cd github-agent-channel
node --version
npm ci --ignore-scripts
npm run build
```

如果已经有checkout，先检查自己的修改，再切到包含 `agent init` 命令的版本，避免覆盖本地配置。以下相对命令均在这个源码目录执行。

## 2. 准备专用 OpenClaw Gateway

### 已有模型可用的专用实例

执行以下命令确认你正在管理哪个实例：

```sh
openclaw --version
openclaw config file
openclaw config validate
```

如果使用命名profile，为所有命令加相同的 `--profile <名字>`。若OpenClaw运行在容器里，使用该运行容器内的CLI和已有配置挂载；不要再启动一个共享状态目录的第二个容器来校验。

建议给GitHub任务使用专用Gateway。Gateway token属于整个实例的访问凭据，不能因为本连接器只暴露两个读取工具，就把它当成细粒度只读token。

### 没有专用实例：建立一个命名profile

已有专用实例可跳过这一小节。下面创建新的profile，不覆盖已有默认配置；示例使用18790端口，若已占用请换一个端口并同步后续URL。

```sh
# 仅在尚未安装所需OpenClaw版本时执行
npm install --global openclaw@2026.11.3
```

从仓库模板创建私有配置：

```sh
node --input-type=module <<'JS'
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const state = join(homedir(), '.openclaw-github-channel');
const config = JSON.parse(readFileSync('deploy/openclaw.example.json', 'utf8'));
config.gateway.port = 18790;
config.gateway.bind = 'loopback';
config.gateway.auth.token = randomBytes(32).toString('hex');
config.agents.defaults.workspace = join(state, 'workspace');
mkdirSync(state, {recursive:true, mode:0o700});
writeFileSync(join(state, 'openclaw.json'), JSON.stringify(config,null,2), {flag:'wx', mode:0o600});
console.log('Created dedicated profile; edit its model provider before starting.');
JS
```

在本机编辑 `~/.openclaw-github-channel/openclaw.json`，把模板的 `models.providers.your-provider` 中 `baseUrl`、`apiKey`、模型 `id/name` 改为实际服务；同步修改 `agents.defaults.model.primary` 为 `<provider键>/<model id>`。模板采用OpenAI-compatible chat/completions协议；其他Provider按其官方配置适配。不要把占位值当成可运行模型，也不要把私有配置提交到Git。

## 3. 开启 Responses，并选择 github Agent

本仓库附带[可合并的配置片段](../deploy/openclaw.channel.patch.json)：

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "responses": {
          "enabled": true,
          "files": { "allowUrl": false },
          "images": { "allowUrl": false }
        }
      }
    }
  },
  "agents": {
    "entries": {
      "github": {
        "name": "GitHub Channel",
        "skills": [],
        "tools": { "deny": ["*"] }
      }
    }
  },
  "tools": { "toolSearch": false }
}
```

`agents.entries.github` 中的 **github就是agentId**。它默认继承已有模型配置；需要指定模型时，在这个entry里增加 `model`。`tools.deny`限制该Agent的内置工具，客户端提供的 `read_issue/read_file` 由连接器处理并交回ECS。repository/push 任务只提供 `read_file`，分析保存在任务 outcome 中，不尝试向不存在的 Issue 发评论；文件仍从默认分支读取，不能当作指定 push SHA 的代码审查。`tools.toolSearch=false`在2026.11.3中是全局设置，不是entry内字段；它直接提供少量客户端工具的定义。共享Gateway时先评估该全局修改对其他Agent的影响，或者使用独立profile。

先审阅片段并备份自己的配置，再执行（以下以新profile为例；已有专用默认实例去掉profile参数）：

```sh
openclaw --profile github-channel config patch --file deploy/openclaw.channel.patch.json --dry-run
openclaw --profile github-channel config patch --file deploy/openclaw.channel.patch.json
openclaw --profile github-channel config validate
```

确保该实例使用 `gateway.auth.mode: token`，且 `gateway.auth.token` 是独立随机值。上述patch不替换已有Provider或token，也不会自动启动Gateway。

在单独终端以前台方式启动新profile：

```sh
openclaw --profile github-channel gateway run --bind loopback --port 18790
```

已由OpenClaw服务管理器启动的实例用 `openclaw --profile github-channel gateway restart`；容器实例用已有Compose/容器管理方式重启。不要再对同一状态目录启动第二个Gateway。前台运行适合首次验证；长期部署沿用服务管理器或容器自启动。

配置字段与请求格式依据：[OpenResponses API](https://docs.openclaw.ai/gateway/openresponses-http-api)、[Agent entries](https://docs.openclaw.ai/gateway/config-agents/entries-and-multi-agent)、[config patch](https://docs.openclaw.ai/cli/config)。

## 4. 配置主动连接器

```sh
npm run channel -- agent init ./agent-data
```

会创建 `agent-data/agent.local.yaml` 和 `agent-data/secrets/`。放入两个文本文件：

- `secrets/connector-token`：管理员提供的Channel连接器token。
- `secrets/openclaw-gateway-token`：本机Gateway实际使用的token原始值，不带JSON引号。若使用上面新profile，就是其 `gateway.auth.token`。不要复制模型API key。

文件可用受控编辑器或安全传输保存，不要把值写进shell参数。两个文件都不会由init自动生成，也不能分别随机生成两个不同的connector token。Linux原生进程以当前用户运行时，设置：

```sh
chmod 700 agent-data/secrets
chmod 600 agent-data/secrets/connector-token agent-data/secrets/openclaw-gateway-token
```

容器方式还需按第6节调整组读取权限，使UID1000能读取文件。

使用完整配置（URL和端口替换为自己的值）：

```yaml
channel:
  baseUrl: https://channel.example.com
  tokenFile: secrets/connector-token
runtime:
  type: openclaw
  baseUrl: http://127.0.0.1:18790
  tokenFile: secrets/openclaw-gateway-token
  agentId: github
  timeoutMs: 180000
  maxToolRounds: 8
stateFile: ./data/agent.db
pollIntervalMs: 2000
requestTimeoutMs: 15000
```

`channel.baseUrl`是ECS入口origin，`runtime.baseUrl`是从连接器所在环境能访问的Gateway origin，均不带 `/v1/responses`；连接器会补协议路径。`tokenFile`和 `stateFile` 相对配置文件目录解析。每个token也可改用 `tokenEnv` 引用环境变量，但同一项不能同时写Env和File。

```sh
npm run channel -- agent check ./agent-data/agent.local.yaml
```

预期显示 `Agent configuration valid`。这只证明配置与secret引用有效，尚不代表模型或GitHub可用。

## 5. 先验证本机模型与工具续调用

先停下尚未通过验收的连接器进程，单独运行随仓库提供的探针。它会调用真实模型，可能产生Provider费用；工具返回合成数据，不读写真实GitHub对象。

本节命令适用于宿主机能访问Gateway的情况。若Gateway仅在Docker网络内可达，使用第6节B中的同网络探针，完成后再启动连接器，不要照抄宿主机的127.0.0.1。

```sh
export OPENCLAW_BASE_URL='http://127.0.0.1:18790'
export OPENCLAW_AGENT_ID='github'
export OPENCLAW_GATEWAY_TOKEN="$(cat agent-data/secrets/openclaw-gateway-token)"
npm run smoke:openclaw
unset OPENCLAW_GATEWAY_TOKEN
```

PowerShell环境变量对应写法：

```powershell
$env:OPENCLAW_BASE_URL = 'http://127.0.0.1:18790'
$env:OPENCLAW_AGENT_ID = 'github'
$env:OPENCLAW_GATEWAY_TOKEN = (Get-Content -Raw .\agent-data\secrets\openclaw-gateway-token).Trim()
npm run smoke:openclaw
Remove-Item Env:OPENCLAW_GATEWAY_TOKEN
```

预期看到 `real-model-text` 与 `real-model-tool-continuation` 的 `passed:true`，并有 `read_issue`、`read_file` 两个callback。只有文字成功而工具失败，不能跳过继续宣称可用。探针失败先排查下面的网络/认证/模型表。

## 6. 选择运行方式

### A. 原生进程（与Gateway同机）

```sh
npm run channel -- agent run ./agent-data/agent.local.yaml
```

连接器只发出请求，不监听HTTP端口。空任务时通常没有持续成功日志；出现认证错误或重试日志时按故障表处理。Ctrl+C停止；不要同时开两个进程共享一个 `stateFile`。

### B. Docker（与已有容器Gateway共网）

此方式不要求把OpenClaw端口发布到宿主或公网。先确认已有Gateway容器的网络和容器名：

```sh
docker ps
docker inspect <OpenClaw容器名> --format '{{json .NetworkSettings.Networks}}'
```

在agent YAML增加：

```yaml
deployment:
  network: openclaw_default
  projectName: github-channel-agent
```

把 `runtime.baseUrl` 改成 `http://<该网络中的OpenClaw容器名或别名>:18789`（端口按实际Gateway修改）。Gateway须监听**容器网络接口**，例如 `--bind lan`，而非只监听容器自身loopback；Docker可以不发布任何宿主端口。原生进程模式则保持loopback。连接器容器里的127.0.0.1指自己，不能用来访问另一个容器。

Docker方式的模型探针也必须从这个网络运行。可先构建镜像：

```sh
docker build -t github-agent-channel:local .
```

将镜像写进agent YAML的 `deployment.image: github-agent-channel:local`（与network/projectName同级）。在容器网络运行相同的模型探针（替换网络和容器名）：

```sh
export OPENCLAW_NETWORK='openclaw_default'
export OPENCLAW_URL='http://openclaw:18789'
# 保留文件owner；让Node镜像的GID1000可读。部署账号也必须能读取这些文件。
sudo chgrp 1000 agent-data/secrets/openclaw-gateway-token agent-data/secrets/connector-token
chmod 640 agent-data/secrets/openclaw-gateway-token agent-data/secrets/connector-token
docker run --rm --network "$OPENCLAW_NETWORK" \
  --mount "type=bind,src=$PWD/scripts,dst=/app/scripts,readonly" \
  --mount "type=bind,src=$PWD/agent-data/secrets/openclaw-gateway-token,dst=/run/secrets/gateway,readonly" \
  -e OPENCLAW_BASE_URL="$OPENCLAW_URL" -e OPENCLAW_AGENT_ID=github \
  github-agent-channel:local \
  sh -c 'export OPENCLAW_GATEWAY_TOKEN="$(cat /run/secrets/gateway)"; exec node scripts/smoke-openclaw.mjs'
```

`scripts/`只读挂载用于这个探针，长期Agent服务不需要挂载源码或脚本。探针的两项passed标准与第5节相同。

生成与启动：

```sh
npm run channel -- agent deploy render ./agent-data/agent.local.yaml ./agent-data/.channel-agent
npm run channel -- agent deploy up ./agent-data/.channel-agent
npm run channel -- agent deploy status ./agent-data/.channel-agent
docker compose -f ./agent-data/.channel-agent/compose.yaml logs --tail 50 agent
```

生成器使用持久卷保存 `/data/agent.db`，服务以UID1000运行且没有ports映射。File secrets建议0600 owner1000或0640 group1000，父目录限制访问。镜像声明的EXPOSE不等于发布宿主端口。配置变更要渲染到新的bundle目录；停止不删除卷：

```sh
npm run channel -- agent deploy down ./agent-data/.channel-agent
```

## 7. 完成真实GitHub闭环

在管理员明确启用的仓库创建测试Issue，用拥有write/maintain/admin权限的账号发表评论（替换机器人名）：

```text
@your-app 请读取这个 Issue 和 README.md，分别说明读到了什么，最后单独一行写 CHANNEL_E2E_OK。只分析与回帖，不修改代码。
```

由两端共同核对：

| 观察位置                     | 通过标准                                                     |
| ---------------------------- | ------------------------------------------------------------ |
| GitHub App Recent deliveries | `issue_comment` / `created`，签名存在，接收入队返回202       |
| Channel后台任务              | `succeeded`，`deliveryStatus=sent`，有publicationReceipt.url |
| GitHub Issue                 | 由App机器人回复，出现指定标记，内容与实际读取相符            |
| 重投同一个delivery           | 仍指向同一个任务，没有第二条机器人回复                       |

管理员从GitHub App的Recent deliveries响应正文取得 `taskId`，然后在ECS源码目录查询任务。以下命令从文件读取管理token，不把它放入命令参数；替换taskId，端口与secret路径按实际部署调整：

```sh
export CHANNEL_TASK_ID='替换为delivery响应中的taskId'
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const taskId = process.env.CHANNEL_TASK_ID;
if (!/^[0-9a-f-]{36}$/.test(taskId ?? '')) throw Error('Set a valid task ID');
const token = readFileSync('channel-data/secrets/channel-admin-token', 'utf8').trim();
const response = await fetch('http://127.0.0.1:18896/tasks/' + taskId, {
  headers: {Authorization: 'Bearer ' + token}
});
if (!response.ok) throw Error('Task query HTTP ' + response.status);
console.log(JSON.stringify(await response.json(), null, 2));
JS
```

尚在执行时稍后重查；出现 `failed` 或 `unknown` 按运维文档对账，不重复发评论代替诊断。已有Channel服务的使用者请由管理员完成此项，不需要取得管理token。

200也可能只是忽略事件，204只表示连接器暂时没有任务；这些都不能单独证明闭环。开启事件订阅之前的旧评论不足以验证新配置，应发表新的触发评论。实际已验证的例子见[主动连接验收](outbound-validation-20261122.md)。

## 故障定位

| 现象                           | 优先检查                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| ECS connector返回401           | 两端connector token不一致；不要拿Gateway或admin token代替                                 |
| Gateway返回401                 | runtime token与Gateway实际认证值不一致                                                    |
| Gateway返回404                 | Responses未启用、URL/端口错误；访问根路径404不等于Gateway没有运行                         |
| 容器连接127.0.0.1失败          | 容器的loopback不是宿主或另一个容器；检查共同网络、Gateway bind和别名                      |
| 有HTTP响应但模型失败           | Provider/model配置和真实工具续调用探针；health只证明进程存活                              |
| Agent持续204但评论不处理       | App事件、签名、仓库binding、机器人名、评论者权限；确认云端没有被unknown任务阻塞           |
| 配置校验通过但容器读secret失败 | Linux文件owner/group/mode必须允许UID1000读取                                              |
| 配置修改后render拒绝覆盖       | 使用新bundle目录，保留旧目录供回滚                                                        |
| 任务unknown或启动提示journal锁 | 不删除数据库重跑；先确认旧执行/旧进程停止，按[运维对账](operations.md#租约和未知状态)处理 |

本教程不把版本升级、schema校验或一次health探测当作完整验收；主线终点是上一步的真实投递、模型执行和回帖证据。

## 无需提及的只读接入

在要启用的仓库 binding 中设置 `requireMention: false` 和 `events: [issue_comment.created, issues.opened, pull_request.opened, pull_request.synchronize]`。当前静态部署需重新渲染并加载服务端配置。匹配的人类流量可能消耗模型资源；先用只读 Runtime、关闭 writePolicy，检查普通评论、重复投递和机器人自身回帖。
