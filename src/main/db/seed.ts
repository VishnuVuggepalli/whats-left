import { TAXONOMY } from '../core/categorize/taxonomy'
import type { Db } from './db'

/**
 * Upsert every taxonomy entry into `categories`. Idempotent: reseeding
 * refreshes name/flags/sort order without duplicating rows, so taxonomy
 * changes in code propagate on next startup.
 */
export function seedTaxonomy(db: Db): void {
  const upsert = db.prepare(
    `INSERT INTO categories (id, name, pfc_code, parent_id, is_income, excluded_from_spend, sort_order)
     VALUES (@id, @name, @pfcCode, NULL, @isIncome, @excludedFromSpend, @sortOrder)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       pfc_code = excluded.pfc_code,
       is_income = excluded.is_income,
       excluded_from_spend = excluded.excluded_from_spend,
       sort_order = excluded.sort_order`,
  )
  const seedAll = db.transaction(() => {
    for (const entry of TAXONOMY) {
      upsert.run({
        id: entry.id,
        name: entry.name,
        pfcCode: entry.pfcCode,
        isIncome: entry.isIncome ? 1 : 0,
        excludedFromSpend: entry.excludedFromSpend ? 1 : 0,
        sortOrder: entry.sortOrder,
      })
    }
  })
  seedAll()
}
