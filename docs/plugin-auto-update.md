# 插件自动更新

从 `dsh-plugin-team-hub@0.1.0-alpha.11` 起支持从内网 Hub 拉取签名包，并通过 Desktop 的 `desktopPnpm.runPlugin` 安装到当前 profile。Hub 使用 HTTP，当前部署地址为 `http://192.168.100.46:3090`，监听 `0.0.0.0:3090`。

## 使用

1. 旧版没有更新器，需要最后手动安装一次 `artifacts/dsh-plugin-team-hub-0.1.0-alpha.11.tgz`，然后重启 Desktop。
2. 登录团队插件，更新器保存该 Hub 地址。默认开启自动更新，每 30 分钟检查一次；Desktop 运行期间最多约一分钟调度延迟。关闭 Desktop 期间不执行客户端更新，下次启动继续检查，无需重新登录即可读取公开发布信息。
3. 云端有更新版本时，后台下载、校验和安装。不会主动重启 Desktop；保存当前工作后自行重启，新版才完整生效。
4. 面板顶部“插件更新”显示运行版本、安装版本、检查结果；可关闭自动更新或点击“检查并更新”。显式检查会执行安装，即使自动更新已关闭。

需要提供 `desktopPnpm.runPlugin` 的 Desktop 版本。缺少该服务时界面提示不支持，仍可手动安装。下载或验签失败不会开始安装；安装失败会尝试重装保留的旧包并核对版本，回退失败时提示从 Desktop 插件管理修复。安装过程中强制退出、断电等情况无法保证自动回退，必要时手动重装保留包。

## 发布新版本

先提升 `packages/dsh-plugin-team-hub/package.json` 的版本号，例如 `0.1.0-alpha.12`，完成相关测试并更新说明。然后在 Hub 仓库根目录执行：

```sh
npm run build:plugin
npm pack ./packages/dsh-plugin-team-hub --pack-destination artifacts
node scripts/publish-plugin-release.mjs artifacts/dsh-plugin-team-hub-0.1.0-alpha.12.tgz
```

发布脚本验证包元数据，生成内容寻址的 `.tgz` 和签名 `latest.json`，输出到 `artifacts/plugin-releases`。Compose 将该目录只读挂载到 Hub，因此后续仅发布插件包无需重启服务器；服务器代码有变化时另外构建部署 Hub。不是从 GitLab 分支自动构建发布，提交代码后仍需维护者执行上述发布流程。

发布接口：

- `GET /team/v1/plugin-releases/latest`：签名版本清单。
- `GET /team/v1/plugin-releases/<sha256>.tgz`：对应包体。

接口允许未登录客户端读取插件包，以便重启后自动更新；不提供匿名上传。通过 `TEAM_PLUGIN_RELEASE_DIR` 可指定发布目录。签名覆盖包名、版本、协议、大小和 SHA-256。客户端使用随插件发布的固定 Ed25519 公钥验证，只接受更高版本，并拒绝路径越界、符号链接及安装生命周期脚本。HTTP 无法避免网络阻断或旧清单重放造成的更新延迟，但篡改包无法通过验签，已安装版本不会自动降级。

## 签名密钥与本地缓存

本机已初始化签名密钥。私钥 `.plugin-signing/private.pem` 已从 Git 和 Docker 构建上下文排除，切勿提交或复制进公开包。请单独备份；后续发布必须使用同一私钥，可通过 `TEAM_PLUGIN_SIGNING_KEY` 指定绝对路径。公钥在 `packages/dsh-plugin-team-hub/src/release-key.json`。`node scripts/init-plugin-signing.mjs` 用于首次初始化，不应在丢失密钥后随意换钥；换钥需要向已有客户端另行分发信任新公钥的插件。

客户端状态、签名包和回退包保存在 `~/.dsh-team-plugin/<profile目录哈希>/updates/`（自定义 `dataDir` 时在其下）。下载包作为 profile 的本地依赖来源保留，请勿在插件仍依赖它时删除。更新不改项目数据库和会话内容；旧包回退仅恢复插件代码。

## 验证范围

包含真实 tar 包和临时签名密钥的更新器测试，验证重复检查合并、签名及摘要校验、拒绝降级、失败回退、禁用更新和重启状态恢复。36 项团队测试、49 项原有测试和浏览器联调通过；已在隔离的 DSH profile 中通过真实 CLI 将 alpha.10 升级为 alpha.11，并验证 bundle 注册保留。Desktop 安装服务使用契约夹具验证；打包 Electron 中跨版本更新和 Windows 安装仍需实际客户端验收。
