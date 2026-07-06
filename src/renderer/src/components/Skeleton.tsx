/**
 * Loading shimmer per the design ("Skeleton · loading"). The gradient +
 * animation live in styles.css (.skeleton) and respect prefers-reduced-motion.
 */

export interface SkeletonProps {
  className?: string
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />
}

/** Row of table-shaped shimmer used by the Transactions / Review lists. */
export function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-[42px] items-center gap-4 border-b border-white/4 px-4 last:border-b-0">
          <Skeleton className="h-3 w-[70px]" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-5 w-[120px] rounded-md" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}
