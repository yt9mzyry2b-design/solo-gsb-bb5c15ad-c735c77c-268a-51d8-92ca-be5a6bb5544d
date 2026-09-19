import type { TEvent, WindowInfo } from '../types'
import { formatAbsolute, formatOffset } from '../lib/format'

interface Props {
  events: TEvent[]
  windows: Map<number, WindowInfo>
  cycleEventIds: Set<string>
  anchorId: string | null
  anchorTime: string
  /** 嵌入修复方案卡片时复用，不再渲染外层面板标题 */
  embedded?: boolean
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
}: Props) {
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
              const width =
                w && w.earliestOffset !== null && w.latestOffset !== null
                  ? `${w.latestOffset - w.earliestOffset} 分钟`
                  : '—'
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
                  <td className="num">{w ? formatOffset(w.earliestOffset) : '—'}</td>
                  <td className="num">
                    {w && w.status !== 'disconnected'
                      ? formatAbsolute(anchorTime, w.earliestOffset)
                      : '—'}
                  </td>
                  <td className="num">{w ? formatOffset(w.latestOffset) : '—'}</td>
                  <td className="num">
                    {w && w.status !== 'disconnected'
                      ? formatAbsolute(anchorTime, w.latestOffset)
                      : '—'}
                  </td>
                  <td className="num">{width}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
