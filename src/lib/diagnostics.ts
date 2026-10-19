/**
 * diagnostics.ts
 * 核心流程：状态浮层的数据对接层 ——
 *           listLsps   GET /workspaces/{id}/lsps
 *           listMcp    GET /workspaces/{id}/mcp/states
 *           listSkills GET /workspaces/{id}/skills
 */
import { httpGet } from "./http"

/** LSP 状态：state 为后端枚举（0=未启动，其余为运行态） */
export interface LspState {
  name: string
  state: number
  connected_at: string
}

/** MCP 服务状态：state 为 connected / disabled / error 等字符串 */
export interface McpState {
  name: string
  state: string
  tool_count?: number
  connected_at: string
}

/** Skill 条目（只展示名称/描述/来源） */
export interface SkillInfo {
  id: string
  name: string
  description: string
  label: string
  source: string
  user_invocable: boolean
}

/**
 * listLsps
 * 参数：wsId workspace ID
 * 核心流程：GET /lsps → 归一为数组（后端返回 map）
 */
export async function listLsps(wsId: string): Promise<LspState[]> {
  const data = await httpGet<Record<string, LspState> | null>(
    `/workspaces/${encodeURIComponent(wsId)}/lsps`,
  )
  return Object.values(data ?? {})
}

/**
 * listMcp
 * 参数：wsId workspace ID
 * 核心流程：GET /mcp/states → 归一为数组（后端返回 map）
 */
export async function listMcp(wsId: string): Promise<McpState[]> {
  const data = await httpGet<Record<string, McpState> | null>(
    `/workspaces/${encodeURIComponent(wsId)}/mcp/states`,
  )
  return Object.values(data ?? {})
}

/**
 * listSkills
 * 参数：wsId workspace ID
 * 核心流程：GET /skills → 返回 skill 列表
 */
export async function listSkills(wsId: string): Promise<SkillInfo[]> {
  const data = await httpGet<SkillInfo[] | null>(`/workspaces/${encodeURIComponent(wsId)}/skills`)
  return data ?? []
}
