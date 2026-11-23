# Channel v2 真实评审闭环（2026-11-23）

评审与部署代码：`dd8111cef163002fa677abbec91ac2fc6dc0708c`，分支 `codex/outbound-connector`；差异基线 `38b92abda2869a6262959dd9d7b5718c6b0f51e4`。本次通过实际 GitHub App 事件、生产 Channel v2、内网出站 bridge 和真实 OpenClaw 模型执行两轮只读评审。不是合成 fixture 验收，也不是原生 OpenClaw channel 插件或 GitHub 正式 PR Review API。

## 实际部署

- 原服务仍是 `b458603` / v1，不能用于验证本次改动。新版本分别构建服务端和 bridge 镜像，并使用新的部署目录、项目名和 schema v2 数据卷；旧容器停止、旧配置和卷保留，没有迁移或清空旧数据库。
- HTTPS 网关只替换标记内的 Channel 路由：Webhook 与 `/connector/v2/`，结果正文限制2MB。原配置备份后执行 `nginx -t` 和 reload；其余站点路由保持原内容。
- 内网仍主动出站，bridge 没有宿主端口映射，最终重启计数0。部署 binding 仅启用测试仓库的评论触发，未启用 writePolicy。
- 新镜像内执行真实 OpenClaw 探针，文字、read_issue/read_file 合成工具续调用均通过。随后执行下述真实 GitHub 读取和回帖测试。

## 可核对证据

测试 [Issue #2](https://github.com/xallor-ai/github-agent-channel/issues/2) 的正文包含固定提交和完整差异（代码、测试、tsconfig），不使用默认分支旧文件替代目标提交。

| 检查             | 实际结果                                                                       | 证据                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首轮触发         | GitHub issue_comment.created，签名存在，HTTP202                                | [触发评论](https://github.com/xallor-ai/github-agent-channel/issues/2#issuecomment-7105242190)；GUID `86df5816-e750-11f1-8e54-7b7c38715307`                                                                                                                                       |
| 首轮执行与回写   | task `634bc434-213e-449e-8769-88d418cabe9b`，succeeded/sent，error=null        | [评审回复](https://github.com/xallor-ai/github-agent-channel/issues/2#issuecomment-7105281303)，含 `CHANNEL_REVIEW_DD8111C` 和对应任务 marker                                                                                                                                     |
| 运行与工具       | execution、read_issue 工具、result 均实际经 HTTPS 返回200                      | Runtime 标识 `github-channel:634bc434-213e-449e-8769-88d418cabe9b`；工具返回实际 Issue 正文，随后模型生成评审                                                                                                                                                                     |
| GitHub Redeliver | 原 GUID 再投返回202、相同 taskId、duplicate=true                               | 原 delivery `3855692751452512256`，重投 `3855692931088252928`；没有第二次执行或额外首轮回复                                                                                                                                                                                       |
| 针对性复核       | 新评论建立独立任务，再次 succeeded/sent                                        | [复核触发](https://github.com/xallor-ai/github-agent-channel/issues/2#issuecomment-7105317400)，task `bff96b65-8e40-4915-b639-5df4ee36be67`；[复核回复](https://github.com/xallor-ai/github-agent-channel/issues/2#issuecomment-7105347836)，含 `CHANNEL_REVIEW_FOLLOWUP_DD8111C` |
| 自身事件防循环   | 两条机器人回帖事件均200 ignored，没有建立任务                                  | 对应 GUID `bb7939fc-e750-11f1-8416-9eef65688ecc`、`12893ce2-e751-11f1-94e2-82ad9b6164d0`                                                                                                                                                                                          |
| 两端状态一致     | 云端恰好2个任务、2个 assignment；bridge 两条 journal 均 reported，运行标识不同 | 云端和 bridge 的 user_version 均为2；publicationReceipt 与 GitHub 实际评论地址一致                                                                                                                                                                                                |
| 公网拒绝路径     | 无签名 Webhook400，无 connector 凭据401                                        | 实际公网 HTTP 探测；不是业务任务成功凭证                                                                                                                                                                                                                                          |

## 闭环暴露的问题及处理

| 问题                                                  | 处理/结论                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root 一次性容器生成 bundle 后普通账号无法执行 Compose | 目录权限700且属于root导致 `.env: permission denied`。修正本次输出目录/配置归属后启动成功；运维文档补充生成用户要求。属于部署操作问题，不放宽服务端 secret 权限                                                                                             |
| OpenClaw 容器旧健康检查显示 unhealthy                 | 真实文字和工具探针通过，两轮模型评审成功。不能仅据容器标签判断 Runtime 不可用，也不把本次成功表述为已修复该容器健康检查                                                                                                                                    |
| 首轮模型评审存在两处解释错误                          | 模型说“JSON解析失败是明确错误”，以及“重复call_id都在任何工具执行前拒绝”。实际 JSON解析/读取异常为 AmbiguousExecution；逐项工具语义校验可能在第一个合法读取已执行后才拒绝后续非法调用。通过 Channel 第二轮评审更正，两种行为亦在本机调用实际 Connector 复现 |
| 默认分支仍是早期实现                                  | 本次明确把目标SHA、基线和完整diff放入 Issue；模型只评审这些证据，没有读取默认分支代替当前改动。不能因此宣称已有自动抓取指定 PR/commit diff 的功能                                                                                                          |

首轮“未发现确认问题”是模型结论，并非正确性证明。第二轮完成了对评审内容的质询和更正；没有把上述既有工具执行顺序误判为本次精简新增缺陷。当前工具只有受控读取，不执行写工具。

## 后续修改的评审流程

1. 完成本机检查，记录确切 commit/base，将修改推送到授权开发分支。
2. 确认部署版本、协议和状态库；真实验收不能用旧服务或替身代替。准备包含确切差异/必要上下文的评审 Issue 或会话评论。
3. 通过 Channel 已启用的事件触发，只读评审；保留 delivery GUID、taskId、Runtime 标识、outcome、publicationReceipt 和 GitHub 链接。
4. 核对模型的发现和关键解释；有争议时在同一 Issue 发起独立复核任务，不直接相信“通过”结论。
5. 核对重投去重、机器人事件忽略和两端最终状态，记录边界与尚未验证项。

本次仅验收了 OpenClaw **代码差异评审→评论回写**，未验收 ACP 真实编码 harness、自动编辑/测试→PR 发布、正式 GitHub Review 或自动抓取 PR diff。模型版本选择沿用已有 Runtime 配置，本记录不将其冒充多模型评审。生产配置、凭据与具体服务器路径只保留在受控部署记录中。
