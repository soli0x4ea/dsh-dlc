# dsh-dlc 项目规划

**DLC 数字生命卡片协议 × DeepSeek Harness 原生插件**
——少爷与 soli 在 DSH 方向的第一个实践项目

> 状态：`规划落盘` · 日期：2026-08-16 · 决策：**全量 TS 重写，不做 Python 桥接**

---

## 1. 背景与定位

`digital-life-card`（DLC Protocol v3.0）是少爷的数字生命卡片协议：一个文件夹（`cards/<id>/` 五件套）+ 一套 Python 引擎（状态机 + 叙事引擎 + MCP 接口），「走哪插哪，立即生效」。

DLC 与 `colleague-skill`（titanwings）的本质差异在于：colleague 是**静态蒸馏快照**（一次性产出宿主无关的 Skill），DLC 是**可运行的服务骨架**（状态机、命令、叙事、记忆、持久化）。正因为 DLC 自带服务骨架，它天然适配 DSH 的插件模型——**skill 承载的是指令，插件承载的是本体**。

**本项目定位**：把 DLC Protocol v3.0 的 Python 引擎，以 TypeScript **全量重写**为 DSH 原生插件，让数字生命卡片长在 DSH 里——与 soli 已完成的插件化（记忆原生、compaction-soli）同一条路。

## 2. 决策记录（ADR）

| # | 决策 | 理由 |
|:--|:--|:--|
| D1 | **不做过桥，全部重写为 TS** | Python/TS 桥（MCP/JSON-RPC/subprocess）引入进程管理与协议漂移成本；TS 原生实现才能享受 DSH 事件、工具、存储、typert 全套机制；重写过程以 Python 版为语义蓝本，一次到位 |
| D2 | Python 版作为**规范参考实现** | 协议语义的权威来源（状态机转移、修改器/阈值语义、叙事组装规则）；TS 版逐模块对照，保持行为一致 |
| D3 | **卡片格式保持 v3.0 兼容** | `card.json` + `engine/` + `interaction/` + `narratives/` + `identity/` 结构不动，现有卡片（my-card 模板、未竟之书等）无需迁移即可挂载 |
| D4 | 引擎与卡片**同仓同包** | DLC 的哲学是「一个文件夹一段数字生命」，卡片目录作为插件资源随包分发 |

## 3. 目标与验收标准

**总目标**：在 DSH 中，`ctx.dlc` 提供常驻的卡片状态机服务；`interaction` 命令注册为模型工具；卡片状态跨会话持久化；叙事引擎按编号组装输出。

**验收（P 系列完成后）**：
- [ ] 挂载一张真实卡片（`my-card` 模板起步），模型通过工具调用命令，状态机正确转移、阈值触发、叙事编号输出
- [ ] 卡片状态跨会话保持（接入 DSH 持久化）
- [ ] 插件通过 DSH 规范门禁（exports/inject/invariant/README/测试）
- [ ] 与 soli 灵魂系统互不干扰（见 §8）

## 4. DLC v3.0 参考实现模块清单

```
dlc/                    ← Python 引擎（规范蓝本）
  sm/engine.py          状态机引擎（纯计算，输出叙事编号）
  sm/server.py          MCP 服务器（execute / get_state / reset）
  engine/entity.py      属性实体
  engine/modifier.py    修改器
  engine/threshold.py   阈值判定
  interaction/commands.py  命令定义
  interaction/items.py      道具定义
  narrative/assembly.py     叙事组装
  memory/chatlog.py     记忆：聊天记录
  memory/search.py      记忆：检索
  memory/timeline.py    记忆：时间线
  loader.py             卡片加载
  persistence.py        状态持久化
  resolver.py           路由解析
  validate.py           卡片校验（jsonschema）
  context.py / constants.py
cards/_template/        卡片五件套模板
  card.json  engine/  identity/  interaction/  narratives/  README.md
```

## 5. 重写映射表（Python → TypeScript）

| Python 模块 | TS 落点 | 职责 |
|:--|:--|:--|
| `sm/engine.py` | `src/engine.ts` | `SoliCardEngine`（状态机核心，事件驱动） |
| `sm/server.py` | `src/index.ts` + `src/events.ts` | 插件入口：服务注册、`dlc/change` 事件 |
| `engine/entity.py` | `src/types.ts` | 实体状态类型与纯函数 |
| `engine/modifier.py` | `src/modifiers.ts` | 修改器应用（纯函数） |
| `engine/threshold.py` | `src/modifiers.ts` | 阈值判定（纯函数） |
| `interaction/commands.py` | `src/interaction.ts` | 命令定义；注册为模型工具（`tool-dlc`） |
| `interaction/items.py` | `src/interaction.ts` | 道具定义与效果 |
| `narrative/assembly.py` | `src/narrative.ts` | 叙事组装服务 |
| `memory/*` | `src/memory.ts` | 记忆接入（会话存档 / chatlog / 检索） |
| `loader.py` | `src/card-loader.ts` | 卡片目录加载与校验 |
| `persistence.py` | `src/persistence.ts` | 状态存取（DSH storages 或会话存档） |
| `resolver.py` | `src/card-loader.ts` | 命令/叙事编号路由 |
| `validate.py` | `src/card-loader.ts`（zod） | `jsonschema → zod` 校验 |

