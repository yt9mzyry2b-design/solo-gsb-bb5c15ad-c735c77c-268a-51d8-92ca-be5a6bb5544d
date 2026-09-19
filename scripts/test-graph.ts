import { analyze, buildEdges, constraintToEdges, traceBoundary } from '../src/lib/graph'
import { DEFAULT_STATE_LIMIT, findMinimalRepairs, MAX_PLANS } from '../src/lib/repair'
import { buildConsistentSample, buildContradictionSample } from '../src/lib/samples'
import type { Constraint, TEvent } from '../src/types'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error('FAIL:', msg)
  }
}

function approxEq(a: number | null, b: number | null) {
  if (a === null || b === null) return a === b
  return a === b
}

// ---- 单条约束的边转换 ----
{
  const c: Constraint = {
    id: 'c1', aId: 'A', bId: 'B', relation: 'earlier', min: 3, max: 8, enabled: true,
  }
  const idx = new Map([['A', 0], ['B', 1]])
  const es = constraintToEdges(c, (id) => idx.get(id)!)
  // earlier: A->B +8 (t_B - t_A <= 8), B->A -3 (t_A - t_B <= -3)
  assert(es.some((e) => e.u === 0 && e.v === 1 && e.w === 8), 'earlier 上界边 A->B +8')
  assert(es.some((e) => e.u === 1 && e.v === 0 && e.w === -3), 'earlier 下界边 B->A -3')

  const c2: Constraint = {
    id: 'c2', aId: 'A', bId: 'B', relation: 'later', min: 3, max: 8, enabled: true,
  }
  const es2 = constraintToEdges(c2, (id) => idx.get(id)!)
  assert(es2.some((e) => e.u === 1 && e.v === 0 && e.w === 8), 'later 上界边 B->A +8')
  assert(es2.some((e) => e.u === 0 && e.v === 1 && e.w === -3), 'later 下界边 A->B -3')
}

// ---- 禁用约束不产生边 ----
{
  const state = buildConsistentSample()
  const all = buildEdges(state.events, state.constraints).edges.length
  const disabled = state.constraints.map((c) => ({ ...c, enabled: false }))
  assert(buildEdges(state.events, disabled).edges.length === 0, '全部停用时边集为空')
  assert(all === state.constraints.length * 2, '每条约束产生 2 条边')
}

// ---- 可满足示例的窗口 ----
{
  const s = buildConsistentSample()
  const r = analyze(s.events, s.constraints, s.anchorId)
  assert(r.satisfiable, '可满足示例判定为可满足')
  assert(!r.cycle, '可满足示例无矛盾环')
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const w = (name: string) => r.windows.get(byName.get(name)!)!

  assert(approxEq(w('值班工程师介入').earliestOffset, 2), '介入最早 +2')
  assert(approxEq(w('值班工程师介入').latestOffset, 5), '介入最晚 +5')
  assert(approxEq(w('定位到故障节点').earliestOffset, 5), '定位最早 +5')
  assert(approxEq(w('定位到故障节点').latestOffset, 15), '定位最晚 +15')
  assert(approxEq(w('完成流量切换').earliestOffset, 6), '切换最早 +6')
  assert(approxEq(w('完成流量切换').latestOffset, 19), '切换最晚 +19（受恢复反推约束）')
  assert(approxEq(w('服务恢复').earliestOffset, 10), '恢复最早 +10（受"定位早于恢复5~15"收紧）')
  assert(approxEq(w('服务恢复').latestOffset, 20), '恢复最晚 +20（整体约束）')
  assert(approxEq(w('复盘会议').earliestOffset, 70), '复盘最早 +70')
  assert(approxEq(w('复盘会议').latestOffset, 200), '复盘最晚 +200')
  assert(w('媒体报道').status === 'disconnected', '媒体报道未连通 -> 无法定时')
  assert(w('值班告警触发').status === 'anchor', '告警为锚点')
}

