/**
 * Money = signed integer cents. Negative = money out. No floats anywhere.
 */

/**
 * Parse a decimal amount string ("-54.23", "2,500.00", "28575.02") to cents.
 * Throws on malformed input — importers must fail loudly (plan §5b).
 */
export function parseAmountToCents(raw: string): number {
  const s = raw.trim().replace(/,/g, '')
  if (!/^-?\$?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`Unparseable amount: ${JSON.stringify(raw)}`)
  }
  const neg = s.startsWith('-')
  const unsigned = s.replace(/^-?\$?/, '')
  const dotIdx = unsigned.indexOf('.')
  const whole = dotIdx === -1 ? unsigned : unsigned.slice(0, dotIdx)
  const fracRaw = dotIdx === -1 ? '' : unsigned.slice(dotIdx + 1)
  const frac = (fracRaw + '00').slice(0, 2)
  const cents = Number(whole) * 100 + Number(frac)
  return neg ? -cents : cents
}

export function centsToDisplay(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${sign}$${whole.toLocaleString('en-US')}.${frac}`
}
