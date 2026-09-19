import type {
  AnalysisResult,
  BoundaryKind,
  BoundaryTrace,
  Constraint,
  DiffEdge,
  TEvent,
  TraceStep,
  WindowInfo,
} from '../types'

/**
 * 把一条“事件 A 比事件 B 早/晚 min..max 分钟”的约束转换为两条差分不等式。
 *
 * 约定有向边 u -> v，权重 w 表示  t_v - t_u <= w
 *
 * earlier:  min <= t_B - t_A <= max
 *   上界  t_B - t_A <= max   =>  A -> B, max
 *   下界  t_B - t_A >= min   =>  t_A - t_B <= -min  =>  B -> A, -min
 *
 * later:    min <= t_A - t_B <= max
 *   上界  t_A - t_B <= max   =>  B -> A, max
 *   下界  t_A - t_B >= min   =>  t_B - t_A <= -min  =>  A -> B, -min
 */
export function constraintToEdges(c: Constraint, index: (id: string) => number): DiffEdge[] {
  const a = index(c.aId)
  const b = index(c.bId)
  if (c.relation === 'earlier') {
    return [
      { u: a, v: b, w: c.max, constraintId: c.id, bound: 'upper' },
      { u: b, v: a, w: -c.min, constraintId: c.id, bound: 'lower' },
    ]
  }
  return [
    { u: b, v: a, w: c.max, constraintId: c.id, bound: 'upper' },
    { u: a, v: b, w: -c.min, constraintId: c.id, bound: 'lower' },
  ]
}

export function buildEdges(
  events: TEvent[],
  constraints: Constraint[],
): { edges: DiffEdge[]; indexOf: Map<string, number> } {
  const indexOf = new Map<string, number>()
  events.forEach((e, i) => indexOf.set(e.id, i))
  const idx = (id: string) => indexOf.get(id)!
  const edges: DiffEdge[] = []
  for (const c of constraints) {
    if (!c.enabled) continue
    // 跳过引用了已删除事件的约束
    if (!indexOf.has(c.aId) || !indexOf.has(c.bId)) continue
    edges.push(...constraintToEdges(c, idx))
  }
  return { edges, indexOf }
}

/**
 * Bellman-Ford：从单一源点出发求最长短路界 dist[v] = t_v - t_s 的最小上界。
 * 不直接使用——下面用带“超级源点”的统一写法做负环检测，
 * 并用“把指定源点置 0、其余置 +∞”的写法求可达距离。
 */

const INF = Number.POSITIVE_INFINITY

interface BFResult {
  dist: number[]
  predEdge: (DiffEdge | null)[]
  /** 第 n 轮仍被松弛的一条边（存在即说明有负环） */
  lastRelaxed: DiffEdge | null
}

/**
 * 通用 Bellman-Ford 松弛。
 * @param n      节点数
 * @param edges  边集
 * @param init   初始距离（长度为 n 的数组）
 */
function bellmanFord(n: number, edges: DiffEdge[], init: number[]): BFResult {
  const dist = init.slice()
  const predEdge: (DiffEdge | null)[] = new Array(n).fill(null)
  let lastRelaxed: DiffEdge | null = null

  for (let round = 0; round < n; round++) {
    lastRelaxed = null
    let changed = false
    for (const e of edges) {
      const nd = dist[e.u] + e.w
      if (nd < dist[e.v]) {
        dist[e.v] = nd
        predEdge[e.v] = e
        changed = true
        lastRelaxed = e
      }
    }
    if (!changed) break
  }
  return { dist, predEdge, lastRelaxed }
}

/**
 * 从最后被松弛的边出发，沿前驱指针回溯，抽取一条负环。
 * 返回的 edges[i] 从 nodes[i] 指向 nodes[(i+1) % len]。
 */