// ---- 矛盾示例：负环提取 ----
{
  const s = buildContradictionSample()
  const r = analyze(s.events, s.constraints, s.anchorId)
  assert(!r.satisfiable, '矛盾示例判定为不可满足')
  assert(!!r.cycle, '提取出矛盾环')
  if (r.cycle) {
    assert(r.cycle.totalWeight === -25, '环权重之和 = -25')
    // 环必须覆盖 A、B、C（不含 D）
    const names = r.cycle.nodes.map((i) => s.events[i].name[0]).sort()
    assert(JSON.stringify(names) === JSON.stringify(['A', 'B', 'C']), '环为 A-B-C')
    // 校验 edges[i] 从 nodes[i] 指向 nodes[(i+1)%n]
    const n = r.cycle.nodes.length
    let aligned = true
    for (let i = 0; i < n; i++) {
      const e = r.cycle.edges[i]
      if (e.u !== r.cycle.nodes[i] || e.v !== r.cycle.nodes[(i + 1) % n]) aligned = false
    }
    assert(aligned, '环边与环节点严格对齐 edges[i]: nodes[i] -> nodes[i+1]')
    // 环上的每条边权重确实来自对应约束
    const sum = r.cycle.edges.reduce((a, e) => a + e.w, 0)
    assert(sum === r.cycle.totalWeight, '环权重求和一致')
  }
}

// ---- 精确间隔约束（min == max）：窗口退化为点 ----
{
  const s = buildConsistentSample()
  s.constraints = s.constraints.map((c) =>
    c.aId === s.events[1].id ? { ...c, min: 4, max: 4 } : c,
  )
  const r = analyze(s.events, s.constraints, s.anchorId)
  const w = r.windows.get(1)!
  assert(r.satisfiable, '改精确间隔后仍可满足')
  assert(w.earliestOffset === 4 && w.latestOffset === 4, '介入窗口退化为 +4 单点')
}

// ---- 空系统 / 无锚点 ----
{
  const r0 = analyze([], [], null)
  assert(r0.satisfiable, '空系统可满足')
  const s = buildConsistentSample()
  const r1 = analyze(s.events, s.constraints, null)
  assert(r1.satisfiable, '无锚点时系统仍判可满足')
  assert([...r1.windows.values()].every((w) => w.status === 'disconnected'), '无锚点时全部无法定时')
}

// ---- 经典矛盾：A 早于 B 10 分钟，又晚于 B 5 分钟（两点环） ----
{
  const ev = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ]
  const cs: Constraint[] = [
    { id: 'x', aId: 'a', bId: 'b', relation: 'earlier', min: 10, max: 20, enabled: true },
    { id: 'y', aId: 'a', bId: 'b', relation: 'later', min: 5, max: 8, enabled: true },
  ]
  const r = analyze(ev, cs, 'a')
  assert(!r.satisfiable, '双向时间冲突判为矛盾')
  // t_B - t_A <= 20 且 t_B - t_A <= -5（A later B min5 => B->A +8, A->B -5）
  // 负环 A->B -5, B->A +8? = +3 不为负；另一环 A->B +20, B->A -8 = +12。
  // 实际矛盾: A->B -5 与 B->A -8？A later B 5..8: B->A +8(上界), A->B -5(下界)
  // A earlier B 10..20: A->B +20, B->A -10
  // 环 A->B(-5) B->A(-10) = -15 <0 ✓
  assert(r.cycle !== undefined && r.cycle.totalWeight < 0, '两点负环权重为负')
}

