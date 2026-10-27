/**
 * model-dialog.tsx
 * 参数：无（开关与关闭函数来自全局 ui-store）
 * 核心流程：前缀 + M 唤起的「模型列表」浮层 ——
 *           拉 providers 目录 + workspace config（当前模型 / 最近使用 / 自定义 provider）；
 *           最近使用置顶、其余按 provider 顺序平铺，行内展示供应商、模型名、模型 id 与当前打勾；
 *           搜索同时匹配供应商与模型；↑↓ 选择、Enter 切换（POST setModel）、Esc 或点遮罩关闭
 */
import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { useLocation } from "@solidjs/router"
import { closeModelDialog, modelDialogOpen } from "../lib/ui-store"
import { selectedWorkspace } from "../lib/workspace-store"
import {
  bumpModelRevision,
  getWorkspaceConfig,
  listProviders,
  mergeProviders,
  modelRevision,
  setModel,
  type Provider,
  type SelectedModel,
} from "../lib/models"
import type { ApiError } from "../lib/http"

/**
 * errorMessage
 * 参数：err 抛出的错误对象
 * 核心流程：安全取 message，取不到时给兜底文案
 */
function errorMessage(err: unknown): string {
  const e = err as ApiError
  return e?.message ?? "Unknown error"
}

/** 一行候选：provider + model 的组合，recent 表示来自「最近使用」置顶区 */
interface ModelOption {
  /** provider\u0000model，用于去重、高亮定位与 pending 匹配 */
  key: string
  provider: string
  providerName: string
  id: string
  name: string
  recent: boolean
}

