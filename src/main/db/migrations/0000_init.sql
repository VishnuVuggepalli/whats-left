-- 0000_init.sql — source of truth for the schema (schema.ts mirrors this).
-- Amounts: signed integer cents (negative = out). Dates: 'YYYY-MM-DD' TEXT.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  institution TEXT NOT NULL CHECK (institution IN ('chase','amex','other')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('teller','csv_only')),
  teller_account_id TEXT,
  teller_enrollment_id TEXT,
  mask TEXT,
  type TEXT NOT NULL CHECK (type IN ('depository','credit')),
  subtype TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','reconnect_required','error')),
  balance_cents INTEGER,
  last_sync_at TEXT,
  closed INTEGER NOT NULL DEFAULT 0,
  tombstone INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL CHECK (source IN ('plaid','teller','chase_csv','amex_csv')),
  external_id TEXT,
  import_hash TEXT NOT NULL,
  linked_source_id TEXT,
  txn_date TEXT NOT NULL,
  post_date TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posted','pending')),
  payee_id TEXT,
  imported_payee TEXT NOT NULL,
  raw_description TEXT NOT NULL,
  category_id TEXT,
  source_category TEXT,
  category_source TEXT CHECK (category_source IN ('user','rule','cache','source','llm')),
  llm_confidence REAL,
  notes TEXT,
  reconciled INTEGER NOT NULL DEFAULT 0,
  tombstone INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_txn_import_hash
  ON transactions(account_id, source, import_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ux_txn_external
  ON transactions(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_txn_account_date ON transactions(account_id, txn_date);
CREATE INDEX IF NOT EXISTS ix_txn_category ON transactions(category_id);

CREATE TABLE IF NOT EXISTS payees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_payees_normalized ON payees(normalized_name);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pfc_code TEXT NOT NULL,
  parent_id TEXT,
  is_income INTEGER NOT NULL DEFAULT 0,
  excluded_from_spend INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS merchant_category_cache (
  normalized_merchant TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('rule','chase','amex','teller','llm','user')),
  confidence REAL,
  locked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  stage TEXT,
  conditions_op TEXT,
  conditions TEXT,
  actions TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  tombstone INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_log (
  id TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  source TEXT NOT NULL,
  account_id TEXT,
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  gc_pending INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Analytics views. Spend = net signed sum over non-excluded categories.
-- NULL-category (uncategorized) posted rows COUNT as spend and stay VISIBLE
-- in every view (COALESCE) — the headline number must never silently shrink
-- because categorization is behind.
CREATE VIEW IF NOT EXISTS v_monthly_category AS
SELECT
  strftime('%Y-%m', t.txn_date) AS month,
  t.category_id,
  SUM(t.amount_cents) AS net_cents,
  COUNT(*) AS txn_count
FROM transactions t
WHERE t.tombstone = 0 AND t.status = 'posted'
GROUP BY strftime('%Y-%m', t.txn_date), t.category_id;

CREATE VIEW IF NOT EXISTS v_monthly_totals AS
SELECT
  strftime('%Y-%m', t.txn_date) AS month,
  SUM(CASE WHEN COALESCE(c.is_income, 0) = 0 AND COALESCE(c.excluded_from_spend, 0) = 0 THEN t.amount_cents ELSE 0 END) AS spend_cents,
  SUM(CASE WHEN COALESCE(c.is_income, 0) = 1 THEN t.amount_cents ELSE 0 END) AS income_cents
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
WHERE t.tombstone = 0 AND t.status = 'posted'
GROUP BY strftime('%Y-%m', t.txn_date);

CREATE VIEW IF NOT EXISTS v_merchant_monthly AS
SELECT
  strftime('%Y-%m', t.txn_date) AS month,
  t.imported_payee AS payee,
  SUM(t.amount_cents) AS net_cents,
  COUNT(*) AS txn_count
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
WHERE t.tombstone = 0 AND t.status = 'posted'
  AND COALESCE(c.excluded_from_spend, 0) = 0 AND COALESCE(c.is_income, 0) = 0
GROUP BY strftime('%Y-%m', t.txn_date), t.imported_payee;