// ---- 最小修复：矛盾示例最少停用 1 条，3 个并列方案 ----
{
  const s = buildContradictionSample()
  const r = findMinimalRepairs(s.events, s.constraints, s.anchorId)
  assert(r.found, '矛盾示例找到修复方案')
  assert(r.disableCount === 1, '矛盾示例最少停用 1 条')
  assert(r.optimumProven && !r.truncated, '最优性已证明且未截断')
  assert(r.totalPlans === 3, `3 个并列最优方案（实际 ${r.totalPlans}）`)
  assert(r.plans.length === 3, '展示全部 3 个方案（≤5）')

  // 每个方案停用 1 条环上约束（前 3 条构成负环；第 4 条是无关正常约束）
  const ringIds = s.constraints.slice(0, 3).map((c) => c.id)
  const unrelatedId = s.constraints[3].id
  for (const plan of r.plans) {
    assert(plan.disableConstraintIds.length === 1, '每个方案停用恰好 1 条')
    assert(ringIds.includes(plan.disableConstraintIds[0]), '停用的是矛盾环上的约束')
    assert(!plan.disableConstraintIds.includes(unrelatedId), '不会建议停用无关约束')
  }

  // 方案按约束录入顺序稳定排序
  const orders = r.plans.map((p) => s.constraints.findIndex((c) => c.id === p.disableConstraintIds[0]))
  assert(JSON.stringify(orders) === JSON.stringify([0, 1, 2]), '方案按录入顺序排序')

  // 每个方案修复后系统确实可满足，且时间窗可计算
  for (const plan of r.plans) {
    const off = new Set(plan.disableConstraintIds)
    const sim = s.constraints.map((c) => (off.has(c.id) ? { ...c, enabled: false } : c))
    const ar = analyze(s.events, sim, s.anchorId)
    assert(ar.satisfiable, '按方案停用后系统可满足')
    assert(plan.windows.get(0)?.status === 'anchor', '方案时间窗：锚点正确')
  }
}

// ---- 最小修复：两个互不相交的负环需各停 1 条（最少 2 条，9 个并列方案）----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
    { id: 'd', name: 'D' }, { id: 'e', name: 'E' }, { id: 'f', name: 'F' },
  ]
  const cs: Constraint[] = [
    // 环 1：A-B-C
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c2', aId: 'c', bId: 'b', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'a', bId: 'c', relation: 'later', min: 10, max: 30, enabled: true },
    // 环 2：D-E-F
    { id: 'c4', aId: 'e', bId: 'd', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c5', aId: 'f', bId: 'e', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c6', aId: 'd', bId: 'f', relation: 'later', min: 10, max: 30, enabled: true },
  ]
  assert(!analyze(events, cs, 'a').satisfiable, '双环系统存在矛盾')
  const r = findMinimalRepairs(events, cs, 'a')
  assert(r.found && r.disableCount === 2, '双环最少停用 2 条')
  assert(r.totalPlans === 9, `9 个并列方案（3×3，实际 ${r.totalPlans}）`)
  assert(r.plans.length === MAX_PLANS, '最多展示 5 个')
  assert(!r.truncated, '9 个状态的搜索远未达上限，不截断')

  // 每个方案必须两环各命中一条
  for (const plan of r.plans) {
    const idx = plan.disableConstraintIds.map((id) => cs.findIndex((c) => c.id === id))
    assert(idx.length === 2, '方案停用 2 条')
    assert(idx[0] < 3 && idx[1] >= 3, '两环各停用 1 条')
  }
  // 展示的是字典序最小的 5 个：[0,3],[0,4],[0,5],[1,3],[1,4]
  const firstFive = r.plans.map((p) =>
    p.disableConstraintIds.map((id) => cs.findIndex((c) => c.id === id)),
  )
  assert(
    JSON.stringify(firstFive) === JSON.stringify([[0, 3], [0, 4], [0, 5], [1, 3], [1, 4]]),
    '截断展示录入顺序最靠前的 5 个',
  )
}

// ---- 最小修复：两环共用一条约束时，停用该共用约束为唯一最优 ----
{
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
    { id: 'c', name: 'C' }, { id: 'd', name: 'D' },
  ]
  const cs: Constraint[] = [
    { id: 'g', aId: 'a', bId: 'b', relation: 'earlier', min: 30, max: 40, enabled: true }, // 共用边
    { id: 'x', aId: 'c', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'y', aId: 'b', bId: 'c', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'p', aId: 'd', bId: 'a', relation: 'later', min: 0, max: 10, enabled: true },
    { id: 'q', aId: 'b', bId: 'd', relation: 'later', min: 0, max: 10, enabled: true },
  ]
  assert(!analyze(events, cs, 'a').satisfiable, '双环（共用边）存在矛盾')
  const r = findMinimalRepairs(events, cs, 'a')
  assert(r.found && r.disableCount === 1, '共用约束使最少停用数为 1')
  assert(r.totalPlans === 1 && r.plans.length === 1, '唯一最优方案')
  assert(r.plans[0].disableConstraintIds[0] === 'g', '唯一方案即停用共用约束')
  // 停用共用约束后 A/B 仍有窗口：B 受 0..10 链路约束相对 A
  const wb = r.plans[0].windows.get(1)!
  assert(wb.status === 'bounded', '修复后 B 仍可定时')
}

