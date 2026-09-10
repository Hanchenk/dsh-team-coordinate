# 内网项目协作 Alpha 使用说明

本轮新增独立的 `team` 服务入口和 `dsh-plugin-team-hub@0.1.0-alpha.1` 插件。旧 `dsh-team-hub start`、原配置和个人工作区隔离逻辑保持原样。新入口无须 DSH 上游，也不会给上游打 settings 补丁。

## 已实现的闭环

项目经理创建项目并定向邀请已有账号；成员接受邀请并将本地会话绑定项目；插件自动采集允许的文本片段；Hub 调用兼容 Chat Completions 的模型整理摘要和记忆，自动发布，无人工审核；其他成员同步后可在界面查看，或由自己的 Agent 自动注入/通过工具检索。

五类组织角色均可分配。仅项目经理可建项目、邀请和移除成员；技术总监、项目经理可撤销记忆；项目负责人可以移交给项目内其他项目经理。服务管理员管理账号，不能仅凭 admin 权限读取未加入的项目。

当前为单组织实现，所有账号属于同一个公司团队。邀请绑定账号、项目和角色，72 小时过期、单次兑换；项目经理不能通过邀请赋予目标用户原本没有的组织角色。

## 本机开发

需要 Node.js 22.19+、npm、PostgreSQL 15+。在 Hub 根目录：

```sh
npm ci
npm run build:plugin
export TEAM_DATABASE_URL='postgresql://<user>:<url-encoded-password>@127.0.0.1:5432/teamhub'
export TEAM_INITIAL_PASSWORD='<至少10位的初始密码>'
node bin/dsh-team-hub.js team init admin
unset TEAM_INITIAL_PASSWORD
npm run team
```

默认访问 `http://127.0.0.1:3090`。`team init` 创建一个具有系统管理和项目经理角色的账号；首次登录必须改密。也可以使用 `PGHOST`、`PGUSER`、`PGPASSWORD`、`PGDATABASE` 代替连接 URL。新表使用 `team_` 前缀，启动自动执行幂等 schema 初始化。

添加其他角色账号：

```sh
export TEAM_INITIAL_PASSWORD='<新成员初始密码>'
node bin/dsh-team-hub.js team user-add director technical_director
node bin/dsh-team-hub.js team user-add product product_manager
node bin/dsh-team-hub.js team user-add manager project_manager
node bin/dsh-team-hub.js team user-add developer developer
node bin/dsh-team-hub.js team user-add tester qa_engineer
unset TEAM_INITIAL_PASSWORD
```

角色参数支持逗号分隔的多个角色。管理页面也支持添加账号。当前暂未提供组织角色变更、禁用账号、密码找回界面，不能沿用旧 `user` CLI 管理新数据库账号。

## 配置模型

```sh
export TEAM_MODEL_BASE_URL='http://<内网模型机器>:8000/v1'
export TEAM_MODEL_NAME='<实际模型名称>'
export TEAM_MODEL_API_KEY='<需要认证时填写>'
npm run team
```

服务向 `<baseUrl>/chat/completions` 发送 `response_format: json_object`，模型必须兼容该接口和参数。默认 120 秒超时、单次输出上限 2,000 tokens、每批最多 48,000 字符，单 worker 串行处理，2 秒检查一次队列。通过 `TEAM_MODEL_TIMEOUT_MS` 修改超时后重启。

不配置模型时服务可正常登录和管理项目，输入批次持久排队，页面显示“整理模型尚未配置”；不会生成假数据。补齐配置并重启后自动处理。模型凭据仅在服务器进程环境中持有。

模型输出必须有摘要、合法分类、`reported/uncertain` 证据状态和输入中真实存在的来源 ID。自动校验通过后在同一数据库事务中发布记忆、标记任务完成和追加变更。输出错误/临时失败最多执行 4 次，指数退避；最终失败显示在任务页面。worker 崩溃通过租约回收，成功提交过的任务不重复发布。

## 公司内网部署

