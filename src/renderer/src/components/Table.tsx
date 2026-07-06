import type { ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: string
  className?: string
  render: (row: T) => ReactNode
}

export interface TableProps<T> {
  columns: ReadonlyArray<Column<T>>
  rows: readonly T[]
  rowKey: (row: T) => string
  emptyText?: string
}

export function Table<T>({ columns, rows, rowKey, emptyText = 'Nothing here yet.' }: TableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-raised/60">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-3 py-2 text-left text-xs font-semibold tracking-wide text-muted uppercase ${col.className ?? ''}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="px-3 py-6 text-center text-muted" colSpan={columns.length}>
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-line/60 last:border-b-0 hover:bg-raised/40">
                {columns.map((col) => (
                  <td key={col.key} className={`px-3 py-2 align-middle ${col.className ?? ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
