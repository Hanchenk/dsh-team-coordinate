# DSH Team Hub Plugin

这是面向 DSH Desktop 的内网项目协作插件，当前版本 `0.1.0-alpha.1`。

支持内网 HTTP 登录、项目创建与邀请、项目成员管理、本地会话/目录绑定、对话增量采集、记忆自动同步、Agent 上下文注入和 `team_memory_search` / `team_memory_read` 工具。

模型整理由配套 Hub 服务统一执行，自动发布，无需审核。插件不收集个人模型 API 密钥。只有明确绑定项目的会话参与采集；首次绑定现有会话从绑定时的事件位置开始，已有私人历史不上传。勾选目录绑定后，该目录后续新会话自动加入项目。

## 安装

本包需要支持 `node:sqlite` 的 Node.js 22.19+，以及提供 `desktopProfiles`、`webServer`、`sessions` 的 Desktop profile。`systemPrompt` 和 `tools` 可选，没有对应服务时界面仍可用。运行时接口检查基于 DSH `0.1.2-rc.1`。

使用 Desktop 标准插件管理入口安装此精确版本或本地 `.tgz` 包。使用该 Desktop 配套的 DSH CLI 时，可在当前 profile 下运行：

```sh
dsh plugin add /absolute/path/dsh-plugin-team-hub-0.1.0-alpha.1.tgz --profile <当前profile名称>
```

重启 Desktop，侧边栏进入“团队项目”。输入内网 Hub 地址并登录，首次登录修改密码，然后加入项目，在“本地绑定”选择当前会话。

如果目标安装器只接受 npm 名称，将包上传公司内网 npm 仓库后安装 `dsh-plugin-team-hub@0.1.0-alpha.1`。不要安装到与 Desktop 无关的全局 DSH profile。

## 行为与限制

- 每 15 秒同步；本地 SQLite 保存队列、来源位置和缓存，网络故障后使用相同操作 ID 重试。
- 数据存放在 `~/.dsh-team-plugin/<当前profile目录哈希>/team.sqlite`，不写入 Desktop 管理的 profile 镜像。可通过插件配置的绝对 `dataDir` 覆盖；移动 profile 目录时需要一并迁移该插件数据目录。
- 长期凭据不落盘。关闭 Desktop/profile 或插件卸载后需要重新登录；重登后先重新验证项目权限，再加载记忆。
- 仅采集用户输入和助手可见文本；不采集隐藏推理、插件上下文、工具结果和附件。超长单条消息截取前 12,000 字符，首次版本会损失截断部分的证据。
- 缓存最多离线使用 24 小时；登录失效或项目撤权后停止注入。当前上下文选取最近 12 条、最多 8,000 字符；完整缓存可用项目内检索工具查询。
- 本地队列上限 200 批；满载时停止推进采集位置并显示错误，待队列恢复后通过历史查询补偿。
- 页面共享记录只读，无法控制他人的 Agent 或代为批准其工具请求。
- 已完成真实 Cordis 的插件加载/卸载测试、DSH Client ModuleLoader 格式检查及浏览器插件界面联调。**尚未在真实打包的 Electron Desktop 中完成安装、三种呈现模式和 macOS/Windows 双平台验证，因此当前属于 Alpha 试用包。**

服务端部署、模型配置及本轮未实现项见 Hub 仓库 `docs/team-collaboration.md`。
