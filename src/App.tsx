import { useEffect, useMemo, useState } from 'react'
import type { AppState, Constraint, TEvent } from './types'
import { analyze } from './lib/graph'
import { findMinimalRepairs } from './lib/repair'
import {
  buildConsistentSample,
  buildContradictionSample,
  defaultAnchorTime,
  emptyState,
  uid,
} from './lib/samples'
import { clearState, loadState, saveState } from './lib/storage'
import { formatFullDateTime } from './lib/format'
import EventEditor from './components/EventEditor'
import ConstraintEditor from './components/ConstraintEditor'
import GraphView from './components/GraphView'
import CyclePanel from './components/CyclePanel'
import WindowsTable from './components/WindowsTable'
import RepairPanel from './components/RepairPanel'

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? buildConsistentSample())
  // 修复方案预览：仅内存生效，不写入 localStorage；任何编辑操作都会退出预览
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

  // 本地持久化：任何修改实时写入 localStorage（预览状态不入存储）
  useEffect(() => {
    saveState(state)
  }, [state])

  const { events, constraints, anchorId, anchorTime } = state

  // —— 原始数据的实时分析（用于矛盾判定与修复搜索）——
  const result = useMemo(
    () => analyze(events, constraints, anchorId),
    [events, constraints, anchorId],
  )

  // —— 最小修复建议：仅在检测到矛盾（负环）时搜索 ——
  const repair = useMemo(
    () =>
      result.satisfiable
        ? null
        : findMinimalRepairs(events, constraints, anchorId),
    [events, constraints, anchorId, result.satisfiable],
  )

  // —— 预览中的停用集合 ——
  const previewOffIds = useMemo(() => {
    if (previewIndex === null || !repair) return null
    return new Set(repair.plans[previewIndex]?.disableConstraintIds ?? [])
  }, [previewIndex, repair])

  // —— 叠加预览后的约束与分析结果（不修改 state，因此不会写入 localStorage）——
  const effectiveConstraints = useMemo(() => {
    if (!previewOffIds) return constraints
    return constraints.map((c) =>
      previewOffIds.has(c.id) ? { ...c, enabled: false } : c,
    )
  }, [constraints, previewOffIds])

  const effectiveResult = useMemo(() => {
    if (!previewOffIds) return result
    return analyze(events, effectiveConstraints, anchorId)
  }, [events, effectiveConstraints, anchorId, previewOffIds, result])

  // 矛盾环相关集合（用于跨组件高亮；预览可满足时为空）
  const cycleEventIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const i of effectiveResult.cycle.nodes) if (events[i]) s.add(events[i].id)
    }
    return s
  }, [effectiveResult, events])

  const cycleConstraintIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) s.add(e.constraintId)
    }
    return s
  }, [effectiveResult])

  const cycleEdgeIds = useMemo(() => {
    const s = new Set<string>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle) {
      for (const e of effectiveResult.cycle.edges) s.add(`${e.constraintId}:${e.bound}`)
    }
    return s
  }, [effectiveResult])

  const cycleNodeIdx = useMemo(() => {
    const s = new Set<number>()
    if (!effectiveResult.satisfiable && effectiveResult.cycle)
      for (const i of effectiveResult.cycle.nodes) s.add(i)
    return s
  }, [effectiveResult])

  const activeCount = constraints.filter((c) => c.enabled).length
  const previewing = previewOffIds !== null

  // —— 编辑操作（均退出预览，避免预览与新数据错位）——
  const addEvent = (name: string, note: string) => {
    setPreviewIndex(null)
    const ev: TEvent = { id: uid('ev'), name, note: note || undefined }
    setState((s) => ({
      ...s,
      events: [...s.events, ev],
      anchorId: s.anchorId ?? ev.id,
    }))
  }

  const removeEvent = (id: string) => {
    setPreviewIndex(null)
    setState((s) => ({
      ...s,
      events: s.events.filter((e) => e.id !== id),
      constraints: s.constraints.filter((c) => c.aId !== id && c.bId !== id),
      anchorId: s.anchorId === id ? null : s.anchorId,
    }))
  }

  const renameEvent = (id: string, name: string) => {
    setPreviewIndex(null)
    setState((s) => ({
      ...s,
      events: s.events.map((e) => (e.id === id ? { ...e, name } : e)),
    }))
  }

  const setAnchor = (id: string) => setState((s) => ({ ...s, anchorId: id }))

  const addConstraint = (c: Omit<Constraint, 'id'>) => {
    setPreviewIndex(null)
    setState((s) => ({ ...s, constraints: [...s.constraints, { ...c, id: uid('ct') }] }))
  }

  const removeConstraint = (id: string) => {
    setPreviewIndex(null)
    setState((s) => ({ ...s, constraints: s.constraints.filter((c) => c.id !== id) }))
  }

  const updateConstraint = (id: string, patch: Partial<Constraint>) => {
    setPreviewIndex(null)
    setState((s) => ({
      ...s,
      constraints: s.constraints.map((c) => {
        if (c.id !== id) return c
        const next = { ...c, ...patch }
        // 防止输入过程中出现 min > max / 负数
        if (!Number.isFinite(next.min) || next.min < 0) next.min = 0
        if (!Number.isFinite(next.max) || next.max < next.min) next.max = next.min
        if (Number.isFinite(next.min) && next.min > next.max) next.min = next.max
        return next
      }),
    }))
  }

  const loadSample = (kind: 'ok' | 'conflict') => {
    setPreviewIndex(null)
    setState(kind === 'ok' ? buildConsistentSample() : buildContradictionSample())
  }

  const resetAll = () => {
    if (!window.confirm('确定清空全部事件、约束与本地存储数据吗？')) return
    setPreviewIndex(null)
    clearState()
    setState(emptyState())
  }

  // —— 修复方案：预览 / 确认应用 ——
  const previewRepair = (i: number) => setPreviewIndex(i)
  const exitPreview = () => setPreviewIndex(null)
  const applyRepair = (i: number) => {
    if (!repair) return
    const plan = repair.plans[i]
    if (!plan) return
    const off = new Set(plan.disableConstraintIds)
    setPreviewIndex(null)
    // 确认后批量停用对应约束（state 变更即写入 localStorage）
    setState((s) => ({
      ...s,
      constraints: s.constraints.map((c) =>
        off.has(c.id) ? { ...c, enabled: false } : c,
      ),
    }))
  }

  // —— 顶部状态 ——
  const anchorExists = anchorId != null && events.some((e) => e.id === anchorId)
  const banner = (() => {
    if (events.length === 0) {
      return {
        cls: 'warn',
        icon: '📋',
        title: '等待录入',
        desc: '添加事件并指定锚点后开始分析。也可以直接载入下方示例数据。',
      }
    }
    if (!effectiveResult.satisfiable) {
      return {
        cls: 'danger',
        icon: '⛔',
        title: '约束相互矛盾，不存在任何可行的事件时间安排',
        desc: `差分约束图中检测到负环（环上权重之和为 ${effectiveResult.cycle?.totalWeight} 分钟 < 0）。红色标出的环即一条可复核的矛盾链：请核对对应证词或记录；下方同时给出停用约束最少的修复建议。`,
      }
    }
    if (previewing) {
      return {
        cls: 'ok',
        icon: '👁️',
        title: '修复预览：停用建议中的约束后，系统恢复可满足',
        desc: '当前为临时预览，停用尚未写入浏览器本地存储；确认无误后请在方案卡片上点击“确认应用”，或退出预览返回原数据。',
      }
    }
    if (!anchorExists) {
      return {
        cls: 'warn',
        icon: '🎯',
        title: '约束系统本身一致，但尚未指定锚点事件',
        desc: '在事件列表中点选单选按钮指定锚点，并设置锚点绝对时间，即可得到各事件的最早 / 最晚时间窗。',
      }
    }
    return {
      cls: 'ok',
      icon: '✅',
      title: '约束可满足：存在与全部约束相容的时间安排',
      desc: `共 ${events.length} 个事件、${activeCount} 条生效约束。下表给出每个事件相对锚点的最早与最晚时间；与锚点无约束通路的事件标记为“无法定时”。`,
    }
  })()

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>事件时序约束校验器</h1>
          <div className="subtitle">
            采访证词 / 事故复盘 · 差分约束图（Difference Constraints）实时可满足性判定
          </div>
        </div>
        <div className="toolbar">
          <button onClick={() => loadSample('ok')}>载入可满足示例</button>
          <button onClick={() => loadSample('conflict')}>载入矛盾示例</button>
          <button className="danger-ghost" onClick={resetAll}>
            清空全部数据
          </button>
        </div>
      </header>

      {/* 锚点 */}
      <div className="anchor-bar">
        <label className="title">锚点</label>
        <select
          value={anchorId ?? ''}
          onChange={(e) => setAnchor(e.target.value)}
          aria-label="锚点事件"
        >
          <option value="">（未选择）</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <label className="title" style={{ fontWeight: 400 }}>
          锚点绝对时间
        </label>
        <input
          type="datetime-local"
          value={anchorTime}
          onChange={(e) => setState((s) => ({ ...s, anchorTime: e.target.value || defaultAnchorTime() }))}
        />
        <span className="anchor-absolute">= {formatFullDateTime(anchorTime)}</span>
      </div>

      {/* 判定横幅 */}
      <div className={`status-banner ${banner.cls}`}>
        <div className="icon">{banner.icon}</div>
        <div>
          <h2>{banner.title}</h2>
          <p>{banner.desc}</p>
          {!effectiveResult.satisfiable && effectiveResult.cycle && (
            <CyclePanel
              cycle={effectiveResult.cycle}
              events={events}
              constraints={effectiveConstraints}
            />
          )}
        </div>
      </div>

      {/* 修复预览提示条（预览不写入 localStorage） */}
      {previewing && (
        <div className="preview-bar">
          <span>
            👁️ 正在<strong>预览修复方案 {previewIndex! + 1}</strong>
            ：已临时停用 {previewOffIds!.size} 条约束（约束列表中置灰并标记“预览停用”），
            本预览<strong>不会写入 localStorage</strong>。
          </span>
          <button className="small" onClick={exitPreview}>
            退出预览
          </button>
        </div>
      )}

      {/* 最小修复建议（仅原始数据存在矛盾时搜索并展示） */}
      {!result.satisfiable && repair && (
        <div style={{ marginBottom: 16 }}>
          <RepairPanel
            events={events}
            constraints={constraints}
            repair={repair}
            anchorId={anchorId}
            anchorTime={anchorTime}
            previewIndex={previewIndex}
            onPreview={previewRepair}
            onExitPreview={exitPreview}
            onApply={applyRepair}
          />
        </div>
      )}

      {/* 差分图 */}
      <div className="panel graph-panel" style={{ marginBottom: 16 }}>
        <h3>
          差分约束图
          <span className="count">边标签 w 表示 t终点 − t起点 ≤ w（分钟）</span>
        </h3>
        <GraphView
          events={events}
          constraints={effectiveConstraints}
          anchorId={anchorId}
          cycleNodes={cycleNodeIdx}
          cycleEdgeIds={cycleEdgeIds}
        />
      </div>

      {/* 编辑器 */}
      <div className="grid-2">
        <EventEditor
          events={events}
          anchorId={anchorId}
          cycleEventIds={cycleEventIds}
          onAdd={addEvent}
          onRemove={removeEvent}
          onRename={renameEvent}
          onSetAnchor={setAnchor}
        />
        <ConstraintEditor
          events={events}
          constraints={effectiveConstraints}
          cycleConstraintIds={cycleConstraintIds}
          previewOffIds={previewOffIds}
          onAdd={addConstraint}
          onRemove={removeConstraint}
          onUpdate={updateConstraint}
        />
      </div>

      {/* 时间窗（预览时展示修复后的窗口；正常可满足时展示当前窗口） */}
      {effectiveResult.satisfiable && (
        <WindowsTable
          events={events}
          windows={effectiveResult.windows}
          cycleEventIds={cycleEventIds}
          anchorId={anchorId}
          anchorTime={anchorTime}
        />
      )}

      <div className="footer-note">
        数据自动保存在浏览器 localStorage，刷新不丢失 · 停用某条约束可即时验证“去掉该证词后矛盾是否消除” ·
        修复方案的“一键预览”仅在内存生效，点击“确认应用”才会批量停用并写入本地存储
      </div>
    </div>
  )
}
