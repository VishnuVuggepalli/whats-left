#!/usr/bin/env node
/**
 * Plaid Sandbox smoke test — proves your keys work end-to-end without the app:
 *   /sandbox/public_token/create → /item/public_token/exchange → /accounts/get
 *   → one /transactions/sync page.
 *
 * Credentials (either):
 *   - env: PLAID_CLIENT_ID + PLAID_SECRET (sandbox secret)
 *   - file: .secrets/plaid-sandbox.json  {"clientId": "...", "secret": "..."}
 *
 * Run: node scripts/plaid-sandbox-smoke.mjs
 * Sandbox only — never point this at production.
 */
import { readFileSync } from 'node:fs'

const BASE = 'https://sandbox.plaid.com'

function loadCreds() {
  const { PLAID_CLIENT_ID, PLAID_SECRET } = process.env
  if (PLAID_CLIENT_ID && PLAID_SECRET) return { clientId: PLAID_CLIENT_ID, secret: PLAID_SECRET }
  try {
    const raw = JSON.parse(readFileSync(new URL('../.secrets/plaid-sandbox.json', import.meta.url), 'utf8'))
    if (raw.clientId && raw.secret) return raw
  } catch {
    /* fall through to the error below */
  }
  console.error(
    'No credentials. Set PLAID_CLIENT_ID + PLAID_SECRET env vars, or create .secrets/plaid-sandbox.json {"clientId","secret"} (gitignored).',
  )
  process.exit(1)
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'plaid-version': '2020-09-14',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    console.error(`✗ ${path} → HTTP ${res.status}`)
    console.error(JSON.stringify(json, null, 2))
    process.exit(1)
  }
  return json
}

const { clientId, secret } = loadCreds()
const auth = { client_id: clientId, secret }

console.log('1/4 creating sandbox public_token (First Platypus Bank)…')
const pub = await post('/sandbox/public_token/create', {
  ...auth,
  institution_id: 'ins_109508',
  initial_products: ['transactions'],
})
console.log('    ✓ public_token created')

console.log('2/4 exchanging for access_token…')
const exch = await post('/item/public_token/exchange', { ...auth, public_token: pub.public_token })
console.log(`    ✓ item_id ${exch.item_id}`)

console.log('3/4 calling /accounts/get…')
const accounts = await post('/accounts/get', { ...auth, access_token: exch.access_token })
for (const a of accounts.accounts) {
  console.log(`    ✓ ${a.name} (${a.subtype}) ••${a.mask} — balance ${a.balances.current}`)
}

console.log('4/4 first /transactions/sync page…')
const sync = await post('/transactions/sync', { ...auth, access_token: exch.access_token })
console.log(
  `    ✓ added=${sync.added.length} modified=${sync.modified.length} removed=${sync.removed.length} has_more=${sync.has_more} cursor=${sync.next_cursor === '' ? '(initial pull still preparing — the app handles this)' : 'ok'}`,
)

console.log('\nAll four calls succeeded — your sandbox keys are good. Same keys + client_id go into the app Settings (env: sandbox).')
