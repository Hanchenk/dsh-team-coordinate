---
name: humanize-ppt-skills
description: >-
  AST-based outline director for human-centered AI presentation workflows. Use before generating PPT/HTML slides from raw material.
metadata:
  source: workbuddy
  originalName: humanize-ppt
  originalLead: humanize-ppt/SKILL.md
---

# Humanize PPT

Use this skill when a user wants to turn raw material, notes, voice transcripts, documents, links, or old PPTs into a presentation-ready outline before rendering slides.

## Positioning

Humanize PPT is an **Outline Director** and **Agent Teams Orchestrator**, not a slide renderer.

It should run before downstream PPT / HTML slide skills. Its job is to produce a clean AST-based production brief so renderers do not ingest raw noisy material directly.

In Agent Teams mode, the main Humanize PPT Agent loads this skill and controls specialist agents:

- Guizang Agent for Chinese stable rendering.
- Zara Agent for style exploration, HTML production, and deploy.
- HyperFrames Agent for video slots.
- Presenter Agent for presenter mode after the deck is finalized.
- QA Agent for content, visual, path, and delivery checks.

## AST theory

AST means **Audience-State-Transfer**.

- **Audience**: who is listening, what they know, what they resist, and why they would keep listening.
- **State**: the audience state before and after the deck, plus the core tension that blocks the transition.
- **Transfer**: the slide-by-slide path that moves the audience from initial state to desired state.

Core sentence:

> PPT is not an information container. PPT is an audience state-transfer artifact.

## Required output contract

For every Humanize PPT run, produce:

1. `deck_brief.md` — audience, goal, tension, success criteria.
2. `ast_outline.md` — AST map and narrative arc.
3. `slide_plan.json` — slide-by-slide plan.
4. `speaker_intent.md` — what the speaker should do on each slide.
5. `asset_manifest.md` — screenshots, charts, images, video needs.
6. `video_slots.json` — optional HyperFrames / video insertion plan.

## Recommended OPC workflow

```text
O — Outline Director
  Humanize PPT: raw material → AST outline + production brief

P — Presentation Production
  guizang path: Chinese stable HTML PPT
  Zara path: style exploration and HTML production

C — Complete / Control
  HyperFrames video adapter
  Presenter Adapter shell
  Deploy / export adapter
  QA checklist
```

## Rules

1. Do not let slide renderers consume raw material directly when Humanize PPT can first produce the AST contract.
2. Keep presenter mode as a post-processing adapter, not a style.
3. Separate deployment from presenter mode.
4. Absorb AI-writing cleanup principles from humanizer tools, but do not reduce Humanize PPT to text polishing.
5. Prefer a small verified workflow over a broad unverified promise.
6. For public Skill releases, create/push the repo, install from GitHub locally, run one safe full sample, verify style exploration + presenter mode + deploy URL, and only then polish README details.
7. For Agent Teams development, emit `router_plan.json`, `run_manifest.json`, bounded `commands/*.md`, and separate `outputs/<agent>/` directories before wiring real downstream Skills.

## Operational references

- `references/agent-teams-public-preview.md` — Agent Teams architecture, specialist-agent command protocol, public preview release loop, and README split convention.

## Local demo

If this repository is installed locally, run:

```bash
python3 scripts/humanize_ppt_v1.py \
  --source examples/01-ai-tool-update/source.md \
  --out .humanize-ppt-runs/ai-tool-update \
  --title "AI 工具更新，不只是功能清单"
```


---

## 📦 资源文件（Resources）

本 skill 包（bundle）内的成员文件与参考资料如下。需要时用相对路径读取（dsh 会基于 resourceBase 解析）：