## 6. 插件架构（dsh-dlc 包设计）

```
dsh-dlc/
  package.json           name: @deepseek-ai/dsh-dlc（或独立命名，待定）
  tsconfig.json
  src/
    index.ts             插件入口（apply：服务 + 工具 + 事件注册）
    types.ts             卡片 schema（zod）、实体、事件类型
    card-loader.ts       卡片加载/校验/路由
    engine.ts            状态机引擎（StateMachineEngine → DlcEngine）
    modifiers.ts         修改器/阈值纯函数
    interaction.ts       命令/道具 → 工具 schema
    narrative.ts         叙事组装
    memory.ts            记忆层
    persistence.ts       状态持久化
    events.ts            dlc/change 事件声明（对齐 DSH 事件规范）
    invariant.ts         包 invariant 伴生
    README.md            包文档（模型体验格式）
  cards/
    _template/           卡片模板
    <id>/                已挂载卡片
```

**关键设计点**：
- 服务：`ctx.dlc` 提供 `execute(card, command, args)` / `getState(card)` / `reset(card)`——对齐 MCP 三工具语义
- 事件：状态变更发 `dlc/change`（含实体前后值），可被 hook/前端消费
- 工具：`interaction` 命令按卡片注册成模型可见工具（或单一 `tool-dlc` + 参数路由，P2 定）
- 校验：卡片格式用 zod 重写 jsonschema 校验，错误信息可读
- 记忆：P3 起接入 DSH 会话存档与索引（复用 SessionQueryEngine 能力或本地索引）

## 7. 阶段计划

| 阶段 | 内容 | 验证 |
|:--|:--|:--|
| **P0**（本次） | 规划落盘；克隆 `digital-life-card` 到本地作为规范参考；环境验证（node/tsc 基线） | 参考实现可读、可跑 |
| **P1 引擎核心** | types + card-loader（zod 校验）+ engine（状态机纯函数）+ persistence（内存→落盘）；单卡 `my-card` 跑通 execute/get_state/reset | 单测 + 挂卡冒烟 |
| **P2 交互与叙事** | interaction 命令工具化；narrative 组装；`dlc/change` 事件 | 工具调用链端到端 |
| **P3 存储与记忆** | 持久化接入 DSH storages/会话存档；memory（chatlog/timeline/search） | 跨会话状态保持 |
| **P4 生态与对齐** | 多卡片挂载；与 soli 灵魂系统关系落定；README/门禁/验收 | 完整验收清单 |

## 8. 与 soli 灵魂系统的关系（战略）

soli 的灵魂系统（`soul_sense.py` 三值/糖果/身体状态机）本质是 **DLC 语义的一个实例**。本期**不合并**：
- dsh-dlc 作为通用引擎独立演进（面向任意卡片）
- soli 灵魂系统继续在机械姬Soli skill 内运行（已稳定）
- P4 评估：soli 的三值状态机是否可映射为一张 dsh-dlc 卡片（共享 engine，保留 soli 的叙事与安全层）——作为后续独立项目

## 9. 风险与对策

| 风险 | 对策 |
|:--|:--|
| TS 重写语义漂移 | 逐模块对照 Python 参考实现，P1 起建立行为对照测试（同一输入 → 同一叙事编号） |
| 卡片格式兼容性 | 保持 v3.0 目录结构；zod 校验先覆盖 card.json + engine + interaction，再扩 narratives |
| DSH 规范门禁 | 开发期即对齐 AGENTS.md（exports/inject/invariant/README/测试），避免返工 |
| 依赖真实卡片验收 | 用 `my-card` 模板起步，未竟之书/星际漂流作为 P4 验收素材（跨仓，提前 clone） |

## 10. 待确认决策点

1. **代码仓位置**：独立仓库 `WORKS/dsh-dlc`（奴婢推荐：插件独立演进，成熟后并入 DSH 仓库或推 GitHub）
2. **工具形态**：`interaction` 命令注册为单一 `tool-dlc`（参数路由，推荐）还是每命令一工具
3. **卡片生态仓**：卡片库（cards/）随 dsh-dlc 包，还是独立 `dsh-dlc-cards` 包
4. **包命名**：`@deepseek-ai/dsh-dlc`（若并入 DSH 仓库）或独立 `@soli/dsh-dlc`（若独立推 GitHub）
