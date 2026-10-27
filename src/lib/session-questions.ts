/**
 * session-questions.ts
 * 核心流程：把会话页从消息流派生的问句索引共享出去 ——
 *           会话页发布（带 sessionId）、离开时清空；前缀 + Q 的浮层按 sessionId 读取；
 *           浮层选中条目时发跳转请求，会话页消费后滚动到对应消息并高亮
 */
import { createSignal } from "solid-js"

/** 问答索引条目：由会话页从 user 消息派生 */
export interface SessionQuestion {
  messageId: string
  order: number
  text: string
  preview: string
  createdAt: number
  answered: boolean
}

interface QuestionIndexState {
  sessionId: string
  items: SessionQuestion[]
}

export interface QuestionJumpRequest {
  sessionId: string
  messageId: string
  /** 递增序号：同一条消息连续点两次也能触发一次新的跳转 */
  nonce: number
}

const [questionIndex, setQuestionIndex] = createSignal<QuestionIndexState>({ sessionId: "", items: [] })
const [questionJumpRequest, setQuestionJumpRequest] = createSignal<QuestionJumpRequest | undefined>(undefined)

export { questionIndex, questionJumpRequest }

/**
 * publishSessionQuestions
 * 参数：sessionId 会话 ID；items 该会话的问句索引
 * 核心流程：整体替换索引；会话页消息变化时调用，浮层只读不拉接口
 */
export function publishSessionQuestions(sessionId: string, items: SessionQuestion[]) {
  setQuestionIndex({ sessionId, items })
}

/**
 * clearSessionQuestions
 * 参数：sessionId 会话 ID
 * 核心流程：仅当索引属于该会话时清空 —— 切换会话时旧页面卸载不会清掉新会话的索引
 */
export function clearSessionQuestions(sessionId: string) {
  if (questionIndex().sessionId !== sessionId) return
  setQuestionIndex({ sessionId: "", items: [] })
}

/**
 * requestQuestionJump
 * 参数：sessionId 会话 ID；messageId 目标消息 ID
 * 核心流程：浮层发出跳转请求，会话页收到后滚动并高亮该消息
 */
export function requestQuestionJump(sessionId: string, messageId: string) {
  setQuestionJumpRequest((prev) => ({ sessionId, messageId, nonce: (prev?.nonce ?? 0) + 1 }))
}

/**
 * consumeQuestionJump
 * 参数：无
 * 核心流程：会话页处理完请求后清空，避免重渲染时重复跳转
 */
export function consumeQuestionJump() {
  setQuestionJumpRequest(undefined)
}
