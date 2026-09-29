# 内网项目协作 Alpha 使用说明

当前插件版本为 `dsh-plugin-team-hub@0.1.0-alpha.11`。项目工作台与专家团接入见 [WorkBuddy 调研与实现说明](workbuddy-integration.md)；服务器常驻 AgentTeams、多 GitLab 仓库见 [AgentTeams 部署说明](agent-teams.md)。下文保留会话协作功能和此前版本变更说明。

`0.1.0-alpha.7` 修复 Agent setup 将预设描述对象误作事务调用 `commit()` 的错误。复用只写入目标会话的 seed；关闭项目记忆的默认系统提示词注入，后续普通新会话不继承上次复用历史。记忆同步和项目限定的按需检索继续可用。升级后重启 Desktop，使旧插件注册的提示词注入退出；已有会话历史不会自动删除。

`0.1.0-alpha.6` 修复复用后工作区不显示：Desktop 的会话列表以 `turn/start` 判断非空，单独写入 recall 会被隐藏。现通过 Agent 的 seed 接口导入已结束轮次，再关联工作区、命名并等待持久化；默认模型和 Agent 预设沿用本机配置。旧隐藏会话不自动改写，升级后重新复用。运行时契约验证脚本为 `scripts/verify-team-reuse-runtime.mjs`，使用 `DSH_RUNTIME_MODULES` 指向隔离安装的 Desktop 运行时 node_modules，`DSH_RUNTIME_TARBALLS` 指向对应 vendor 包目录。

## 已实现的闭环

`0.1.0-alpha.5` 修复：同一项目按设备、profile 与本地 session 标识合并共享会话，切换登录账号不会重复创建记录或模型任务；旧重复记录自动合并显示，旧链接继续可读，原上传审计保留。不同项目之间不合并。会话页和项目记忆页仅在返回数据变化时更新内容，无变化时保留原 DOM；新数据先完整读取再更新，避免清空闪动。

模型整理读取该批消息之前的同会话上下文，最多最近 100 条、48,000 字符，不再只读取孤立的单条消息。模型没有提取出新知识时，整理任务显示“已整理 · 无新增项目记忆”，原始会话和摘要仍然保留；一般闲聊或身份确认不强制生成项目记忆。

项目经理创建项目；项目经理和技术总监通过用户下拉框直接添加已有账号，无需接受邀请；成员登录并选择项目后关联已有工作区或新建工作区；插件自动同步该目录中已有及后续会话的可见文本；Hub 调用兼容 Chat Completions 的模型整理摘要和记忆，自动发布，无人工审核；其他成员同步后可在界面查看，或由自己的 Agent 通过工具按需检索。

五类组织角色均可分配。仅项目经理可建项目；项目经理和技术总监可直接添加和移除成员；技术总监、项目经理可撤销记忆；项目负责人可以移交给项目内其他项目经理。服务管理员管理账号，不能仅凭 admin 权限读取未加入的项目。

当前为单组织实现，所有账号属于同一个公司团队。成员下拉框展示尚未加入项目的活跃账号及数量，只能选择该用户已有的组织角色。旧邀请 API 保留兼容旧客户端，新版 UI 已取消邀请令牌与接受邀请入口。

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

## 后台配置模型

管理员登录管理页后展开“整理模型配置”，填写服务地址（如 `http://host.docker.internal:8000/v1`）、模型名称、可选 API Key 和超时。保存后立即供下一次整理任务使用，无须重启容器。只有 admin 可读写配置；API 不回传密钥，空密钥输入保留原值，勾选清除后移除原密钥。配置持久化在 PostgreSQL，优先于环境变量，数据库备份也包含此配置。

### 环境变量初始值

```sh
export TEAM_MODEL_BASE_URL='http://<内网模型机器>:8000/v1'
export TEAM_MODEL_NAME='<实际模型名称>'
export TEAM_MODEL_API_KEY='<需要认证时填写>'
npm run team
```

服务向 `<baseUrl>/chat/completions` 发送 `response_format: json_object`，模型必须兼容该接口和参数。默认 120 秒超时、单次输出上限 2,000 tokens、每批最多 48,000 字符，单 worker 串行处理，2 秒检查一次队列。通过 `TEAM_MODEL_TIMEOUT_MS` 修改超时后重启。

