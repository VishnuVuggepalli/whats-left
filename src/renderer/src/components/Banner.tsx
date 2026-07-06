/**
 * Inline banner per the design ("Banner · attention"): tinted panel with a
 * leading icon, message, optional action, optional dismiss. Danger banners
 * announce assertively (role="alert"), the rest politely (role="status").
 */
import type { ReactNode } from 'react'
import { IconWarning, IconX, IconArrowRight } from './Icons'

export type BannerTone = 'warn' | 'danger' | 'info'

const TONE_CLASSES: Record<BannerTone, string> = {
  warn: 'border-warn-deep/35 bg-warn-deep/9 text-warn-soft',
  danger: 'border-neg-deep/35 bg-neg-deep/9 text-neg',
  info: 'border-accent/20 bg-accent/8 text-ink-dim',
}

const ICON_CLASSES: Record<BannerTone, string> = {
  warn: 'text-warn',
  danger: 'text-neg',
  info: 'text-[#60A5FA]',
}

export interface BannerProps {
  tone?: BannerTone
  children: ReactNode
  /** custom leading icon (defaults per tone) */
  icon?: ReactNode
  /** trailing action, e.g. an outline button */
  action?: ReactNode
  onDismiss?: () => void
  className?: string
}

export function Banner({ tone = 'warn', children, icon, action, onDismiss, className = '' }: BannerProps) {
  const defaultIcon =
    tone === 'info' ? <IconArrowRight size={15} strokeWidth={2} /> : <IconWarning size={17} strokeWidth={2} />
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`fadein flex items-center gap-3 rounded-[10px] border px-3.5 py-3 text-[13px] ${TONE_CLASSES[tone]} ${className}`}
    >
      <span className={`flex shrink-0 ${ICON_CLASSES[tone]}`}>{icon ?? defaultIcon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={`flex cursor-pointer rounded-md border-0 bg-transparent p-1 opacity-70 transition-opacity hover:opacity-100 ${ICON_CLASSES[tone]}`}
        >
          <IconX size={15} />
        </button>
      )}
    </div>
  )
}

/** Outline action button matched to the banner tone (design "Review" button). */
export function BannerAction({
  tone = 'warn',
  onClick,
  children,
}: {
  tone?: BannerTone
  onClick: () => void
  children: ReactNode
}) {
  const toneClass =
    tone === 'warn'
      ? 'border-warn/40 text-warn hover:bg-warn/12'
      : tone === 'danger'
        ? 'border-neg/40 text-neg hover:bg-neg/12'
        : 'border-accent/40 text-accent-soft hover:bg-accent/12'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 cursor-pointer rounded-[7px] border bg-transparent px-3 py-[5px] text-xs font-semibold transition-colors ${toneClass}`}
    >
      {children}
    </button>
  )
}
