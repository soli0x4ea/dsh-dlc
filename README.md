# dsh-dlc

**DLC 数字生命卡片协议 × DeepSeek Harness 原生插件** — 全量 TypeScript 重写。

一个文件夹，一段数字生命。`dsh-dlc` 把 [DLC Protocol v3.0](https://github.com/soli0x4ea/digital-life-card) 的 Python 引擎整体重写为 TypeScript，以 **Cordis 插件**的形式长进 DeepSeek Harness：状态机常驻、命令即工具、叙事自动组装、记忆与状态本地持久化。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org)

---

## 特性

- **状态机引擎**（`DlcEngine`）：命令/触发词 → 状态转移 → 叙事编号 → 阈值 → diff，零自然语言，纯计算；
- **交互系统**：命令加载、最长触发词匹配、`/命令` 与自然语言双入口、四类效果（modifier / state / narrative / command_narrative）、道具与库存（稀有度五档）；
- **叙事组装**（`NarrativeAssembly`）：编号域分发（action / threshold / boundary / system / emergence）、管道操作（range / switch / cond / rand / interp）、legacy 兼容；
- **记忆系统**：双核线性记忆 —— `ChatlogStore`（按日 JSONL · MD5 去重 · 原子写）+ `TimelineStore`（小时槽覆盖）+ `MemorySearch`（按日/区间/关键词检索）；
- **可插拔存储**：`StateStore` 接口（文件 / 内存 / DSH storages 可替换）+ 导出/导入/备份；
- **Cordis 插件化**：`ctx.dlc` 服务 + 三个模型工具 + `systemPrompt` 提示段；
- **卡片格式 v3.0 兼容**：`card.json` + `engine/` + `interaction/` + `narratives/` + `identity/` 结构不变，现有卡片即插即用。

## 架构

```
命令/触发词 → 状态机(executeCommand) → 叙事编号(NarrativeAssembly) → 阈值 → diff
    → dlc/change 事件 → 记忆(chatlog/timeline) → 状态(StateStore 可插拔)
```

```
src/
  types.ts        卡片 schema（zod）· 实体 · 事件类型
  entity.ts       实体状态 · 自然衰减
  modifiers.ts    修改器（add/set/multiply/state_set/batch_restore/flag_toggle/钳制/冷却/自动触发）
  thresholds.ts   阈值判定（操作符 + 冷却）
  card-loader.ts  卡片加载 · 版本兼容 · 模块索引 · 运行时上下文
  interaction.ts  命令与道具系统
  narrative.ts    叙事组装
  memory.ts       双核线性记忆 + 检索
  storage.ts      可插拔状态存储
  events.ts       dlc/change 事件
  engine.ts       DlcEngine 状态机
  tools.ts        tool-dlc 工具契约
  plugin.ts       Cordis 插件入口
```

## 快速开始

```sh
pnpm install        # 依赖（@deepseek-ai/* 通过 file: 链接 DSH 仓库）
pnpm test           # 30 项测试（引擎/交互/叙事/记忆/插件冒烟）
pnpm run build      # tsc 类型 + tsdown bundle → lib/index.js
```

## 作为 DSH 插件挂载

```yaml
- id: dlc
  name: '@soli/dsh-dlc'
  config:
    cardsDir: /path/to/cards   # 缺省为包内 cards/
    defaultCard: my-card
```

挂载后模型获得三个工具：

| 工具 | 作用 |
|:--|:--|
| `dlc_execute` | 执行卡片命令，返回叙事编号 + 状态 diff |
| `dlc_get_state` | 读取卡片状态快照（channels / flags） |
| `dlc_reset` | 重置卡片状态到初始值 |

## 阶段历史

| 阶段 | 交付 | 测试 |
|:--|:--|:--|
| P0 | 规划 · GitHub 建仓 · 参考实现克隆 | — |
| P1 | 引擎核心（types / entity / modifiers / thresholds / loader / persistence / engine） | 9 |
| P2 | 交互与叙事（interaction / NarrativeAssembly / dlc/change 事件） | 18 |
| P3 | 记忆与存储（chatlog / timeline / search / StateStore / 工具契约） | 26 |
| P4 | Cordis 插件化（ctx.dlc 服务 + 三工具 + 提示段） | 30 |

## 生态

- **[digital-life-card](https://github.com/soli0x4ea/digital-life-card)** — DLC Protocol v3.0 官方协议（Python 参考实现，本项目的语义蓝本）
- **[cardforge](https://github.com/soli0x4ea/cardforge)** — DLC 数字生命卡片编译器

## License

[MIT](LICENSE) © 2026 soli0x4ea