不配置模型时服务可正常登录和管理项目，输入批次持久排队，页面显示“整理模型尚未配置”；不会生成假数据。补齐配置并重启后自动处理。模型凭据由服务器环境或管理员保存的数据库配置持有，客户端仅收到配置是否包含密钥的标记。

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

容器默认向 `0.0.0.0` 发布 Hub 端口，数据库不映射到办公网络。`TEAM_ALLOWED_HOSTS` 仍需填写实际访问地址及端口，不能用 `0.0.0.0` 代替。未启用 SSO 的可信内网部署无需 HTTPS、证书或反向代理；服务器防火墙放行公司实际网段即可。启用 SSO 时请按下方生产说明配置 HTTPS。模型可以是内网服务或公司选择的外部服务，外部模型意味着整理输入会离开内网。

### 当前 Mac 部署

本机部署（未启用 SSO）使用 Compose 项目名 `dsh-team`，访问地址为 `http://192.168.100.46:3090`，本机也可使用 `http://127.0.0.1:3090`。插件的 Hub 地址填写前者。启用 SSO 的生产部署应改用 HTTPS 反向代理地址，见下方说明。`.env.team` 保存本机配置与数据库密码，已忽略 Git，并限制为文件所有者读写。

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

真实整理模型可由 admin 在管理页配置，也可在首次部署前通过 `.env.team` 设置环境变量初始值。若模型运行在同一台 Mac，容器中用 `host.docker.internal` 访问 Mac 上的模型服务。

Docker Desktop 需要保持运行，Mac 需要保持唤醒。若 Mac 内网 IP 变化，应同步修改 `TEAM_ALLOWED_HOSTS` 并重新创建 Hub 容器，插件也需更新地址。

浏览器管理页使用仅保存在页面内存的 token，刷新页面需重新登录；当前未使用 Cookie，因此不存在 Secure Cookie 的 HTTP 兼容问题。插件页面只访问本机 Host，由 Host 通过配置的 HTTP/HTTPS Hub 地址访问服务，长期 token 不传给 renderer。Host/Origin 校验、默认拒绝跨域和 JSON 写请求约束仍然启用。未启用 SSO 时的 HTTP 链路本身不加密，应仅用于可信公司内网。

### 野马通行证 SSO（生产）

