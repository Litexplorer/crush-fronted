/**
 * subagent-context.tsx
 * 核心流程：子 agent 数据的只读上下文 ——
 *           会话页持有子会话消息/会话信息/加载态/跨消息工具结果/后台回执，
 *           时间线里的 SubagentCard 按 child session id 或 label 读取，避免逐层传 props
 */
import { createContext, useContext, type Accessor, type JSX } from "solid-js"
import type { Session, SessionMessage } from "../../lib/sessions"
import type { SubagentReportPartData } from "../../lib/subagents"
import type { JobOutputGroup } from "./job-output"
import type { ToolCallPartData, ToolResultPartData } from "./parts"

export interface SubagentStore {
  messages: Accessor<Record<string, SessionMessage[]>>
  sessions: Accessor<Record<string, Session>>
  loading: Accessor<Record<string, boolean>>
  errors: Accessor<Record<string, string>>
  toolResults: Accessor<Map<string, ToolResultPartData>>
  toolCalls: Accessor<Map<string, ToolCallPartData>>
  /** job_output 按 shell_id 合并后的卡片：同一后台任务的多轮读取只渲染一条 */
  jobOutputGroups: Accessor<Map<string, JobOutputGroup>>
  /** 运行中工具的实时输出尾部快照，按 shell_id 索引（来自 tool_progress 事件） */
  toolProgress: Accessor<Map<string, string>>
  /** 后台子 agent 的回执，按 label 索引：派发卡片据此判断跑完并展示答复 */
  reports: Accessor<Map<string, SubagentReportPartData>>
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
