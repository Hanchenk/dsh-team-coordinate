# 内网 AgentTeams 与多仓库项目

插件 `0.1.0-alpha.8` 新增 Agent 协作和 GitLab 仓库入口。项目经理、技术总监可以将 Agent 作为项目成员添加，配置角色和职责，并为一个项目关联多个仓库。项目成员创建任务时选择参与的 Agent 和仓库。页面展示规划、任务依赖、成员状态、执行消息和任务输出。

## 运行方式

Hub 将任务保存到 PostgreSQL；服务器上的 agent-supervisor 常驻领取任务，每次协作创建独立 Docker 容器，运行原生 AgentTeams 调度器。Desktop 只负责操作和查看，关闭、退出登录或者断网不会停止服务器任务。

运行时固定为 Harness `0.1.2-rc.1`、AgentTeams `0.1.16-rc.3`，与 Desktop 的版本独立。团队先生成计划，在页面批准后开始派发任务。项目记录的模型整理仍自动发布，不需要审核；任务执行计划批准是另一项操作。

## 部署

在仓库目录运行：

```sh
docker compose -p dsh-team --env-file .env.team -f compose.team.yml --profile agents build
docker compose -p dsh-team --env-file .env.team -f compose.team.yml --profile agents up -d
```

服务默认绑定 `0.0.0.0:3090`，本机内网入口为 `http://192.168.100.46:3090`。Docker Desktop 必须保持运行，Mac 必须保持唤醒。执行管理容器按 `unless-stopped` 策略启动。

管理员在后台单独配置“Agent 执行模型”的兼容 Chat Completions 服务地址、模型名和密钥。配置独立于整理模型，不复用个人 Desktop 的模型凭据。模型需要支持工具调用。

## 多仓库

项目的“GitLab 仓库”页可以添加多个 HTTP/HTTPS 克隆地址、分支和访问令牌；私有仓库使用具备 `read_repository` 权限的个人访问令牌。默认允许 `gitlab.yemast.com`，其他内网 GitLab 地址需写入 `TEAM_GITLAB_HOSTS`，多个主机用逗号分隔，非默认端口应包含端口。

每个仓库有独立目录名称，例如 `frontend`、`backend`。任务检出到 `/workspace/repos/frontend`、`/workspace/repos/backend`，记录实际提交 SHA。任务保存创建时的 Agent 和仓库配置快照；移除项目仓库不会删除已有任务成果。

GitLab 令牌加密存入数据库，加密密钥位于 `team-agent-secrets` 卷；备份时需要同时保留数据库及此卷。令牌仅用于服务器检出，不写入仓库配置，也不传给任务容器。

## 成果与运行限制

- 页面支持读取任务结果、成员消息和执行状态，约每 2 秒更新。
- 修改后的代码和文件保留在 `dsh-team-agent-data` 卷的 `<任务ID>/workspace` 下。当前没有网页下载接口，管理员可用 `docker cp dsh-team-run-<任务ID>:/workspace/repos ./任务成果` 导出仓库；交付文件位于 `/workspace/deliverables`。
- 不自动推送、创建 MR、合并或部署。仓库和 Agent 配置当前支持添加、删除，修改时需要重新添加。
- 默认最多同时执行 2 个任务，每任务最长 1 小时、最多 200 次模型请求；容器限制为 2 CPU、4 GiB 内存。并发通过 `TEAM_RUN_CONCURRENCY` 配置。
- 执行管理服务重启会接管原有运行容器。服务器或 Docker 引擎重启后，停止或丢失的执行标记失败，当前不自动恢复模型执行；需要重新创建任务。
- 任务创建者被移出项目或账号停用后，执行管理服务会停止任务。项目成员只能访问所在项目的任务和配置。
- 任务容器使用只读根文件系统，不挂载 Docker socket 或数据库凭据，只挂载本任务目录。管理容器持有 Docker socket，应仅部署在可信内网服务器。
- 已结束容器及成果暂不自动清理；管理员在导出成果后安排清理和容量监控。

## 验证范围

已使用真实 Docker、PostgreSQL 和固定版本的原生 AgentTeams 验证团队创建、计划批准、成员派发及完成，并验证两个 Git 仓库检出和执行管理服务重启接管。模型采用确定性 HTTP 测试服务；真实执行模型、私有 GitLab 凭据和打包 Electron 安装仍需现场验收。

AgentTeams 图标的许可证见插件包 `THIRD_PARTY_NOTICES.md`。
