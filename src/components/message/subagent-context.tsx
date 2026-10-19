/**
 * subagent-context.tsx
 * 核心流程：子 agent 数据的只读上下文 ——
 *           会话页持有子会话消息/会话信息/加载态/跨消息工具结果，
 *           时间线里的 SubagentCard 按 child session id 读取，避免逐层传 props
 */
import { createContext, useContext, type Accessor, type JSX } from "solid-js"
import type { Session, SessionMessage } from "../../lib/sessions"
import type { ToolResultPartData } from "./parts"

export interface SubagentStore {
  messages: Accessor<Record<string, SessionMessage[]>>
  sessions: Accessor<Record<string, Session>>
  loading: Accessor<Record<string, boolean>>
  errors: Accessor<Record<string, string>>
  toolResults: Accessor<Map<string, ToolResultPartData>>
  ensure: (sessionId: string) => void
}

const SubagentContext = createContext<SubagentStore>()

/**
 * SubagentProvider
 * 参数：store 会话页持有的子 agent 缓存；children 时间线内容
 * 核心流程：向下提供只读 store，避免 message part 层层透传
 */
export function SubagentProvider(props: { store: SubagentStore; children: JSX.Element }) {
  return <SubagentContext.Provider value={props.store}>{props.children}</SubagentContext.Provider>
}

/**
 * useSubagentStore
 * 核心流程：读取会话页提供的子 agent store；独立渲染（无 Provider）时返回 undefined
 */
export function useSubagentStore(): SubagentStore | undefined {
  return useContext(SubagentContext)
}
