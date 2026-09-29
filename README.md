# dsh-team-hub

面向 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 的团队协作服务。当前仓库：<https://github.com/Hanchenk/dsh-team-hub>。

[English README](README.en.md)

它包含两种可独立使用的模式：

- **团队协作**：独立的 `team` 服务和 Desktop 插件 `dsh-plugin-team-hub`。成员在项目中同步会话与记忆，使用项目工作台，并由服务器上的 AgentTeams 执行任务。
- **单宿主网关**：位于浏览器和本机 DSH Web 之间，提供登录、角色、工作区隔离、RPC/WebSocket 过滤、Admin 控制台和审计。不修改 DSH 本体。

Hub 包版本为 v0.2.7。插件源码在 `packages/dsh-plugin-team-hub`，当前包版本为 `0.1.0-alpha.15`。

> 这是独立社区项目，不是 DeepSeek 官方产品。

## 团队协作

已实现的主要能力：

- 五类组织角色、项目成员管理、会话绑定
- 模型整理摘要和项目记忆，校验通过后自动发布
- 项目工作台：动态、看板、任务、资产、项目指令、专家团和周期自动化
- 服务器常驻 AgentTeams，支持为一个项目关联多个 GitLab 仓库；计划需在页面批准后执行，不自动推送、创建 MR 或部署
- Ed25519 签名的插件发布与客户端自动更新

可信内网试点可以使用 HTTP。团队模式使用 PostgreSQL，配置与下方网关模式分开。

### 系统截图

项目记忆、工作台和 Agent 协作：

![项目记忆](docs/assets/team-memory.png)

![项目工作台](docs/assets/team-workbench.png)

![Agent 协作](docs/assets/team-agents.png)

Desktop 插件里的会话摘要：

![团队插件](docs/assets/team-plugin.png)

详细说明：

- [内网项目协作](docs/team-collaboration.md)
- [AgentTeams 与多仓库](docs/agent-teams.md)
- [项目工作台](docs/workbuddy-integration.md)
- [插件自动更新](docs/plugin-auto-update.md)

### 环境

- Node.js 22.19 或更高版本
- PostgreSQL 15 或更高版本
- 可选：Docker，用于 Compose 部署和 Agent 运行时

### 本机启动

```sh
npm ci
npm run build:plugin
export TEAM_DATABASE_URL='postgresql://<user>:<url-encoded-password>@127.0.0.1:5432/teamhub'
export TEAM_INITIAL_PASSWORD='<至少10位的初始密码>'
node bin/dsh-team-hub.js team init admin
unset TEAM_INITIAL_PASSWORD
npm run team
```

默认地址是 `http://127.0.0.1:3090`。`team init` 创建同时具有系统管理和项目经理角色的账号，首次登录必须修改密码。

添加其他账号：

```sh
export TEAM_INITIAL_PASSWORD='<新成员初始密码>'
node bin/dsh-team-hub.js team user-add developer developer
unset TEAM_INITIAL_PASSWORD
```

角色可用逗号分隔。公司内网部署和模型配置见 [内网项目协作说明](docs/team-collaboration.md)。Compose 示例为 `compose.team.yml`；包含密码的 `.env.team` 不应提交。

插件打包：

```sh
npm run build:plugin
```

安装与发布流程见插件目录 [README](packages/dsh-plugin-team-hub/README.md) 和 [自动更新说明](docs/plugin-auto-update.md)。签名私钥位于 `.plugin-signing/private.pem`，已被 Git 忽略，不要提交。

## 单宿主网关

网关把只监听本机的单用户 DSH Web，变成局域网内可登录、按成员隔离的入口。

```bash
npm install -g dsh-team-hub
dsh-team-hub init alice bob
dsh-team-hub start
```

初始化会打印一次 admin 初始密码。成员入口为 `http://<服务器局域网IP>:3090`，Admin 控制台为同地址下的 `/admin`。所有用户首次登录都必须修改密码。

![Admin 控制台](docs/assets/admin-console.png)

常用命令：

```bash
dsh-team-hub init [--port 3090] [--upstream http://127.0.0.1:3080] [member ...]
dsh-team-hub start
dsh-team-hub selftest
dsh-team-hub user add <name> [--role member|admin]
dsh-team-hub user disable <name>
dsh-team-hub user enable <name>
dsh-team-hub user reset-password <name>
dsh-team-hub patch status|apply|rollback [--dsh-root <path>]
dsh-team-hub service install|status|uninstall
```

运行数据默认在 `~/.dsh-team-hub`，可用 `DSH_TEAM_HUB_HOME` 修改。需要 Node.js 22 或更高版本，以及可访问的 DSH Web，默认 `http://127.0.0.1:3080`。v0.1 网关面向可信局域网，不建议直接暴露到公网。

安全模型、控制台和部署细节：

- [安全说明](docs/security.md)
- [Admin 控制台](docs/admin-console.md)
- [部署](docs/deployment.md)
- [兼容性](docs/compatibility.md)

升级 DSH 后运行 `dsh-team-hub selftest` 和 `npm test`。未识别的新 RPC 方法默认拒绝，避免升级后意外暴露其他成员的数据。

## 开发

```bash
npm ci
npm test
npm run test:team
```

## License

MIT