// ---- 最小修复：状态数上限触发，明确标记可能不完备 ----
{
  const s = buildContradictionSample()
  // stateLimit = 1：只分析根状态（未分支）即达上限，找不到方案
  const r0 = findMinimalRepairs(s.events, s.constraints, s.anchorId, { stateLimit: 1 })
  assert(!r0.found, '上限 1（仅根状态）时未找到方案')
  assert(r0.truncated && !r0.optimumProven, '标记截断且最优性未证明')
  assert(r0.stateLimit === 1 && r0.statesVisited === 1, '回传上限与已访问状态数')

  // stateLimit = 3：根 + 2 个一层状态；三个环约束各停 1 条都可行，
  // 第 3 个并列方案未探索到 -> 找到最优但列表可能不完备
  const r1 = findMinimalRepairs(s.events, s.constraints, s.anchorId, { stateLimit: 3 })
  assert(r1.found && r1.disableCount === 1, '上限 3 时在第 1 层找到最优')
  assert(r1.truncated, '同层未探索完：标记截断（结果可能不完备）')
  assert(r1.plans.length === 2, '只展示已探索到的 2 个并列方案')

  // 双环系统：根 1 + 一层 3 个状态均不可行；上限 4 时第 2 层一个都未分析 -> 未找到且截断
  const events: TEvent[] = [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
    { id: 'd', name: 'D' }, { id: 'e', name: 'E' }, { id: 'f', name: 'F' },
  ]
  const cs: Constraint[] = [
    { id: 'c1', aId: 'b', bId: 'a', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c2', aId: 'c', bId: 'b', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c3', aId: 'a', bId: 'c', relation: 'later', min: 10, max: 30, enabled: true },
    { id: 'c4', aId: 'e', bId: 'd', relation: 'later', min: 10, max: 20, enabled: true },
    { id: 'c5', aId: 'f', bId: 'e', relation: 'later', min: 5, max: 10, enabled: true },
    { id: 'c6', aId: 'd', bId: 'f', relation: 'later', min: 10, max: 30, enabled: true },
  ]
  const r2 = findMinimalRepairs(events, cs, 'a', { stateLimit: 4 })
  assert(!r2.found && r2.truncated && !r2.optimumProven, '双环在上限 4 时截断且未找到方案')

  // 上限 5：根 + 3 个一层 + 1 个二层可行状态 -> 找到 1 个最优但截断
  const r3 = findMinimalRepairs(events, cs, 'a', { stateLimit: 5 })
  assert(r3.found && r3.disableCount === 2 && r3.truncated, '上限 5 时找到二层最优但截断')
  assert(r3.totalPlans === 1 && r3.optimumProven, '最少停用数 2 仍被证明，并列方案不全')
}

// ---- 最小修复：常量默认值 ----
{
  assert(DEFAULT_STATE_LIMIT === 2000, '默认搜索上限为 2000 个状态')
  assert(MAX_PLANS === 5, '并列方案最多展示 5 个')
}

// ---- 最小修复：可满足系统无需修复 ----
{
  const s = buildConsistentSample()
  const r = findMinimalRepairs(s.events, s.constraints, s.anchorId)
  assert(r.found && r.plans.length === 0 && r.disableCount === 0, '可满足系统返回空方案、停用数 0')
  assert(!r.truncated && r.optimumProven, '可满足系统不截断')
}

