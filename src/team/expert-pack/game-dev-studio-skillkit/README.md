# 游戏开发工作室 · 专家团技能包（Game Development Studio Skill Kit）

> 由 **1 位主理人 + 6 位专家成员** 组成的 Team 型专家包。它是一个可直接安装到 WorkBuddy 的「团队专家插件」，把一次 AI 会话升级为一个完整的游戏开发工作室，驱动一款游戏从**概念 → 系统设计 → 技术搭建 → 预制作 → 制作 → 打磨 → 发布**全流程协同推进。

---

## 这个技能包做什么

把「独立游戏开发」按专业职能拆成六大域，每域由一位专家负责，主理人统一编排、管质量门、汇编交付。它把数十种传统工作室角色归并为 6 大专业成员，调度更轻、职责更清。

| 专业域 | 成员（花名 / Agent ID） | 核心职责 |
|--------|------------------------|----------|
| 游戏策划与叙事设计 | 文策渊 `design-strategist` | 概念/MDA/GDD/关卡/经济/世界观/UX |
| 技术与引擎工程 | 程基岩 `engineering-lead` | 架构/ADR/Godot·Unity·Unreal/玩法·引擎·AI·网络代码/性能/DevOps/安全 |
| 美术与视觉表现 | 林绘澄 `art-director` | 美术圣经/资产规格/着色器·VFX/技术美术/可访问性 |
| 音频与声效设计 | 阮和鸣 `audio-director` | 音乐方向/音效/混音/音频实现/配音 |
| 质量保障与测试 | 严守真 `quality-lead` | 测试策略/QA 计划/烟雾测试/回归/Bug 分级/Playtest |
| 发布与运营管理 | 路远行 `release-ops-lead` | 发布清单/本地化/Live Ops/社区/热修/回滚 |
| **统一编排·SOP·质量门·汇编** | **主理人 游承峰 `game-development-studio-team-lead`** | 阶段诊断、路由调度、门控评审、最终交付 |

---

## 七阶段标准工作流（SOP）

1. **概念孵化** — 头脑风暴、设计支柱、MDA 分析、美术圣经
2. **系统设计** — 系统拆解、逐系统 GDD、跨 GDD 一致性评审
3. **技术搭建** — 主架构、ADR、控制清单、可访问性分级
4. **预制作** — UX 规格、资产规格、Epic/Story 拆分、测试脚手架、首冲刺
5. **制作** — 按冲刺循环实现 Story、QA、设计评审、范围检查
6. **打磨** — 性能剖析、平衡检查、资产审计、多轮 Playtest
7. **发布** — 发布清单、补丁说明、本地化、上线门控

> 主理人铁律：**编排者只编排，不建造**。专业产出（GDD/架构/测试用例/美术规格）由各成员负责，主理人只做调度、一致性检查与汇编。任何文件 Write/Edit、git commit、发布/回滚等高影响动作，必须经用户许可。成员之间不直连，所有产出经主理人中转。

---

## 目录结构

```
game-dev-studio-skillkit/
├── README.md                      # 本说明文档
├── .codebuddy-plugin/
│   └── plugin.json                # 专家包元数据清单（WorkBuddy 识别入口）
├── agents/                        # 7 个 SKILL.md：主理人 + 6 成员
│   ├── game-development-studio-team-lead.md   # 主理人游承峰
│   ├── design-strategist.md       # 文策渊
│   ├── engineering-lead.md        # 程基岩
│   ├── art-director.md            # 林绘澄
│   ├── audio-director.md          # 阮和鸣
│   ├── quality-lead.md            # 严守真
│   └── release-ops-lead.md        # 路远行
└── avatars/                       # 7 张成员头像（PNG，插件显示用）
    ├── game-development-studio-team-lead.png
    ├── design-strategist.png
    ├── engineering-lead.png
    ├── art-director.png
    ├── audio-director.png
    ├── quality-lead.png
    └── release-ops-lead.png
```

每个 `agents/*.md` 是一个**标准 SKILL 文档**，文件头含 WorkBuddy 专家元数据：

