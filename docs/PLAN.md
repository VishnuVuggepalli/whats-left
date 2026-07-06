# Expense Tracker — Implementation Plan (v2)

**Date:** 2026-07-06 · **Status:** Planning complete (v2 after 3-critic adversarial review), no code yet
**One-liner:** Free Windows desktop app (Electron) that pulls Chase + Amex transactions via Teller.io, backfills from bank CSV exports, categorizes locally (rules + Ollama), and answers "how much did I spend on what."

---

## 1. Goals & Non-Goals

### Goals (v1)
- Automatic transaction sync from **Chase** (checking + credit) and **American Express** (credit, maybe savings) — $0 running cost.
- Historical backfill (~2 years) from bank CSV exports.
- Reliable categorization with near-zero manual effort after warm-up.
- Spend analytics: by category, by month, by merchant, trends. "How much on what."
- Everything local: SQLite on disk, secrets DPAPI-encrypted, no cloud, no server.
- Runs in system tray, syncs on schedule, launches at login.
- **Working dashboard by ~week 3** (CSV data + native bank categories), before Teller/LLM work starts.

### Non-Goals (v1) — explicitly deferred
- Budgeting/envelopes, bill forecasting, net-worth/investments.
- Multi-user, multi-device sync, mobile app, any backend server (future PWA seam prepared — §10).
- **Generic user-editable rules engine + Rules screen** (Actual-grade machinery; single user needs cache+lock — post-v1).
- **Fuzzy payee clustering** (regex table + Teller counterparty pairs cover the bulk; fuzzball-based clustering post-v1).

---

## 2. Locked Decisions (with reasons)

