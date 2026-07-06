import type { ReactNode } from 'react'

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral'

const TONE_CLASSES: Record<BadgeTone, string> = {
  ok: 'bg-pos/15 text-pos',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-neg/15 text-neg',
  info: 'bg-accent/15 text-accent',
  neutral: 'bg-raised text-ink-dim',
}

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  className?: string
}

export function Badge({ tone = 'neutral', children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}
