/**
 * model-select.tsx
 * 参数：wsId workspace ID；onToast 轻提示回调（加载失败 / 切换失败时调用）
 * 核心流程：Composer 底部的模型选择器 ——
 *           打开时拉取 providers 目录 + workspace config（config 失败可点击重试）
 *           顶部 Recent 分组展示最近使用模型（config.recent_models.large），其余按 provider 分组；
 *           支持输入过滤、当前项打勾，Recent 中的模型从普通分组剔除避免重复
 *           选中后乐观更新显示与最近使用顺序 → POST setModel → 失败回退旧值并 toast
 */
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import {
  getWorkspaceConfig,
  listProviders,
  setModel,
  type Provider,
  type SelectedModel,
} from "../lib/models"
import type { ApiError } from "../lib/http"

/** 从抛出的错误对象中安全取 message */
function errorMessage(err: unknown): string {
  const e = err as ApiError
  return e?.message ?? "Unknown error"
}

/**
 * ModelRow
 * 参数：name 展示名；id 模型 id；providerName 可选（Recent 分组展示来源）；current 是否当前模型；onSelect 选择回调
 * 核心流程：统一下拉行 UI —— 模型名 + 模型 id + 当前项勾选；Recent 行额外前置 provider 名
 */
function ModelRow(props: {
  name: string
  id: string
  providerName?: string
  current: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[13px] transition-colors hover:bg-raised"
      classList={{ "bg-raised": props.current }}
      onClick={() => props.onSelect()}
    >
      <Show when={props.providerName}>
        <span class="max-w-[88px] shrink-0 truncate text-[11px] text-faint">{props.providerName}</span>
      </Show>
      <span class="min-w-0 flex-1 truncate text-text">{props.name}</span>
      <span class="shrink-0 text-[11px] text-faint">{props.id}</span>
      <Show when={props.current}>
        <svg viewBox="0 0 14 14" class="size-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M2.5 7.5 5.5 10.5 11.5 3.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </Show>
    </button>
  )
}

/** 过滤后的分组结构：provider 名 + 命中的模型列表 */
interface ModelGroup {
  id: string
  name: string
  models: { id: string; name: string }[]
}

/** 最近使用项：跨 provider，需要同时携带 provider 展示名 */
interface ModelOption {
  provider: string
  providerName: string
  id: string
  name: string
}

