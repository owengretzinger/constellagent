import { describe, expect, it } from 'bun:test'
import { didCronFireBetween, shouldCatchUpOnWake } from './automation-catchup'

describe('automation catch-up decisions', () => {
  it('returns true when at least one scheduled slot was missed', () => {
    const from = Date.UTC(2026, 1, 19, 10, 0, 10)
    const to = Date.UTC(2026, 1, 19, 10, 3, 5)

    expect(didCronFireBetween('*/1 * * * *', from, to)).toBe(true)
  })

  it('coalesces multiple missed slots into a single catch-up decision', () => {
    const from = Date.UTC(2026, 1, 19, 10, 0, 0)
    const to = Date.UTC(2026, 1, 19, 16, 30, 0)

    expect(
      shouldCatchUpOnWake({
        cronExpression: '0 * * * *',
        lastCheckedAt: from,
        nowMs: to,
        nextRunAt: null,
      })
    ).toBe(true)
  })

  it('returns false when no schedule boundary was crossed', () => {
    const from = Date.UTC(2026, 1, 19, 10, 0, 10)
    const to = Date.UTC(2026, 1, 19, 10, 0, 50)

    expect(didCronFireBetween('*/1 * * * *', from, to)).toBe(false)
  })

  it('returns false for invalid cron expressions', () => {
    const from = Date.UTC(2026, 1, 19, 10, 0, 0)
    const to = Date.UTC(2026, 1, 19, 11, 0, 0)

    expect(didCronFireBetween('not-a-cron', from, to)).toBe(false)
  })

  it('uses nextRunAt fast-path when available', () => {
    const lastCheckedAt = Date.UTC(2026, 1, 19, 10, 0, 0)
    const nowMs = Date.UTC(2026, 1, 19, 10, 15, 0)
    const nextRunAt = Date.UTC(2026, 1, 19, 10, 5, 0)

    expect(
      shouldCatchUpOnWake({
        cronExpression: '0 0 1 1 *',
        lastCheckedAt,
        nowMs,
        nextRunAt,
      })
    ).toBe(true)
  })

  it('does not catch up when window is zero-length (startup baseline)', () => {
    const nowMs = Date.UTC(2026, 1, 19, 10, 0, 0)
    expect(
      shouldCatchUpOnWake({
        cronExpression: '*/1 * * * *',
        lastCheckedAt: nowMs,
        nowMs,
        nextRunAt: null,
      })
    ).toBe(false)
  })
})
