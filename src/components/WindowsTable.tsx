import type { BoundaryKind, TEvent, WindowInfo } from '../types'
import { formatAbsolute, formatOffset } from '../lib/format'

interface Props {
  events: TEvent[]
  windows: Map<number, WindowInfo>
  cycleEventIds: Set<string>
  anchorId: string | null
  anchorTime: string
  /** 嵌入修复方案卡片时复用，不再渲染外层面板标题 */
  embedded?: boolean
  /** 传入后启用「边界依据追溯」：点击有界的最早/最晚单元格展示紧约束链 */
  onTrace?: (eventId: string, kind: BoundaryKind) => void
  /** 当前追溯的目标事件与边界（用于高亮对应单元格） */
  traceEventId?: string | null
  traceKind?: BoundaryKind | null
}

const STATUS_META: Record<WindowInfo['status'], { label: string; cls: string; hint: string }> = {
  anchor: { label: '锚点', cls: 'anchor', hint: '时间即指定的锚点时间' },
  bounded: { label: '可定时', cls: 'bounded', hint: '最早/最晚均可由约束推出' },
  oneSided: { label: '仅单边有界', cls: 'oneSided', hint: '只能推出最早或最晚一侧' },
  disconnected: { label: '无法定时', cls: 'disconnected', hint: '未与锚点形成有向通路' },
}

export default function WindowsTable({
  events,
  windows,
  cycleEventIds,
  anchorId,
  anchorTime,
  embedded = false,
  onTrace,
  traceEventId,
  traceKind,
}: Props) {
  const traceEnabled = !!onTrace

  /** 渲染一个最早/最晚边界单元格（偏移列与绝对时间列共用）：可追溯时渲染为按钮 */
  const renderBoundaryCell = (
    ev: TEvent,
    kind: BoundaryKind,
    offset: number | null,
    status: WindowInfo['status'],
    mode: 'offset' | 'absolute',
  ) => {
    const offsetText = formatOffset(offset)
    const absoluteText = status !== 'disconnected' ? formatAbsolute(anchorTime, offset) : '—'
    const text = mode === 'offset' ? offsetText : absoluteText
    const active = traceEnabled && traceEventId === ev.id && traceKind === kind

    if (!traceEnabled || offset === null) {
      let reason = ''
      if (traceEnabled && offset === null) {
        reason =
          status === 'disconnected'
            ? '该事件与锚点之间没有有向约束通路，无法定时'
            : kind === 'earliest'
              ? '没有任何约束给出通向锚点的下界（最早时间无界，−∞）'
              : '没有任何约束给出从锚点出发的上界（最晚时间无界，+∞）'
      }
      return (
        <span className={`cell-bound unbound${active ? ' trace-active' : ''}`} title={reason || undefined}>
          {text}
        </span>
      )
    }

    return (
      <button
        type="button"
        className={`cell-bound trace-link${active ? ' trace-active' : ''}`}
        onClick={() => onTrace(ev.id, kind)}
        title={`点击查看「${ev.name}」${kind === 'earliest' ? '最早' : '最晚'}时间的边界依据追溯（紧约束链）`}
      >
        {text}
      </button>
    )
  }

  return (
    <div className="panel" style={embedded ? { padding: 0, border: 'none', background: 'transparent' } : undefined}>
      {!embedded && (
        <h3>
          各事件相对锚点的时间窗
          <span className="count">最早 ≤ 实际时间 ≤ 最晚</span>
        </h3>
      )}
      {!anchorId && <div className="empty-hint">请在事件列表中点选单选按钮指定锚点事件。</div>}
      <div style={{ overflowX: 'auto' }}>
        <table className="windows">
          <thead>
            <tr>
              <th>事件</th>
              <th>状态</th>
              <th className="num">最早偏移</th>
              <th className="num">最早时间</th>
              <th className="num">最晚偏移</th>
              <th className="num">最晚时间</th>
              <th className="num">窗宽</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev, i) => {
              const w = windows.get(i)
              const meta = w ? STATUS_META[w.status] : STATUS_META.disconnected
              const inCycle = cycleEventIds.has(ev.id)
              const status = w?.status ?? 'disconnected'
              const width =
                w && w.earliestOffset !== null && w.latestOffset !== null
                  ? `${w.latestOffset - w.earliestOffset} 分钟`
                  : '—'
              const earliestOffsetCell = renderBoundaryCell(
                ev, 'earliest', w?.earliestOffset ?? null, status, 'offset',
              )
              const earliestAbsCell = renderBoundaryCell(
                ev, 'earliest', w?.earliestOffset ?? null, status, 'absolute',
              )
              const latestOffsetCell = renderBoundaryCell(
                ev, 'latest', w?.latestOffset ?? null, status, 'offset',
              )
              const latestAbsCell = renderBoundaryCell(
                ev, 'latest', w?.latestOffset ?? null, status, 'absolute',
              )
              return (
                <tr key={ev.id} className={inCycle ? 'cycle' : ''}>
                  <td>
                    {ev.name}
                    {ev.note && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>{ev.note}</div>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${meta.cls}`} title={meta.hint}>
                      {meta.label}
                    </span>
                  </td>
                  <td className="num">{earliestOffsetCell}</td>
                  <td className="num">{earliestAbsCell}</td>
                  <td className="num">{latestOffsetCell}</td>
                  <td className="num">{latestAbsCell}</td>
                  <td className="num">{width}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!embedded && traceEnabled && anchorId && (
        <div className="windows-hint">
          点击任意<strong>可定时</strong>单元格的最早 / 最晚时间，可查看从锚点推导该边界的<strong>紧约束链</strong>
          （锚点单元格为零步证明；「—」表示该侧无界或与锚点无通路，不可点击）。
        </div>
      )}
    </div>
  )
}