原生进程可以绑定服务器内网 IP，并显式设置允许的 Host：

```sh
export TEAM_HOST='192.168.10.20'
export TEAM_PORT='3090'
export TEAM_ALLOWED_HOSTS='192.168.10.20:3090,teamhub.internal:3090'
npm run team
```

也可以使用 `compose.team.yml`。在不提交 Git 的 `.env.team` 中设置以下变量（示意值需替换）：

```dotenv
TEAM_POSTGRES_PASSWORD=replace-with-a-long-password
TEAM_BIND_IP=0.0.0.0
TEAM_PORT=3090
TEAM_ALLOWED_HOSTS=192.168.10.20:3090,teamhub.internal:3090
TEAM_MODEL_BASE_URL=http://192.168.10.30:8000/v1
TEAM_MODEL_NAME=company-model
TEAM_MODEL_API_KEY=
```

```sh
docker compose --env-file .env.team -f compose.team.yml up -d --build
docker compose --env-file .env.team -f compose.team.yml exec -e TEAM_INITIAL_PASSWORD='<初始密码>' hub node bin/dsh-team-hub.js team init admin
```

容器默认向 `0.0.0.0` 发布 Hub 端口，数据库不映射到办公网络。`TEAM_ALLOWED_HOSTS` 仍需填写实际访问地址及端口，不能用 `0.0.0.0` 代替。无需 HTTPS、证书或反向代理；服务器防火墙放行公司实际网段即可。模型可以是内网服务或公司选择的外部服务，外部模型意味着整理输入会离开内网。

### 当前 Mac 部署

本机部署使用 Compose 项目名 `dsh-team`，访问地址为 `http://192.168.100.46:3090`，本机也可使用 `http://127.0.0.1:3090`。插件的 Hub 地址填写前者。`.env.team` 保存本机配置与数据库密码，已忽略 Git，并限制为文件所有者读写。

在 `dsh-team-hub` 目录执行：

```sh
docker compose -p dsh-team --env-file .env.team -f compose.team.yml ps
docker compose -p dsh-team --env-file .env.team -f compose.team.yml logs --tail=100 hub
# 更新代码后重建并启动
docker compose -p dsh-team --env-file .env.team -f compose.team.yml up -d --build
# 修改模型环境变量后重新创建服务
docker compose -p dsh-team --env-file .env.team -f compose.team.yml up -d hub
# 停止，保留数据库卷
docker compose -p dsh-team --env-file .env.team -f compose.team.yml down
```

数据库持久化于 `dsh-team_team-postgres` 卷；不要使用 `down -v`，该参数会删除数据库。部署沿用原账号和项目，无须再次运行 `team init`。原 `dsh-team-dev-postgres` 容器及迁移备份保留作恢复来源，后续新增数据以 Compose 数据库为准。旧本机 `3091` 开发服务在迁移时停止，统一使用 `3090`。

目前未配置真实整理模型；在 `.env.team` 补齐 `TEAM_MODEL_BASE_URL`、`TEAM_MODEL_NAME` 和必要的 `TEAM_MODEL_API_KEY` 后执行上述重新创建命令。若模型运行在同一台 Mac，容器中用 `host.docker.internal` 访问 Mac 上的模型服务。

Docker Desktop 需要保持运行，Mac 需要保持唤醒。若 Mac 内网 IP 变化，应同步修改 `TEAM_ALLOWED_HOSTS` 并重新创建 Hub 容器，插件也需更新地址。

浏览器管理页使用仅保存在页面内存的 token，刷新页面需重新登录；当前未使用 Cookie，因此不存在 Secure Cookie 的 HTTP 兼容问题。插件页面只访问本机 Host，由 Host 通过 HTTP 访问 Hub，长期 token 不传给 renderer。Host/Origin 校验、默认拒绝跨域和 JSON 写请求约束仍然启用。HTTP 链路本身不加密，按可信公司内网使用。

## 打包和安装插件

```sh
npm run build:plugin
npm pack ./packages/dsh-plugin-team-hub --pack-destination artifacts
```

