import { centsToDisplay } from '../lib/format'

export interface MoneyTextProps {
  cents: number
  className?: string
}

/** Signed cents rendered red (out) / green (in) / muted (zero), tabular. */
export function MoneyText({ cents, className = '' }: MoneyTextProps) {
  const tone = cents < 0 ? 'text-neg' : cents > 0 ? 'text-pos' : 'text-muted'
  return <span className={`font-medium tabular-nums ${tone} ${className}`}>{centsToDisplay(cents)}</span>
}
