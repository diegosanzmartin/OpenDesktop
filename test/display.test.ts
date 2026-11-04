import { afterEach, describe, expect, test, vi } from 'vitest'
import { dayBucket } from '@shared/sessions'

afterEach(() => vi.useRealTimers())

const day = 86_400_000

describe('the date headings in the sidebar', () => {
  // Wednesday 4 November 2026, midday.
  const now = new Date(2026, 10, 4, 12).getTime()

  test('say what range they cover: last week is not this week, five weeks ago is not this month', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    expect(dayBucket(now - 6 * day)).toBe('Previous 7 days')
    expect(dayBucket(now - 20 * day)).toBe('Previous 30 days')
  })

  test('today and yesterday stay calendar days', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    expect(dayBucket(now - 60_000)).toBe('Today')
    expect(dayBucket(now - day)).toBe('Yesterday')
  })
})