`artifacts/dsh-plugin-team-hub-0.1.0-alpha.1.tgz` 是独立插件包。包中包含 Host、符合 DSH ModuleLoader 格式的 Client、界面静态资源及 Cordis bundle patch；不包含 Hub 服务、PostgreSQL 驱动或用户数据。

通过 Desktop 当前 profile 的标准插件安装入口安装；如果使用 CLI，必须使用 Desktop 配套 DSH，而不是另一套全局运行时：

```sh
dsh plugin add /absolute/path/dsh-plugin-team-hub-0.1.0-alpha.1.tgz --profile <当前profile名称>
```

安装后重启，在侧边栏“团队项目”中登录、接受邀请并绑定本地会话。现有会话只同步绑定后的新内容；“该目录后续新会话自动绑定”只绑定精确目录，避免误匹配嵌套项目。插件重载或 profile 切换后重新登录，队列和归属映射仍保留。

## 验证

```sh
npm test
npm run build:plugin
export TEAM_TEST_DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:5432/teamhub_test'
npm run test:team
npm run verify:team-ui
```

数据库用户需要创建 schema 权限。测试创建随机隔离 schema 并在结束后删除，不修改现存项目。浏览器验证默认使用已安装 Chrome，也可通过 `TEAM_BROWSER_CHANNEL` 指定 Playwright channel。

未配置 `TEAM_TEST_DATABASE_URL` 时，数据库集成测试会明确标记 skip，不应将该结果作为数据库验证通过。浏览器脚本必须配置数据库，截图输出到 `artifacts/team-ui/`。

已覆盖真实 PostgreSQL、HTTP API、模拟模型 HTTP 端点、双客户端队列同步、邀请竞态、越权访问、撤权、撤销、来源校验、重试、token 轮换，以及真实 Cordis 加载/卸载和 DSH Client 模块包装。浏览器流程还验证了项目创建、邀请、插件加入、绑定、事件采集、自动发布、Agent 按项目检索与桌面/窄屏截图。

## 本轮边界与后续工作

这是可以联调的 Alpha 闭环，不是原方案全部阶段的完成版本：

- 尚未对真实打包 Electron Desktop 做安装和三种呈现模式、macOS/Windows 双平台验证。当前 Host 容器测试使用真实 Cordis，DSH services 使用契约测试适配器；Electron 中 `node:sqlite` 兼容性仍需验证。
- 尚未接入公司的真实模型地址和凭据。自动整理链路已用模拟模型验证，真实模型质量、JSON 兼容性及耗时待试点。
- 暂不提供历史私人会话导入、完整会话/工具结果/附件共享、代码同步和远程 Agent 控制。
- 当前按增量批次生成摘要与独立记忆，只做精确内容去重；跨批次语义合并、长期会话滚动摘要、冲突归并、纠错重算、版本回滚仍需后续实现。撤销有 tombstone，精确重复内容不会复活。
- 当前每个项目最多 500 条记忆用于全量缓存，超过时明确报容量错误；用户/项目列表及部分记录列表采用首版有界读取。分页快照、日志保留和来源 30 天清理策略尚未实现，试点需监控存储量。
- 单进程串行 worker，无日 token 预算、按项目配额、45 秒合并窗口和管理端动态模型配置；不适合大规模团队直接上线。
- 系统凭据存储尚未接入，使用内存 token；关闭后重新登录。本地队列最多 200 批，缓存离线使用上限 24 小时。
- 首版选最近 12 条、最多 8,000 字符作为上下文，未实现按任务语义召回；模型可以通过项目限定的记忆检索/读取工具查询完整缓存。
- 组织多租户、旧账号迁移、细化内容编辑权、账号禁用/角色更新管理、数据库升级迁移版本和备份恢复演练尚待补齐。

下一步优先在一台真实 Desktop 安装 Alpha 插件，连接内网 Hub 和公司模型完成试点，再完善多回合归并、配额及正式迁移/运维能力。
