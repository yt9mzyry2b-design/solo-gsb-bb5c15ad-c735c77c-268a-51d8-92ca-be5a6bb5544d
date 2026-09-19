import type { BoundaryTrace, Constraint, TEvent } from '../types'
import { describeConstraint } from '../lib/format'

interface Props {
  trace: BoundaryTrace
  events: TEvent[]
  constraints: Constraint[]
  onClose: () => void
}

const KIND_META = {
  earliest: {
    label: '最早',
    explain:
      '最早边界在反向图上求最短路得到。下表按推导顺序（锚点在前）列出被采用的紧约束：' +
      '每一步采用约束的下界侧（t前一事件 − t后一事件 ≤ 负的最小间隔），其在原图中的方向为「后一事件 → 前一事件」，' +
      '即沿「目标 → 锚点」方向逐步反推；累计偏移（取负后）即到该步为止目标最早可能相对锚点的偏移。',
    chainHint: '下界边在原图中的方向（指向锚点）；自上而下 = 推导顺序（锚点 → 目标）',
  },
  latest: {
    label: '最晚',
    explain:
      '最晚边界即正向差分图上从锚点到目标的最短路。下表按推导顺序（锚点在前）列出紧约束：' +
      '每一步采用约束的上界侧（t后一事件 − t前一事件 ≤ 最大间隔），沿「锚点 → 目标」方向逐步收紧；' +
      '累计偏移即到该步为止目标最晚可能相对锚点的偏移。',
    chainHint: '上界边方向（锚点 → 目标）；自上而下 = 推导顺序',
  },
} as const

function signed(w: number): string {
  return w > 0 ? `+${w}` : `${w}`
}

/** 累计偏移带符号展示（负值用排版上的减号） */
function fmtCumulative(v: number): string {
  if (v === 0) return '0'
  return v > 0 ? `+${v}` : `−${Math.abs(v)}`
}

/**
 * 边界依据追溯面板：按推导顺序列出从锚点到目标边界的紧约束链——
 * 每一步展示采用的原始约束、上/下界侧差分不等式与累计偏移，
 * 链上的边与约束同时在图和约束列表中高亮。
 */
export default function TracePanel({ trace, events, constraints, onClose }: Props) {
  const meta = KIND_META[trace.kind]
  const nameOf = (i: number) => events[i]?.name ?? `#${i}`
  const constraintById = new Map(constraints.map((c) => [c.id, c]))
  const target = nameOf(trace.targetIdx)
  const anchor = nameOf(trace.anchorIdx)
  const off = trace.offset
  const offText = off === 0 ? '与锚点同时' : off > 0 ? `晚于锚点 ${off} 分钟` : `早于锚点 ${-off} 分钟`

  return (
    <div className="panel trace-panel">
      <div className="trace-head">
        <h3>
          边界依据追溯 ·「{target}」的{meta.label}时间
          <span className="count">紧约束链（{trace.steps.length} 步）· 同步高亮于图与约束列表</span>
        </h3>
        <button className="small" onClick={onClose} title="清除追溯高亮">
          清除追溯 ✕
        </button>
      </div>

      <div className="trace-explain">{meta.explain}</div>

      {trace.steps.length === 0 ? (
        <div className="trace-zero">
          🎯「{target}」即锚点事件，其时间由用户指定的锚点绝对时间直接确定，
          <strong>零步证明</strong>，不依赖任何约束。
        </div>
      ) : (
        <>
          <div className="trace-chain-hint">↳ {meta.chainHint}</div>
          <ol className="trace-chain">
            {trace.steps.map((step, i) => {
              const c = constraintById.get(step.edge.constraintId)
              const boundLabel = step.edge.bound === 'upper' ? '上界' : '下界'
              // 不等式：t_v − t_u ≤ w
              const inequality = (
                <>
                  t(<span className="tn">{nameOf(step.to)}</span>) − t(
                  <span className="tn">{nameOf(step.from)}</span>) ≤{' '}
                  <span className="tw">{signed(step.weight)}</span>
                </>
              )
              return (
                <li key={`${step.edge.constraintId}:${step.edge.bound}:${i}`} className="trace-step">
                  <div className="trace-step-head">
                    <span className="trace-step-no">第 {i + 1} 步</span>
                    <span className="trace-badges">
                      <span className={`trace-bound ${step.edge.bound}`}>{boundLabel}侧</span>
                    </span>
                    <span className="trace-cum">
                      累计偏移 <strong>{fmtCumulative(step.cumulative)}</strong> 分钟
                    </span>
                  </div>
                  <div className="trace-inequality">{inequality}</div>
                  <div className="trace-from">
                    <span className="trace-node">{nameOf(step.from)}</span>
                    <span className="trace-arrow">── {signed(step.weight)} →</span>
                    <span className="trace-node">{nameOf(step.to)}</span>
                  </div>
                  {c && (
                    <div className="trace-constraint">
                      原始约束：{describeConstraint(c, (id) => {
                        const ev = events.find((e) => e.id === id)
                        return ev ? ev.name : '（已删除事件）'
                      })}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>

          <div className="trace-conclusion">
            {trace.kind === 'earliest' ? (
              <>
                由「{target}」沿上述下界边（原图方向）反推至
                <span className="trace-node">{anchor}</span>（锚点，偏移 0），
                链上权重之和取负即「{target}」的{meta.label}边界：
              </>
            ) : (
              <>
                <span className="trace-node">{anchor}</span>（锚点，偏移 0）沿上述上界链推导，
                得到「{target}」的{meta.label}边界：
              </>
            )}
            <strong>
              {' '}
              {fmtCumulative(off)} 分钟
            </strong>
            （{offText}）。链上每条边都在最短路中实际收紧了该边界，因而是
            <strong>紧约束链</strong>；任一环节放宽都会改变此边界。
          </div>
        </>
      )}
    </div>
  )
}
