/**
 * Surface card per the design: #101A34 on #0F172A, hairline border,
 * 12px radius, 15/600 title with an 11/500 muted subtitle.
 */
import type { ReactNode } from 'react'

export interface CardProps {
  title?: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** disable the default padding when the body manages its own (tables, wizards) */
  flush?: boolean
}

export function Card({ title, subtitle, actions, children, className = '', flush = false }: CardProps) {
  const hasHeader = title !== undefined || actions !== undefined
  return (
    <section className={`rounded-xl border border-line bg-surface ${flush ? 'overflow-hidden' : 'p-5'} ${className}`}>
      {hasHeader && (
        <header className={`mb-4 flex items-start justify-between gap-3 ${flush ? 'px-5 pt-5' : ''}`}>
          <div className="min-w-0">
            {title !== undefined && <h2 className="text-[15px] font-semibold text-white">{title}</h2>}
            {subtitle !== undefined && <p className="mt-0.5 text-[11px] font-medium text-faint">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}
