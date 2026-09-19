/**
 * 应用领域类型
 */

/** 事件（时间轴上的一个待定位的点） */
export interface TEvent {
  id: string
  name: string
  note?: string
}

/** 关系方向：A 早于 B，或 A 晚于 B */
export type Relation = 'earlier' | 'later'

/**
 * 一条“事件 A 比事件 B {早|晚} min..max 分钟”的约束。
 * min <= max，单位为分钟（整数）。
 */
export interface Constraint {
  id: string
  aId: string
  bId: string
  relation: Relation
  min: number
  max: number
  enabled: boolean
}

/** 应用持久化状态 */
export interface AppState {
  events: TEvent[]
  constraints: Constraint[]
  /** 锚点事件 id */
  anchorId: string | null
  /** 锚点绝对时间（本地时间，ISO 格式 yyyy-MM-ddTHH:mm） */
  anchorTime: string
}

/** 差分图中的一条有向边 u -> v，权重 w（分钟），表示 t_v - t_u <= w */
export interface DiffEdge {
  u: number
  v: number
  w: number
  /** 产生该边的约束 id */
  constraintId: string
  /** 该边是约束的上界侧还是下界侧 */
  bound: 'upper' | 'lower'
}

export interface AnalysisResult {
  /** 是否存在矛盾（负环） */
  satisfiable: boolean
  /** 命中的一条矛盾环（按沿环行走的顺序） */
  cycle?: CycleInfo
  /** 每个事件的时间窗（仅可满足时计算） */
  windows: Map<number, WindowInfo>
}

export interface CycleInfo {
  /** 环上的节点，按环顺序，首尾不重复 */
  nodes: number[]
  /** 环上的边，edges[i] 从 nodes[i] 指向 nodes[(i+1) % n] */
  edges: DiffEdge[]
  /** 环上权重之和（严格小于 0） */
  totalWeight: number
}

export type WindowStatus = 'anchor' | 'bounded' | 'oneSided' | 'disconnected'

export interface WindowInfo {
  status: WindowStatus
  /** 相对锚点最早偏移（分钟）；单边/不可达时可能为 null（-∞） */
  earliestOffset: number | null
  /** 相对锚点最晚偏移（分钟）；单边/不可达时可能为 null（+∞） */
  latestOffset: number | null
}

/**
 * 最小修复方案：停用 disableConstraintIds 中的约束后，差分系统恢复可满足。
 */
export interface RepairPlan {
  /** 建议停用的约束 id（按约束录入顺序升序排列） */
  disableConstraintIds: string[]
  /** 停用上述约束后，每个事件相对锚点的时间窗 */
  windows: Map<number, WindowInfo>
}

/** 最小修复搜索结果 */
export interface RepairSearchResult {
  /** 是否找到至少一个可满足修复方案 */
  found: boolean
  /** 并列最优方案，最多 5 个，按需停用约束的录入顺序稳定排序 */
  plans: RepairPlan[]
  /** 已找到的并列最优方案总数（可能大于 plans.length；截断时为下界） */
  totalPlans: number
  /** 每个方案需停用的约束数量（found 为 true 时即已证明的最小停用数） */
  disableCount: number
  /** 是否因达到累计状态数上限而提前停止（结果可能不完备） */
  truncated: boolean
  /** 最小停用数是否已被证明（found 为 true 时恒为 true） */
  optimumProven: boolean
  /** 累计访问的搜索状态数 */
  statesVisited: number
  /** 状态数上限（默认 2000） */
  stateLimit: number
}