// ---- 最小修复：已停用 / 引用缺失事件的约束不进入候选 ----
{
  const s = buildContradictionSample()
  const disabled = s.constraints.map((c, i) =>
    i === 0 ? { ...c, enabled: false } : c,
  )
  // 停用环上第一条后系统本应恢复，这里再验证修复搜索候选不含已停用约束
  const stillConflict = analyze(s.events, disabled, s.anchorId)
  // c1 是 A<-B 约束；停用它后环被打断
  assert(stillConflict.satisfiable, '手动停用环上一条后矛盾消除（与修复建议等价）')
  const r = findMinimalRepairs(s.events, disabled, s.anchorId)
  assert(r.found && r.disableCount === 0 && r.plans.length === 0, '已无可修复矛盾')
}

// ---- 边界依据追溯：通用结构校验 ----
{
  const s = buildConsistentSample()
  const r = analyze(s.events, s.constraints, s.anchorId)
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const idOf = (name: string) => s.events[byName.get(name)!].id
  const constraintIds = s.constraints.map((c) => c.id)

  // 链必须满足：从锚点起步、到达目标、相邻端点衔接、累计偏移=边权前缀和、
  // 最终偏移与时间窗数值一致。
  function checkChain(targetName: string, kind: 'earliest' | 'latest') {
    const t = traceBoundary(s.events, s.constraints, s.anchorId, idOf(targetName), kind)
    assert(!!t, `${kind} 追溯：${targetName} 可得到紧约束链`)
    if (!t) return
    const targetIdx = byName.get(targetName)!
    assert(t.anchorIdx === 0, '追溯起点为锚点下标 0')
    assert(t.targetIdx === targetIdx, '追溯终点为目标事件')
    const win = r.windows.get(targetIdx)!
    const expected = kind === 'earliest' ? win.earliestOffset : win.latestOffset
    assert(t.offset === expected, `${kind} 追溯最终偏移 ${t.offset} 与时间窗 ${expected} 一致`)

    // 每步边端点与 from/to 一致
    for (const st of t.steps) {
      assert(st.edge.u === st.from && st.edge.v === st.to, '追溯步端点与差分边一致')
      assert(constraintIds.includes(st.edge.constraintId), '追溯边来自有效约束')
    }
    // 衔接：首步触及锚点、末步触及目标；
    // 最晚链沿原图方向（锚点 → 目标），最早链边方向为目标 → 锚点（推导顺序仍锚点在前）。
    if (t.steps.length > 0) {
      if (kind === 'latest') {
        assert(t.steps[0].from === t.anchorIdx, '最晚链从锚点出发')
        assert(t.steps[t.steps.length - 1].to === t.targetIdx, '最晚链到达目标')
      } else {
        assert(t.steps[0].to === t.anchorIdx, '最早链首步（反向图路径首边）触及锚点')
        assert(t.steps[t.steps.length - 1].from === t.targetIdx, '最早链末步起于目标')
      }
      for (let i = 1; i < t.steps.length; i++) {
        const prev = t.steps[i - 1]
        const cur2 = t.steps[i]
        const connected =
          kind === 'latest'
            ? prev.to === cur2.from
            : // 最早链按推导顺序排列、边方向朝锚点：第 i-1 步的起点 = 第 i 步的终点
              prev.from === cur2.to
        assert(connected, '追溯链相邻步骤首尾相接')
      }
      // 累计偏移 = 边权前缀和（最晚链）；最早链沿原图反向，前缀和为累计偏移取负
      let acc = 0
      for (let i = 0; i < t.steps.length; i++) {
        acc += t.steps[i].weight
        if (kind === 'latest') {
          assert(t.steps[i].cumulative === acc, '最晚链累计偏移=边权前缀和')
        } else {
          assert(t.steps[i].cumulative === -acc, '最早链累计偏移=边权前缀和取负')
        }
      }
      const sum = t.steps.reduce((a, st) => a + st.weight, 0)
      assert(t.offset === (kind === 'latest' ? sum : -sum), '追溯偏移等于链上权重之和')
    }
  }

  for (const name of [
    '值班工程师介入',
    '定位到故障节点',
    '完成流量切换',
    '服务恢复',
    '复盘会议',
  ]) {
    checkChain(name, 'latest')
    checkChain(name, 'earliest')
  }

  // 最晚链的每一步都是“上界含义”的松弛：链上距离等于边权前缀和（已在上面验证）；
  // 具体验证「完成流量切换」最晚 +19 是经“服务恢复”反推的紧约束：
  const failLatest = traceBoundary(
    s.events, s.constraints, s.anchorId, idOf('完成流量切换'), 'latest',
  )!
  assert(failLatest.offset === 19, '切换最晚追溯偏移 +19')
  const failNames = failLatest.steps.map((st) => `${s.events[st.from].name}->${s.events[st.to].name}:${st.edge.bound}`)
  // 路径必经过“服务恢复”（+20 整体上界 + 恢复早于切换的下界 -1）
  assert(
    failLatest.steps.some((st) => s.events[st.to].name === '服务恢复' || s.events[st.from].name === '服务恢复'),
    `切换最晚链经过服务恢复（实际 ${failNames.join(' | ')}）`,
  )
  // 最后一步必须是恢复->切换的下界边（lower, -1）
  const lastStep = failLatest.steps[failLatest.steps.length - 1]
  assert(
    s.events[lastStep.from].name === '服务恢复' &&
      s.events[lastStep.to].name === '完成流量切换' &&
      lastStep.edge.bound === 'lower' &&
      lastStep.weight === -1,
    '切换最晚链末步为 恢复->切换 的下界边 -1（最早边界反向路径同理）',
  )

  // 最早边界必须正确还原反向图路径：「定位到故障节点」最早 +5 =
  // 锚点->介入 下界边(介入->锚点 -2) + 介入->定位 下界边(定位->介入 -3)，
  // 链在原图中的方向是“目标 → 锚点”，推导顺序按锚点在前排列。
  const faultEarliest = traceBoundary(
    s.events, s.constraints, s.anchorId, idOf('定位到故障节点'), 'earliest',
  )!
  assert(faultEarliest.offset === 5, '定位最早追溯偏移 +5')
  assert(faultEarliest.steps.length === 2, '定位最早链 2 步')
  const fe0 = faultEarliest.steps[0]
  const fe1 = faultEarliest.steps[1]
  assert(
    s.events[fe0.from].name === '值班工程师介入' &&
      s.events[fe0.to].name === '值班告警触发' &&
      fe0.weight === -2 &&
      fe0.edge.bound === 'lower' &&
      fe0.cumulative === 2,
    '最早链第 1 步还原原图下界边：介入→锚点 -2，累计 +2',
  )
  assert(
    s.events[fe1.from].name === '定位到故障节点' &&
      s.events[fe1.to].name === '值班工程师介入' &&
      fe1.weight === -3 &&
      fe1.edge.bound === 'lower' &&
      fe1.cumulative === 5,
    '最早链第 2 步还原原图下界边：定位→介入 -3，累计 +5',
  )

  // 最早链的图方向整体指向锚点（每一步 to 比 from 更靠近锚点）
  for (const st of faultEarliest.steps) {
    assert(st.edge.u === st.from && st.edge.v === st.to, '最早链边为原图原始方向')
  }
}

