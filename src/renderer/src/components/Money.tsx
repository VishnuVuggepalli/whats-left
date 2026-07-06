/**
 * Money figures per the design type spec: Fira Code, tabular, explicit sign
 * (− U+2212 / +). Money in is green; money out stays neutral by design;
 * pending / de-emphasized rows go muted. Never color-only: the sign always
 * carries the direction.
 */
import { centsToDisplay } from '../lib/format'

export type MoneySign = 'always' | 'negative-only' | 'never'

export interface MoneyProps {
  cents: number
  /** 'always' (ledger rows) | 'negative-only' (balances) | 'never' (totals) */
  sign?: MoneySign
  /** force the muted treatment (pending rows) */
  muted?: boolean
  className?: string
}

export function formatSignedMoney(cents: number, sign: MoneySign = 'always'): string {
  const abs = centsToDisplay(Math.abs(cents))
  if (sign === 'never') return abs
  if (cents < 0) return `−${abs}`
  return sign === 'always' ? `+${abs}` : abs
}

export function Money({ cents, sign = 'always', muted = false, className = '' }: MoneyProps) {
  const tone = muted ? 'text-faint' : cents > 0 ? 'text-pos' : 'text-ink'
  return (
    <span className={`font-mono font-medium tabular-nums ${tone} ${className}`}>
      {formatSignedMoney(cents, sign)}
    </span>
  )
}
