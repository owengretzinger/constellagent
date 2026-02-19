interface ParsedCron {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
  dayOfMonthWildcard: boolean
  dayOfWeekWildcard: boolean
}

interface CronField {
  values: Set<number>
}

const SUNDAY = 0
const SUNDAY_ALT = 7
const SCAN_LIMIT_MINUTES = 525_600

export interface CatchUpDecisionInput {
  cronExpression: string
  lastCheckedAt: number
  nowMs: number
  nextRunAt: number | null
}

export function shouldCatchUpOnWake(input: CatchUpDecisionInput): boolean {
  const { cronExpression, lastCheckedAt, nowMs, nextRunAt } = input
  if (!Number.isFinite(lastCheckedAt) || !Number.isFinite(nowMs) || nowMs <= lastCheckedAt) return false
  if (nextRunAt !== null && Number.isFinite(nextRunAt)) {
    return nowMs >= nextRunAt
  }
  return didCronFireBetween(cronExpression, lastCheckedAt, nowMs)
}

export function didCronFireBetween(cronExpression: string, fromMs: number, toMs: number): boolean {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return false
  const parsed = parseCron(cronExpression)
  if (!parsed) return false

  const start = new Date(fromMs)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  const end = new Date(toMs)
  end.setSeconds(0, 0)
  if (start.getTime() > end.getTime()) return false

  let cursor = start
  let steps = 0
  while (cursor.getTime() <= end.getTime()) {
    if (matchesCron(parsed, cursor)) return true
    cursor = new Date(cursor.getTime() + 60_000)
    steps += 1
    if (steps > SCAN_LIMIT_MINUTES) {
      return true
    }
  }

  return false
}

function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const minute = parseField(parts[0], 0, 59)
  const hour = parseField(parts[1], 0, 23)
  const dayOfMonth = parseField(parts[2], 1, 31)
  const month = parseField(parts[3], 1, 12)
  const dayOfWeek = parseField(parts[4], 0, 7, true)
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthWildcard: parts[2] === '*',
    dayOfWeekWildcard: parts[4] === '*',
  }
}

function parseField(raw: string, min: number, max: number, normalizeDow = false): CronField | null {
  const values = new Set<number>()
  const segments = raw.split(',')
  if (segments.length === 0) return null

  for (const segRaw of segments) {
    const seg = segRaw.trim()
    if (!seg) return null

    const [base, stepRaw] = seg.split('/')
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step <= 0) return null

    if (base === '*') {
      for (let n = min; n <= max; n += step) {
        values.add(normalizeDowValue(n, normalizeDow))
      }
      continue
    }

    const range = parseRange(base, min, max, normalizeDow)
    if (!range) return null
    for (let n = range.start; n <= range.end; n += step) {
      values.add(normalizeDowValue(n, normalizeDow))
    }
  }

  if (values.size === 0) return null
  return { values }
}

function parseRange(base: string, min: number, max: number, normalizeDow = false): { start: number; end: number } | null {
  if (!base.includes('-')) {
    const n = Number(base)
    if (!Number.isInteger(n)) return null
    const normalized = normalizeDowValue(n, normalizeDow)
    if (normalized < min || normalized > max) return null
    return { start: normalized, end: normalized }
  }

  const [aRaw, bRaw] = base.split('-')
  const a = Number(aRaw)
  const b = Number(bRaw)
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null
  const start = normalizeDowValue(a, normalizeDow)
  const end = normalizeDowValue(b, normalizeDow)
  if (start < min || start > max || end < min || end > max || end < start) return null
  return { start, end }
}

function normalizeDowValue(value: number, normalizeDow: boolean): number {
  if (!normalizeDow) return value
  return value === SUNDAY_ALT ? SUNDAY : value
}

function matchesCron(parsed: ParsedCron, at: Date): boolean {
  const minute = at.getMinutes()
  const hour = at.getHours()
  const dayOfMonth = at.getDate()
  const month = at.getMonth() + 1
  const dayOfWeek = at.getDay()

  const minuteMatch = parsed.minute.values.has(minute)
  const hourMatch = parsed.hour.values.has(hour)
  const monthMatch = parsed.month.values.has(month)
  const dayOfMonthMatch = parsed.dayOfMonth.values.has(dayOfMonth)
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(dayOfWeek)

  const dayMatch =
    parsed.dayOfMonthWildcard && parsed.dayOfWeekWildcard
      ? true
      : parsed.dayOfMonthWildcard
        ? dayOfWeekMatch
        : parsed.dayOfWeekWildcard
          ? dayOfMonthMatch
          : dayOfMonthMatch || dayOfWeekMatch

  return minuteMatch && hourMatch && monthMatch && dayMatch
}