export default function ModelDialog() {
  const location = useLocation()
  const [catalog, setCatalog] = createSignal<Provider[]>([])
  const [current, setCurrent] = createSignal<SelectedModel>()
  const [recent, setRecent] = createSignal<SelectedModel[]>([])
  const [loadedFor, setLoadedFor] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [pendingKey, setPendingKey] = createSignal("")
  const [error, setError] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)
  const [located, setLocated] = createSignal(false)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  // 当前工作区：优先取路由参数，其次取已选中的工作区（首页场景）
  const workspaceId = createMemo(() => {
    const match = /^\/w\/([^/?#]+)/.exec(location.pathname)
    if (match) return decodeURIComponent(match[1])
    return selectedWorkspace()?.id ?? ""
  })

  /**
   * load
   * 参数：wsId workspace ID
   * 核心流程：并行拉 provider 目录与 config；config 失败不让整体失败（仅失去当前项打勾），
   *           目录失败展示错误行；成功后记下已加载的 wsId，避免重复请求
   */
  async function load(wsId: string) {
    if (!wsId || loading()) return
    setLoading(true)
    setError("")
    try {
      const [list, config] = await Promise.all([
        listProviders(wsId),
        getWorkspaceConfig(wsId).catch(() => undefined),
      ])
      // 目录 / 当前模型 / 最近使用必须一起生效：若分次写入，高亮定位会按「还没排序」的列表算错位置
      batch(() => {
        setCatalog(mergeProviders(list, config?.providers))
        setCurrent(config?.models?.large)
        setRecent(config?.recent_models?.large ?? [])
        setLoadedFor(wsId)
      })
    } catch (err) {
      setCatalog([])
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  /**
   * options
   * 参数：无
   * 核心流程：展开扁平候选 —— 最近使用按后端的新→旧顺序置顶，其余按 provider 目录追加；
   *           目录里已不存在的 provider/model 跳过，provider+model 去重
   */
  const options = createMemo<ModelOption[]>(() => {
    const providers = catalog()
    const byId = new Map(providers.map((provider) => [provider.id, provider]))
    const out: ModelOption[] = []
    const seen = new Set<string>()
    const push = (providerId: string | undefined, modelId: string | undefined, isRecent: boolean) => {
      if (!providerId || !modelId) return
      const provider = byId.get(providerId)
      const model = provider?.models?.find((item) => item.id === modelId)
      if (!provider || !model) return
      const key = `${providerId}\u0000${modelId}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({
        key,
        provider: providerId,
        providerName: provider.name || providerId,
        id: modelId,
        name: model.name || modelId,
        recent: isRecent,
      })
    }
    for (const item of recent()) push(item.provider, item.model, true)
    for (const provider of providers) {
      for (const model of provider.models ?? []) push(provider.id, model.id, false)
    }
    return out
  })

  /**
   * filtered
   * 参数：无
   * 核心流程：按输入过滤，供应商名/id 与模型名/id 任一命中即可；保持「最近使用在前」的顺序
   */
  const filtered = createMemo<ModelOption[]>(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return options()
    return options().filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.id.toLowerCase().includes(needle) ||
        item.providerName.toLowerCase().includes(needle) ||
        item.provider.toLowerCase().includes(needle),
    )
  })

  /** isCurrent：该行是否为 workspace config 里的当前 large 模型 */
  function isCurrent(item: ModelOption): boolean {
    const cur = current()
    return cur?.provider === item.provider && cur.model === item.id
  }

  /**
   * currentLabel
   * 核心流程：底部右侧展示「当前模型」；config 没读到或模型已下架时给兜底文案
   */
  const currentLabel = createMemo(() => {
    const cur = current()
    if (!cur?.provider || !cur.model) return loading() ? "加载中…" : "未获取当前模型"
    const hit = options().find((item) => item.provider === cur.provider && item.id === cur.model)
    return hit ? `当前：${hit.providerName} · ${hit.name}` : `当前：${cur.provider} · ${cur.model}`
  })

  // 打开时重置搜索/高亮/错误，把焦点交给搜索框；工作区变了或首次打开才拉数据
  createEffect(
    on(modelDialogOpen, (open) => {
      if (!open) return
      setQuery("")
      setActiveIndex(0)
      setLocated(false)
      setError("")
      queueMicrotask(() => inputRef?.focus())
      // 换了工作区：先清空上一个工作区的目录，避免列表闪现别家模型
      if (loadedFor() !== workspaceId()) {
        setCatalog([])
        void load(workspaceId())
      }
    }),
  )

  // 其他入口（Composer 下拉）切换过模型：标记已加载失效，下次打开重新拉当前模型与最近使用
  createEffect(on(modelRevision, () => setLoadedFor("")))

  // 首次渲染完候选后把高亮定位到当前模型：直接按 Enter 不会误切到别的模型
  createEffect(() => {
    if (!modelDialogOpen() || located()) return
    const cur = current()
    if (!cur?.provider || !cur.model) return
    const index = filtered().findIndex((item) => item.provider === cur.provider && item.id === cur.model)
    if (index < 0) return
    setActiveIndex(index)
    setLocated(true)
  })

  /**
   * moveActive
   * 参数：delta 相对位移
   * 核心流程：在过滤结果里上下移动高亮并首尾循环
   */
  function moveActive(delta: number) {
    const total = filtered().length
    if (total === 0) return
    setActiveIndex((prev) => (prev + delta + total) % total)
  }

  /**
   * select
   * 参数：item 选中的模型行
   * 核心流程：POST setModel（带上模型默认 reasoning_effort）→ 成功后广播模型变更并关闭浮层；
   *           失败保留浮层并把错误显示在底部
   */
  async function select(item: ModelOption) {
    const wsId = workspaceId()
    if (!wsId || pendingKey()) return
    const model = catalog().find((provider) => provider.id === item.provider)?.models?.find((m) => m.id === item.id)
    setPendingKey(item.key)
    setError("")
    try {
      await setModel(wsId, {
        provider: item.provider,
        model: item.id,
        ...(model?.default_reasoning_effort ? { reasoning_effort: model.default_reasoning_effort } : {}),
      })
      setCurrent({ provider: item.provider, model: item.id })
      // 本地同步「最近使用」顺序（新→旧、去重、最多 10 条）：下次打开不重拉目录也能置顶
      setRecent((prev) =>
        [
          { provider: item.provider, model: item.id },
          ...prev.filter((m) => !(m.provider === item.provider && m.model === item.id)),
        ].slice(0, 10),
      )
      bumpModelRevision()
      closeModelDialog()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPendingKey("")
    }
  }

  // 高亮项滚动进视野：模型可能很多
  createEffect(() => {
    const index = activeIndex()
    if (!modelDialogOpen()) return
    queueMicrotask(() => {
      listRef?.querySelector<HTMLElement>(`[data-model-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
    })
  })

  onMount(() => {
    /**
     * handleKeydown
     * 参数：event 全局键盘事件
     * 核心流程：浮层打开期间接管 ↑↓ / Enter / Esc（不依赖搜索框焦点），
     *           其它按键放行给搜索框输入；已被上游浮层消费的按键（命令面板的 Enter）不重复处理
     */
    const handleKeydown = (event: KeyboardEvent) => {
      if (!modelDialogOpen() || event.isComposing || event.defaultPrevented) return
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        moveActive(event.key === "ArrowDown" ? 1 : -1)
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        const target = filtered()[activeIndex()]
        if (target) void select(target)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        closeModelDialog()
      }
    }
    document.addEventListener("keydown", handleKeydown)
    onCleanup(() => document.removeEventListener("keydown", handleKeydown))
  })

  return (
    <Show when={modelDialogOpen()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[14vh]"
        onClick={closeModelDialog}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Model list"
          class="flex max-h-[64vh] w-[540px] max-w-full flex-col overflow-hidden rounded-xl border border-edge bg-base shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            ref={inputRef}
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setActiveIndex(0)
            }}
            placeholder="搜索模型 / 供应商…"
            aria-label="Search models"
            class="h-10 w-full shrink-0 border-b border-edge bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-faint"
          />
          <div ref={listRef} role="listbox" aria-label="Models" class="min-h-0 flex-1 overflow-y-auto py-1">
            <For each={filtered()}>
              {(item, index) => {
                const active = () => index() === activeIndex()
                const busy = () => pendingKey() === item.key
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active()}
                    data-model-index={index()}
                    data-model-key={item.key}
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors"
                    classList={{
                      "bg-raised text-text": active(),
                      "text-muted hover:bg-raised/60": !active(),
                    }}
                    onMouseEnter={() => setActiveIndex(index())}
                    onClick={() => void select(item)}
                  >
                    <span class="w-[92px] shrink-0 truncate text-[11px] text-faint">{item.providerName}</span>
                    <span class="min-w-0 flex-1 truncate">{item.name}</span>
                    <Show when={item.recent}>
                      <span class="shrink-0 rounded-[4px] bg-accent/10 px-1 text-[10px] text-accent">最近</span>
                    </Show>
                    <span class="shrink-0 text-[10px] text-faint">{item.id}</span>
                    <Show
                      when={busy()}
                      fallback={
                        <Show when={isCurrent(item)}>
                          <svg
                            viewBox="0 0 14 14"
                            class="size-3.5 shrink-0 text-accent"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                          >
                            <path d="M2.5 7.5 5.5 10.5 11.5 3.5" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                        </Show>
                      }
                    >
                      <span class="size-2.5 shrink-0 animate-spin rounded-full border border-current/40 border-t-current" />
                    </Show>
                  </button>
                )
              }}
            </For>
            <Show when={filtered().length === 0}>
              <p class="px-3 py-6 text-center text-[12px] text-faint">
                {!workspaceId()
                  ? "请先打开一个工作区"
                  : loading()
                    ? "加载模型列表…"
                    : error()
                      ? "模型列表加载失败"
                      : "没有匹配的模型"}
              </p>
            </Show>
          </div>
          <Show when={error()}>
            <p class="shrink-0 border-t border-edge px-3 py-1.5 text-[11px] text-[#e5484d]">{error()}</p>
          </Show>
          <div class="flex shrink-0 items-center justify-between gap-2 border-t border-edge px-3 py-1.5 text-[10px] text-faint">
            <span class="shrink-0">↑↓ 选择 · Enter 切换 · Esc 关闭</span>
            <span class="min-w-0 truncate">{currentLabel()}</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
