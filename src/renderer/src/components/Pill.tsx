/**
 * Status pill per the design inventory: rounded-full tinted chip with an
 * optional status dot. Meaning is always carried by the label text too —
 * never by color alone.
 */
import type { ReactNode } from 'react'

export type PillTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral'

const TONE_CLASSES: Record<PillTone, string> = {
  ok: 'bg-pos-deep/13 text-pos',
  warn: 'bg-warn-deep/13 text-warn',
  danger: 'bg-neg-deep/13 text-neg',
  info: 'bg-accent/13 text-accent-soft',
  neutral: 'bg-white/6 text-muted',
}

const DOT_CLASSES: Record<PillTone, string> = {
  ok: 'bg-pos-deep',
  warn: 'bg-warn-deep',
  danger: 'bg-neg-deep',
  info: 'bg-accent',
  neutral: 'bg-faint',
}

export interface PillProps {
  tone?: PillTone
  /** show the small status dot before the label */
  dot?: boolean
  children: ReactNode
  className?: string
}

export function Pill({ tone = 'neutral', dot = false, children, className = '' }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-[9px] py-1 text-[11px] font-semibold whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`}
    >
      {dot && <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${DOT_CLASSES[tone]}`} aria-hidden="true" />}
      {children}
    </span>
  )
}
