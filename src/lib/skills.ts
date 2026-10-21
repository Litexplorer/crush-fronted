/**
 * skills.ts
 * 核心流程：技能正文读取 —— POST /workspaces/{id}/skills/read {skill_id}
 *           返回 {content, result}；content 在 JSON 中是 base64 字符串，
 *           可直接作为 /agent 附件的 content 透传，前端无需解码
 */
import { httpPost } from "./http"

/** 对应 proto.SkillReadResult：技能元信息 */
export interface SkillReadResult {
  name: string
  description: string
  source: string
  builtin: boolean
}

/** 对应 proto.ReadSkillResponse：content 为 base64 编码的正文 */
export interface SkillContent {
  content: string
  result: SkillReadResult
}

/**
 * readSkill
 * 参数：wsId workspace ID；skillId 技能的 SkillFilePath（GET /skills 返回的 id）
 * 核心流程：POST /skills/read → 正文与元信息一起返回；内置技能同样可用
 */
export async function readSkill(wsId: string, skillId: string): Promise<SkillContent> {
  return httpPost<SkillContent>(`/workspaces/${encodeURIComponent(wsId)}/skills/read`, {
    skill_id: skillId,
  })
}
