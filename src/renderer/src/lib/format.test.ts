import { describe, expect, it } from 'vitest'
import {
  addMonths,
  centsToCompact,
  centsToDisplay,
  currentMonth,
  isYearMonth,
  lastNMonths,
  monthLabel,
  monthOf,
} from './format'

describe('centsToDisplay', () => {
  it('formats zero', () => {
    expect(centsToDisplay(0)).toBe('$0.00')
  })

  it('formats negative amounts with leading minus', () => {
    expect(centsToDisplay(-654321)).toBe('-$6,543.21')
  })

  it('formats sub-dollar amounts', () => {
    expect(centsToDisplay(5)).toBe('$0.05')
    expect(centsToDisplay(-5)).toBe('-$0.05')
  })

  it('groups thousands', () => {
    expect(centsToDisplay(123456789)).toBe('$1,234,567.89')
  })

  it('throws on non-integer input', () => {
    expect(() => centsToDisplay(12.5)).toThrow()
    expect(() => centsToDisplay(Number.NaN)).toThrow()
    expect(() => centsToDisplay(Number.POSITIVE_INFINITY)).toThrow()
  })
})

describe('centsToCompact', () => {
  it('keeps small amounts exact-ish', () => {
    expect(centsToCompact(84500)).toBe('$845')
    expect(centsToCompact(-84500)).toBe('-$845')
  })

  it('compacts thousands', () => {
    expect(centsToCompact(123400)).toBe('$1.2k')
    expect(centsToCompact(-186006)).toBe('-$1.9k')
  })

  it('compacts millions', () => {
    expect(centsToCompact(250000000)).toBe('$2.5m')
  })

  it('formats zero', () => {
    expect(centsToCompact(0)).toBe('$0')
  })

  it('throws on non-integer input', () => {
    expect(() => centsToCompact(0.5)).toThrow()
  })
})

describe('isYearMonth', () => {
  it('accepts YYYY-MM', () => {
    expect(isYearMonth('2026-07')).toBe(true)
  })

  it('rejects other shapes', () => {
    expect(isYearMonth('2026-7')).toBe(false)
    expect(isYearMonth('2026-07-01')).toBe(false)
    expect(isYearMonth('07-2026')).toBe(false)
    expect(isYearMonth('')).toBe(false)
  })
})

describe('addMonths', () => {
  it('adds within a year', () => {
    expect(addMonths('2026-03', 2)).toBe('2026-05')
  })

  it('wraps forward across December', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01')
  })

  it('wraps backward across January', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12')
  })

  it('handles multi-year deltas', () => {
    expect(addMonths('2026-07', -12)).toBe('2025-07')
    expect(addMonths('2026-07', -19)).toBe('2024-12')
  })

  it('zero delta is identity', () => {
    expect(addMonths('2026-07', 0)).toBe('2026-07')
  })

  it('throws on malformed month', () => {
    expect(() => addMonths('2026-7', 1)).toThrow()
    expect(() => addMonths('garbage', 1)).toThrow()
    expect(() => addMonths('2026-13', 1)).toThrow()
    expect(() => addMonths('2026-00', 1)).toThrow()
  })
})

describe('lastNMonths', () => {
  it('returns ascending months ending at the given month', () => {
    expect(lastNMonths('2026-07', 3)).toEqual(['2026-05', '2026-06', '2026-07'])
  })

  it('crosses year boundaries', () => {
    expect(lastNMonths('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })

  it('n=1 returns just the month', () => {
    expect(lastNMonths('2026-07', 1)).toEqual(['2026-07'])
  })

  it('throws on n < 1 and malformed month', () => {
    expect(() => lastNMonths('2026-07', 0)).toThrow()
    expect(() => lastNMonths('nope', 3)).toThrow()
  })
})

describe('monthLabel', () => {
  it('renders friendly month name', () => {
    expect(monthLabel('2026-07')).toBe('Jul 2026')
    expect(monthLabel('2025-12')).toBe('Dec 2025')
    expect(monthLabel('2024-01')).toBe('Jan 2024')
  })

  it('throws on out-of-range month', () => {
    expect(() => monthLabel('2026-13')).toThrow()
    expect(() => monthLabel('2026-00')).toThrow()
    expect(() => monthLabel('202607')).toThrow()
  })
})

describe('monthOf', () => {
  it('slices the month from an ISO date (pure string op)', () => {
    expect(monthOf('2026-07-06')).toBe('2026-07')
  })

  it('throws on non-ISO input', () => {
    expect(() => monthOf('07/06/2026')).toThrow()
    expect(() => monthOf('2026-07')).toThrow()
  })
})

describe('currentMonth', () => {
  it('uses local date components, not UTC string parsing', () => {
    // Construct from numeric components — the only sanctioned Date usage.
    expect(currentMonth(new Date(2026, 6, 6))).toBe('2026-07')
    expect(currentMonth(new Date(2025, 0, 1))).toBe('2025-01')
    expect(currentMonth(new Date(2025, 11, 31))).toBe('2025-12')
  })

  it('defaults to now and returns a valid YYYY-MM', () => {
    expect(isYearMonth(currentMonth())).toBe(true)
  })
})
