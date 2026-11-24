/**
 * job-output.ts
 * 核心流程：把同一后台任务（shell_id）的多次 job_output 调用合并成一条时间线卡片 ——
 *           每次调用只带回 offset 之后的新增日志，这里按 offset 升序拼接还原完整输出，
 *           并指定"最后一次调用"作为唯一渲染位置，避免每轮轮询都刷出一张新卡
 */
import type { ToolCallPartData, ToolResultPartData } from "./parts"

/** job_output 结果里 metadata 的字段（后端 JobOutputResponseMetadata 的子集） */
export interface JobOutputMeta {
  shell_id?: string
  command?: string
  description?: string
  done?: boolean
  offset?: number
  skipped?: number
  status?: string
}

/** 合并后的一张 Job Output 卡片 */
export interface JobOutputGroup {
  shellId: string
  /** 唯一渲染该卡片的 tool_call id（同一 shell 的第一次调用，卡片位置固定不动） */
  ownerId: string
  /** 按 offset 升序拼接后的完整输出（已剥掉每次结果的 Status/Offset 头） */
  content: string
  /** 最近一次读取的状态文案，例如 running / completed (exit code 2) */
  status: string
  done: boolean
  /** 已合并的读取次数 */
  reads: number
  command?: string
  description?: string
}

interface JobOutputChunk {
  callId: string
  offset: number
  next: number
  payload: string
  status: string
  done: boolean
  order: number
}

/** job_output 历史结果里的占位文案：没有新日志，不参与拼接 */
const EMPTY_PAYLOADS = new Set(["", "no output", "no new output"])

/**
 * parseJobOutputInput
 * 参数：inputRaw 工具调用参数（JSON 字符串）
 * 核心流程：解析 shell_id 与 offset；解析失败返回空对象，调用方按普通卡片处理
 */
export function parseJobOutputInput(inputRaw: string | undefined): { shellId?: string; offset: number } {
  if (!inputRaw) return { offset: 0 }
  try {
    const input = JSON.parse(inputRaw) as Record<string, unknown>
    const shellId = input.shell_id
    const offset = input.offset
    return {
      shellId: typeof shellId === "string" && shellId ? shellId : undefined,
      offset: typeof offset === "number" && Number.isFinite(offset) && offset > 0 ? offset : 0,
    }
  } catch {
    return { offset: 0 }
  }
}

/**
 * jobOutputShellId
 * 参数：inputRaw 工具调用参数
 * 核心流程：只取 shell_id，供渲染层判断这次调用属于哪张合并卡
 */
export function jobOutputShellId(inputRaw: string | undefined): string | undefined {
  return parseJobOutputInput(inputRaw).shellId
}

/**
 * parseJobOutputMeta
 * 参数：metadata 结果 metadata（JSON 字符串）
 * 核心流程：解析后端返回的状态/offset/命令描述；解析失败按空对象处理
 */
export function parseJobOutputMeta(metadata: string | undefined): JobOutputMeta {
  if (!metadata) return {}
  try {
    const meta = JSON.parse(metadata) as JobOutputMeta
    return meta && typeof meta === "object" ? meta : {}
  } catch {
    return {}
  }
}

/**
 * splitResultContent
 * 参数：content 一次 job_output 的结果正文
 * 核心流程：以首个空行切分头部（Status/Offset/提示行）与日志正文；
 *           头部不是 "Status:" 开头（老格式或错误文本）时整段都算正文
 */
export function splitResultContent(content: string | undefined): { header: string; body: string } {
  if (!content) return { header: "", body: "" }
  const split = content.indexOf("\n\n")
  if (split < 0) return content.startsWith("Status:") ? { header: content, body: "" } : { header: "", body: content }
  const header = content.slice(0, split)
  if (!header.startsWith("Status:")) return { header: "", body: content }
  return { header, body: content.slice(split + 2) }
}

/**
 * buildJobOutputGroups
 * 参数：calls 会话级工具调用表（按时间顺序）；results 会话级工具结果表
 * 核心流程：按 shell_id 归组 → 每次读取取 offset 与日志正文 → offset 升序拼接 →
 *           取 offset 最大的调用作为渲染锚点；offset 全为 0（老格式每次都是全量）时只留最后一次
 */
export function buildJobOutputGroups(
  calls: Map<string, ToolCallPartData>,
  results: Map<string, ToolResultPartData>,
): Map<string, JobOutputGroup> {
  const byShell = new Map<string, JobOutputChunk[]>()
  let order = 0

  for (const call of calls.values()) {
    if ((call.name ?? "").toLowerCase() !== "job_output" || !call.id) continue
    const { shellId, offset } = parseJobOutputInput(call.input)
    if (!shellId) continue
    const result = results.get(call.id)
    const meta = parseJobOutputMeta(result?.metadata)
    const { body } = splitResultContent(result?.content)
    const chunk: JobOutputChunk = {
      callId: call.id,
      offset,
      next: typeof meta.offset === "number" && meta.offset >= 0 ? meta.offset : -1,
      payload: EMPTY_PAYLOADS.has(body.trim()) ? "" : body,
      status: typeof meta.status === "string" ? meta.status : "",
      done: meta.done === true,
      order: order++,
    }
    const chunks = byShell.get(shellId)
    if (chunks) chunks.push(chunk)
    else byShell.set(shellId, [chunk])
  }

  const groups = new Map<string, JobOutputGroup>()
  for (const [shellId, chunks] of byShell) {
    // 时间顺序第一次调用：卡片就渲染在它所在的位置，后续读取只往里追加日志，
    // 不会因为新调用而把卡片挤到时间线底部
    const chronological = [...chunks].sort((a, b) => a.order - b.order)
    const latest = chronological[chronological.length - 1]
    // 正文按 offset 升序拼接；同一 offset 重读过（例如等待超时后又读一次）保留最新一条
    const byOffset = new Map<number, JobOutputChunk>()
    for (const chunk of chronological) byOffset.set(chunk.offset, chunk)
    const ordered = [...byOffset.values()].sort((a, b) => a.offset - b.offset)

    // 最后一次读取从 0 开始，说明是一次全量重读（不是增量），只保留它自己的正文
    const freshRead = latest.offset === 0 && ordered.length > 1
    const pieces = freshRead ? [latest] : ordered
    const content = pieces
      .map((piece) => piece.payload)
      .filter((payload) => payload.length > 0)
      .join("\n")
      .replace(/\n+$/, "")
    const meta = parseJobOutputMeta(results.get(latest.callId)?.metadata)

    groups.set(shellId, {
      shellId,
      ownerId: chronological[0].callId,
      content,
      // 上游结果不再带 status：按 done 推导，卡片头部据此显示最终状态
      status: latest.status || (latest.done ? "completed" : "running"),
      done: latest.done,
      reads: ordered.length,
      command: meta.command,
      description: meta.description,
    })
  }
  return groups
}

/**
 * jobOutputSummary
 * 参数：group 合并后的卡片数据
 * 核心流程：卡片头部摘要 —— shell id + 命令描述（缺失时省略）+ 读取次数 + offset 区间，
 *           一眼能看出这张卡承载了多少次轮询
 */
export function jobOutputSummary(group: JobOutputGroup): string {
  const head = group.description?.trim() || group.command?.trim()
  const reads = group.reads > 1 ? `${group.reads}× · ` : ""
  return `shell ${group.shellId} · ${head ? `${head} · ` : ""}${reads}${group.status}`
}
