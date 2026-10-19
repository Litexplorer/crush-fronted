/**
 * questions.ts
 * 核心流程：问答链路两个接口的对接层 ——
 *           answerQuestions POST /workspaces/{id}/questions/answer（body QuestionAnswer）
 *           cancelQuestions POST /workspaces/{id}/questions/cancel（无 body）
 */
import { httpPost } from "./http"

/** 对应 proto.QuestionChoice：单个选项 */
export interface QuestionChoice {
  id: string
  label: string
  description?: string
}

/** 对应 proto.QuestionItem；type 取值 yes_no / single_choice / multi_choice / free_text */
export interface QuestionItem {
  id: string
  type: string
  label?: string
  question: string
  description?: string
  choices?: QuestionChoice[]
}

/** 对应 proto.QuestionRequest，SSE question_batch_request 的载荷 */
export interface QuestionRequest {
  id: string
  session_id: string
  tool_call_id?: string
  questions: QuestionItem[]
  confirm_title?: string
  confirm_description?: string
}

/** 对应 proto.QuestionResponse：request_id 即 QuestionItem.id，按题型填 selected_ids / fill_in_text / yes */
export interface QuestionResponse {
  request_id: string
  selected_ids?: string[]
  fill_in_text?: string
  yes?: boolean
}

/** POST /questions/answer 响应，对应 proto.QuestionAnswerResponse */
export interface QuestionAnswerResponse {
  resolved: boolean
}

/**
 * answerQuestions
 * 参数：wsId workspace ID；batch_request_id 待答复批次 ID（QuestionRequest.id）；responses 各题答案
 * 核心流程：POST /questions/answer（handlePostWorkspaceQuestionsAnswer），
 *           返回 resolved（false 表示批次已被其他客户端处理，非错误）
 */
export async function answerQuestions(
  wsId: string,
  batch_request_id: string,
  responses: QuestionResponse[],
): Promise<QuestionAnswerResponse> {
  return httpPost<QuestionAnswerResponse>(
    `/workspaces/${encodeURIComponent(wsId)}/questions/answer`,
    { batch_request_id, responses },
  )
}

/**
 * cancelQuestions
 * 参数：wsId workspace ID
 * 核心流程：POST /questions/cancel（handlePostWorkspaceQuestionsCancel），
 *           取消该工作区当前挂起的问答批次（整个批次，不限本会话）
 */
export async function cancelQuestions(wsId: string): Promise<QuestionAnswerResponse> {
  return httpPost<QuestionAnswerResponse>(
    `/workspaces/${encodeURIComponent(wsId)}/questions/cancel`,
    {},
  )
}
