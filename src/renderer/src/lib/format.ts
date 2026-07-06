/**
 * Renderer-local display/formatting helpers.
 *
 * `centsToDisplay` deliberately DUPLICATES src/main/core/money.ts instead of
 * importing it: the renderer lives on the other side of the IPC process
 * boundary and must depend only on src/shared + the window.api contract
 * (plan §3 invariant 2 — the future PWA seam). A ~15-line duplicate is
 * cheaper than coupling the renderer bundle to main-process code.
 *
 * All month/date helpers are pure string ops — never `new Date('YYYY-MM-DD')`
 * (plan §3 invariant 4: UTC-midnight parsing shifts a day in US timezones).
 */

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const MONTH_NAMES_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

function assertInteger(cents: number): void {
  if (!Number.isInteger(cents)) {
    throw new Error(`Amount must be integer cents, got: ${cents}`)
  }
}

/** Signed integer cents → "$1,234.56" / "-$0.05". */
export function centsToDisplay(cents: number): string {
  assertInteger(cents)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${sign}$${whole.toLocaleString('en-US')}.${frac}`
}

/** Compact form for chart axes: "$845", "$1.2k", "$2.5m". Rounds; display-only. */
export function centsToCompact(cents: number): string {
  assertInteger(cents)
  const sign = cents < 0 ? '-' : ''
  const dollars = Math.abs(cents) / 100
  if (dollars >= 1_000_000) return `${sign}$${(dollars / 1_000_000).toFixed(1)}m`
  if (dollars >= 1_000) return `${sign}$${(dollars / 1_000).toFixed(1)}k`
  return `${sign}$${Math.round(dollars)}`
}

export function isYearMonth(s: string): boolean {
  return YEAR_MONTH_RE.test(s)
}

function assertYearMonth(month: string): void {
  if (!isYearMonth(month)) throw new Error(`Not a YYYY-MM month: ${JSON.stringify(month)}`)
}

/** 'YYYY-MM' ± n months, pure integer math on the string parts. */
export function addMonths(month: string, delta: number): string {
  assertYearMonth(month)
  if (!Number.isInteger(delta)) throw new Error(`Month delta must be an integer, got: ${delta}`)
  const total = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta
  const year = Math.floor(total / 12)
  const m = (total % 12 + 12) % 12 + 1
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}`
}

/** The n months ending at `endMonth`, ascending. */
export function lastNMonths(endMonth: string, n: number): string[] {
  assertYearMonth(endMonth)
  if (!Number.isInteger(n) || n < 1) throw new Error(`Month count must be >= 1, got: ${n}`)
  return Array.from({ length: n }, (_, i) => addMonths(endMonth, i - (n - 1)))
}

/** 'YYYY-MM' → 'Jul 2026'. */
export function monthLabel(month: string): string {
  assertYearMonth(month)
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1]
  if (!name) throw new Error(`Out-of-range month: ${JSON.stringify(month)}`)
  return `${name} ${month.slice(0, 4)}`
}

/** 'YYYY-MM' → 'July 2026' (full month name, design month stepper). */
export function monthLabelFull(month: string): string {
  assertYearMonth(month)
  const name = MONTH_NAMES_FULL[Number(month.slice(5, 7)) - 1]
  if (!name) throw new Error(`Out-of-range month: ${JSON.stringify(month)}`)
  return `${name} ${month.slice(0, 4)}`
}

/** 'YYYY-MM' → 'July' (full month name only, dashboard hero caption). */
export function monthNameFull(month: string): string {
  assertYearMonth(month)
  const name = MONTH_NAMES_FULL[Number(month.slice(5, 7)) - 1]
  if (!name) throw new Error(`Out-of-range month: ${JSON.stringify(month)}`)
  return name
}

/** 'YYYY-MM-DD' → 'Jun 29' (pure string ops — never parses into a Date). */
export function shortDate(isoDate: string): string {
  if (!ISO_DATE_RE.test(isoDate)) throw new Error(`Not an ISO date: ${JSON.stringify(isoDate)}`)
  const name = MONTH_NAMES[Number(isoDate.slice(5, 7)) - 1]
  if (!name) throw new Error(`Out-of-range month in date: ${JSON.stringify(isoDate)}`)
  return `${name} ${Number(isoDate.slice(8, 10))}`
}

/** 'YYYY-MM-DD' → 'YYYY-MM' (pure slice — never parses into a Date). */
export function monthOf(isoDate: string): string {
  if (!ISO_DATE_RE.test(isoDate)) throw new Error(`Not an ISO date: ${JSON.stringify(isoDate)}`)
  return isoDate.slice(0, 7)
}

/**
 * Current month from the live clock, via LOCAL date components — the one
 * sanctioned Date usage (constructing from "now", never from a date string).
 */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}