| 文件 | 成员 / 内容 |
|------|------------|
| `./README.md` | README.md |
| `./frontend-slides/README.md` | README.md |
| `./frontend-slides/SKILL.md` | frontend-slides |
| `./frontend-slides/STYLE_PRESETS.md` | STYLE_PRESETS.md |
| `./frontend-slides/animation-patterns.md` | animation-patterns.md |
| `./frontend-slides/html-template.md` | html-template.md |
| `./guizang-ppt-skill/README.en.md` | README.en.md |
| `./guizang-ppt-skill/README.md` | README.md |
| `./guizang-ppt-skill/SKILL.md` | guizang-ppt-skill |
| `./guizang-ppt-skill/references/browser-validation-notes.md` | browser-validation-notes.md |
| `./guizang-ppt-skill/references/checklist.md` | checklist.md |
| `./guizang-ppt-skill/references/components.md` | components.md |
| `./guizang-ppt-skill/references/image-prompts.md` | image-prompts.md |
| `./guizang-ppt-skill/references/layouts.md` | layouts.md |
| `./guizang-ppt-skill/references/template-known-issues.md` | template-known-issues.md |
| `./guizang-ppt-skill/references/themes.md` | themes.md |
| `./html-ppt/README.md` | README.md |
| `./html-ppt/README.zh-CN.md` | README.zh-CN.md |
| `./html-ppt/SKILL.md` | html-ppt |
| `./html-ppt/references/animations.md` | animations.md |
| `./html-ppt/references/authoring-guide.md` | authoring-guide.md |
| `./html-ppt/references/full-decks.md` | full-decks.md |
| `./html-ppt/references/layouts.md` | layouts.md |
| `./html-ppt/references/presenter-mode.md` | presenter-mode.md |
| `./html-ppt/references/themes.md` | themes.md |
| `./humanize-ppt/AST-theory.md` | AST-theory.md |
| `./humanize-ppt/OPC-workflow.md` | OPC-workflow.md |
| `./humanize-ppt/README.en.md` | README.en.md |
| `./humanize-ppt/README.md` | README.md |
| `./humanize-ppt/adapters/guizang-bridge-notes.md` | guizang-bridge-notes.md |
| `./humanize-ppt/adapters/presenter-adapter-spec.md` | presenter-adapter-spec.md |
| `./humanize-ppt/adapters/zara-bridge-notes.md` | zara-bridge-notes.md |
| `./humanize-ppt/agent-teams.md` | agent-teams.md |
| `./humanize-ppt/contracts/asset-manifest.template.md` | asset-manifest.template.md |
| `./humanize-ppt/contracts/ast-outline.schema.md` | ast-outline.schema.md |
| `./humanize-ppt/contracts/deck-brief.template.md` | deck-brief.template.md |
| `./humanize-ppt/contracts/speaker-intent.template.md` | speaker-intent.template.md |
| `./humanize-ppt/index.md` | index.md |
| `./humanize-ppt/presenter-adapter.md` | presenter-adapter.md |
| `./humanize-ppt/references/agent-teams-public-preview.md` | agent-teams-public-preview.md |
| `./humanize-ppt/router-rules.md` | router-rules.md |
| `./remotion-video-toolkit/SKILL.md` | remotion-video-toolkit |
| `./remotion-video-toolkit/rules/3d.md` | 3d |
| `./remotion-video-toolkit/rules/animations.md` | animations |
| `./remotion-video-toolkit/rules/assets.md` | assets |
| `./remotion-video-toolkit/rules/audio.md` | audio |
| `./remotion-video-toolkit/rules/calculate-metadata.md` | calculate-metadata |
| `./remotion-video-toolkit/rules/can-decode.md` | can-decode |
| `./remotion-video-toolkit/rules/charts.md` | charts |
| `./remotion-video-toolkit/rules/compositions.md` | compositions |
| `./remotion-video-toolkit/rules/display-captions.md` | display-captions |
| `./remotion-video-toolkit/rules/extract-frames.md` | extract-frames |
| `./remotion-video-toolkit/rules/fonts.md` | fonts |
| `./remotion-video-toolkit/rules/get-audio-duration.md` | get-audio-duration |
| `./remotion-video-toolkit/rules/get-video-dimensions.md` | get-video-dimensions |
| `./remotion-video-toolkit/rules/get-video-duration.md` | get-video-duration |
| `./remotion-video-toolkit/rules/gifs.md` | gif |
| `./remotion-video-toolkit/rules/images.md` | images |
| `./remotion-video-toolkit/rules/import-srt-captions.md` | import-srt-captions |
| `./remotion-video-toolkit/rules/lottie.md` | lottie |
| `./remotion-video-toolkit/rules/measuring-dom-nodes.md` | measuring-dom-nodes |
| `./remotion-video-toolkit/rules/measuring-text.md` | measuring-text |
| `./remotion-video-toolkit/rules/rendering.md` | rendering |
| `./remotion-video-toolkit/rules/sequencing.md` | sequencing |
| `./remotion-video-toolkit/rules/tailwind.md` | tailwind |
| `./remotion-video-toolkit/rules/text-animations.md` | text-animations |
| `./remotion-video-toolkit/rules/timing.md` | timing |
| `./remotion-video-toolkit/rules/transcribe-captions.md` | transcribe-captions |
| `./remotion-video-toolkit/rules/transitions.md` | transitions |
| `./remotion-video-toolkit/rules/trimming.md` | trimming |
| `./remotion-video-toolkit/rules/videos.md` | videos |

