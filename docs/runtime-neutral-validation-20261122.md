# Channel v2 实现与验证（2026-11-22）

本记录对应从 `6c51ead` 开始的实现纠偏。代码使用新契约，直接删除旧路径；未把生产部署切换到 v2，未创建真实 GitHub 代码 PR。

## 实际完成

| 项目         | 结果                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Runtime 装配 | type 必填，OpenClaw 或官方 ACP SDK；无默认 provider 回退                                                                          |
| 通用任务     | source/target 必填，支持已配置的 Issue/PR/push 触发；无根级评论别名                                                               |
| 成果         | outcome 包含 text/artifacts/publication，实际测试/文件产物与 publicationReceipt 分开                                              |
| 编码委托     | ACP 调用已有 harness，准备好的独立 clone；无自研编码循环                                                                          |
| PR 发布      | 显式 writePolicy、基线/文件/actor 校验，派生任务分支，Octokit 创建 draft PR                                                       |
| 删除         | v1 路由、旧结果字段、自动迁移、ConfigManager/update/getPublicConfig、旧 claim/finish、unknown→success 修复分支及五份失效计划/日志 |
| 数据边界     | 旧库拒绝打开且数据保留；新 schema v2 独立建立                                                                                     |

## 验证证据

最终源码包 SHA-256：`d3f408d43cfdc12768ccd770890aeb097dbb6f8393372e17c791f15d12b938a9`。包只含源码、测试、脚本、示例和构建文件，未带生产配置/secret；复制到隔离 Linux 测试目录并校验 SHA-256。

| 环境/检查                           | 实际结果                                                                                                                                          | 边界                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Linux Node 24.22.1，完整 `npm test` | **138 通过，0 失败**                                                                                                                              | GitHub transport/模型行为为替身，HTTP/SQLite/SDK/子进程/Git/验证命令实际执行 |
| Windows Node 24.18.0                | 前一完整套件135通过；新增编码闭环2项与最终模式检查2项分别通过                                                                                     | 不冒充同一条最终138项 Windows 全量运行                                       |
| TypeScript、build、format           | 通过                                                                                                                                              | 不是线上运行证明                                                             |
| Linux Docker 29.4.0 / Compose 5.1.1 | external 与 Caddy 两种隔离部署退出码0；非 root、签名路由、IP 变更、卷持久化、v2 TLS 出站和重启 unknown 通过                                       | Caddy 使用本地测试 CA；没有公网 ACME、生产容器变更或真实 GitHub 请求         |
| 完整本地编码闭环                    | 签名 Webhook→SQLite→出站 HTTP→官方 ACP SDK 子进程→真实临时 Git 文件修改→配置的验证命令→nested outcome→真实 Octokit + 替身 GitHub→draft PR receipt | harness 的模型/编辑逻辑合成；没有真实外部 PR                                 |
| 验证失败                            | 退出码7保留变更/测试产物，publication=none，无 GitHub 写入                                                                                        | 不用模型口头“通过”覆盖实际失败                                               |
| 去重与未知结果                      | 重复事件/结果不重复执行或发布；过期/重启/丢响应不盲目重放                                                                                         | 不宣称外部执行 exactly-once                                                  |
| 严格新契约                          | 缺少 type、旧 task 字段、扁平结果、v1 路由和旧库均拒绝                                                                                            | 没有兼容别名或数据库转换                                                     |
| 文档与配置                          | 19份 Markdown、146个本地链接、25个模块索引、44项能力和4份指南配置检查通过；CLI 模板与 YAML 示例一致                                               | 不代表用户的实际凭据或部署已经可用                                           |

## 独立审查与修正

1. Git 检查子进程曾继承 bridge 环境，仓库 fsmonitor/filter 等配置可能执行 helper。已限制环境、固定 Git 可执行路径、禁用/拒绝相关配置和元数据重定向，并检查运行前后配置摘要；合成秘密回归通过。
2. 项目验证命令不再继承 harness 模型认证变量；回归确认验证输出、产物和 PR body 不包含合成 token。
3. PR 人工对账曾用未转义仓库名构建正则，带点名称可匹配别的仓库。已改为字面路径范围与数字 PR ID 检查，真实本地 HTTP 回归通过。
4. Linux 发现仅暂存的可执行位变更与 Windows 行为不同。已同时检查 index 和工作区模式，保留跨平台拒绝规则；最终 Linux 完整套件通过。

## 尚未验证或未实现

- 真实第三方 ACP 编码 harness、真实项目测试及 GitHub draft PR 的线上闭环尚未验收。
- ACP 原生进程不是 OS sandbox；不支持多个 bridge 共享工作区、自动 clone/provision 或自动 Docker 渲染 ACP。
- 运行标识已持久化；取消请求不是远端已停止证明，没有自动 resume、查询恢复或多 worker 路由。
- 只支持当前 schema/策略允许的文本文件变更；不支持二进制、symlink/submodule 或可执行文件模式产物。
- 中间 Git 对象或分支可能在后续失败时留下；unknown 必须人工对账，不自动重发创建请求。

操作入口见 [v2 契约](protocol-v2.md)、[ACP](acp-setup.md) 和 [OpenClaw](setup.md)。
