/**
 * session.tsx
 * 参数：无（从路由取 :workspaceId / :sessionId）
 * 核心流程：会话页双栏主链路 ——
 *           进入页面：订阅 SSE，连接打开后上报 current-session（重连后重报）→ 拉会话信息 + 历史消息 → 确认 agent 就绪
 *           SSE：单一 EventSource 收 message/session/run_complete 事件，按 id upsert 本地列表
 *           时间线：user 右侧气泡、assistant 左对齐无气泡；分片渲染委托 components/message/parts
 *           输入区：Enter 发送（Shift+Enter 换行）、乐观插入用户消息、busy 时 Stop 可中断
 *           滚动：仅当用户贴近底部时新消息自动滚到底
 *           头部：会话标题 + 工作区名/路径（色点与标题栏标签一致）
 *           双栏：左侧会话内容，右侧 SessionPanel（Files 树，可折叠/拖宽，状态存 localStorage）
 */
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { getSession, listMessages, renameSession, summarizeSession, type Session, type SessionMessage } from "../lib/sessions"
import { cancel, getAgent, initAgent, newRunId, sendMessage, setCurrentSession } from "../lib/agent"
import { closeEvents, ensureEvents, eventsConnection, onEventsOpen, subscribeEvents, type WorkspaceEvent } from "../lib/events"
import { setSessionRunning } from "../lib/run-status"
import { grantPermission, getSkip, setSkip, type PermissionAction, type PermissionRequest } from "../lib/permissions"
import { answerQuestions, cancelQuestions, type QuestionRequest, type QuestionResponse } from "../lib/questions"
import { MessageItem, textOf, type TimelineMessage, type ToolCallPartData, type ToolResultPartData } from "../components/message/parts"
import { InlineTitle } from "../components/inline-title"
import RunningIndicator from "../components/message/running-indicator"
import { SubagentProvider, type SubagentStore } from "../components/message/subagent-context"
import FileMention from "../components/file-mention"
import HashMention from "../components/hash-mention"
import ModelSelect from "../components/model-select"
import UsageMeter from "../components/usage-meter"
import SessionInfoDialog from "../components/session-info-dialog"
import type { SelectedModel } from "../lib/models"
import PermissionDock from "../components/permission-dock"
import QuestionDock from "../components/question-dock"
import SessionPanel from "../components/session-panel"
import TodoDock from "../components/todo-dock"
import type { QuestionItem } from "../components/panel-questions"
import {
  clearSessionQuestions,
  consumeQuestionJump,
  publishSessionQuestions,
  questionJumpRequest,
} from "../lib/session-questions"
import { compactRequest, ensureSessionTab, openSessions, retargetSessionTabs, updateSessionTab } from "../lib/ui-store"
import VirtualTimeline from "../components/message/virtual-timeline"
import { recalledWorkspacePath, recalledYolo, rememberWorkspace, rememberYolo, selectedWorkspace, setSelectedWorkspace } from "../lib/workspace-store"
import { createWorkspace, getWorkspace, type Workspace } from "../lib/workspaces"
import { workspaceColor } from "../lib/workspace-color"
import { childSessionId, loadSubagent } from "../lib/subagents"
import type { FileEntry } from "../lib/files"
import { readSkill } from "../lib/skills"
import type { MentionItem } from "../lib/mentions"
import type { ApiError } from "../lib/http"

type LoadState = "loading" | "ready" | "error"
type AgentState = "checking" | "ready" | "unready"

/**
 * basename
 * 参数：path 项目绝对路径
 * 核心流程：取最后一个非空目录名；路径为空时返回空串
 */
function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path
}

/** 右侧面板：宽度默认/边界与 localStorage 持久化键 */
const PANEL_WIDTH_DEFAULT = 420
const PANEL_WIDTH_MIN = 320
const PANEL_WIDTH_MAX = 640
const PANEL_COLLAPSED_KEY = "crush.panel.collapsed"
const PANEL_WIDTH_KEY = "crush.panel.width"

/** 待办 Dock：折叠状态持久化键 */
const TODOS_COLLAPSED_KEY = "crush.todos.collapsed"

/** 图片附件：单条上限与数量上限（base64 会进入会话历史与 SSE，需限制体积） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES = 4

/** 已粘贴/拖入的图片：base64 为发送用内容，previewUrl 为本地缩略图 */
interface ImageAttachment {
  id: string
  name: string
  mime: string
  base64: string
  previewUrl: string
}

/** # 引用到的技能：content 为后端返回的 base64 正文，发送时原样作附件内容 */
interface SkillAttachment {
  id: string
  name: string
  content: string
}

/**
 * readAsDataUrl
 * 参数：file 浏览器 File 对象
 * 核心流程：FileReader 读取为 data URL（onload 返回字符串，onerror 抛错）
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(file)
  })
}

/**
 * imageFiles
 * 参数：files 粘贴/拖拽得到的 File 列表
 * 核心流程：过滤非图片文件，保持原顺序，供 addImages 校验与读取
 */
function imageFiles(files: FileList | File[]): File[] {
  return [...files].filter((file) => file.type.startsWith("image/"))
}

/** 本地消息：在 proto.Message 基础上加 pending 标记（乐观插入、尚未被 SSE 真实消息替换） */
type ChatMessage = TimelineMessage

/** 从抛出的错误对象中安全取 message */
function errorMessage(err: unknown): string {
  const e = err as ApiError
  return e?.message ?? "Unknown error"
}

/**
 * byCreatedAt
 * 参数：a/b 两条消息
 * 核心流程：按 created_at 升序排序（同秒依赖 Array.sort 稳定性保持插入序）
 */
function byCreatedAt(a: SessionMessage, b: SessionMessage): number {
  return a.created_at - b.created_at
}

/**
 * questionPreview
 * 参数：text 问句全文
 * 核心流程：取首个非空行，连续空白压成单空格；超过 80 字符截断并补省略号
 */
function questionPreview(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? text
  const compact = firstLine.replace(/\s+/g, " ").trim()
  return compact.length > 80 ? `${compact.slice(0, 80)}…` : compact
}

/**
 * clampPanelWidth
 * 参数：w 期望宽度
 * 核心流程：面板宽度钳制在 320~640px 区间（取整）
 */
function clampPanelWidth(w: number): number {
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(w)))
}

/**
 * readPanelCollapsed
 * 参数：无
 * 核心流程：从 localStorage 读取折叠状态（"1" 为折叠）；读取失败默认展开
 */
function readPanelCollapsed(): boolean {
  try {
    return localStorage.getItem(PANEL_COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * readPanelWidth
 * 参数：无
 * 核心流程：从 localStorage 读取面板宽度并钳制；无记录或读取失败用默认 420
 */
function readPanelWidth(): number {
  try {
    const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY))
    if (Number.isFinite(raw) && raw > 0) return clampPanelWidth(raw)
  } catch {
    // localStorage 不可用：回落默认宽度
  }
  return PANEL_WIDTH_DEFAULT
}

/**
 * persistPanelState
 * 参数：collapsed 是否折叠；width 面板宽度
 * 核心流程：折叠状态与宽度写入 localStorage（刷新后还原）；写入失败静默跳过
 */
function persistPanelState(collapsed: boolean, width: number) {
  try {
    localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? "1" : "0")
    localStorage.setItem(PANEL_WIDTH_KEY, String(clampPanelWidth(width)))
  } catch {
    // localStorage 不可用：仅当前会话内生效
  }
}

/**
 * readTodosCollapsed
 * 参数：无
 * 核心流程：从 localStorage 读取待办折叠状态（"1" 为折叠）；读取失败默认展开
 */