```yaml
---
name: <agent-id>                      # 成员唯一 ID，需与 plugin.json 中一致
description: <激活描述>               # 触发该专家的关键词与职责域
displayName:
  en: "<English 显示名>"
  zh: "<中文显示名>"
profession:
  en: "<English 职业>"
  zh: "<中文职业>"
maxTurns: 80                          # 该专家单次会话最大轮次
---
# 正文：角色定位 / 核心能力 / 数据获取 / 分析框架 / 工作方式 / 输出规范 / 注意事项
```

---

## 如何安装到 WorkBuddy（本地）

技能包已符合 WorkBuddy 专家插件格式，两种安装方式任选其一：

### 方式 A：放入专家插件目录（推荐，可被「专家」入口识别）

将整个 `game-dev-studio-skillkit/` 文件夹复制（或软链）到 WorkBuddy 专家插件目录，并确保目录名与 `plugin.json` 的 `name` 一致：

```bash
# 目标目录（macOS 示例），如不存在请先创建
mkdir -p "$HOME/.workbuddy/plugins/marketplaces/experts/plugins/"

# 复制（或：ln -s 软链，便于后续编辑同步）
cp -R game-dev-studio-skillkit "$HOME/.workbuddy/plugins/marketplaces/experts/plugins/game-development-studio"

# 重启 WorkBuddy / 刷新专家列表后，即可在「专家」入口看到
# 「游戏开发工作室（game-development-studio-team-lead）」
```

### 方式 B：作为用户级/项目级 Skill 引用

若只想复用成员定义作为普通 Skill，可把 `agents/` 下的 `.md` 文件按需放入：
- 用户级：`~/.workbuddy/skills/<name>/SKILL.md`
- 项目级：`<workspace>/.workbuddy/skills/<name>/SKILL.md`

（注意：Team 型协作依赖 `plugin.json` 中的 `teamInfo` 与主理人调度逻辑，单独复制单个 `.md` 会丢失「spawn 成员 + SendMessage 中转」的团队工作流。）

### 避免名称冲突

若你已通过专家市场安装过同名插件，本地再装一份会冲突。可将 `plugin.json` 的 `name` 与 `plugin` 字段改为自定义名（如 `game-dev-studio-local`），并同步修改目录名，即可并存。

---

## 典型用法（开局提示词）

| 你想做的事 | 直接说 |
|-----------|--------|
| 不知从哪开始 | 「帮我把游戏项目当工作室来推进，先告诉我现在该走哪个阶段」 |
| 从零想一个游戏 | 「帮我头脑风暴一个游戏概念，含设计支柱、MDA 分析与范围分层」 |
| 推进开发 | 「规划下一个冲刺：挑选就绪故事、实现、测试并收尾」 |
| 准备发布 | 「帮我跑一遍发布清单，确认能不能上线」 |

与主理人游承峰对话，它会先诊断你所在阶段，再按 SOP 调度对应成员。你也可以跳过主理人，**直接对单个成员提问**（如「文策渊，帮我写一份战斗系统的 GDD」），但那样不会走完整团队质量门。

---

## 适用 / 不适用

- ✅ 有结构、多职能、多阶段的游戏项目（从概念到上线）
- ✅ 想用工作室流程约束自己、避免硬编码与跳过设计文档的独立开发者
- ❌ 单一孤立小问题——可直调对应成员，无需走完整 SOP

---

## 自定义与扩展

- **改角色/职责**：编辑对应 `agents/*.md` 的「角色定位 / 核心能力」。
- **增删成员**：在 `plugin.json` 的 `teamInfo.memberAgents`、`agents`、`members` 三处同步增删，并新增对应 `agents/<id>.md`。
- **改阶段流**：主理人 `game-development-studio-team-lead.md` 中的 Phase 0–8 即 SOP，可增删阶段。
- **换头像**：替换 `avatars/` 下同名 PNG，并保持 `plugin.json` 中 `avatar` / `members[].avatar` 路径一致。

> 本技能包内容以 WorkBuddy 专家市场中「游戏开发工作室」团队专家为蓝本生成，保持其一贯的编排者角色设定与七阶段工作流。