| Decision | Choice | Why |
|---|---|---|
| Shell | **Electron** (not Tauri) | Teller requires mTLS client certs; in Electron main this is a 3-line Node `https.Agent`. Tauri's JS http plugin has **no client-cert support** (open issues #985/#917) → would force custom Rust on the security-critical path. Electron `safeStorage` (DPAPI) is built-in; Tauri's Stronghold is deprecated for v3. |
| Scaffold | **electron-vite** (`electron-vite-react` template) | 2026 default; HMR; proper main/preload/renderer split. |
| UI | **React 19 + TS + Tailwind + shadcn/ui + Recharts** | shadcn Charts are Recharts-based → themed financial charts nearly free. |
| DB | **better-sqlite3 + Drizzle ORM** | Typed schema/queries/migrations all in TS. Pin Electron + better-sqlite3 versions together (prebuild lag risk); escape hatch: `node:sqlite`. |
| Bank feed | **Teller.io development environment** | Free forever for personal use: 100 **lifetime** enrollments, real banks, transactions+balance for both `chase` and `amex` (verified in Teller's institutions API). No server — Connect hands accessToken directly to client. |
| Dev/test env | **Teller sandbox for ALL iteration** | Development env touched exactly twice (Phase 0 real enrollments) + update-mode repairs thereafter. Sandbox: unlimited enrollments, certs optional, scripted MFA/disconnect personas. |
| Backfill | **CSV import** (Chase checking, Chase credit, Amex extended) | Free; Chase credit + Amex CSVs include native Category columns → free backfill labels AND the early dashboard. |
| Taxonomy | **Plaid PFC 16 primaries** as canonical IDs, friendly display names on top | Separates spend vs transfers vs loan payments (the #1 cause of garbage spend numbers); Chase's 16, Teller's **28**, Amex's categories map ~1:1. |
| LLM | **Ollama + Qwen3 8B** (4B on weak hardware), temperature 0, JSON-schema enum output | Grammar-constrained decoding = output physically cannot leave the taxonomy. LLM is tier 4 of 4 — called once per new merchant ever. |
| Signing/distribution | **None.** Local build only | Locally built binaries never trigger SmartScreen (no Mark-of-the-Web). electron-updater + GitHub Releases only if ever shared. |

---

## 3. Architecture

```
┌─ Electron main process (privileged) ─────────────────────────┐
│  TellerClient      https.Agent({cert,key}) + Basic auth      │
│  SyncEngine        polling, cursor pagination, reconcile     │
│  CsvImporter       chase-checking | chase-credit | amex      │
│  Reconciler        dedup/matching (adapted Actual algorithm) │
│  Categorizer       4-tier resolver (rules→cache→source→LLM)  │
│  OllamaClient      localhost:11434, JSON-schema output       │
│  Db                better-sqlite3 + Drizzle + migrations     │
│  Secrets           safeStorage (DPAPI): token, enr_id, key   │
│  Scheduler         setInterval sync; Tray; openAtLogin       │
│  EnrollmentServer  127.0.0.1-only, temporary, Teller Connect │
└──────────────┬───────────────────────────────────────────────┘
               │ IPC (contextBridge) — typed repository API
┌──────────────┴───────────────────────────────────────────────┐
│  Renderer (React) — NO secrets, NO direct network/db access  │
│  Dashboard · Transactions · Accounts · Import · Review · Settings │
└───────────────────────────────────────────────────────────────┘
```

**Invariants that must never break:**
1. All Teller API traffic from main process only. Renderer/webview cannot do mTLS and must never see the private key or accessToken.
2. Renderer talks to a **repository-style interface** (`window.api.getTransactions(...)`, `syncNow()`, …). This is the future PWA lift-out seam (§10) AND the test seam.
3. Every Electron API (safeStorage, Tray, dialog, login items) wrapped behind a thin interface with an in-memory fake — decided in Phase 1 before any module that uses them.
4. **Dates are opaque `YYYY-MM-DD` strings end-to-end.** All grouping in SQL via `strftime`. Never construct a JS `Date` from a date-only string (`new Date('2026-02-01')` = UTC midnight = Jan 31 in US timezones). Lint rule enforces.
5. Sync/reconcile updates never modify `category_id` or `payee_id` on rows with `category_source='user'`, and never re-run the resolver on already-categorized rows.
6. `TELLER_ENV` config (sandbox|development) with **separate token/enrollment storage per environment**.

### Teller enrollment flow (Connect widget)
- Primary: temporary HTTP server bound to `127.0.0.1` (random port, single-shot), serving a page with `https://cdn.teller.io/connect/connect.js`; open system browser; page POSTs `onSuccess` payload back; listener dies. (Proven pattern — zrabin/personal-finance-mcp.) Fallback: BrowserWindow.
- `onSuccess` → `{accessToken, user.id, enrollment.id, ...}` — persist accessToken **and** enrollment.id encrypted.
- **Update mode from day one:** reconnect with `TellerConnect.setup({enrollmentId: "enr_..."})` — repairs the enrollment, same accessToken, **does not burn quota**. The 100-enrollment dev cap is LIFETIME ("deleting an enrollment does not restore your count"). Phase 0 verifies update mode re-delivers a working accessToken.
- Expect periodic disconnects (Chase MFA, Amex is OTP-happy): sync failures with enrollment-inactive semantics → persistent "Reconnect" badge on the account.

---

## 4. Data Model (SQLite, amounts = signed integer cents, negative = money out)

```sql
accounts(
  id TEXT PK, name TEXT, institution TEXT,          -- chase | amex
  source_kind TEXT,                                  -- teller | csv_only
  teller_account_id TEXT, teller_enrollment_id TEXT,
  mask TEXT, type TEXT, subtype TEXT,                -- depository/credit …
  status TEXT, closed INT DEFAULT 0, tombstone INT DEFAULT 0
);

transactions(
  id TEXT PK,                                        -- app UUID
  account_id TEXT NOT NULL REFERENCES accounts,
  source TEXT CHECK(source IN ('teller','chase_csv','amex_csv')),
  external_id TEXT,          -- BANK-ISSUED id only: Teller txn id | Amex Reference. NULL for hash-only CSV rows
  import_hash TEXT,          -- synthesized sha256 — idempotency ONLY, never treated as an id by the matcher
  linked_source_id TEXT,     -- cross-source match record
  txn_date TEXT,             -- earliest known transaction date (YYYY-MM-DD)
  post_date TEXT,            -- posting date; posting-only sources fill this, NEVER overwrite populated txn_date
  amount_cents INTEGER NOT NULL,
  status TEXT CHECK(status IN ('posted','pending')),
  payee_id TEXT REFERENCES payees,
  imported_payee TEXT, raw_description TEXT,         -- verbatim, kept forever
  category_id TEXT REFERENCES categories,
  source_category TEXT,                              -- Chase/Amex/Teller label as-is
  category_source TEXT CHECK(category_source IN ('user','rule','cache','source','llm')),
  notes TEXT, reconciled INT DEFAULT 0, tombstone INT DEFAULT 0,
  UNIQUE(account_id, source, import_hash)
);
CREATE UNIQUE INDEX ux_txn_external ON transactions(source, external_id) WHERE external_id IS NOT NULL;

payees(id PK, name, normalized_name, tombstone INT DEFAULT 0);
payee_mapping(id PK, target_id);

categories(id PK, name, pfc_code, parent_id, is_income INT, sort_order REAL);

merchant_category_cache(
  normalized_merchant TEXT PK, category_id TEXT,
  source TEXT CHECK(source IN ('rule','chase','amex','teller','llm','user')),
  confidence REAL, locked INT DEFAULT 0              -- user edits lock the row
);

rules(id PK, stage TEXT, conditions_op TEXT,         -- table kept for post-v1;
      conditions TEXT, actions TEXT,                 -- v1 defaults are HARD-CODED in code
      sort_order REAL, tombstone INT DEFAULT 0);

sync_log(id PK, ran_at, source, account_id, fetched INT, inserted INT,
         matched INT, gc_pending INT, errors TEXT);
```

**Spend definition (explicit):** spend per category = **net signed sum** of non-transfer, non-loan-payment categories. Refunds reduce the category they refund. Pending rows: shown in current-month dashboard with visual distinction, **excluded** from historical totals and exports. Charts clamp net-negative categories (bucket as "Refunds" line, exclude from donut).

Aggregates = SQL views over `(strftime('%Y-%m', txn_date), category_id)`. <100k rows — nothing fancier warranted.

---

## 5. Ingestion Pipeline

### 5a. Teller live sync
- Poll 2–4×/day (Teller refreshes banks ≥1×/24h itself; webhooks need a server — polling is the model).
- **Fetch strategy:** paginate backward with `from_id` cursor until **K consecutive already-known external_ids** are seen (not a fixed date window — catches backdated ACH, dispute reversals, post-repair backfills). Weekly deep resync: 90-day window, counts reconciled in sync_log. Fetch window always extends back to the **oldest local pending row's date**.
- Reconcile by Teller `id` first (ids occasionally change on pending→posted).
- **Pending GC (presence-based):** any local `status='pending'` row whose Teller id is **absent from the freshly fetched window** is tombstoned that sync. Before tombstoning, if a replacing posted row is identifiable (amount-tolerant ±20% + date window — tips change amounts), carry user edits (category_source='user', notes) onto it. Voided pre-auths thus disappear; tip-adjusted charges never double.
- Keep `details.counterparty.name` (cleaned merchant) and `details.category` (**28-value enum** — includes BOTH `transport` and `transportation`; exhaustiveness unit test; unknown value → fail-loud to review queue).
- 429 → exponential backoff. Enrollment-inactive → `status='reconnect_required'`.

### 5b. CSV importers (one parser per format, header-detected — never trust filename)
| Format | Header | Sign → canonical |
|---|---|---|
| Chase checking | `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #` | Already signed → as-is. Posting date only (fills post_date AND txn_date if unknown). Tolerate trailing-comma 8th field. |
| Chase credit | `Transaction Date,Post Date,Description,Category,Type,Amount,Memo` | Purchases negative → as-is. Keep `Category` (Chase's 16) as `source_category`. |
| Amex credit (extended) | `Date,Description,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category` | **Charges positive → INVERT.** Keep `Category`. `Reference` → `external_id` **only after Phase 0 gate proves it present/unique/stable across overlapping exports** — else NULL and hash-only. Never mixed-key: one scheme per source, decided once at the gate. |
- **Account attribution is explicit:** CSVs have no account column and two same-format cards export identical headers. Import wizard **requires** create-or-select of target account (filename last-4 as default hint, never silent); dry-run report names target account + mask before commit. A **"link CSV history to this Teller account"** action rewrites `account_id` on csv_only rows, then runs the reconciler over the merged account.
- Idempotency: `import_hash = sha256(account_id|post_date|amount_cents|raw_description|occurrence_index)`; `occurrence_index` disambiguates identical same-day rows; `UNIQUE(account_id, source, import_hash)` makes overlapping-file re-import a no-op.
- Validate sign sanity on first Chase-checking import against the running `Balance` column; fail loudly on unknown headers (formats undocumented, have changed before).

### 5c. Cross-source reconciliation (CSV backfill ↔ Teller feed overlap) — adapted from Actual Budget (MIT)
1. Exact **external_id** match (same namespace) → done.
2. Same account + **exact amount** + post date within ±7 days, candidates sorted by date distance, prefer same normalized payee.
3. First remaining window candidate regardless of payee.
- **strictIdChecking is NAMESPACE-SCOPED:** a fuzzy merge is blocked only when both candidates carry **bank-issued ids from the same namespace** (two different Teller ids, or two different Amex References). Synthesized import hashes are NOT ids — hash-only CSV rows are always fuzzy-eligible. Cross-namespace pairs (csv↔teller) are always eligible for passes 2–3. *(v1 critic consensus: the naive port of Actual's guard would have made cross-source matching dead code and double-counted the entire backfill overlap.)*
- **Candidate consumption:** each existing row matches at most once per import batch — two identical same-day coffees pair 1:1, never 2×2 or 0.
- On match: update existing row, record `linked_source_id`; **date precedence** — keep earliest txn_date (CSV transaction date wins over Teller posting date; a Jan-30 purchase posting Feb-2 stays in January regardless of source arrival order).
- Required tests (Phase 2): (a) import CSV → simulate Teller sync of same txns with Teller ids → **0 inserts, N matches**; (b) 2 identical same-day CSV coffees + 2 identical Teller coffees → 1:1; (c) Jan-30/Feb-2 pair → month stable in both import orders; (d) re-import same file → 0 changes.

### 5d. Transfer/payment exclusion — BOTH sides (biggest wrong-number risk)
- Card side: `Type=Payment` → LOAN_PAYMENTS (never spend).
- **Checking side (shipped default rules, locked, never reach LLM):** `CHASE CREDIT CRD (AUTOPAY|EPAY)`, `AMEX EPAYMENT`, `AMERICAN EXPRESS ACH PMT`, Chase Type `ACCT_XFER`, Zelle/`QUICKPAY` → LOAN_PAYMENTS / TRANSFER_OUT as appropriate. Otherwise the monthly -$2,400 autopay debit doubles total spend.
- **Integrity check in dashboard:** monthly sum(LOAN_PAYMENTS out of checking) ≈ sum(payments received on cards); divergence → warning banner (signature of a leaked payment row).
- Refund rule: positive-amount rows on credit accounts whose normalized merchant is in the cache inherit that category — never INCOME, never LLM.

---

## 6. Categorization — 4-tier resolver (LLM last)

```
(1) user override + shipped default rules (HARD-CODED ordered table in code, unit-tested)
(2) merchant_category_cache                → one LLM call per merchant EVER; user edit → locked
(3) source label mapping                   → Chase-16 / Amex / Teller-28 static maps → PFC
(4) Ollama batch call                      → only genuinely new merchants
```
- **v1 scope cut (critic-driven):** no generic rules engine, no Rules screen, no fuzzy clustering. "Recategorize once, remember forever" is delivered by cache+lock. The rules DB table stays in schema for post-v1.
- Payee normalization: regex table (strip `TST*`, `SQ *`, `PAYPAL *`, `AMZN Mktp`, `DD *DOORDASH`, `ORIG CO NAME:`… prefixes; store#/phone/trailing `CITY ST` noise) → title-case. Teller `counterparty.name` pairs (raw→clean) form a self-training dictionary that also normalizes CSV rows. (Post-v1: fuzzball token_sort_ratio ≥ 90 clustering — note: rapidfuzz is Python-only, fuzzball is the npm equivalent.)
- Ollama: batch 10–30 unique normalized merchants; system prompt = taxonomy + one-line definitions + few-shot from past user corrections; `format` = JSON schema with `category` **enum**; temperature 0. Low confidence → review queue.
- **Recategorize UI = two explicit actions:** "this transaction only" (row-level, `category_source='user'`, no cache write) vs "always for this merchant" (locked cache row + offer "apply to N existing" — updating only rows where `category_source != 'user'`).
- Amex noise: Plan It fees, Membership Rewards credits → shipped default rules.
- Steady state: ~10–40 new merchants/month → near-zero LLM calls.

---

## 7. UI (screens, v1)

| Screen | Content |
|---|---|
| **Dashboard** | Month spend by category (bar/donut, net-negative clamped), 12-month trend, top merchants, MoM deltas, payments-integrity banner. Transfers/payments excluded by definition; pendings badged, current month only. |
| **Transactions** | Virtualized table; filter account/category/date/text; inline recategorize (two-action); pending + source badges. |
| **Accounts** | Enrollment health; last sync; **Reconnect** (update mode); enrollment-quota counter; balances; "link CSV history" action. |
| **Import** | Drop CSV → header auto-detect → **account create-or-select (required)** → preview with parsed sign/date → dry-run dedup report ("38 new, 122 matched, 0 conflicts → into Chase Credit •4321") → commit. |
| **Review queue** | Low-confidence LLM categorizations to confirm/fix. |
| **Settings** | Sync schedule, TELLER_ENV indicator, Ollama model/endpoint, display names, backup/export (full CSV/JSON). |

(Rules screen: cut from v1.)

---

## 8. Security & Secrets Lifecycle

- `teller.zip` (cert + key, generated once at signup): **keep an offline backup** (password-manager attachment / encrypted archive off the dev box) — DPAPI ciphertext dies with the Windows profile and Teller's reissue policy is undocumented. In-app: PEM contents safeStorage-encrypted; no plaintext key file in app data.
- Cert expiry: check `notAfter` at startup, warn 30 days out; diary the date at Phase 0 (`openssl x509 -enddate`).
- accessToken + enrollment ids: safeStorage-encrypted, **per TELLER_ENV**.
- **Dev-time secrets:** gitignored local secrets dir (cert path + token) read by a config layer in development; safeStorage path used in packaged runtime. Losing the dev token is recoverable via update-mode re-auth (no quota burn — verified Phase 0).
- DPAPI ceiling acknowledged: per-user, not per-app — accepted for a personal machine.
- Enrollment listener: `127.0.0.1` only, random port, single-shot.
- Renderer: CSP, `contextIsolation: true`, `nodeIntegration: false`, no remote content.
- CSV test fixtures: **sanitizer script** rewrites real exports (scrambled merchants/amounts, preserved structure incl. trailing commas + sign conventions) into committable golden files — raw bank exports never enter the repo.

---

## 9. Phases & Task List

**Testing policy (scoped honestly):** vitest + in-memory better-sqlite3 + Electron-API fakes. **80%+ coverage on pure logic** — parsers, reconciler, normalizer, categorizer tiers, sync reconcile, SQL views — where all the risk lives. Shell/UI exempt. E2E v1 = one manual smoke checklist, no Playwright-Electron.

### Phase 0 — Spikes & account setup (de-risk, ~2–3 evenings)
- [ ] Teller signup → `teller.zip`; inspect key encoding (PKCS#1 vs #8); diary cert expiry; **offline backup**.
- [ ] Sandbox spike: Connect via localhost+browser pattern AND BrowserWindow; capture `onSuccess`. (Sandbox personas: password `password`, `otp`→`0000`, `disconnected` for reconnect UX.)
- [ ] mTLS spike: `https.Agent` handshake, `GET /accounts`.
- [ ] **Capture sanitized JSON fixtures** (sandbox + development: accounts, transactions incl. pending, enrollment-inactive error bodies) — SyncEngine tests run on these, never live API.
- [ ] Real CSV samples: Chase checking, Chase credit, **two overlapping Amex extended exports** → verify headers/signs; **diff Amex ranges: Reference present/unique/stable? → decide external_id vs hash-only for amex_csv, once**.
- [ ] **Per-account-type sign check:** same known transaction via Teller AND its CSV → assert canonical sign + cent-exact amount equality (validates sign maps AND the reconciler's exact-amount precondition).
- [ ] Verify update mode re-delivers a working accessToken.
- [ ] **Gate:** dev-env enrollment of real Chase + Amex succeeds (2 of 100 quota — the only two dev-env enrollments ever; all iteration on sandbox). If Teller-Amex fails → **fallback is Amex CSV-only** (already first-class); Plaid free tier only as one-off backfill trial — conflicting reports on current terms (Trial-plan-10-Items vs Limited-Production-200-calls), re-verify at gate, do not load-bear.

### Phase 1 — Skeleton + harness (~1 week part-time)
- [ ] Scaffold electron-vite-react + TS + Tailwind + shadcn/ui; main/preload/renderer per §3.
- [ ] **Test harness first:** vitest, in-memory sqlite, Electron-API interface + fakes (safeStorage, Tray, dialog, login items).
- [ ] Drizzle schema (§4) + migrations + seed PFC taxonomy.
- [ ] Typed IPC repository interface + contextBridge; renderer on mock data.
- [ ] `TELLER_ENV` config layer + per-env secret storage + dev-secrets dir; safeStorage module against the fake, then real.

### Phase 2 — CSV importers + reconciler (~1–1.5 weeks)
- [ ] Fixture sanitizer script; golden files from Phase 0 samples.
- [ ] Header-detecting parser framework; 3 format parsers (trailing comma, sign inversion, unknown-header loud failure).
- [ ] Idempotent ingestion: import_hash + occurrence_index; re-import → 0 changes.
- [ ] Reconciler: 3-pass, **namespace-scoped strictIdChecking, candidate consumption, date precedence** + the four required tests from §5c.
- [ ] Import wizard: account create-or-select, dry-run report, link-CSV-history action.

### Phase 2.5 — **Early dashboard** (~1 week) ← *the payoff, pulled forward*
- [ ] Static maps: Chase-16 → PFC, Amex → PFC (Teller-28 lands Phase 3) + exhaustiveness tests + fail-loud unknown values.
- [ ] Shipped default rules (hard-coded ordered table): card payments, **checking-side autopay/transfer descriptors (§5d)**, Amex Plan It/MR noise, Zelle.
- [ ] SQL views (month×category net-sum, merchant rollup, trends) + repository queries.
- [ ] Dashboard v1 + Transactions table with two-action recategorize.
- [ ] **Milestone: "how much did I spend on what" answered from 2 years of CSV, before any Teller code.**

### Phase 3 — Teller sync (~1–1.5 weeks)
- [ ] TellerClient (mTLS, Basic auth, versioned header, backoff) — tested on fixtures.
- [ ] Enrollment flow + persistence; **update-mode reconnect**; sandbox `disconnected` test.
- [ ] SyncEngine: cursor pagination until K known ids, weekly deep resync, **presence-based pending GC with user-edit carry-over**, sync_log.
- [ ] Teller-28 → PFC map; counterparty self-training dictionary.
- [ ] Accounts screen + quota counter; real Chase/Amex cutover; reconcile against CSV backfill (0-duplicate assertion on real data).

### Phase 4 — LLM tier + review queue (~1 week, honest after scope cuts)
- [ ] Payee normalizer (regex table) tested on real Phase 2 corpus.
- [ ] merchant_category_cache + lock semantics + "apply to N existing".
- [ ] OllamaClient (schema-enum, temp 0, batching) + review queue UI.
- [ ] Backfill categorization run; measure: % resolved per tier, misclassification spot-check.

### Phase 5 — Daemonize & polish (~2–3 evenings)
- [ ] Tray, close-to-hide, scheduler, `openAtLogin`, sync notifications.
- [ ] Payments-integrity banner; full export; DB backup rotation.
- [ ] Error surfacing pass: every swallowed error becomes a visible toast/log entry.
- [ ] Manual smoke checklist.

---

## 10. Future: iPhone access (out of scope v1, seam prepared)
Renderer is plain React behind the repository interface. PWA later = small self-hosted API server on the Linux box holding cert+token+DB (mTLS/SQLite can't live in a browser; Teller forbids shipping the key). Desktop impl = IPC; PWA impl = fetch. No renderer rewrite.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Teller enrollment staleness (Chase MFA, Amex OTP) | Update-mode reconnect day one; health badges; polling detects via API failures |
| 100 lifetime dev enrollments | Sandbox-only iteration; dev env touched twice ever; quota counter in UI |
| Cert expiry undocumented / DPAPI profile loss | Offline teller.zip backup; startup expiry check + 30-day warning |
| Chase/Amex CSV format drift | Header detection, loud failure, sign sanity vs Balance column |
| Teller drops an institution | CSV path stays first-class; Plaid only after re-verifying current free terms (conflicting reports) |
| Double-counted spend (payments/transfers/refunds/pendings) | §5d both-sides rules, integrity banner, net-sum spend definition, presence-based pending GC — all with dedicated tests |
| better-sqlite3 prebuild lag | Pin versions; `node:sqlite` escape hatch |
| LLM miscategorizes ambiguous merchants (~10–15%) | Enum-constrained output, confidence review queue, cache+lock on correction |

---

## Appendix: v1 → v2 review changes (3-critic adversarial pass)
1. **strictIdChecking namespace-scoped** (consensus finding: naive port disabled all cross-source matching → would have double-counted the entire backfill overlap). `source_id` split into `external_id` (bank-issued only) + `import_hash` (idempotency only).
2. CSV **account attribution** made explicit (wizard picker + link-history action) — CSVs carry no account identity.
3. Pending GC switched to **presence-based** (tip adjustments, voided pre-auths).
4. **Checking-side payment/transfer rules** added (autopay debit was free to double total spend); integrity banner.
5. Refund/return + pending + net-sum **spend semantics defined**; date precedence + string-date invariant.
6. Recategorize split into **transaction-only vs always-merchant**; user categorizations immune to sync overwrites.
7. **Phases reordered:** dashboard at ~week 3 from CSV + native categories (was week 5–6); rules engine, Rules screen, fuzzy clustering cut to post-v1.
8. **Teller environment strategy:** sandbox for all iteration, fixtures captured Phase 0, per-env secrets, dev-secrets dir, teller.zip offline backup.
9. Plaid fallback demoted (free-tier terms conflicting/unverified) → Amex CSV-only is the real fallback.
10. Corrections: Teller category enum = **28** values (not 27); rapidfuzz → **fuzzball** (npm); test policy scoped to pure logic.
