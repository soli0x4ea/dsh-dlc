/**
 * tool-dlc 工具契约 — interaction 命令的模型可见工具 schema。
 * P3 提供 JSON Schema 契约；P4 插件化时注册进 Cordis 工具系统。
 */
export interface DlcToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 执行卡片命令：状态机转移 → 叙事编号 + diff。 */
export const executeTool: DlcToolSchema = {
  name: 'dlc_execute',
  description: '执行数字生命卡片的命令（状态机转移），返回叙事编号与状态变更 diff。',
  parameters: {
    type: 'object',
    properties: {
      card_id: { type: 'string', description: '目标卡片 ID（默认当前卡片）' },
      command: { type: 'string', description: '命令 id、/命令 或自然语言触发词' },
      params: {
        type: 'object',
        description: '可选参数（intensity / count 等）',
        additionalProperties: true,
      },
    },
    required: ['command'],
  },
}

/** 读取卡片状态快照（纯数据，无叙事）。 */
export const getStateTool: DlcToolSchema = {
  name: 'dlc_get_state',
  description: '读取数字生命卡片的当前状态快照（channels / flags）。',
  parameters: {
    type: 'object',
    properties: {
      card_id: { type: 'string', description: '目标卡片 ID（默认当前卡片）' },
    },
  },
}

/** 重置卡片状态到初始值。 */
export const resetTool: DlcToolSchema = {
  name: 'dlc_reset',
  description: '将数字生命卡片状态重置为初始值。',
  parameters: {
    type: 'object',
    properties: {
      card_id: { type: 'string', description: '目标卡片 ID（默认当前卡片）' },
    },
  },
}

export const DLC_TOOLS: DlcToolSchema[] = [executeTool, getStateTool, resetTool]
