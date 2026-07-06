/**
 * Full-panel empty / error / success state per the design: icon tile,
 * 17/600 title, muted body, action row. Error tone announces via role=alert.
 */
import type { ReactNode } from 'react'

export type EmptyStateTone = 'default' | 'danger' | 'success'

const TILE_CLASSES: Record<EmptyStateTone, string> = {
  default: 'bg-surface border-line text-accent',
  danger: 'bg-neg-deep/10 border-neg-deep/25 text-neg',
  success: 'bg-pos-deep/13 border-pos-deep/32 text-pos',
}

export interface EmptyStateProps {
  tone?: EmptyStateTone
  icon: ReactNode
  title: string
  body: ReactNode
  actions?: ReactNode
  className?: string
}

export function EmptyState({ tone = 'default', icon, title, body, actions, className = '' }: EmptyStateProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex min-h-[520px] flex-col items-center justify-center p-10 text-center ${className}`}
    >
      <div
        className={`mb-5 flex h-[54px] w-[54px] items-center justify-center rounded-[14px] border ${TILE_CLASSES[tone]}`}
      >
        {icon}
      </div>
      <div className="mb-2 text-[17px] font-semibold text-white">{title}</div>
      <div className="mb-6 max-w-[380px] text-[13px] leading-relaxed text-muted">{body}</div>
      {actions !== undefined && <div className="flex flex-wrap justify-center gap-2.5">{actions}</div>}
    </div>
  )
}
