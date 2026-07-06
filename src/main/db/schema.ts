import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Drizzle schema — mirrors src/main/db/migrations/0000_init.sql (hand-written
 * migration is the source of truth; keep both in sync).
 * Amounts: signed integer cents (negative = out). Dates: 'YYYY-MM-DD' TEXT.
 * Analytics views (raw SQL only): NULL-category posted rows count as spend
 * everywhere (COALESCE in v_monthly_totals / v_merchant_monthly).
 */

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  institution: text('institution', { enum: ['chase', 'amex'] }).notNull(),
  sourceKind: text('source_kind', { enum: ['teller', 'csv_only'] }).notNull(),
  tellerAccountId: text('teller_account_id'),
  tellerEnrollmentId: text('teller_enrollment_id'),
  mask: text('mask'),
  type: text('type', { enum: ['depository', 'credit'] }).notNull(),
  subtype: text('subtype'),
  status: text('status', { enum: ['ok', 'reconnect_required', 'error'] })
    .notNull()
    .default('ok'),
  balanceCents: integer('balance_cents'),
  lastSyncAt: text('last_sync_at'),
  closed: integer('closed').notNull().default(0),
  tombstone: integer('tombstone').notNull().default(0),
})

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    source: text('source', { enum: ['teller', 'chase_csv', 'amex_csv'] }).notNull(),
    /** bank-issued id only (Teller txn id, Amex Reference); NULL for hash-only rows */
    externalId: text('external_id'),
    /** synthesized sha256 — idempotency only, never treated as an id by the matcher */
    importHash: text('import_hash').notNull(),
    linkedSourceId: text('linked_source_id'),
    txnDate: text('txn_date').notNull(),
    postDate: text('post_date'),
    amountCents: integer('amount_cents').notNull(),
    status: text('status', { enum: ['posted', 'pending'] }).notNull(),
    payeeId: text('payee_id'),
    importedPayee: text('imported_payee').notNull(),
    rawDescription: text('raw_description').notNull(),
    categoryId: text('category_id'),
    sourceCategory: text('source_category'),
    categorySource: text('category_source', {
      enum: ['user', 'rule', 'cache', 'source', 'llm'],
    }),
    llmConfidence: real('llm_confidence'),
    notes: text('notes'),
    reconciled: integer('reconciled').notNull().default(0),
    tombstone: integer('tombstone').notNull().default(0),
  },
  (t) => [
    uniqueIndex('ux_txn_import_hash').on(t.accountId, t.source, t.importHash),
    index('ix_txn_account_date').on(t.accountId, t.txnDate),
    index('ix_txn_category').on(t.categoryId),
    // partial unique on (source, external_id) WHERE external_id IS NOT NULL
    // is created in raw SQL migration (drizzle partial index support via .where)
  ],
)

export const payees = sqliteTable('payees', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  tombstone: integer('tombstone').notNull().default(0),
})

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  pfcCode: text('pfc_code').notNull(),
  parentId: text('parent_id'),
  isIncome: integer('is_income').notNull().default(0),
  excludedFromSpend: integer('excluded_from_spend').notNull().default(0),
  sortOrder: real('sort_order').notNull().default(0),
})

export const merchantCategoryCache = sqliteTable('merchant_category_cache', {
  normalizedMerchant: text('normalized_merchant').primaryKey(),
  categoryId: text('category_id').notNull(),
  source: text('source', { enum: ['rule', 'chase', 'amex', 'teller', 'llm', 'user'] }).notNull(),
  confidence: real('confidence'),
  locked: integer('locked').notNull().default(0),
})

/** kept for post-v1 rules engine; v1 default rules are hard-coded in code */
export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  stage: text('stage'),
  conditionsOp: text('conditions_op'),
  conditions: text('conditions'),
  actions: text('actions'),
  sortOrder: real('sort_order').notNull().default(0),
  tombstone: integer('tombstone').notNull().default(0),
})

export const syncLog = sqliteTable('sync_log', {
  id: text('id').primaryKey(),
  ranAt: text('ran_at').notNull(),
  source: text('source').notNull(),
  accountId: text('account_id'),
  fetched: integer('fetched').notNull().default(0),
  inserted: integer('inserted').notNull().default(0),
  matched: integer('matched').notNull().default(0),
  gcPending: integer('gc_pending').notNull().default(0),
  errors: text('errors'),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
