import { describe, expect, it } from 'vitest'
import { TAXONOMY } from '../core/categorize/taxonomy'
import { openDb, runMigrations } from './db'
import { seedTaxonomy } from './seed'

interface CategoryRow {
  id: string
  name: string
  pfc_code: string
  parent_id: string | null
  is_income: number
  excluded_from_spend: number
  sort_order: number
}

function freshDb() {
  const db = openDb(':memory:')
  runMigrations(db)
  return db
}

function allCategories(db: ReturnType<typeof freshDb>): CategoryRow[] {
  return db.prepare('SELECT * FROM categories ORDER BY id').all() as CategoryRow[]
}

describe('seedTaxonomy', () => {
  it('inserts every taxonomy entry with correct flags', () => {
    const db = freshDb()
    seedTaxonomy(db)
    const rows = allCategories(db)
    expect(rows).toHaveLength(TAXONOMY.length)

    const income = rows.find((r) => r.id === 'income')
    expect(income).toMatchObject({
      name: 'Income',
      pfc_code: 'INCOME',
      is_income: 1,
      excluded_from_spend: 0,
      sort_order: 1,
    })

    const loan = rows.find((r) => r.id === 'loan_payments')
    expect(loan).toMatchObject({
      name: 'Card & Loan Payments',
      pfc_code: 'LOAN_PAYMENTS',
      is_income: 0,
      excluded_from_spend: 1,
    })

    const groceries = rows.find((r) => r.id === 'groceries')
    expect(groceries).toMatchObject({ pfc_code: 'FOOD_AND_DRINK', sort_order: 6.5 })
  })

  it('is idempotent — reseeding leaves exactly one row per entry', () => {
    const db = freshDb()
    seedTaxonomy(db)
    seedTaxonomy(db)
    expect(allCategories(db)).toHaveLength(TAXONOMY.length)
  })

  it('upserts: reseeding restores tampered fields', () => {
    const db = freshDb()
    seedTaxonomy(db)
    db.prepare(
      `UPDATE categories SET name = 'Tampered', excluded_from_spend = 1 WHERE id = 'groceries'`,
    ).run()
    seedTaxonomy(db)
    const groceries = allCategories(db).find((r) => r.id === 'groceries')
    expect(groceries).toMatchObject({ name: 'Groceries', excluded_from_spend: 0 })
  })
})