完整的通行证接口字段和状态码见 [野马通行证外部服务接入指南](https://gitlab.yemast.com/awesome-skill/yemast_certificate/-/blob/master/docs/sso-integration-guide.md)。Hub 支持通过野马通行证的桌面端登录态直接创建 Team Hub 会话。插件 Host 从本机通行证服务 `http://127.0.0.1:19800` 读取短暂的 access token，再提交到 Hub；Hub 服务端调用通行证的 `/api/validate` 校验 token 后才建立本地账号映射。Hub 不信任浏览器提交的用户名、角色或 JWT 内容，也不会把通行证角色自动提升为 Team Hub 管理员或项目角色。

在生产环境的 Hub 容器或进程中设置通行证服务的地址。地址应指向可由 Hub 服务器访问的 HTTPS 反向代理；不要把桌面端的 `127.0.0.1:19800` 填到 `TEAM_SSO_BASE_URL`，它只用于插件所在电脑的本地服务。

启用 SSO 时，插件到 Hub 的访问链路也应使用 HTTPS 反向代理；否则短暂的通行证 access token 会以明文经过内网。反向代理终止 TLS 后，应将 `TEAM_ALLOWED_HOSTS` 配置为代理转发给 Hub 的实际 `Host`（包含端口时也要包含端口）。未启用 SSO 的可信内网部署仍可使用本节前面的 HTTP 方式。

启用 SSO 后，Hub 的登录页、静态资源和 `/team/v1/` API 都要求安全传输，只有 `/health` 保留为无凭据预检入口。插件和浏览器会先读取该预检结果；只有 Hub 明确声明关闭 SSO 且不要求安全 API 时，才会在远程 HTTP 上发送账号密码。生产环境应直接使用 HTTPS 地址，不要依赖 HTTP 回退。

```dotenv
TEAM_SSO_BASE_URL=https://<生产通行证域名>
TEAM_SSO_PROVIDER=yemast
TEAM_SSO_TIMEOUT_MS=5000
TEAM_SSO_ALLOW_INSECURE=false
TEAM_SSO_TRUST_PROXY=true
TEAM_SSO_PROXY_ADDRESSES=127.0.0.1,::1
TEAM_SSO_DEFAULT_ROLES=developer
```

`<生产通行证域名>` 只是占位符，不能原样部署；当前仓库没有真实生产地址或凭据。部署前必须由通行证运维提供可从 Hub 主机访问的 HTTPS 地址，并替换该值。未设置 `TEAM_SSO_BASE_URL` 时 SSO 保持关闭，账号密码登录仍可用。旧部署若仍使用 `TEAM_CERTIFICATE_BASE_URL`，Compose 会兼容透传它并遵守同样的 HTTPS 校验；新部署请使用 `TEAM_SSO_BASE_URL`。

`TEAM_SSO_ALLOW_INSECURE` 默认关闭。它只控制 Hub 到通行证上游的地址是否允许使用明文 HTTP；只有本地开发或隔离测试环境才临时设为 `true`。用户电脑到 Hub 的 SSO 链路仍必须使用 HTTPS（或本机 `localhost`/回环地址开发），生产环境应保持 `false` 并通过 HTTPS 反向代理访问通行证。

`TEAM_SSO_TRUST_PROXY` 默认关闭。生产 Hub 放在 TLS 反向代理后时，代理必须覆盖并转发 `X-Forwarded-Proto: https`，同时将该变量设为 `true`；Hub 只在 `TEAM_SSO_PROXY_ADDRESSES` 列出的代理来源地址收到该 header 时信任它。默认只信任本机回环地址；如果代理运行在另一台机器或 Docker 网桥中，必须把代理的固定源 IP 加入该变量，不能把 Hub 端口直接暴露给公网。启用 SSO 后，所有 `/team/v1/` API（包括账号密码回退、刷新和业务请求）都要求 HTTPS；本机 `localhost`、`127.0.0.1` 和 `[::1]` 的 HTTP 仅用于开发。

`TEAM_SSO_TIMEOUT_MS` 必须是 `500` 到 `30000` 之间的整数；`TEAM_SSO_DEFAULT_ROLES` 支持逗号分隔，但只允许低权限的 `developer` 和 `qa_engineer`。`project_manager`、`technical_director` 等高权限组织角色必须由管理员在本地显式授予，不能通过 SSO 默认配置批量授予。其他值或高权限角色会在 Hub 启动时直接报错，不会等到第一次登录才发现。

配置后重建或重启 Hub：

```sh
docker compose -p dsh-team --env-file .env.team -f compose.team.yml up -d --build hub
```

用户需要先在自己的电脑上登录野马通行证桌面端，再在插件登录页点击“使用野马通行证登录”。桌面端未登录、未运行或本机服务不可达时，界面会提示原因；可以继续使用 Hub 的账号密码登录接口作为回退。浏览器版 Hub 页面也会尝试读取本机通行证服务；当前桌面端按接入指南允许跨域，若后续部署收紧本地服务来源策略，需将 Hub 页面来源加入白名单。跨设备访问时应优先使用插件 Host 登录路径。

首次 SSO 登录会按通行证返回的稳定 `id`（以及 `TEAM_SSO_PROVIDER`）创建或绑定本地用户，默认只授予低权限的 `TEAM_SSO_DEFAULT_ROLES` 组织角色。通行证返回的职位只记录在身份审计信息中，不会改变本地角色。为避免用户名冲突继承权限，只有尚未完成首次改密、尚未加入项目且没有组织高权限角色的普通本地账号会做兼容绑定；已有同名管理员、高权限账号或项目成员会创建独立的 `sso_<hash>` 用户。高权限角色和项目成员关系仍需管理员在 Hub 内显式配置。同一 provider 下一个本地账号绑定另一个 subject 会被拒绝。停用本地账号、项目成员关系和项目权限仍由 Hub 管理。

生产检查清单：

- Hub 对插件和浏览器的入口使用 HTTPS；反向代理转发的 `Host` 已加入 `TEAM_ALLOWED_HOSTS`。
- 反向代理覆盖 `X-Forwarded-Proto` 为 `https`，Hub 设置 `TEAM_SSO_TRUST_PROXY=true`，并将代理固定源 IP 写入 `TEAM_SSO_PROXY_ADDRESSES`；不信任来自公网客户端自行提交的该 header。
- 通过 HTTPS 反向代理到通行证 `/api/validate`、`/api/login` 和 `/api/refresh`，并仅允许 Hub 服务网段访问。
- 不要把通行证 `JWT_SECRET` 或 refresh token 配置到 Hub，也不要把 token 写入日志、前端持久化或错误响应。
- 插件的 SSO 按钮会把短期 access token 交给当前填写的 Hub 地址，只在确认地址属于团队服务时使用，不要把未验证的第三方地址填入登录页。
- 修改 `.env.team` 后重新创建 Hub 容器；确认日志只显示 SSO 地址和状态，不显示 access token。
- 先用一台已登录通行证桌面端的插件验证新用户创建、再次登录幂等和账号密码回退，再扩大到其他客户端。

## 打包和安装插件

```sh
npm run build:plugin
npm pack ./packages/dsh-plugin-team-hub --pack-destination artifacts
```

`artifacts/dsh-plugin-team-hub-0.1.0-alpha.11.tgz` 是独立插件包。包中包含 Host、符合 DSH ModuleLoader 格式的 Client、界面静态资源及 Cordis bundle patch；不包含 Hub 服务、PostgreSQL 驱动或用户数据。

通过 Desktop 当前 profile 的标准插件安装入口安装；如果使用 CLI，必须使用 Desktop 配套 DSH，而不是另一套全局运行时：

```sh
dsh plugin add /absolute/path/dsh-plugin-team-hub-0.1.0-alpha.11.tgz --profile <当前profile名称>
```

安装后重启，点击右下角悬浮球登录。选择项目后弹窗关联已有工作区或按绝对目录新建工作区；精确目录中的已有、已保存及后续会话自动绑定并上传。首次升级会补同步原有绑定会话的早期文本。每 2 秒检查上传与项目列表，打开会话页时每 2 秒拉取最新记录；这是秒级轮询，不是逐 token 推送。插件重载或 profile 切换后需重新登录，队列和归属映射仍保留。

会话记录独立于模型整理保存，没有模型也能查看。会话列表及消息分页读取；“复用会话”在指定工作区创建自己的持久化会话，以 Harness recall 上下文保存完整文本和来源信息，随后从工作区的“复用 · 标题”会话继续。不会复制另一人的 Agent、工具执行状态或本机附件。

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
- 会话同步范围是所选项目工作区的用户/助手可见文本，包括已有历史。暂不共享隐藏推理、工具调用状态或附件二进制；服务器 Agent 协作使用独立任务和多仓库检出，不控制个人 Desktop Agent。
- 当前按增量批次生成摘要与独立记忆，只做精确内容去重；跨批次语义合并、长期会话滚动摘要、冲突归并、纠错重算、版本回滚仍需后续实现。撤销有 tombstone，精确重复内容不会复活。
- 当前每个项目最多 500 条记忆用于全量缓存，超过时明确报容量错误；用户/项目列表及部分记录列表采用首版有界读取。分页快照、日志保留和来源 30 天清理策略尚未实现，试点需监控存储量。
- 单进程串行 worker，无日 token 预算、按项目配额和 45 秒合并窗口；不适合大规模团队直接上线。
- 系统凭据存储尚未接入，使用内存 token；关闭后重新登录。本地队列最多 200 批，缓存离线使用上限 24 小时。
- 不再默认注入最近项目记忆；模型可以通过项目限定的记忆检索/读取工具按需查询完整缓存。
- 组织多租户、旧账号迁移、细化内容编辑权、账号禁用/角色更新管理、数据库升级迁移版本和备份恢复演练尚待补齐。

下一步优先在一台真实 Desktop 安装 Alpha 插件，连接内网 Hub 和公司模型完成试点，再完善多回合归并、配额及正式迁移/运维能力。