function extractCycle(lastEdge: DiffEdge, predEdge: (DiffEdge | null)[]): {
  nodes: number[]
  edges: DiffEdge[]
} | null {
  const n = predEdge.length
  // 回溯到环上：最后松弛边的终点一定可达某个负环；先走 n 步入环
  let cur = lastEdge.v
  for (let i = 0; i < n; i++) {
    const pe = predEdge[cur]
    if (!pe) return null
    cur = pe.u
  }

  const cycleNodes: number[] = []
  const cycleEdges: DiffEdge[] = []
  const seenAt = new Map<number, number>()
  let start = cur
  // 从环上某点沿前驱方向收集（方向是反向环绕），直到再次遇到该点
  let guard = 0
  while (!seenAt.has(cur) && guard <= n) {
    seenAt.set(cur, cycleNodes.length)
    cycleNodes.push(cur)
    const pe = predEdge[cur]
    if (!pe) return null
    cycleEdges.push(pe)
    cur = pe.u
    guard++
  }
  if (cur !== start) {
    // 回溯路径中先经过了一段“环外尾巴”，裁掉尾巴
    const cut = seenAt.get(cur)!
    cycleNodes.splice(0, cut)
    cycleEdges.splice(0, cut)
  }
  // 当前 cycleEdges[i] 进入 cycleNodes[i]（来自 cycleNodes[i+1]，反向环绕）。
  // 反转节点与边的顺序，再把边数组循环左移一位，
  // 使最终 edges[i] 从 nodes[i] 指向 nodes[(i+1) % len]。
  cycleNodes.reverse()
  cycleEdges.reverse()
  if (cycleEdges.length > 1) {
    cycleEdges.push(cycleEdges.shift()!)
  }
  return { nodes: cycleNodes, edges: cycleEdges }
}

/** 从单个源点求最短路距离；不可达为 +∞。同时返回前驱边用于依据追溯 */
function shortestFromWithPred(source: number, n: number, edges: DiffEdge[]): {
  dist: number[]
  pred: (DiffEdge | null)[]
} {
  const init = new Array(n).fill(INF)
  init[source] = 0
  const { dist, predEdge } = bellmanFord(n, edges, init)
  return { dist, pred: predEdge }
}

/** 从单个源点求最短路距离；不可达为 +∞ */
function shortestFrom(source: number, n: number, edges: DiffEdge[]): number[] {
  return shortestFromWithPred(source, n, edges).dist
}

/**
 * 超级源点 Bellman-Ford 检测负环：等价于加入一个指向所有节点、权重 0 的超级源点，
 * 即所有节点初始距离为 0（差分约束经典做法）。找到时抽取一条负环。
 */
export function findNegativeCycle(
  n: number,
  edges: DiffEdge[],
): { nodes: number[]; edges: DiffEdge[]; totalWeight: number } | null {
  if (n === 0) return null
  const { predEdge, lastRelaxed } = bellmanFord(n, edges, new Array(n).fill(0))
  if (!lastRelaxed) return null
  const cyc = extractCycle(lastRelaxed, predEdge)
  if (!cyc) return null
  return { nodes: cyc.nodes, edges: cyc.edges, totalWeight: cyc.edges.reduce((s, e) => s + e.w, 0) }
}

/**
 * 对当前全部启用的约束做完整分析：
 * 1) 超级源点 Bellman-Ford 检测差分系统是否可满足（有无负环）；
 * 2) 有负环时抽取一条矛盾环；
 * 3) 可满足时，以锚点为源求各事件相对锚点的最早/最晚时间窗。
 */
export function analyze(
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
): AnalysisResult {
  const n = events.length
  const { edges } = buildEdges(events, constraints)
  const windows = new Map<number, WindowInfo>()

  if (n === 0) {
    return { satisfiable: true, windows }
  }

  const cyc = findNegativeCycle(n, edges)
  if (cyc) {
    return {
      satisfiable: false,
      cycle: cyc,
      windows,
    }
  }

  // —— 可满足：计算时间窗
  const anchorIdx = anchorId != null ? events.findIndex((e) => e.id === anchorId) : -1
  if (anchorIdx < 0) {
    // 未指定锚点：系统一致但无法给出绝对时间窗
    for (let i = 0; i < n; i++) {
      windows.set(i, { status: 'disconnected', earliestOffset: null, latestOffset: null })
    }
    return { satisfiable: true, windows }
  }

  // 最晚偏移：t_i - t_anchor 的最小上界（正向最短路）
  const upper = shortestFrom(anchorIdx, n, edges)
  // 最早偏移：t_anchor - t_i 的最小上界取负（反向图最短路）
  const reversed = edges.map((e) => ({ ...e, u: e.v, v: e.u }))
  const back = shortestFrom(anchorIdx, n, reversed)

  for (let i = 0; i < n; i++) {
    if (i === anchorIdx) {
      windows.set(i, { status: 'anchor', earliestOffset: 0, latestOffset: 0 })
      continue
    }
    const hasUpper = Number.isFinite(upper[i])
    const hasLower = Number.isFinite(back[i])
    const earliest = hasLower ? -back[i] : null
    const latest = hasUpper ? upper[i] : null

    let status: WindowInfo['status']
    if (hasLower && hasUpper) status = 'bounded'
    else if (hasLower || hasUpper) status = 'oneSided'
    else status = 'disconnected'

    windows.set(i, { status, earliestOffset: earliest, latestOffset: latest })
  }

  return { satisfiable: true, cycle: undefined, windows }
}

