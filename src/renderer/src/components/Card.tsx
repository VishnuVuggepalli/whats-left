import type { ReactNode } from 'react'

export interface CardProps {
  title?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}

export function Card({ title, actions, children, className = '' }: CardProps) {
  return (
    <section className={`rounded-lg border border-line bg-surface p-4 ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title !== undefined && (
            <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
          )}
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}