// ---- 边界依据追溯：锚点零步证明 ----
{
  const s = buildConsistentSample()
  const anchorName = '值班告警触发'
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const anchorId = s.events[byName.get(anchorName)!].id
  for (const kind of ['earliest', 'latest'] as const) {
    const t = traceBoundary(s.events, s.constraints, anchorId, anchorId, kind)!
    assert(t.offset === 0 && t.steps.length === 0, '锚点事件为零步证明（0 偏移、0 步）')
    assert(t.anchorIdx === t.targetIdx, '零步证明锚点即目标')
  }
}

// ---- 边界依据追溯：无法定时 / 无锚点 / 不存在事件返回 null ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const pressId = s.events[byName.get('媒体报道')!].id
  assert(
    traceBoundary(s.events, s.constraints, s.anchorId, pressId, 'earliest') === null &&
      traceBoundary(s.events, s.constraints, s.anchorId, pressId, 'latest') === null,
    '与锚点无通路的事件追溯为 null（不可点击）',
  )
  assert(
    traceBoundary(s.events, s.constraints, null, s.events[0].id, 'latest') === null,
    '未设锚点时追溯为 null',
  )
  assert(
    traceBoundary(s.events, s.constraints, s.anchorId, 'no-such-event', 'latest') === null,
    '不存在的事件追溯为 null',
  )
}