/**
 * 沿前驱指针回溯构造按“源点 → 目标”推导顺序排列的紧约束链。
 * cumulative 取最短路距离（每一步对应的松弛后上界）。
 */
function predChainToSteps(
  pred: (DiffEdge | null)[],
  target: number,
  dist: number[],
): TraceStep[] | null {
  const collected: TraceStep[] = []
  const seen = new Set<number>()
  let cur = target
  while (pred[cur]) {
    // 无负环时前驱链必为简单路径；遇节点重复说明数据异常，交由调用方按不可达处理
    if (seen.has(cur)) return null
    seen.add(cur)
    const e = pred[cur]!
    collected.push({ edge: e, from: e.u, to: e.v, weight: e.w, cumulative: dist[cur] })
    cur = e.u
  }
  collected.reverse()
  return collected
}

/**
 * 边界依据追溯：在当前生效约束构成的差分图中，返回从锚点推导目标事件
 * 指定边界（最早 / 最晚）的紧约束链——即 Bellman-Ford 最短路上实际发生
 * 松弛的边序列，每一步都在收紧该边界。
 *
 * - 最晚边界：正向图最短路，链按“锚点 → 目标”的上界松弛顺序排列；
 * - 最早边界：在反向图上跑最短路后，把每条反向边映射回它在原始图中的
 *   差分边，将反向图路径（锚点 → 目标）还原为原图中“目标 → 锚点”方向
 *   的下界推导链（推导顺序仍为锚点 → 目标，累计偏移取负）。
 *
 * 前置条件：系统可满足（无负环）。该侧与锚点无通路时返回 null。
 */
export function traceBoundary(
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
  targetId: string,
  kind: BoundaryKind,
): BoundaryTrace | null {
  const n = events.length
  const { edges, indexOf } = buildEdges(events, constraints)
  const anchorIdx = anchorId != null ? indexOf.get(anchorId) : undefined
  const targetIdx = indexOf.get(targetId)
  if (anchorIdx === undefined || targetIdx === undefined) return null

  // 锚点自身：零步证明
  if (targetIdx === anchorIdx) {
    return { kind, anchorIdx, targetIdx, offset: 0, steps: [] }
  }

  if (kind === 'latest') {
    // 最晚偏移：t_target - t_anchor 的最小上界（正向最短路）
    const { dist, pred } = shortestFromWithPred(anchorIdx, n, edges)
    if (!Number.isFinite(dist[targetIdx])) return null
    const steps = predChainToSteps(pred, targetIdx, dist)
    if (!steps || steps.length === 0 || steps[0].from !== anchorIdx) return null
    return { kind, anchorIdx, targetIdx, offset: dist[targetIdx], steps }
  }

  // 最早偏移：t_anchor - t_target 的最小上界取负（反向图最短路）。
  // 反向边只交换端点，保留 constraintId / bound 以便映射回原始边。
  const originalByKey = new Map<string, DiffEdge>()
  for (const e of edges) originalByKey.set(`${e.constraintId}:${e.bound}`, e)
  const reversed = edges.map((e) => ({ ...e, u: e.v, v: e.u }))
  const { dist, pred } = shortestFromWithPred(anchorIdx, n, reversed)
  if (!Number.isFinite(dist[targetIdx])) return null

  // 沿前驱指针在反向图中回溯（目标 → 锚点），再反转为推导顺序（锚点 → 目标）
  const backCollected: { rev: DiffEdge; node: number }[] = []
  const seen = new Set<number>()
  let cur = targetIdx
  while (pred[cur]) {
    if (seen.has(cur)) return null
    seen.add(cur)
    const rev = pred[cur]!
    backCollected.push({ rev, node: cur })
    cur = rev.u
  }
  backCollected.reverse()
  if (backCollected.length === 0 || backCollected[0].rev.u !== anchorIdx) return null

  const steps: TraceStep[] = backCollected.map(({ rev, node }) => {
    const orig = originalByKey.get(`${rev.constraintId}:${rev.bound}`) ?? rev
    // 反向图中该步由 orig.v(=rev.u) 走向 orig.u(=rev.v=node)；
    // 还原到原图方向即 orig.u → orig.v（指向锚点一侧的下界边）。
    return {
      edge: orig,
      from: orig.u,
      to: orig.v,
      weight: orig.w,
      cumulative: -dist[node],
    }
  })

  return { kind, anchorIdx, targetIdx, offset: -dist[targetIdx], steps }
}