export default function ModelSelect(props: {
  wsId: string
  onToast: (msg: string) => void
  /** 当前模型变化：上报选中项、context_window 与图片能力，供 Composer 用量指示与粘贴校验 */
  onModelChange?: (
    model: SelectedModel | undefined,
    contextWindow: number | undefined,
    supportsImages: boolean | undefined,
  ) => void
}) {
  const [providers, setProviders] = createSignal<Provider[]>([])
  const [configProviders, setConfigProviders] = createSignal<Provider[]>([])
  const [current, setCurrent] = createSignal<SelectedModel>()
  const [configError, setConfigError] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const [filter, setFilter] = createSignal("")
  // 最近使用模型：数据来自 config.recent_models.large（后端已按新→旧维护）
  const [recent, setRecent] = createSignal<SelectedModel[]>([])

  let rootRef: HTMLDivElement | undefined
  let inputRef: HTMLInputElement | undefined

  /**
   * load
   * 参数：force 是否强制重载
   * 核心流程：并行拉 providers 与 config；config 失败降级为 configError（按钮显示默认值），
   *           providers 失败整体失败并 toast；成功后标记 loaded 避免重复请求
   */
  async function load(force = false) {
    const wsId = props.wsId
    if (!wsId || loading()) return
    if (loaded() && !force) return
    setLoading(true)
    try {
      // config 单独兜底：其失败不应影响目录展示，仅标记错误态供重试
      const [pv, cfg] = await Promise.all([
        listProviders(wsId),
        getWorkspaceConfig(wsId).catch(() => undefined),
      ])
      setProviders(pv)
      setLoaded(true)
      if (cfg) {
        setCurrent(cfg.models?.large)
        setConfigProviders(Object.values(cfg.providers ?? {}))
        // 最近使用列表随 config 一起返回：首屏即可排序到候选列表最前
        setRecent(cfg.recent_models?.large ?? [])
        setConfigError(false)
        emitModel(cfg.models?.large)
      } else {
        setConfigError(true)
        setRecent([])
        emitModel(undefined)
      }
    } catch (err) {
      props.onToast(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  /**
   * allProviders
   * 核心流程：合并 catwalk 目录与 workspace config 中的自定义 provider（同 id 以配置为准），
   *           保证本地接入的 provider（如 huya-copilot）也能出现在下拉里
   */
  const allProviders = createMemo<Provider[]>(() => {
    const map = new Map<string, Provider>()
    for (const p of providers()) map.set(p.id, p)
    for (const p of configProviders()) {
      map.set(p.id, { id: p.id, name: p.name || p.id, models: p.models ?? [] })
    }
    return [...map.values()]
  })

  /**
   * recentModels
   * 核心流程：把 config 里的 recent_models.large 映射为候选行数据 ——
   *           跳过目录中已不存在的 provider/model，按 provider+model 去重，保持后端的新→旧顺序
   */
  const recentModels = createMemo<ModelOption[]>(() => {
    const out: ModelOption[] = []
    const seen = new Set<string>()
    for (const item of recent()) {
      if (!item.provider || !item.model) continue
      const key = `${item.provider}\u0000${item.model}`
      if (seen.has(key)) continue
      const pv = allProviders().find((p) => p.id === item.provider)
      const md = pv?.models?.find((m) => m.id === item.model)
      if (!pv || !md) continue
      seen.add(key)
      out.push({ provider: pv.id, providerName: pv.name || pv.id, id: md.id, name: md.name || md.id })
    }
    return out
  })

  /** recentKeys：用于从普通 provider 分组中剔除已置顶的模型，避免重复出现 */
  const recentKeys = createMemo(() => new Set(recentModels().map((m) => `${m.provider}\u0000${m.id}`)))

  /**
   * contextWindowOf
   * 参数：model 选中的 provider/model
   * 核心流程：在合并后的目录中查找模型元数据，返回正数上下文窗口，否则 undefined
   */
  function contextWindowOf(model: SelectedModel | undefined): number | undefined {
    if (!model?.provider || !model.model) return undefined
    const provider = allProviders().find((p) => p.id === model.provider)
    const item = provider?.models?.find((m) => m.id === model.model)
    return item?.context_window && item.context_window > 0 ? item.context_window : undefined
  }

  /**
   * supportsImagesOf
   * 参数：model 选中的 provider/model
   * 核心流程：在合并后的目录中查 supports_attachments；未知时返回 undefined
   */
  function supportsImagesOf(model: SelectedModel | undefined): boolean | undefined {
    if (!model?.provider || !model.model) return undefined
    const provider = allProviders().find((p) => p.id === model.provider)
    return provider?.models?.find((m) => m.id === model.model)?.supports_attachments
  }

  /**
   * emitModel
   * 参数：model 选中项
   * 核心流程：把模型、上下文窗口与图片能力同步给外部（用量指示器 / 图片粘贴校验）
   */
  function emitModel(model: SelectedModel | undefined) {
    props.onModelChange?.(model, contextWindowOf(model), supportsImagesOf(model))
  }

  /**
   * providerLabel
   * 核心流程：按钮左侧展示供应商名 —— 配置存在时取 name，缺失时回退 provider id
   */
  const providerLabel = createMemo(() => {
    const cur = current()
    if (!cur?.provider) return ""
    const pv = allProviders().find((p) => p.id === cur.provider)
    return pv?.name || cur.provider
  })

  /**
   * modelLabel
   * 核心流程：按钮右侧展示完整模型名 —— 优先目录展示名，否则保留完整模型 id
   */
  const modelLabel = createMemo(() => {
    const cur = current()
    if (!cur?.model) return "Model"
    const pv = allProviders().find((p) => p.id === cur.provider)
    const md = pv?.models?.find((m) => m.id === cur.model)
    return md?.name || cur.model
  })

  /**
   * groups：按输入过滤后仍非空的 provider 分组 ——
   * 搜索词同时匹配 provider 名/id 与模型名/id：命中 provider 时展示该组全部模型；
   * 空搜索时剔除已置顶的最近项，搜索时展示全量避免与 Recent 重复
   */
  const groups = createMemo<ModelGroup[]>(() => {
    const q = filter().trim().toLowerCase()
    const pinned = q ? new Set<string>() : recentKeys()
    // provider 名/id 命中的分组优先排列，避免被「模型名恰好包含关键词」的分组挤到后面
    const providerHits = new Set(
      allProviders()
        .filter((p) => q && ((p.name || p.id).toLowerCase().includes(q) || p.id.toLowerCase().includes(q)))
        .map((p) => p.id),
    )
    const list = allProviders()
      .map((p) => {
        const providerName = p.name || p.id
        const providerHit = providerHits.has(p.id)
        return {
          id: p.id,
          name: providerName,
          models: (p.models ?? [])
            .filter((m) => {
              if (pinned.has(`${p.id}\u0000${m.id}`)) return false
              if (!q) return true
              if (providerHit) return true
              return m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)
            })
            .map((m) => ({ id: m.id, name: m.name || m.id })),
        }
      })
      .filter((g) => g.models.length > 0)
    return q ? list.sort((a, b) => Number(providerHits.has(b.id)) - Number(providerHits.has(a.id))) : list
  })

  /**
   * isOpenCurrent
   * 参数：providerId/modelId 候选项
   * 核心流程：判断是否为当前选中的 large 模型（下拉内打勾 + 高亮）
   */
  function isCurrent(providerId: string, modelId: string): boolean {
    const cur = current()
    return cur?.provider === providerId && cur?.model === modelId
  }

  /**
   * toggleOpen
   * 核心流程：开 → 清空过滤、聚焦搜索框、按需加载（config 失败则强制重试）；关 → 仅收起
   */
  function toggleOpen() {
    if (open()) {
      setOpen(false)
      return
    }
    setOpen(true)
    setFilter("")
    void load(configError())
    queueMicrotask(() => inputRef?.focus())
  }

  /**
   * select
   * 参数：providerId/modelId 用户选中的模型
   * 核心流程：乐观更新当前模型（带新模型默认 reasoning_effort）→ POST setModel；
   *           失败回退旧值并 toast，成功保持新显示（后端 config 已生效）
   */
  async function select(providerId: string, modelId: string) {
    const wsId = props.wsId
    if (!wsId || pending()) return
    const pv = allProviders().find((p) => p.id === providerId)
    const md = pv?.models?.find((m) => m.id === modelId)
    const prev = current()
    const next: SelectedModel = {
      provider: providerId,
      model: modelId,
      ...(md?.default_reasoning_effort ? { reasoning_effort: md.default_reasoning_effort } : {}),
    }
    setCurrent(next)
    setOpen(false)
    setConfigError(false)
    emitModel(next)
    setPending(true)
    try {
      await setModel(wsId, {
        provider: providerId,
        model: modelId,
        ...(md?.default_reasoning_effort ? { reasoning_effort: md.default_reasoning_effort } : {}),
      })
      // 写入成功：本地同步最近使用顺序（新→旧、去重、最多 10 条），下次打开下拉立即置顶
      setRecent((prev) =>
        [
          { provider: providerId, model: modelId },
          ...prev.filter((m) => !(m.provider === providerId && m.model === modelId)),
        ].slice(0, 10),
      )
    } catch (err) {
      setCurrent(prev)
      emitModel(prev)
      props.onToast(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  // 进入会话/切换工作区即加载当前模型，按钮无需展开下拉就能显示模型名
  createEffect(
    on(
      () => props.wsId,
      () => {
        setProviders([])
        setConfigProviders([])
        setCurrent(undefined)
        setRecent([])
        setLoaded(false)
        emitModel(undefined)
        void load(true)
      },
    ),
  )

  // 下拉打开期间监听外部点击 / Escape，点击组件外或按 Esc 收起
  createEffect(() => {
    if (!open()) return
    const onDown = (e: PointerEvent) => {
      if (rootRef && !rootRef.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown)
      document.removeEventListener("keydown", onKey)
    })
  })

  return (
    <div ref={rootRef} class="relative min-w-0">
      {/* 触发按钮：供应商 + 完整模型名 + 右侧小箭头，pending 时展示旋转标记 */}
      <button
        type="button"
        aria-label="Choose model"
        title={`${providerLabel()} · ${modelLabel()}`}
        class="flex max-w-[340px] items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted transition-colors hover:bg-raised hover:text-text"
        onClick={toggleOpen}
      >
        <Show when={providerLabel()}>
          <span class="shrink-0 text-faint">{providerLabel()}</span>
          <span class="shrink-0 text-faint/70">·</span>
        </Show>
        <span class="truncate text-text">{modelLabel()}</span>
        <Show when={pending()} fallback={
          <svg viewBox="0 0 12 12" class="size-3 shrink-0" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M2.5 4.5 6 8l3.5-3.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        }>
          <span class="size-2.5 shrink-0 animate-spin rounded-full border border-current/40 border-t-current" />
        </Show>
      </button>
      <Show when={open()}>
        {/* 下拉面板：向上弹出，顶部过滤输入，中部分组列表，底部 config 失败重试条 */}
        <div class="absolute bottom-full left-0 z-40 mb-2 flex max-h-80 w-[320px] flex-col overflow-hidden rounded-xl border border-edge bg-base shadow-lg">
          <div class="shrink-0 border-b border-edge p-2">
            <input
              ref={inputRef}
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
              placeholder="Search models…"
              class="w-full bg-transparent text-[13px] leading-5 text-text outline-none placeholder:text-faint"
            />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-1">
            <Show
              when={groups().length > 0 || (!filter().trim() && recentModels().length > 0)}
              fallback={
                <div class="px-2 py-3 text-center text-[12px] text-muted">
                  {loading() ? "Loading models…" : "No matching models"}
                </div>
              }
            >
              {/* Recent：最近使用模型置顶（跨 provider），搜索时隐藏避免与常规分组重复 */}
              <Show when={!filter().trim() && recentModels().length > 0}>
                <div class="mb-1">
                  <div class="px-2 py-1 text-[11px] font-medium text-faint">Recent</div>
                  <For each={recentModels()}>
                    {(m) => (
                      <ModelRow
                        name={m.name}
                        id={m.id}
                        providerName={m.providerName}
                        current={isCurrent(m.provider, m.id)}
                        onSelect={() => void select(m.provider, m.id)}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <For each={groups()}>
                {(g) => (
                  <div class="mb-1">
                    <div class="px-2 py-1 text-[11px] font-medium text-faint">{g.name}</div>
                    <For each={g.models}>
                      {(m) => (
                        <ModelRow
                          name={m.name}
                          id={m.id}
                          current={isCurrent(g.id, m.id)}
                          onSelect={() => void select(g.id, m.id)}
                        />
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <Show when={configError()}>
            {/* config 读取失败：提示条可点击强制重试 */}
            <button
              type="button"
              class="shrink-0 border-t border-edge px-2 py-1.5 text-start text-[11px] text-[#e5484d] transition-colors hover:bg-raised"
              onClick={() => void load(true)}
            >
              Config unavailable — click to retry
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
