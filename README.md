# What's Left

Local-first personal expense tracker. Pulls Chase + Amex transactions via **Plaid** (free Trial plan) and **bank CSV exports**, categorizes them on-device (rules → merchant cache → bank labels → local LLM via Ollama), and answers one question fast: **how much did I spend, on what?**

Everything stays on your machine: SQLite on disk, secrets DPAPI/keychain-encrypted, no cloud, no server, no telemetry.

## Stack

Electron (main = the "server": Plaid client, sync engine, SQLite, secrets) · React 19 + Tailwind v4 + Recharts renderer · better-sqlite3 + Drizzle · zod at every external boundary · vitest (721 tests).

## Run it

```bash
npm install

# desktop app (any OS with a display)
npm run sqlite:electron   # flip native sqlite to Electron's ABI
npm run dev

# browser-only preview with demo data (no Electron, headless-friendly)
npm run dev:web           # → http://<host>:5173
```

### The dual-ABI thing (read once)

`better-sqlite3` compiles against ONE runtime. Tests run under Node, the app under Electron — flip before each:

```bash
npm run sqlite:node       # before: npm test
npm run sqlite:electron   # before: npm run dev / electron .
```

Electron is pinned to `^42` because better-sqlite3 publishes prebuilds only up to that ABI — bump both together after checking [releases](https://github.com/WiseLibs/better-sqlite3/releases).

## Bank feed setup (Plaid, $0)

1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com) → apply for the **Trial plan** (10 lifetime Production Items free; you need 2 — one Chase login, one Amex).
2. Sanity-check your keys without the app:
   ```bash
   echo '{"clientId":"...","secret":"<sandbox secret>"}' > .secrets/plaid-sandbox.json
   node scripts/plaid-sandbox-smoke.mjs
   ```
3. In the app: Settings → provider *Plaid* → client_id + secret (write-only, stored encrypted) → Accounts → *Add account*. Bank linking opens your browser; OAuth banks (Chase/Amex) pop their own window — allow popups for the 127.0.0.1 page.
4. **Never re-link a broken connection fresh — always use the Reconnect button** (Link update mode). Fresh links permanently burn one of the 10 lifetime Items; the counter is in Settings.

No Plaid yet? CSV import is first-class: chase.com / amex.com → download activity CSV → Import screen. Re-importing overlapping ranges is safe (idempotent, dry-run before commit).

## Development

```bash
npm run typecheck   # tsc strict, whole repo
npm test            # 721 tests (sqlite:node first)
npm run build       # electron-vite production bundles
```

- `docs/PLAN.md` — the full design: architecture invariants, reconciliation algorithm, categorization tiers, review-hardened decisions.
- `design/whats-left.dc.html` — the UI design canvas the renderer is ported from.
- Provider modules under `src/main/core/{plaid,teller,csv}` sit behind one interface; Teller is dormant (signup closed) but tested, in case it reopens.

## License

MIT