// ---- 边界依据追溯：精确间隔约束下最早=最晚同值（点窗口），两侧链均可还原 ----
{
  const s = buildConsistentSample()
  s.constraints = s.constraints.map((c) =>
    c.aId === s.events[1].id ? { ...c, min: 4, max: 4 } : c,
  )
  const t = traceBoundary(s.events, s.constraints, s.anchorId, s.events[1].id, 'latest')!
  const te = traceBoundary(s.events, s.constraints, s.anchorId, s.events[1].id, 'earliest')!
  assert(t.offset === 4 && te.offset === 4, '精确间隔：两侧追溯偏移均为 +4')
  assert(t.steps[0].edge.bound === 'upper' && t.steps[0].weight === 4, '最晚链采用上界边 +4')
  assert(te.steps[0].edge.bound === 'lower' && te.steps[0].weight === -4, '最早链还原下界边 -4')
}

// ---- 边界依据追溯：停用的约束不参与链；修复预览口径（有效约束）重算 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  // 「服务恢复比告警晚 8~20」是恢复最晚 +20 的依据；停用它后恢复最晚应变松（走链路 +25）
  const overall = s.constraints.find(
    (c) => c.aId === s.events[byName.get('服务恢复')!].id &&
      c.bId === s.events[byName.get('值班告警触发')!].id,
  )!
  const before = traceBoundary(
    s.events, s.constraints, s.anchorId,
    s.events[byName.get('服务恢复')!].id, 'latest',
  )!
  assert(before.offset === 20 && before.steps.some((st) => st.edge.constraintId === overall.id),
    '停用前恢复最晚链采用整体约束 +20')

  const sim = s.constraints.map((c) => (c.id === overall.id ? { ...c, enabled: false } : c))
  const after = traceBoundary(
    s.events, sim, s.anchorId,
    s.events[byName.get('服务恢复')!].id, 'latest',
  )!
  assert(after.offset === 25, `停用整体约束后恢复最晚变松为 +25（实际 ${after.offset}）`)
  assert(!after.steps.some((st) => st.edge.constraintId === overall.id), '追溯链不含已停用约束')
  // 链上每条边都能在有效边集中找到
  const { edges: activeEdges } = buildEdges(s.events, sim)
  const activeKeys = new Set(activeEdges.map((e) => `${e.constraintId}:${e.bound}`))
  for (const st of after.steps) {
    assert(activeKeys.has(`${st.edge.constraintId}:${st.edge.bound}`), '追溯边全部来自当前有效约束')
  }
}

// ---- 边界依据追溯：切换锚点后链从新锚点出发 ----
{
  const s = buildConsistentSample()
  const byName = new Map(s.events.map((e, i) => [e.name, i]))
  const recoveredId = s.events[byName.get('服务恢复')!].id
  const alertId = s.events[byName.get('值班告警触发')!].id
  const t = traceBoundary(s.events, s.constraints, recoveredId, alertId, 'latest')!
  // 恢复为锚点时告警相对恢复的最晚偏移：
  // 直接整体约束给出 t_alert - t_rec ≤ -8；经“恢复→定位(-5)→介入(-3)→告警(-2)”
  // 的下界链更紧，结果为 -10（即告警必须至少早于恢复 10 分钟）。
  assert(t.anchorIdx === byName.get('服务恢复')!, '新锚点为服务恢复')
  assert(t.offset === -10, `以恢复为锚点，告警最晚偏移 -10（实际 ${t.offset}）`)
  assert(t.steps[0].from === t.anchorIdx, '链从新锚点出发')
  assert(
    t.steps[t.steps.length - 1].to === byName.get('值班告警触发'),
    '链到达新目标（告警）',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
