/**
 * Dates are opaque 'YYYY-MM-DD' strings end-to-end (plan §3 invariant 4).
 * NEVER construct a JS Date from a date-only string — new Date('2026-02-01')
 * is UTC midnight and renders as Jan 31 in US timezones. All arithmetic here
 * is done via Date.UTC components only.
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
const US_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/

export function isIsoDate(s: string): boolean {
  return ISO_RE.test(s)
}

/** 'MM/DD/YYYY' (Chase/Amex CSV) → 'YYYY-MM-DD'. Throws on malformed input. */
export function usDateToIso(s: string): string {
  const m = US_RE.exec(s.trim())
  if (!m) throw new Error(`Unparseable US date: ${JSON.stringify(s)}`)
  const [, mm, dd, yyyy] = m
  const month = Number(mm)
  const day = Number(dd)
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Out-of-range US date: ${JSON.stringify(s)}`)
  }
  return `${yyyy}-${mm}-${dd}`
}

/** days between two ISO dates (b - a), computed in UTC — no TZ involvement */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000)
}

export function addDays(iso: string, days: number): string {
  const ms = toUtcMs(iso) + days * 86_400_000
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function minIso(a: string, b: string): string {
  return a <= b ? a : b
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

function toUtcMs(iso: string): number {
  if (!ISO_RE.test(iso)) throw new Error(`Not an ISO date: ${JSON.stringify(iso)}`)
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  const d = Number(iso.slice(8, 10))
  return Date.UTC(y, m - 1, d)
}