function readTodosCollapsed(): boolean {
  try {
    return localStorage.getItem(TODOS_COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * persistTodosCollapsed
 * 参数：collapsed 是否折叠
 * 核心流程：写入 localStorage；写入失败静默跳过
 */
function persistTodosCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(TODOS_COLLAPSED_KEY, collapsed ? "1" : "0")
  } catch {
    // localStorage 不可用：仅当前会话内生效
  }
}

export default function Session() {
  const params = useParams<{ workspaceId: string; sessionId: string }>()
  const navigate = useNavigate()
  const [session, setSession] = createSignal<Session>()
  const [state, setState] = createSignal<LoadState>("loading")
  const [error, setError] = createSignal("")
  // 工作区详情：头部展示项目路径；本地选中项/标签缺失时按 id 从服务端补齐
  const [workspaceInfo, setWorkspaceInfo] = createSignal<Workspace>()

  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  const [busy, setBusy] = createSignal(false)
  // 本地 busy 同步到全局运行表：点发送后标签栏立刻出现运行图标，不必等 SSE。
  // 必须以「已加载的 session」为准：路由参数在请求返回前就变了，
  // 直接读 params.sessionId 会把上一个会话的 busy 记到新标签上
  createEffect(() => {
    const current = session()
    // 只在 ready 时上报：切换过程中 session/busy 分属新旧两个会话，
    // 此时写回会把仍在运行的旧会话误清掉
    if (!current || state() !== "ready") return
    setSessionRunning(current.id, busy())
  })
  const [sending, setSending] = createSignal(false)
  // 手动刷新：重新拉取会话详情与消息列表，期间按钮旋转并禁用
  const [refreshing, setRefreshing] = createSignal(false)
  // 会话压缩：请求同步等待摘要生成，期间禁止发送并展示忙碌态
  const [compacting, setCompacting] = createSignal(false)
  const [agentState, setAgentState] = createSignal<AgentState>("checking")
  const [draft, setDraft] = createSignal("")
  const [sendError, setSendError] = createSignal("")

  // @ 文件引用：输入框 + 按钮或输入 @ 打开选择浮层，选中项作为附件随 prompt 发送
  const [attachments, setAttachments] = createSignal<FileEntry[]>([])
  const [mentionOpen, setMentionOpen] = createSignal(false)

  // # 引用：输入 # 打开技能/MCP 浮层；技能正文作为附件，MCP 只插入引导文本
  const [hashOpen, setHashOpen] = createSignal(false)
  const [skillAttachments, setSkillAttachments] = createSignal<SkillAttachment[]>([])

  // 图片附件：粘贴/拖拽进入，以 base64 内联发送（无需落盘）；previewUrl 仅本地预览
  const [images, setImages] = createSignal<ImageAttachment[]>([])
  let imageSeq = 0

  // 权限 Dock：FIFO 队列，只渲染队首一条，处理完显示下一条
  const [permissionQueue, setPermissionQueue] = createSignal<PermissionRequest[]>([])
  const [permResponding, setPermResponding] = createSignal(false)
  const [permError, setPermError] = createSignal("")

  // Question Dock：同权限的队列语义，批次按 id 进出
  const [questionQueue, setQuestionQueue] = createSignal<QuestionRequest[]>([])
  const [quesResponding, setQuesResponding] = createSignal(false)
  const [quesError, setQuesError] = createSignal("")

  // YOLO 开关：undefined 表示尚未加载；切换走乐观更新，失败回滚
  const [yolo, setYolo] = createSignal<boolean | undefined>(undefined)
  const [yoloPending, setYoloPending] = createSignal(false)
  const [yoloError, setYoloError] = createSignal("")
  // YOLO 请求序号：切换工作区时自增，旧请求的响应回来直接丢弃，避免串台
  let yoloRequestSeq = 0

  // Composer 轻提示：附件未支持 / 模型切换失败等一次性文案，2.5s 自动消失
  const [composerToast, setComposerToast] = createSignal("")
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  // 消息跳转高亮定时器：重复点击时重置
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  // 滚动高亮的帧句柄：同一帧内的多次滚动事件只做一次可见行查询
  let questionSyncFrame = 0
  // 滞后校正：虚拟列表在下一帧才挂载新行，滚动停下后再对齐一次
  let questionSettleTimer: ReturnType<typeof setTimeout> | undefined

  // 右侧面板：折叠状态与宽度从 localStorage 恢复；拖拽中仅更新内存，松手才持久化
  const [panelOpen, setPanelOpen] = createSignal(!readPanelCollapsed())
  const [panelWidth, setPanelWidth] = createSignal(readPanelWidth())

  // 会话待办：折叠态持久化；数据来自 getSession 与 SSE session 事件
  const [todosCollapsed, setTodosCollapsed] = createSignal(readTodosCollapsed())

  // Composer 用量指示器：当前模型的 context_window，由 ModelSelect 加载/切换时上报
  const [modelContextWindow, setModelContextWindow] = createSignal<number>()
  // 当前模型选择快照（含思考强度）：会话信息弹窗展示用
  const [modelSelection, setModelSelection] = createSignal<SelectedModel>()
  // 会话信息弹窗开关（Ctrl+Alt+I 或头部 ⓘ 按钮）
  const [infoOpen, setInfoOpen] = createSignal(false)
  // 当前模型是否支持图片：undefined = 能力未知（不拦截），false = 明确不支持（发送前提示）
  const [modelSupportsImages, setModelSupportsImages] = createSignal<boolean>()

  // 子 agent：按 child session id 缓存消息/会话信息，供 SubagentCard 展开与实时更新
  const [subagentMessages, setSubagentMessages] = createSignal<Record<string, SessionMessage[]>>({})
  const [subagentSessions, setSubagentSessions] = createSignal<Record<string, Session>>({})
  const [subagentLoading, setSubagentLoading] = createSignal<Record<string, boolean>>({})
  const [subagentErrors, setSubagentErrors] = createSignal<Record<string, string>>({})
  const knownSubagentIds = new Set<string>()
  const loadedSubagents = new Set<string>()
  const loadingSubagents = new Set<string>()
  let subagentEpoch = 0

  // 问答索引：active 标记当前选中问句（长期），highlight 仅用于消息短暂高亮
  const [activeQuestionId, setActiveQuestionId] = createSignal("")
  const [highlightedMessageId, setHighlightedMessageId] = createSignal("")
  // 跳转目标：虚拟列表需强制把该消息纳入渲染窗口，滚到位并高亮后清除
  const [pinnedMessageId, setPinnedMessageId] = createSignal<string>()

  let scrollRef: HTMLDivElement | undefined
  let draftRef: HTMLTextAreaElement | undefined
  // 输入历史游标：-1 表示当前草稿，>=0 指向历史条目（0 为最新一条）
  let historyIndex = -1
  // 进入历史前的草稿快照：回退到草稿态时原样恢复
  let historyDraft = ""
  // # 触发位置（草稿中 # 的下标）：选中候选后据此把 # 替换成结果，-1 表示无待替换
  let hashAnchor = -1
  // 贴近底部标记：用户上翻即停用自动滚动，重新滚到底部附近后恢复
  let stickToBottom = true
  // 容器内指针是否按下：按住拖动滚动条/选中文本时产生的滚动才算用户操作
  let pointerHeld = false
  // 触摸手势起点纵坐标：手指下移（内容上翻）才关闭跟随
  let touchStartY = 0
  let pendingSeq = 0
  // current-session 上报序号：仅最后一次请求生效，避免过期重试覆盖新会话登记
  let reportSeq = 0
  // 面板拖拽起点：pointerdown 时记录起始鼠标位置与宽度，move 期间计算增量
  let resizeState: { startX: number; startWidth: number } | undefined

  /**
   * showComposerToast
   * 参数：msg 轻提示文案
   * 核心流程：写入 toast 状态并重置 2.5s 自动清除定时器（连续调用只保留最后一条）
   */
  function showComposerToast(msg: string) {
    setComposerToast(msg)
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => setComposerToast(""), 2500)
  }

  /**
   * commitRename
   * 参数：next 新标题（InlineTitle 已 trim 且与旧值不同）
   * 核心流程：PUT title 子资源 → 就地更新 session 与标签栏标题；
   *           失败只提示不改状态，标题保持原值
   */
  async function commitRename(next: string) {
    const { workspaceId, sessionId } = params
    try {
      const saved = await renameSession(workspaceId, sessionId, next)
      if (params.sessionId !== sessionId) return
      setSession((prev) => (prev ? { ...prev, title: saved.title } : prev))
      updateSessionTab({ id: saved.id, title: saved.title || "Untitled", workspaceId })
    } catch (err) {
      showComposerToast(errorMessage(err))
    }
  }

  /**
   * addImages
   * 参数：files 粘贴或拖拽得到的 File 列表
   * 核心流程：过滤非图片 → 逐张校验数量/体积 → FileReader 转 data URL →
   *           去掉 data: 前缀得到 base64 入队；被拒绝的图片给出一次性提示
   */
  async function addImages(files: File[]) {
    for (const file of imageFiles(files)) {
      if (images().length >= MAX_IMAGES) {
        showComposerToast(`最多附加 ${MAX_IMAGES} 张图片`)
        break
      }
      if (file.size > MAX_IMAGE_BYTES) {
        showComposerToast(`${file.name || "图片"} 超过 10 MB，已跳过`)
        continue
      }
      try {
        const dataUrl = await readAsDataUrl(file)
        const comma = dataUrl.indexOf(",")
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : ""
        if (!base64) continue
        setImages((prev) =>
          prev.length >= MAX_IMAGES
            ? prev
            : [
                ...prev,
                {
                  id: `image-${++imageSeq}`,
                  name: file.name || `image-${imageSeq}.${file.type.split("/")[1] || "png"}`,
                  mime: file.type || "image/png",
                  base64,
                  previewUrl: dataUrl,
                },
              ],
        )
      } catch {
        showComposerToast("图片读取失败")
      }
    }
  }

  /**
   * handleComposerPaste
   * 参数：e 粘贴事件
   * 核心流程：从 clipboardData.items 取图片文件；有图片才阻止默认粘贴（保留文本粘贴）
   */
  function handleComposerPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (!files.length) return
    e.preventDefault()
    void addImages(files)
  }

  /**
   * handleComposerDrop
   * 参数：e 拖放事件
   * 核心流程：仅接管图片文件，阻止浏览器直接打开；非图片拖放保持默认行为
   */
  function handleComposerDrop(e: DragEvent) {
    const files = e.dataTransfer?.files
    if (!files || imageFiles(files).length === 0) return
    e.preventDefault()
    void addImages([...files])
  }

  /** handleComposerDragOver：拖入文件时阻止默认打开行为，允许 drop 触发 */
  function handleComposerDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault()
  }

  // textarea 自适应高度：草稿变化时先复位再按内容撑开，钳制在 240px 内（超出滚动）
  createEffect(() => {
    draft()
    const el = draftRef
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  })

  // 离开页面：清理 toast、消息高亮与滚动同步的这些定时器
  onCleanup(() => {
    if (toastTimer) clearTimeout(toastTimer)
    if (highlightTimer) clearTimeout(highlightTimer)
    if (questionSyncFrame) cancelAnimationFrame(questionSyncFrame)
    if (questionSettleTimer) clearTimeout(questionSettleTimer)
  })

  /**
   * toggleTodos
   * 参数：无
   * 核心流程：切换待办 Dock 折叠态并持久化
   */
  function toggleTodos() {
    const next = !todosCollapsed()
    setTodosCollapsed(next)
    persistTodosCollapsed(next)
  }

  /**
   * loadSession
   * 参数：wsId workspace ID；sid 会话 ID
   * 核心流程：GET /workspaces/{wsId}/sessions/{sid} → 成功写 session 并以 is_busy 初始化
   *           busy 态进入 ready；失败记文案进入 error（Retry 复用同一函数）
   */
  async function loadSession(wsId: string, sid: string) {
    setState("loading")
    setError("")
    // 标题栏标签页：会话切换时先占位并带上项目路径，服务端重启后可按路径恢复
    const existingTab = openSessions().find((tab) => tab.id === sid)
    const projectPath = selectedWorkspace()?.id === wsId ? selectedWorkspace()?.path : existingTab?.projectPath
    ensureSessionTab({ id: sid, title: "Untitled", workspaceId: wsId, projectPath })
    try {
      const data = await getSession(wsId, sid)
      if (params.sessionId !== sid) return
      // 先写 busy 再写 session：同步 effect 按「已加载会话」上报运行状态，
      // 若顺序反了，切换标签瞬间会把上一个会话的 busy 记到新会话头上
      setBusy(data.is_busy)
      setSession(data)
      updateSessionTab({ id: data.id, title: data.title || "Untitled", workspaceId: wsId, projectPath })
      setState("ready")
    } catch (err) {
      if (params.sessionId !== sid) return
      const msg = errorMessage(err)
      // 服务端重启后 workspace 已不在内存：优先按标签里的项目路径重建并跳到新 id
      if (/workspace not found/i.test(msg)) {
        const path = existingTab?.projectPath ?? recalledWorkspacePath()
        if (path) {
          try {
            // 重建时带上本地缓存的 YOLO：服务端按 args.YOLO 初始化权限模式，重建后不丢开关
            const ws = await createWorkspace({ path, yolo: recalledYolo(path) })
            rememberWorkspace(ws)
            setSelectedWorkspace(ws)
            retargetSessionTabs(path, ws.id)
            navigate(`/w/${encodeURIComponent(ws.id)}/session/${encodeURIComponent(sid)}`, { replace: true })
            return
          } catch {
            // 重建失败：继续走普通错误态
          }
        }
      }
      setError(msg)
      setSession(undefined)
      setState("error")
    }
  }

  /**
   * loadMessages
   * 参数：wsId workspace ID；sid 会话 ID
   * 核心流程：GET /sessions/{sid}/messages → 按 created_at 升序写入本地列表；
   *           首次加载强制贴底滚动；失败不阻塞页面（会话骨架已有独立错误态）
   */
  async function loadMessages(wsId: string, sid: string) {
    setMessages([])
    try {
      const data = await listMessages(wsId, sid)
      if (params.sessionId !== sid) return
      const sorted = [...data].sort(byCreatedAt)
      setMessages(sorted)
      // 历史里可能已有子 agent 调用：登记 child session id，后续 SSE 事件才能路由
      for (const message of sorted) registerAgentCalls(message)
      stickToBottom = true
    } catch {
      // 消息加载失败：本阶段不加额外失败 UI，等待 SSE upsert 补齐
    }
  }

  /**
   * ensureAgentReady
   * 参数：wsId workspace ID
   * 核心流程：getAgent 查询 is_ready → 未就绪则 initAgent 初始化后复查；全程异常归入 unready
   */
  async function ensureAgentReady(wsId: string) {
    setAgentState("checking")
    try {
      const info = await getAgent(wsId)
      if (info.is_ready) {
        setAgentState("ready")
        return
      }
      // 未就绪：触发初始化后复查一次
      await initAgent(wsId)
      const after = await getAgent(wsId)
      setAgentState(after.is_ready ? "ready" : "unready")
    } catch {
      setAgentState("unready")
    }
  }

  /**
   * refreshSession
   * 参数：无（读取当前路由上的 workspace/session）
   * 核心流程：清空滚动贴底与高亮定位态 → 重新拉取会话详情与消息列表 →
   *           结束后释放按钮禁用；刷新失败由 loadSession 转入错误态
   */
  async function refreshSession() {
    if (refreshing()) return
    setRefreshing(true)
    // 消息整表替换后旧定位失效：贴底、清空问答高亮与钉住行
    stickToBottom = true
    setActiveQuestionId("")
    setHighlightedMessageId("")
    setPinnedMessageId(undefined)
    if (highlightTimer) clearTimeout(highlightTimer)
    try {
      await Promise.all([
        loadSession(params.workspaceId, params.sessionId),
        loadMessages(params.workspaceId, params.sessionId),
      ])
    } finally {
      setRefreshing(false)
    }
  }

  /**
   * upsertMessage
   * 参数：msg SSE 推送的真实消息
   * 核心流程：先移除同 role 同文本的乐观占位 → 按 id 替换或追加 → 保持 created_at 有序
   */
  function upsertMessage(msg: ChatMessage) {
    registerAgentCalls(msg)
    setMessages((prev) => {
      const cleared = prev.filter(
        (m) => !(m.pending && m.role === msg.role && textOf(m) === textOf(msg)),
      )
      const idx = cleared.findIndex((m) => m.id === msg.id)
      if (idx === -1) {
        return [...cleared, msg].sort(byCreatedAt)
      }
      const next = [...cleared]
      next[idx] = msg
      return next
    })
  }

  /**
   * registerAgentCalls
   * 参数：message 任意会话消息
   * 核心流程：扫描 agent tool_call，按 messageID$$toolCallID 登记子会话，
   *           供 handleEvent 把子会话 SSE 路由到对应卡片
   */
  function registerAgentCalls(message: SessionMessage) {
    if (!message.id) return
    for (const part of message.parts) {
      if (part.type !== "tool_call") continue
      const call = (part.data ?? {}) as ToolCallPartData
      if (call.name !== "agent" || !call.id) continue
      knownSubagentIds.add(childSessionId(message.id, call.id))
    }
  }

  /**
   * mergeSubagentMessages
   * 参数：sessionId 子会话 ID；incoming 新增/更新的消息
   * 核心流程：按 id 合并并保留更新的 updated_at；按 created_at 排序，避免 SSE 与 REST 回填互相覆盖
   */
  function mergeSubagentMessages(sessionId: string, incoming: SessionMessage[]) {
    setSubagentMessages((prev) => {
      const next = [...(prev[sessionId] ?? [])]
      for (const message of incoming) {
        const idx = next.findIndex((item) => item.id === message.id)
        if (idx === -1) {
          next.push(message)
        } else if ((message.updated_at ?? 0) >= (next[idx].updated_at ?? 0)) {
          next[idx] = message
        }
      }
      next.sort(byCreatedAt)
      return { ...prev, [sessionId]: next }
    })
  }

  /**
   * removeSubagentMessage
   * 参数：sessionId 子会话 ID；messageId 被删除的消息
   * 核心流程：从子会话缓存中移除消息，保持其余顺序
   */
  function removeSubagentMessage(sessionId: string, messageId: string) {
    setSubagentMessages((prev) => {
      const list = prev[sessionId]
      if (!list) return prev
      return { ...prev, [sessionId]: list.filter((message) => message.id !== messageId) }
    })
  }

  /**
   * setSubagentSession
   * 参数：session 子会话信息
   * 核心流程：写入标题、token、时间戳，卡片据此展示标题与用量
   */
  function setSubagentSession(session: Session) {
    setSubagentSessions((prev) => ({ ...prev, [session.id]: session }))
  }

  /**
   * ensureSubagentLoaded
   * 参数：sessionId 子会话 ID
   * 核心流程：登记 child id → 并发读取子会话与消息 → 合并缓存并扫描嵌套 agent；
   *           404 视为子会话尚未创建，不展示错误，等待 SSE 重试
   */
  async function ensureSubagentLoaded(sessionId: string) {
    if (!sessionId) return
    knownSubagentIds.add(sessionId)
    if (loadedSubagents.has(sessionId) || loadingSubagents.has(sessionId)) return
    const epoch = subagentEpoch
    loadingSubagents.add(sessionId)
    setSubagentLoading((prev) => ({ ...prev, [sessionId]: true }))
    try {
      const snapshot = await loadSubagent(params.workspaceId, sessionId)
      if (epoch !== subagentEpoch) return
      setSubagentSession(snapshot.session)
      mergeSubagentMessages(sessionId, snapshot.messages)
      for (const message of snapshot.messages) registerAgentCalls(message)
      loadedSubagents.add(sessionId)
      setSubagentErrors((prev) => {
        if (!(sessionId in prev)) return prev
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
    } catch (err) {
      if (epoch !== subagentEpoch) return
      const error = err as ApiError
      // agent 刚启动时子会话可能尚未落库，等 SSE 第一条消息后再重试
      if (error?.status !== 404) {
        setSubagentErrors((prev) => ({
          ...prev,
          [sessionId]: error?.message ?? "Failed to load sub-agent",
        }))
      }
    } finally {
      if (epoch === subagentEpoch) {
        loadingSubagents.delete(sessionId)
        setSubagentLoading((prev) => {
          if (!(sessionId in prev)) return prev
          const next = { ...prev }
          delete next[sessionId]
          return next
        })
      }
    }
  }

  /**
   * resetSubagents
   * 核心流程：切换会话/workspace 时清空子会话缓存与登记，防止旧卡片串台
   */
  function resetSubagents() {
    subagentEpoch++
    knownSubagentIds.clear()
    loadedSubagents.clear()
    loadingSubagents.clear()
    setSubagentMessages({})
    setSubagentSessions({})
    setSubagentLoading({})
    setSubagentErrors({})
  }

  /** 会话级工具结果表：agent 结果在后续 tool 消息里，SubagentCard 需要跨消息取回 */
  const toolResults = createMemo(() => {
    const map = new Map<string, ToolResultPartData>()
    for (const message of messages()) {
      for (const part of message.parts) {
        if (part.type !== "tool_result") continue
        const data = (part.data ?? {}) as ToolResultPartData
        if (data.tool_call_id) map.set(data.tool_call_id, data)
      }
    }
    return map
  })

  /** 会话级工具调用表：结果消息只带 tool_call_id，据此反查原始 input（edit diff 需要文件路径） */
  const toolCalls = createMemo(() => {
    const map = new Map<string, ToolCallPartData>()
    for (const message of messages()) {
      for (const part of message.parts) {
        if (part.type !== "tool_call") continue
        const data = (part.data ?? {}) as ToolCallPartData
        if (data.id) map.set(data.id, data)
      }
    }
    return map
  })

  const subagentStore: SubagentStore = {
    messages: subagentMessages,
    sessions: subagentSessions,
    loading: subagentLoading,
    errors: subagentErrors,
    toolResults,
    toolCalls,
    ensure: (sessionId) => void ensureSubagentLoaded(sessionId),
  }

  /**
   * reportCurrentSession
   * 参数：wsId workspace ID；sid 会话 ID（null 表示清除登记）
   * 核心流程：POST current-session → 409/400 时仅 console.warn 并静默重试一次，
   *           其余错误也只 warn；过期上报（期间已有新请求）直接丢弃，避免旧值回写
   */
  async function reportCurrentSession(wsId: string, sid: string | null) {
    const seq = ++reportSeq
    try {
      // 上报当前会话：需在 SSE 长连接建立后调用（由 onEventsOpen 驱动）
      await setCurrentSession(wsId, sid)
    } catch (err) {
      // 过期上报：期间已有更新的登记请求，直接丢弃
      if (seq !== reportSeq) return
      const e = err as ApiError
      // 409/400（client not attached 等）：不产生用户可见错误，静默重试一次
      if (e?.status === 409 || e?.status === 400) {
        console.warn(`[crush] current-session ${sid ?? "clear"} -> ${e.status} ${e.message}, retry once`)
        try {
          await setCurrentSession(wsId, sid)
        } catch (retryErr) {
          console.warn(`[crush] current-session retry failed: ${(retryErr as ApiError)?.message ?? "unknown"}`)
        }
        return
      }
      console.warn(`[crush] current-session failed: ${e?.message ?? "unknown"}`)
    }
  }

  /**
   * dequeuePermission
   * 参数：id 权限请求 ID
   * 核心流程：按 id 移出权限队列并清空错误（裁决成功 / 他人已处理 / 通知到达时复用）
   */
  function dequeuePermission(id: string) {
    setPermissionQueue((prev) => prev.filter((p) => p.id !== id))
    setPermError("")
  }

  /**
   * dequeueQuestion
   * 参数：id 批次 ID
   * 核心流程：按批次 id 移出问答队列并清空错误
   */
  function dequeueQuestion(id: string) {
    setQuestionQueue((prev) => prev.filter((p) => p.id !== id))
    setQuesError("")
  }

  /**
   * handlePermissionAction
   * 参数：action 用户决定 allow / allow_session / deny
   * 核心流程：对队首权限请求 POST grant → 成功或 409/404（已被其他客户端处理）即出队，
   *           其余失败在 Dock 内展示错误并保留该请求供重试
   */
  async function handlePermissionAction(action: PermissionAction) {
    const wsId = params.workspaceId
    const req = permissionQueue()[0]
    if (!wsId || !req || permResponding()) return
    setPermResponding(true)
    setPermError("")
    try {
      // 裁决权限：resolved=false 表示请求已被别的客户端处理，同样按成功出队
      await grantPermission(wsId, req, action)
      dequeuePermission(req.id)
    } catch (err) {
      const e = err as ApiError
      if (e?.status === 409 || e?.status === 404) {
        // 已被其他客户端处理/工作区不存在：按成功处理并移除
        dequeuePermission(req.id)
      } else {
        setPermError(errorMessage(err))
      }
    } finally {
      setPermResponding(false)
    }
  }

  /**
   * handleQuestionSubmit
   * 参数：responses 逐题答案（selected_ids / fill_in_text / yes）
   * 核心流程：对队首批次 POST answer → 成功或 409/404 出队，失败在 Dock 内展示错误
   */
  async function handleQuestionSubmit(responses: QuestionResponse[]) {
    const wsId = params.workspaceId
    const req = questionQueue()[0]
    if (!wsId || !req || quesResponding()) return
    setQuesResponding(true)
    setQuesError("")
    try {
      // 提交整批答案：resolved=false 表示批次已被别的客户端答复，同样按成功出队
      await answerQuestions(wsId, req.id, responses)
      dequeueQuestion(req.id)
    } catch (err) {
      const e = err as ApiError
      if (e?.status === 409 || e?.status === 404) {
        dequeueQuestion(req.id)
      } else {
        setQuesError(errorMessage(err))
      }
    } finally {
      setQuesResponding(false)
    }
  }

  /**
   * handleQuestionCancel
   * 参数：无
   * 核心流程：POST questions/cancel 取消工作区当前挂起批次 → 成功或 409/404 出队，失败展示错误
   */
  async function handleQuestionCancel() {
    const wsId = params.workspaceId
    const req = questionQueue()[0]
    if (!wsId || quesResponding()) return
    setQuesResponding(true)
    setQuesError("")
    try {
      await cancelQuestions(wsId)
      if (req) dequeueQuestion(req.id)
    } catch (err) {
      const e = err as ApiError
      if (e?.status === 409 || e?.status === 404) {
        if (req) dequeueQuestion(req.id)
      } else {
        setQuesError(errorMessage(err))
      }
    } finally {
      setQuesResponding(false)
    }
  }

  /**
   * loadWorkspaceInfo
   * 参数：wsId workspace ID
   * 核心流程：GET /workspaces/{id} 获取项目路径 → 回填头部展示与当前标签的 projectPath；
   *           失败时沿用本地已知路径，不阻塞会话主流程
   */
  async function loadWorkspaceInfo(wsId: string) {
    try {
      // 拉取工作区详情：路径是服务端生成 workspace id 之外唯一稳定的项目标识
      const info = await getWorkspace(wsId)
      if (params.workspaceId !== wsId) return
      setWorkspaceInfo(info)
      const tab = openSessions().find((item) => item.id === params.sessionId)
      if (tab && info.path && tab.projectPath !== info.path) updateSessionTab({ ...tab, projectPath: info.path })
    } catch {
      // 详情不可用：回退到 selectedWorkspace / 标签里的已知路径
    }
  }

  /**
   * workspacePathFor
   * 参数：wsId workspace ID
   * 核心流程：按 服务端详情 → 选中工作区 → 标签页缓存 依次解析工作区路径，本地 YOLO 缓存按路径归档
   */
  function workspacePathFor(wsId: string): string {
    const info = workspaceInfo()
    if (info?.id === wsId && info.path) return info.path
    const selected = selectedWorkspace()
    if (selected?.id === wsId && selected.path) return selected.path
    return openSessions().find((item) => item.workspaceId === wsId)?.projectPath ?? ""
  }

  /**
   * loadYolo
   * 参数：wsId workspace ID
   * 核心流程：先用本地缓存兜底（workspace 被回收重建时不闪回 Off）→ GET permissions/skip 校准；
   *           响应回来时校验工作区仍为 wsId 且序号最新，过期响应直接丢弃；失败保留缓存值并提示
   */
  async function loadYolo(wsId: string) {
    const seq = ++yoloRequestSeq
    setYoloError("")
    const path = workspacePathFor(wsId)
    const cached = path ? recalledYolo(path) : undefined
    setYolo(cached)
    try {
      // 读取工作区级跳过权限开关：成功后映射到本地开关状态并回写缓存
      const skip = await getSkip(wsId)
      if (params.workspaceId !== wsId || seq !== yoloRequestSeq) return
      setYolo(skip)
      if (path) rememberYolo(path, skip)
    } catch (err) {
      if (params.workspaceId !== wsId || seq !== yoloRequestSeq) return
      setYolo(cached ?? false)
      setYoloError(errorMessage(err))
    }
  }

  /**
   * toggleYolo
   * 参数：无
   * 核心流程：乐观翻转开关 → POST setSkip → 失败回滚到旧值并在开关旁提示错误
   */
  async function toggleYolo() {
    const wsId = params.workspaceId
    const prev = yolo() === true
    if (!wsId || yoloPending()) return
    // 作废仍在飞行中的 loadYolo：避免旧 GET 结果回来把刚切换的状态覆盖掉
    yoloRequestSeq++
    setYolo(!prev)
    setYoloPending(true)
    setYoloError("")
    try {
      await setSkip(wsId, !prev)
      // 成功后回写按路径的本地缓存：workspace 被回收重建时可回填
      const path = workspacePathFor(wsId)
      if (path) rememberYolo(path, !prev)
    } catch (err) {
      // 请求失败：回滚开关并展示后端 message
      setYolo(prev)
      setYoloError(errorMessage(err))
    } finally {
      setYoloPending(false)
    }
  }

  /**
   * resetDocks
   * 参数：无
   * 核心流程：清空权限/问答队列与提交态（切换会话时调用，避免旧会话请求串台）
   */
  function resetDocks() {
    setPermissionQueue([])
    setQuestionQueue([])
    setPermResponding(false)
    setPermError("")
    setQuesResponding(false)
    setQuesError("")
    resetSubagents()
    }

  /**
   * handleEvent
   * 参数：ev 解包后的 workspace 事件
   * 核心流程：message created/updated 按 id upsert（并替换同文本乐观项）、deleted 移除；
   *           session/updated 更新标题（is_busy 仅 true 时采纳，避免恒 false 的 SSE 载荷误清 busy）；
   *           run_complete 匹配当前会话则结束 busy 态并清理残留乐观消息；
   *           permission_request/question_batch_request 按 session 过滤后入队，
   *           对应 notification 按请求 id 出队（其他客户端已处理的同步路径）
   */
  function handleEvent(ev: WorkspaceEvent) {
    const sid = params.sessionId
    if (ev.type === "message") {
      const msg = ev.payload as ChatMessage | null
      if (!msg || !msg.id) return
      // 子会话事件：登记过的 child session 才接收，避免 title 生成等内部会话污染时间线
      if (msg.session_id !== sid) {
        if (!knownSubagentIds.has(msg.session_id)) return
        if (ev.eventType === "deleted") {
          removeSubagentMessage(msg.session_id, msg.id)
          return
        }
        if (ev.eventType === "created" || ev.eventType === "updated") {
          registerAgentCalls(msg)
          mergeSubagentMessages(msg.session_id, [msg])
          // 首次实时事件到达：补一次子会话元数据，拿到标题/token/耗时
          if (!loadedSubagents.has(msg.session_id)) void ensureSubagentLoaded(msg.session_id)
        }
        return
      }
      if (ev.eventType === "deleted") {
        setMessages((prev) => prev.filter((m) => m.id !== msg.id))
        return
      }
      if (ev.eventType === "created" || ev.eventType === "updated") {
        upsertMessage(msg)
      }
      return
    }
    if (ev.type === "session") {
      const s = ev.payload as Session | null
      if (!s) return
      if (s.id !== sid) {
        if (knownSubagentIds.has(s.id)) setSubagentSession(s)
        return
      }
      // SSE 路径的 session 载荷不填 is_busy（见 proto/session.go 注释），故只在 true 时采纳
      // todos 带 omitempty：载荷缺省即表示待办已清空，按空数组覆盖
      // 用量字段每个 step 结束由后端 Save 推送，合并后上下文占比实时刷新
      setSession((prev) =>
        prev && prev.id === s.id
          ? {
              ...prev,
              title: s.title,
              todos: s.todos ?? [],
              prompt_tokens: s.prompt_tokens,
              completion_tokens: s.completion_tokens,
              total_tokens: s.total_tokens,
              cost: s.cost,
            }
          : prev,
      )
      // 标题变化同步到标题栏标签页
      updateSessionTab({ id: s.id, title: s.title || "Untitled", workspaceId: params.workspaceId })
      if (s.is_busy) setBusy(true)
      return
    }
    if (ev.type === "run_complete") {
      const rc = ev.payload as { session_id?: string } | null
      if (!rc || rc.session_id !== sid) return
      setBusy(false)
      setMessages((prev) => prev.filter((m) => !m.pending))
      return
    }
    if (ev.type === "permission_request") {
      const req = ev.payload as PermissionRequest | null
      if (!req?.id || req.session_id !== sid) return
      // 入队：同 id 去重，FIFO 逐条处理
      setPermissionQueue((prev) => (prev.some((p) => p.id === req.id) ? prev : [...prev, req]))
      return
    }
    if (ev.type === "permission_notification") {
      const n = ev.payload as { tool_call_id?: string } | null
      if (!n?.tool_call_id) return
      // 请求已被处理（本端或他端）：按 tool_call_id 出队
      setPermissionQueue((prev) => prev.filter((p) => p.tool_call_id !== n.tool_call_id))
      setPermError("")
      return
    }
    if (ev.type === "question_batch_request") {
      const req = ev.payload as QuestionRequest | null
      if (!req?.id || req.session_id !== sid) return
      setQuestionQueue((prev) => (prev.some((p) => p.id === req.id) ? prev : [...prev, req]))
      return
    }
    if (ev.type === "question_batch_notification") {
      const n = ev.payload as { batch_id?: string } | null
      if (!n?.batch_id) return
      // 批次已被处理：按 batch_id 出队
      setQuestionQueue((prev) => prev.filter((p) => p.id !== n.batch_id))
      setQuesError("")
    }
  }

  /**
   * canCompact
   * 参数：无
   * 核心流程：仅在 agent 就绪、会话空闲且已有用户消息时允许压缩；
   *           压缩进行中禁用，避免重复触发（后端会返回 session busy）
   */
  function canCompact(): boolean {
    return (
      agentState() === "ready" &&
      !busy() &&
      !sending() &&
      !compacting() &&
      messages().some((m) => m.role === "user")
    )
  }

  /**
   * handleCompact
   * 参数：无
   * 核心流程：POST summarize 触发压缩 → 期间进入 busy/compacting 双状态；
   *           摘要消息通过 SSE 渲染，接口返回后恢复状态；失败在 Composer 上方提示
   */
  async function handleCompact() {
    const wsId = params.workspaceId
    const sid = params.sessionId
    if (!wsId || !sid || !canCompact()) return

    setSendError("")
    setCompacting(true)
    setBusy(true)
    try {
      await summarizeSession(wsId, sid)
    } catch (err) {
      setSendError(errorMessage(err))
    } finally {
      setCompacting(false)
      setBusy(false)
    }
  }

  /**
   * 前缀 + U / 命令面板：全局只会发出压缩请求，真正执行要看当前会话状态，
   * 因此在这里监听并复用 handleCompact，条件不满足时给出原因而不是静默失败
   */
  createEffect(
    on(
      compactRequest,
      () => {
        if (compacting()) return
        if (busy() || sending()) {
          showComposerToast("运行中无法压缩会话，请先停止当前回复")
          return
        }
        if (agentState() !== "ready") {
          showComposerToast("会话尚未就绪，稍后再试")
          return
        }
        if (!messages().some((m) => m.role === "user")) {
          showComposerToast("当前会话还没有消息，无需压缩")
          return
        }
        void handleCompact()
      },
      { defer: true },
    ),
  )

  /**
   * replaceHashAnchor
   * 参数：text 用于替换 # 的文本
   * 核心流程：按触发位置把草稿里的 # 换成 text → 下一帧聚焦输入框并把光标落到插入文本之后；
   *           无待替换锚点（浮层非 # 触发）时只聚焦，不改草稿
   */
  function replaceHashAnchor(text: string) {
    const at = hashAnchor
    hashAnchor = -1
    if (at < 0) {
      queueMicrotask(() => draftRef?.focus())
      return
    }
    const prev = draft()
    const index = Math.min(at, prev.length)
    const before = prev.slice(0, index)
    setDraft(before + text + prev.slice(index + 1))
    // 等一帧：draft effect 先跑高度自适应，再定位光标避免落在旧布局上
    requestAnimationFrame(() => {
      const el = draftRef
      if (!el) return
      el.focus()
      const caret = before.length + text.length
      el.setSelectionRange(caret, caret)
      el.scrollTop = el.scrollHeight
    })
  }

  /**
   * handleMentionPick
   * 参数：item 浮层选中的候选（技能或 MCP server）
   * 核心流程：MCP 插入「使用该 server 工具」的引导文本 → 技能先用 skills/read 读取正文，
   *           成功后挂到附件区并替换成 #name；读取失败保留 # 并在 Composer 上方提示
   */
  async function handleMentionPick(item: MentionItem) {
    setHashOpen(false)
    if (item.kind === "mcp") {
      replaceHashAnchor(`#${item.name} (use the "${item.name}" MCP server tools) `)
      return
    }
    const wsId = params.workspaceId
    if (!wsId) return
    try {
      // 读取技能正文：content 为后端 JSON 中的 base64，可直接作为附件内容
      const { content, result } = await readSkill(wsId, item.id)
      const name = result.name || item.name
      setSkillAttachments((prev) =>
        prev.some((skill) => skill.id === item.id) ? prev : [...prev, { id: item.id, name, content }],
      )
      replaceHashAnchor(`#${name} `)
    } catch (err) {
      showComposerToast(errorMessage(err))
      replaceHashAnchor("#")
    }
  }

  /**
   * handleSend
   * 参数：无（读取 draft 输入）
   * 核心流程：校验就绪 → 乐观插入本地用户消息（临时 id）→ POST /agent 202 受理；
   *           运行中发送不传 run_id，后端会把该 prompt 折叠进当前回合的下一步
   *           （工具调用结束后立即执行），无需等整轮结束；
   *           失败路径：移除乐观消息、恢复输入、输入框上方错误条展示后端 message
   */
  async function handleSend() {
    const wsId = params.workspaceId
    const sid = params.sessionId
    const text = draft().trim()
    if (!wsId || !sid || !text || sending() || agentState() !== "ready") return
    // 运行中发送属于插队：run_id 留空，后端在下一步折叠；空闲时生成独立 run id
    const wasBusy = busy()

    // 模型明确不支持图片时直接拦截：后端 preparePrompt 会静默丢弃图片附件
    const pendingImages = images()
    if (pendingImages.length > 0 && modelSupportsImages() === false) {
      showComposerToast("当前模型不支持图片，请切换到支持视觉的模型")
      return
    }

    // 斜杠命令：/compact 直接触发压缩，不进消息流（运行中不允许，避免打断当前回合）
    if (text === "/compact") {
      if (busy()) {
        showComposerToast("运行中无法压缩会话，请先停止当前回复")
        return
      }
      setDraft("")
      setMentionOpen(false)
      resetHistoryCursor()
      void handleCompact()
      return
    }

    setDraft("")
    setSendError("")
    setMentionOpen(false)
    setHashOpen(false)
    resetHistoryCursor()
    setBusy(true)
    setSending(true)
    // 新一轮对话必然跟随输出：即便之前因为上翻停用了自动滚动
    stickToBottom = true

    // 乐观更新：立即插入临时用户消息，SSE 真实消息到来后按文本匹配替换
    const now = Math.floor(Date.now() / 1000)
    const optimistic: ChatMessage = {
      id: `pending-${++pendingSeq}`,
      role: "user",
      session_id: sid,
      parts: [
        { type: "text", data: { text } },
        // 图片先以本地 base64 插入，SSE 真实消息到达后按文本匹配替换
        ...pendingImages.map((img) => ({
          type: "binary",
          data: { Path: "", MIMEType: img.mime, Data: img.base64 },
        })),
      ],
      model: "",
      provider: "",
      created_at: now,
      updated_at: now,
      pending: true,
    }
    setMessages((prev) => [...prev, optimistic])

    try {
      // 发送 prompt：202 即受理，assistant 输出经 SSE message 事件逐步推送；
      // @ 文件只传路径由后端读取；粘贴图片直接内联 base64（磁盘上无文件）
      await sendMessage(wsId, {
        session_id: sid,
        prompt: text,
        // 运行中留空即插队（下一步折叠）；空闲时用独立 run id 关联完成事件
        run_id: wasBusy ? "" : newRunId(),
        attachments: [
          ...attachments().map((f) => ({
            file_path: f.path,
            file_name: f.is_dir ? `${f.name}/` : f.name,
          })),
          // # 引用的技能：正文直接内联（技能文件常在 workspace 之外，后端无法按路径读取）
          ...skillAttachments().map((skill) => ({
            file_name: `${skill.name}.md`,
            mime_type: "text/markdown",
            content: skill.content,
          })),
          ...pendingImages.map((img) => ({
            file_name: img.name,
            mime_type: img.mime,
            content: img.base64,
          })),
        ],
      })
      setAttachments([])
      setSkillAttachments([])
      setImages([])
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
      setDraft(text)
      setSendError(errorMessage(err))
      // 只有空闲发起时才解除 busy；插队失败不影响已在运行的回合
      if (!wasBusy) setBusy(false)
    }
    setSending(false)
  }

  /**
   * handleStop
   * 参数：无
   * 核心流程：POST cancel 中断当前会话的 run；成功即本地解除 busy（服务端随后补发 run_complete）
   */
  async function handleStop() {
    const wsId = params.workspaceId
    const sid = params.sessionId
    if (!wsId || !sid) return
    try {
      await cancel(wsId, sid)
      setBusy(false)
    } catch (err) {
      setSendError(errorMessage(err))
    }
  }

  /**
   * handleInputKeyDown
   * 参数：e 键盘事件
   * 核心流程：Enter（非 Shift、非输入法组词）拦截默认行为并触发发送；
   *           ↑/↓ 在光标处于首行/末行时回溯本会话输入历史，其余情况交还原生光标移动
   */
  function handleInputKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void handleSend()
      return
    }
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
    // @ 文件浮层与 # 技能/MCP 浮层自己用 ↑↓ 选择：浮层打开时让给它
    if (mentionOpen() || hashOpen()) return
    const entries = historyEntries()
    if (entries.length === 0) return
    const el = e.currentTarget as HTMLTextAreaElement
    // 多行草稿：只在首行/末行拦截（单行草稿两处都成立，光标在行内任意位置都能回溯）
    if (e.key === "ArrowUp" && el.value.slice(0, el.selectionStart).includes("\n")) return
    if (e.key === "ArrowDown" && el.value.slice(el.selectionEnd).includes("\n")) return
    if (e.key === "ArrowUp") {
      // 已到最早一条：继续阻挡，避免光标跳到开头
      if (historyIndex >= entries.length - 1) {
        e.preventDefault()
        return
      }
      // 首次进入历史：记下未发送草稿，↓ 回退到草稿态时原样恢复
      if (historyIndex === -1) historyDraft = draft()
      historyIndex += 1
    } else {
      if (historyIndex === -1) return
      historyIndex -= 1
    }
    e.preventDefault()
    applyDraft(historyIndex === -1 ? historyDraft : entries[historyIndex])
  }

  /**
   * applyDraft
   * 参数：value 目标文本
   * 核心流程：写入草稿 → 下一帧把光标置末并滚到可见（高度自适应由 draft effect 接管）
   */
  function applyDraft(value: string) {
    setDraft(value)
    // 等一帧：高度自适应 effect 跑完后再定位光标，避免落在旧布局上
    requestAnimationFrame(() => {
      const el = draftRef
      if (!el) return
      el.setSelectionRange(el.value.length, el.value.length)
      el.scrollTop = el.scrollHeight
    })
  }

  /**
   * resetHistoryCursor
   * 参数：无
   * 核心流程：清空历史游标与草稿快照，发送后回到实时草稿态
   */
  function resetHistoryCursor() {
    historyIndex = -1
    historyDraft = ""
  }

  /**
   * handleScroll
   * 参数：无（读取滚动容器）
   * 核心流程：位置变化即刷新右侧 Q&A 选中项；只有按住指针拖动滚动条才用它判定
   *           跟随开关（拖到顶部附近停用、拖回底部恢复）——
   *           其余滚动事件可能来自跟随写入或浏览器滚动锚定，一律不改跟随状态
   */
  function handleScroll() {
    const el = scrollRef
    if (!el) return
    // 位置变化即刷新右侧 Q&A 选中项，程序化的贴底滚动同样需要
    scheduleQuestionSync()
    if (!pointerHeld) return
    stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  /**
   * onWheelIntent
   * 参数：e 滚轮事件
   * 核心流程：向上滚动（deltaY < 0）直接停用跟随；向下滚且已经到底时恢复跟随 ——
   *           依赖用户意图而不是几何距离，避免刷屏时追不上被误判成用户上翻
   */
  function onWheelIntent(e: WheelEvent) {
    const el = scrollRef
    if (!el) return
    if (e.deltaY < 0) {
      stickToBottom = false
      return
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) stickToBottom = true
  }

  /**
   * onKeyIntent
   * 参数：e 键盘事件（挂在 window 捕获阶段——容器本身不可聚焦，只挂容器时按键收不到）
   * 核心流程：容器内按键滚动时按方向更新跟随 ——
   *           ↑/PageUp/Home 视为用户上翻，停用跟随；↓/PageDown/End 且已到底时恢复；
   *           焦点落在输入控件或弹窗上时不处理，避免和控件自身的按键语义冲突；
   *           焦点掉到 body/容器外时把焦点收回时间线，否则原生滚动没有落点
   */
  function onKeyIntent(e: KeyboardEvent) {
    const el = scrollRef
    if (!el) return
    const target = e.target as HTMLElement | null
    if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return
    if (document.querySelector("[role='dialog']")) return
    switch (e.key) {
      case "ArrowUp":
      case "PageUp":
      case "Home":
        stickToBottom = false
        break
      case "ArrowDown":
      case "PageDown":
      case "End":
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) stickToBottom = true
        break
      default:
        return
    }
    // 虚拟列表会卸载焦点元素，焦点掉到 body 后浏览器找不到可滚动目标（body 为 overflow-hidden），
    // 把焦点收回容器，让原生方向键滚动作用在时间线上
    const active = document.activeElement
    if (!active || active === document.body || !el.contains(active)) {
      el.focus({ preventScroll: true })
    }
  }

  /**
   * onPointerDownIntent
   * 参数：e 指针按下事件
   * 核心流程：标记指针处于按下状态，供滚动监听区分拖动滚动条与程序化滚动
   */
  function onPointerDownIntent() {
    pointerHeld = true
  }

  /**
   * onPointerUpIntent
   * 参数：无
   * 核心流程：指针抬起/取消即清除按下标记
   */
  function onPointerUpIntent() {
    pointerHeld = false
  }

  /**
   * onTouchStartIntent
   * 参数：e 触摸事件
   * 核心流程：记录手势起点纵坐标，供 touchmove 判断方向
   */
  function onTouchStartIntent(e: TouchEvent) {
    touchStartY = e.touches[0]?.clientY ?? 0
  }

  /**
   * onTouchMoveIntent
   * 参数：e 触摸事件
   * 核心流程：手指下移超过 6px 视为内容上翻，停用跟随
   */
  function onTouchMoveIntent(e: TouchEvent) {
    const y = e.touches[0]?.clientY ?? touchStartY
    if (y - touchStartY > 6) stickToBottom = false
  }

  /**
   * togglePanel
   * 参数：无
   * 核心流程：翻转右侧面板展开/折叠，并把折叠状态 + 当前宽度持久化 localStorage
   */
  function togglePanel() {
    const next = !panelOpen()
    setPanelOpen(next)
    persistPanelState(!next, panelWidth())
  }

  /**
   * onPanelResizeStart
   * 参数：e 指针按下事件
   * 核心流程：记录拖拽起点（鼠标 X + 起始宽度）并捕获指针，后续 move 即使移出元素也持续跟踪
   */
  function onPanelResizeStart(e: PointerEvent & { currentTarget: HTMLDivElement }) {
    resizeState = { startX: e.clientX, startWidth: panelWidth() }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  /**
   * onPanelResizeMove
   * 参数：e 指针移动事件
   * 核心流程：面板在右侧，鼠标左移加宽 —— 新宽度 = 起始宽度 - 水平位移，钳制 320~640
   */
  function onPanelResizeMove(e: PointerEvent) {
    if (!resizeState) return
    setPanelWidth(clampPanelWidth(resizeState.startWidth - (e.clientX - resizeState.startX)))
  }

  /**
   * onPanelResizeEnd
   * 参数：无
   * 核心流程：结束拖拽并把最终宽度持久化 localStorage（折叠状态不变）
   */
  function onPanelResizeEnd() {
    if (!resizeState) return
    resizeState = undefined
    persistPanelState(!panelOpen(), panelWidth())
  }

  // 进入页面主流程：订阅 SSE → 连接打开后上报 current-session → 加载会话/历史 → 确认 agent 就绪；
  // 任一路由参数变化整体重建，离开页面时关闭连接并清除 current-session
  createEffect(
    on(
      () => [params.workspaceId, params.sessionId] as const,
      ([wsId, sid]) => {
        // 切换会话：清空本地 Dock 队列与提交态，避免旧会话的请求串台
        resetDocks()
        setAttachments([])
        setImages([])
        setMentionOpen(false)
        setActiveQuestionId("")
        setHighlightedMessageId("")
        setWorkspaceInfo(undefined)
        if (highlightTimer) clearTimeout(highlightTimer)
        ensureEvents(wsId)
        const unsubscribe = subscribeEvents(handleEvent)
        // current-session 上报由 SSE 打开事件驱动：首次建连/重连成功都会触发；
        // 已连接时注册即触发，保证会话切换立即上报（不在挂载时盲调，避免 409）
        const unsubscribeOpen = onEventsOpen(() => void reportCurrentSession(wsId, sid))
        onCleanup(() => {
          unsubscribeOpen()
          unsubscribe()
          closeEvents()
          // 离开页面：空 session_id 清除登记，避免会话作用域事件继续路由到本客户端
          void reportCurrentSession(wsId, null)
        })
        void loadYolo(wsId)
        void loadWorkspaceInfo(wsId)
        void loadSession(wsId, sid)
        void loadMessages(wsId, sid)
        void ensureAgentReady(wsId)
      },
    ),
  )

  // 自动滚动交由 VirtualTimeline：贴底时消息新增或高度实测后重滚到底部

  const title = () => session()?.title || "Untitled"

  // 虚拟列表按 id 渲染：流式分片只替换消息对象，行组件与 DOM 保持复用，避免整卡重建导致闪屏
  const messageIds = createMemo(() => messages().map((message) => message.id))
  const messageById = createMemo(() => {
    const map = new Map<string, TimelineMessage>()
    for (const message of messages()) map.set(message.id, message)
    return map
  })

  // 输入历史：本会话已发送的提问文本，最新在前、同文去重，供输入框 ↑/↓ 回溯
  const historyEntries = createMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const message of messages()) {
      if (message.role !== "user") continue
      const text = textOf(message).trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      list.push(text)
    }
    return list.reverse()
  })

  // 工作区路径：服务端详情优先，其次选中项/当前标签中持久化的项目路径
  const workspacePath = () =>
    workspaceInfo()?.path ??
    (selectedWorkspace()?.id === params.workspaceId ? selectedWorkspace()?.path : undefined) ??
    openSessions().find((tab) => tab.id === params.sessionId)?.projectPath ??
    ""
  // 工作区展示名：路径末段；路径未知时退回 workspace id
  const workspaceName = () => basename(workspacePath()) || params.workspaceId
  // 工作区配色：与标题栏标签色条保持一致，便于跨会话识别
  const workspaceTint = () => workspaceColor(workspacePath() || params.workspaceId)

  // 最近一次实际使用的模型：ModelSelect 尚未上报时的兜底展示
  const lastUsedModel = createMemo(() => {
    const list = messages()
    for (let index = list.length - 1; index >= 0; index--) {
      const message = list[index]
      if (message.role !== "assistant") continue
      if (!message.model && !message.provider) continue
      return { model: message.model, provider: message.provider }
    }
    return undefined
  })

  // 运行指示：busy 且最后一条不是"正在流式的 assistant"时显示在时间线底部；
  // assistant 已开始流式后由消息自身的底部指示器接管，避免出现两条
  const showTurnIndicator = createMemo(() => {
    if (!busy()) return false
    const list = messages()
    const last = list[list.length - 1]
    return !(last?.role === "assistant" && !last.parts.some((p) => p.type === "finish"))
  })

  // 问答索引：从时间线提取非空 user 问句，answered 表示下一条 user 之前已有 assistant 输出
  const questions = createMemo<QuestionItem[]>(() => {
    const list = messages()
    const userMessages = list
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message }) =>
          message.role === "user" && !message.pending && textOf(message).trim().length > 0,
      )

    return userMessages.map(({ message, index }, position) => {
      const nextIndex = userMessages[position + 1]?.index ?? list.length
      const answered = list.slice(index + 1, nextIndex).some(
        (item) =>
          item.role === "assistant" &&
          (textOf(item).trim().length > 0 || item.parts.some((part) => part.type === "finish")),
      )
      const text = textOf(message).trim()
      return {
        messageId: message.id,
        order: position + 1,
        text,
        preview: questionPreview(text),
        createdAt: message.created_at,
        answered,
      }
    })
  })

  // 问句 id 集合：滚动高亮时用来判断某条 user 消息是否在索引里
  const questionIds = createMemo(() => new Set(questions().map((item) => item.messageId)))

  // 问答索引同步到全局：前缀 + Q 的浮层直接读这份数据，不再重复拉消息
  createEffect(
    on(
      () => questions(),
      (list) => publishSessionQuestions(params.sessionId, list),
    ),
  )

  // 离开会话页：清掉索引，避免浮层展示上一个会话的问句
  onCleanup(() => clearSessionQuestions(params.sessionId))

  // 浮层点名跳转：只处理当前会话的请求，消费后滚动到对应消息并高亮
  createEffect(
    on(
      () => questionJumpRequest(),
      (request) => {
        if (!request || request.sessionId !== params.sessionId) return
        consumeQuestionJump()
        jumpToMessage(request.messageId)
      },
    ),
  )

  /** 滚动高亮的帧句柄：同一帧内的多次滚动事件只做一次可见行查询 */

  /**
   * syncActiveQuestion
   * 核心流程：以可视区顶部下 24px 为判定线，在已挂载的行里找第一条跨过它的消息；
   *           该行不是提问时向前回落到最近的 user 消息，据此更新右侧 Q&A 选中项
   */
  function syncActiveQuestion() {
    const container = scrollRef
    const list = messages()
    const ids = questionIds()
    if (!container || ids.size === 0) return

    const rows = container.querySelectorAll<HTMLElement>("[data-message-id]")
    if (rows.length === 0) return

    const line = container.getBoundingClientRect().top + 24
    let currentId = ""
    for (const row of rows) {
      if (row.getBoundingClientRect().bottom > line) {
        currentId = row.dataset.messageId ?? ""
        break
      }
    }
    if (!currentId) currentId = rows[rows.length - 1].dataset.messageId ?? ""

    const index = list.findIndex((message) => message.id === currentId)
    if (index < 0) return

    // 判定线落在回答中段时，高亮这条回答对应的那次提问
    for (let i = index; i >= 0; i--) {
      const message = list[i]
      if (message.role === "user" && ids.has(message.id)) {
        setActiveQuestionId(message.id)
        return
      }
    }
  }

  /**
   * scheduleQuestionSync
   * 核心流程：滚动事件合到下一帧做一次即时同步，并在滚动停止后补一次校正
   *           （虚拟列表换行晚于滚动事件，只靠即时同步会拿到上一批行）
   */
  function scheduleQuestionSync() {
    if (!questionSyncFrame) {
      questionSyncFrame = requestAnimationFrame(() => {
        questionSyncFrame = 0
        syncActiveQuestion()
      })
    }
    if (questionSettleTimer) clearTimeout(questionSettleTimer)
    questionSettleTimer = setTimeout(() => {
      questionSettleTimer = undefined
      syncActiveQuestion()
    }, 140)
  }

  // 首屏与消息数变化后对齐一次：初始渲染不触发滚动事件
  createEffect(
    on(
      () => [messages().length, state()] as const,
      () => scheduleQuestionSync(),
    ),
  )

  /**
   * jumpToMessage
   * 参数：messageId 目标消息 id
   * 核心流程：关闭贴底自动滚动 → 用 pin 把目标拉进虚拟列表渲染窗口 → 逐帧校正锚点位置
   *           （未测量条目的占位高度会在滚动中被实测值替换，需多轮微调直到偏差收敛）；
   *           同步标记索引选中项，并给目标消息 1.6s 高亮
   */
  function jumpToMessage(messageId: string) {
    const container = scrollRef
    if (!container) return

    stickToBottom = false
    setActiveQuestionId(messageId)
    setHighlightedMessageId(messageId)
    setPinnedMessageId(messageId)
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => {
      setHighlightedMessageId("")
      setPinnedMessageId(undefined)
    }, 1600)

    // 目标可能尚未挂载（在视口外）：等 pin 生效渲染出来，再按实际位置反复校正
    let attempt = 0
    const settle = () => {
      const target = document.getElementById(`msg-${messageId}`)
      if (!target) {
        if (attempt++ < 10) requestAnimationFrame(settle)
        return
      }
      const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top - 16
      if (Math.abs(delta) < 8) return
      container.scrollTo({ top: Math.max(0, container.scrollTop + delta), behavior: "auto" })
      if (attempt++ < 10) requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
  }

  const agentHint = () => {
    switch (agentState()) {
      case "checking":
        return "Agent is starting…"
      case "unready":
        return "Agent is not ready"
      default:
        return ""
    }
  }

  // 方向键滚动意图：挂 window 捕获阶段，避免焦点掉到 body 或卡片被卸载后收不到按键
  onMount(() => {
    window.addEventListener("keydown", onKeyIntent, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyIntent, true))
  })

  // 会话信息弹窗快捷键：Ctrl+Alt+I 开关（纯展示操作，输入框内同样生效）
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "i") return
      event.preventDefault()
      setInfoOpen((open) => !open)
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <div class="m-2 flex min-h-0 min-w-0 flex-1 flex-row gap-2 overflow-hidden">
      {/* 左栏：会话内容（header + 消息区 + 输入区），保持原单栏结构 */}
      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-base">
      {/* SessionHeader：返回首页 + 会话标题 + SSE 状态点 + 面板切换按钮 */}
      <header class="flex h-12 shrink-0 items-center gap-1.5 border-b border-edge px-2">
        <button
          type="button"
          aria-label="Back to home"
          class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
          onClick={() => navigate("/")}
        >
          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M10 3.5 5.5 8l4.5 4.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        {/* 会话标题 + 工作区信息：标题主行，项目名/路径副行（色点与标签栏一致） */}
        <div class="flex min-w-0 flex-1 flex-col justify-center">
          <InlineTitle
            value={title()}
            class="truncate px-1 text-[13px] font-medium leading-4 text-text"
            inputClass="mx-1 rounded-[4px] border border-edge bg-raised px-1 text-[13px] font-medium leading-4 text-text outline-none focus:border-accent"
            onCommit={commitRename}
          />
          <span
            class="flex min-w-0 items-center gap-1 px-1 text-[11px] leading-4 text-muted"
            title={workspacePath() || params.workspaceId}
          >
            <span
              aria-hidden="true"
              class="size-1.5 shrink-0 rounded-full"
              style={{ "background-color": workspaceTint()?.solid ?? "transparent" }}
            />
            <span class="shrink-0">{workspaceName()}</span>
            <Show when={workspacePath()}>
              <span class="min-w-0 truncate opacity-70">· {workspacePath()}</span>
            </Show>
          </span>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-2 pr-1.5" title={`Events: ${eventsConnection()}`}>
          <span
            class="size-2 rounded-full transition-colors"
            classList={{ "opacity-50": eventsConnection() !== "connected" }}
            style={{
              "background-color":
                eventsConnection() === "connected" ? "var(--status-connected)" : "var(--status-disconnected)",
            }}
          />
          {/* 会话信息：模型 / 用量 / MCP / LSP / Skills 汇总（Ctrl+Alt+I） */}
          <button
            type="button"
            aria-label="Session info"
            title="Session info (Ctrl+Alt+I)"
            class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
            onClick={() => setInfoOpen(true)}
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 7.4v3.8" stroke-linecap="round" />
              <circle cx="8" cy="5" r="0.85" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {/* 刷新会话：重拉会话详情与消息；刷新期间图标旋转并禁用按钮 */}
          <button
            type="button"
            aria-label="Refresh session"
            title="Refresh session"
            class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text disabled:cursor-default disabled:opacity-60"
            disabled={refreshing()}
            onClick={() => void refreshSession()}
          >
            <svg
              viewBox="0 0 16 16"
              class="size-4"
              classList={{ "animate-spin": refreshing() }}
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8" />
              <path d="M13.4 2.8v2.9h-2.9" />
            </svg>
          </button>
          {/* 面板切换按钮：展开/折叠右侧面板，状态持久化 localStorage */}
          <button
            type="button"
            aria-label={panelOpen() ? "Hide side panel" : "Show side panel"}
            title={panelOpen() ? "Hide side panel" : "Show side panel"}
            class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted transition-colors hover:bg-raised hover:text-text"
            classList={{ "bg-raised text-text": panelOpen() }}
            onClick={togglePanel}
          >
            <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <path d="M10 3v10" />
            </svg>
          </button>
        </div>
      </header>

      <Show when={state() !== "error"} fallback={
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <span class="text-[13px] leading-5 text-muted">Failed to load session: {error()}</span>
          <button
            type="button"
            class="rounded-[6px] border border-edge px-2 py-1 text-[12px] text-text transition-colors hover:border-edge-strong hover:bg-raised"
            onClick={() => void loadSession(params.workspaceId, params.sessionId)}
          >
            Retry
          </button>
        </div>
      }>
        <Show when={state() !== "loading"} fallback={
          <div class="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
            <span class="text-[13px] leading-5 text-faint">Loading session…</span>
          </div>
        }>
          <div class="flex min-h-0 flex-1 flex-col">
            {/* 消息时间线：可滚动区，内容最大宽 1000px 居中（对齐 opencode 2xl） */}
            <div
              ref={scrollRef}
              tabIndex={-1}
              class="min-h-0 flex-1 overflow-y-auto"
              onScroll={handleScroll}
              onWheel={onWheelIntent}
              onPointerDown={onPointerDownIntent}
              onPointerUp={onPointerUpIntent}
              onPointerCancel={onPointerUpIntent}
              onTouchStart={onTouchStartIntent}
              onTouchMove={onTouchMoveIntent}
            >
              <div class="mx-auto flex w-full max-w-[1000px] flex-col px-4 py-5">
                <Show when={messages().length > 0} fallback={
                  <div class="py-10 text-center text-[13px] leading-5 text-faint">Empty session</div>
                }>
                  <SubagentProvider store={subagentStore}>
                    {/* 时间线虚拟化：仅挂载视口附近的卡片，其余用实测高度占位 */}
                    <VirtualTimeline
                      items={messageIds()}
                      scroll={() => scrollRef}
                      pin={pinnedMessageId()}
                      stick={() => stickToBottom}
                      onAutoScroll={() => {
                        // 贴底自动滚动后行位置会变化，重新对齐一次 Q&A 选中项
                        scheduleQuestionSync()
                      }}
                      render={(id, index) => (
                        <div
                          id={`msg-${id}`}
                          data-message-id={id}
                          class="rounded-[12px] transition-shadow"
                          classList={{ "ring-2 ring-accent/50": highlightedMessageId() === id }}
                        >
                          <Show when={messageById().get(id)}>
                            {(message) => (
                              <MessageItem message={message()} showFinish={index() === messages().length - 1} />
                            )}
                          </Show>
                        </div>
                      )}
                    />
                    {/* 运行中字符带：占位高度恒定，出现/消失不改变滚动高度，避免跟随漏触发 */}
                    <div class="h-8 px-1 py-2" classList={{ invisible: !showTurnIndicator() }}>
                      <Show when={showTurnIndicator()}>
                        <RunningIndicator />
                      </Show>
                    </div>
                  </SubagentProvider>
                </Show>
              </div>
            </div>

            {/* 输入区：固定底部，错误条 + 输入框容器（圆角 12px、最小高 96px、最大宽 1000px 居中） */}
            <div class="shrink-0 px-3 pb-3 pt-1">
              <Show when={sendError()}>
                <div class="mx-auto mb-2 max-w-[1000px] rounded-[8px] border border-[#e5484d]/40 bg-[#e5484d]/10 px-3 py-2 text-[12px] leading-4 text-[#e5484d]">
                  {sendError()}
                </div>
              </Show>
              <div class="mx-auto w-full max-w-[1000px]">
                {/* 待办 Dock：会话存在 todo 时展示完成进度与列表，折叠态持久化 */}
                <Show when={(session()?.todos?.length ?? 0) > 0}>
                  <TodoDock
                    todos={session()?.todos ?? []}
                    collapsed={todosCollapsed()}
                    onToggle={toggleTodos}
                  />
                </Show>
                {/* YOLO 开关：读取 permissions/skip 初始化，乐观切换、失败回滚 */}
                <div class="mb-2 flex items-center justify-end gap-2">
                  <Show when={yoloError()}>
                    <span class="truncate text-[11px] text-[#e5484d]">{yoloError()}</span>
                  </Show>
                  {/* 会话压缩：调用 summarize 接口，把历史消息折叠成一条摘要消息 */}
                  <button
                    type="button"
                    aria-label="Compact session"
                    title="Summarize the conversation to reduce context size（前缀 + U）"
                    class="flex items-center gap-1.5 rounded-[8px] border border-edge px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!canCompact()}
                    onClick={() => void handleCompact()}
                  >
                    <Show
                      when={compacting()}
                      fallback={
                        <>
                          <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4" stroke-linecap="round" stroke-linejoin="round" />
                            <path d="M2.5 6.5l4-4M13.5 9.5l-4 4" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                          Compact
                        </>
                      }
                    >
                      <span class="size-2.5 animate-spin rounded-full border border-current/40 border-t-current" />
                      Compacting…
                    </Show>
                  </button>
                  <button
                    type="button"
                    title="Skip permission prompts"
                    class="flex items-center gap-1.5 rounded-[8px] border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                    classList={{
                      "border-[#f5a623]/60 bg-[#f5a623]/10 text-[#f5a623]": yolo() === true,
                      "border-edge text-muted hover:bg-raised": yolo() !== true,
                    }}
                    disabled={yoloPending() || yolo() === undefined}
                    onClick={() => void toggleYolo()}
                  >
                    <Show when={yoloPending()}>
                      <span class="size-2.5 animate-spin rounded-full border border-current/40 border-t-current" />
                    </Show>
                    {yolo() === true ? "YOLO on" : "YOLO off"}
                  </button>
                </div>
                {/* 权限 Dock：FIFO 只渲染队首，裁决后自动显示下一条 */}
                <Show when={permissionQueue()[0]}>
                  {(req) => (
                    <PermissionDock
                      request={req()}
                      responding={permResponding()}
                      error={permError()}
                      onAction={(action) => void handlePermissionAction(action)}
                    />
                  )}
                </Show>
                {/* Question Dock：FIFO 只渲染队首批次 */}
                <Show when={questionQueue()[0]}>
                  {(req) => (
                    <QuestionDock
                      request={req()}
                      submitting={quesResponding()}
                      error={quesError()}
                      onSubmit={(responses) => void handleQuestionSubmit(responses)}
                      onCancel={() => void handleQuestionCancel()}
                    />
                  )}
                </Show>
                {/* Composer 轻提示：附件未支持 / 模型切换失败等一次性文案 */}
                <Show when={composerToast()}>
                  <div class="mb-2 flex w-fit max-w-full items-center rounded-lg border border-edge bg-raised px-3 py-1.5 text-[12px] leading-4 text-text shadow-sm">
                    {composerToast()}
                  </div>
                </Show>
                {/* opencode 版式 Composer：rounded-xl、min-h 96px、pt 12px；底部行 = 左侧 + / 模型选择器，右侧圆形发送 */}
                <div
                  class="relative flex min-h-[96px] flex-col rounded-xl border border-edge bg-deep pt-3 transition-colors focus-within:border-edge-strong"
                  onPaste={handleComposerPaste}
                  onDragOver={handleComposerDragOver}
                  onDrop={handleComposerDrop}
                >
                  {/* # 引用浮层：选中技能附加正文、选中 MCP 插入引导文本 */}
                  <Show when={hashOpen()}>
                    <HashMention
                      wsId={params.workspaceId}
                      onPick={(item) => void handleMentionPick(item)}
                      onClose={() => {
                        setHashOpen(false)
                        queueMicrotask(() => draftRef?.focus())
                      }}
                    />
                  </Show>
                  {/* @ 文件引用浮层：选择文件后作为附件随 prompt 发送 */}
                  <Show when={mentionOpen()}>
                    <FileMention
                      wsId={params.workspaceId}
                      onPick={(f) => {
                        setAttachments((prev) => (prev.some((x) => x.path === f.path) ? prev : [...prev, f]))
                        setMentionOpen(false)
                        setDraft((prev) => prev.replace(/@$/, ""))
                        // 选完立即把焦点还给 Composer，键盘可继续输入
                        queueMicrotask(() => draftRef?.focus())
                      }}
                      onClose={() => {
                        setMentionOpen(false)
                        queueMicrotask(() => draftRef?.focus())
                      }}
                    />
                  </Show>
                  {/* 技能 chips：# 引用到的技能正文会随 prompt 发送，可单个移除 */}
                  <Show when={skillAttachments().length > 0}>
                    <div class="flex flex-wrap gap-1.5 px-3 pb-2">
                      <For each={skillAttachments()}>
                        {(skill) => (
                          <span class="flex max-w-[220px] items-center gap-1 rounded-md border border-edge bg-raised px-1.5 py-0.5 text-[11px] text-muted">
                            <svg viewBox="0 0 16 16" class="size-3 shrink-0 text-accent" fill="none" stroke="currentColor" stroke-width="1.4">
                              <path d="M3.5 3.5h9v9h-9z" stroke-linejoin="round" />
                              <path d="M6 6.5h4M6 9h4" stroke-linecap="round" />
                            </svg>
                            <span class="truncate">{skill.name}</span>
                            <span class="shrink-0 rounded-[3px] bg-edge px-1 text-[10px] text-faint">skill</span>
                            <button
                              type="button"
                              aria-label={`Remove ${skill.name}`}
                              class="shrink-0 rounded-[3px] px-0.5 text-faint hover:bg-edge hover:text-text"
                              onClick={() => setSkillAttachments((prev) => prev.filter((x) => x.id !== skill.id))}
                            >
                              ×
                            </button>
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                  {/* 附件 chips：展示已选文件，可单个移除 */}
                  <Show when={attachments().length > 0}>
                    <div class="flex flex-wrap gap-1.5 px-3 pb-2">
                      <For each={attachments()}>
                        {(f) => (
                          <span class="flex max-w-[220px] items-center gap-1 rounded-md border border-edge bg-raised px-1.5 py-0.5 text-[11px] text-muted">
                            {/* 文件夹附件用目录图标，名称补 / 以区分文件 */}
                            <Show
                              when={f.is_dir}
                              fallback={
                                <svg viewBox="0 0 16 16" class="size-3 shrink-0" fill="none" stroke="currentColor" stroke-width="1.4">
                                  <path d="M4 2.5h5l3 3v8H4z" stroke-linejoin="round" />
                                </svg>
                              }
                            >
                              <svg viewBox="0 0 16 16" class="size-3 shrink-0" fill="none" stroke="currentColor" stroke-width="1.4">
                                <path d="M2 5.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1H8L6.5 4H3a1 1 0 0 0-1 1v.5Z" stroke-linejoin="round" />
                              </svg>
                            </Show>
                            <span class="truncate">{f.is_dir ? `${f.name}/` : f.name}</span>
                            <button
                              type="button"
                              aria-label={`Remove ${f.name}`}
                              class="shrink-0 rounded-[3px] px-0.5 text-faint hover:bg-edge hover:text-text"
                              onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== f.path))}
                            >
                              ×
                            </button>
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                  {/* 图片 chips：粘贴/拖拽得到，展示缩略图与文件名，可单个移除 */}
                  <Show when={images().length > 0}>
                    <div class="flex flex-wrap gap-1.5 px-3 pb-2">
                      <For each={images()}>
                        {(img) => (
                          <div class="relative flex max-w-[200px] items-center gap-1.5 rounded-md border border-edge bg-raised p-1 pr-1.5 text-[11px] text-muted">
                            <img
                              src={img.previewUrl}
                              alt={img.name}
                              class="size-8 shrink-0 rounded object-cover"
                            />
                            <span class="min-w-0 truncate">{img.name}</span>
                            <button
                              type="button"
                              aria-label={`Remove ${img.name}`}
                              class="shrink-0 rounded-[3px] px-0.5 text-faint hover:bg-edge hover:text-text"
                              onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                            >
                              ×
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <textarea
                    ref={draftRef}
                    value={draft()}
                    onInput={(e) => {
                      const el = e.currentTarget
                      const value = el.value
                      setDraft(value)
                      // 输入 @ 结尾：打开文件选择浮层
                      if (value.endsWith("@")) setMentionOpen(true)
                      // 输入 #：仅行首或空白之后触发技能/MCP 浮层，避免 markdown 标题误触
                      const caret = el.selectionStart ?? value.length
                      if (value[caret - 1] === "#" && (caret < 2 || /\s/.test(value[caret - 2]))) {
                        hashAnchor = caret - 1
                        setMentionOpen(false)
                        setHashOpen(true)
                      }
                    }}
                    onKeyDown={handleInputKeyDown}
                    disabled={agentState() !== "ready"}
                    placeholder="现在帮我"
                    rows={1}
                    class="block max-h-[240px] min-h-[60px] w-full resize-none overflow-y-auto bg-transparent px-4 pb-2 text-[13px] leading-5 text-text outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <div class="flex h-11 shrink-0 items-center gap-1 px-2">
                    <div class="flex min-w-0 flex-1 items-center gap-1">
                      {/* + 按钮：打开 @ 文件选择浮层 */}
                      <button
                        type="button"
                        aria-label="Add attachments"
                        title="Add attachments"
                        class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-text"
                        onClick={() => setMentionOpen(true)}
                      >
                        <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M8 3.5v9M3.5 8h9" stroke-linecap="round" />
                        </svg>
                      </button>
                      <Show when={agentState() === "unready"}>
                        <span class="truncate text-[11px] text-muted">
                          {agentHint()}
                          <button
                            type="button"
                            class="ml-1 shrink-0 text-accent hover:underline"
                            onClick={() => void ensureAgentReady(params.workspaceId)}
                          >
                            Retry
                          </button>
                        </span>
                      </Show>
                      {/* 模型选择器：当前 large 模型名 + 小箭头，下拉分组/过滤/打勾 */}
                      <ModelSelect
                        wsId={params.workspaceId}
                        onToast={showComposerToast}
                        onModelChange={(model, contextWindow, supportsImages) => {
                          setModelSelection(model)
                          setModelContextWindow(contextWindow)
                          setModelSupportsImages(supportsImages)
                        }}
                      />
                      {/* 用量指示器：生成中实时 tok/s，右侧为当前上下文占窗口百分比 */}
                      <UsageMeter
                        session={session()}
                        messages={messages()}
                        busy={busy()}
                        contextWindow={modelContextWindow()}
                      />
                    </div>
                    <Show
                      when={busy()}
                      fallback={
                        // 空闲：圆形 Send（向上箭头），无文本或 agent 未就绪时禁用
                        <button
                          type="button"
                          aria-label="Send"
                          title="Send"
                          class="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={!draft().trim() || agentState() !== "ready" || sending()}
                          onClick={() => void handleSend()}
                        >
                          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                        </button>
                      }
                    >
                      {/* busy：仍可继续输入插队 —— Send 在工具调用结束后并入当前回合；Stop 中断当前 run */}
                      <div class="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label="Queue message"
                          title="Send after the current tool call"
                          class="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={!draft().trim() || agentState() !== "ready" || sending()}
                          onClick={() => void handleSend()}
                        >
                          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          aria-label="Stop"
                          title="Stop"
                          class="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#e5484d] text-white transition-colors hover:bg-[#e5484d]/85"
                          onClick={() => void handleStop()}
                        >
                          <svg viewBox="0 0 16 16" class="size-3" fill="currentColor">
                            <rect x="3" y="3" width="10" height="10" rx="1.5" />
                          </svg>
                        </button>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Show>
      </Show>
      </div>

      {/* 右栏：可折叠面板（折叠时整体隐藏、左栏自动占满），左缘拖拽调宽 320~640 */}
      <Show when={panelOpen()}>
        <div
          class="relative flex h-full shrink-0 flex-col overflow-hidden rounded-[10px] bg-base"
          style={{ width: `${panelWidth()}px` }}
        >
          <SessionPanel
            wsId={params.workspaceId}
            sessionId={params.sessionId}
            questions={questions()}
            activeQuestionId={activeQuestionId()}
            onJump={jumpToMessage}
          />
          {/* 拖拽把手：贴左缘 8px 命中区，pointer capture 保证移出元素仍持续跟踪 */}
          <div
            class="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none"
            onPointerDown={onPanelResizeStart}
            onPointerMove={onPanelResizeMove}
            onPointerUp={onPanelResizeEnd}
            onPointerCancel={onPanelResizeEnd}
          />
        </div>
      </Show>

      {/* 会话信息弹窗：固定遮罩层，打开时焦点进入弹窗 */}
      <Show when={infoOpen()}>
        <SessionInfoDialog
          wsId={params.workspaceId}
          session={session()}
          model={modelSelection()}
          lastUsed={lastUsedModel()}
          contextWindow={modelContextWindow()}
          onClose={() => setInfoOpen(false)}
        />
      </Show>
    </div>
  )
}

// 消息条目渲染见 components/message/parts.tsx：user 右侧气泡、assistant 左对齐逐分片渲染
