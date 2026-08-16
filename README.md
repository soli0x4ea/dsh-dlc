# dsh-dlc

DLC 数字生命卡片协议 × DeepSeek Harness 原生插件 —— 全量 TypeScript 重写。

> 规划与 ADR：见 [PLAN.md](PLAN.md) · 参考实现（Python 语义蓝本）：`reference/digital-life-card/`

## 状态：P0–P4 全部完成（2026-08-16）

| 阶段 | 交付 |
|:--|:--|
| P0 | 规划落盘、GitHub 建仓（soli0x4ea/dsh-dlc）、参考实现克隆 |
| P1 | 引擎核心：types / entity / modifiers / thresholds / card-loader / persistence / **DlcEngine**（execute/get_state/reset）|
| P2 | 交互与叙事：interaction（命令/触发词/道具）+ **NarrativeAssembly** + **dlc/change 事件** |
| P3 | 记忆与存储：**ChatlogStore / TimelineStore / MemorySearch** + 可插拔 **StateStore** + **tool-dlc 工具契约** |
| P4 | **Cordis 插件化**：`ctx.dlc` 服务 + 三工具注册（dlc_execute/get_state/reset）+ systemPrompt 提示段 |

测试：**30/30**（引擎 9 + 交互叙事 9 + 记忆存储 8 + 插件冒烟 4）。

## 架构

```
命令/触发词 → 状态机(executeCommand) → 叙事编号(NarrativeAssembly) → 阈值 → diff
    → dlc/change 事件 → 记忆(chatlog/timeline) → 状态(StateStore 可插拔)
```

## 作为 DSH 插件挂载

```yaml
- id: dlc
  name: '@soli/dsh-dlc'
  config:
    cardsDir: /path/to/cards    # 缺省为包内 cards/
    defaultCard: my-card
```

挂载后模型获得三个工具：`dlc_execute`（命令 → 叙事编号 + diff）、`dlc_get_state`（状态快照）、`dlc_reset`（重置）。

## 开发

```sh
pnpm install        # 依赖（@deepseek-ai/* 通过 file: 链接 DSH 仓库）
pnpm run typecheck  # tsc --noEmit
pnpm test           # build + 30 项测试
pnpm run build      # tsc 类型 + tsdown bundle → lib/index.js
```
