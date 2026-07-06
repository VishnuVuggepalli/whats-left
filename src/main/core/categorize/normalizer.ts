/**
 * Payee normalization (plan §6): a deterministic, pure regex-table pipeline.
 * uppercase → ACH extraction → channel noise → processor prefixes → noise
 * tokens → location tail → Title Case. Best-effort display cleanup, not
 * perfect merchant resolution ('Wholefds' is explicitly acceptable per plan).
 * Idempotent: normalizePayee(normalizePayee(x)) === normalizePayee(x).
 */

const US_STATES: ReadonlySet<string> = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR',
])

interface PrefixRule {
  re: RegExp
  replacement: string
}

/**
 * Processor prefixes, first match wins. Whole-string rules replace the entire
 * descriptor (the remainder is processor junk, not merchant).
 */
const PROCESSOR_PREFIXES: readonly PrefixRule[] = [
  { re: /^AMZN MKTP\b.*$/, replacement: 'AMAZON MARKETPLACE' },
  { re: /^AMAZON\.COM.*$/, replacement: 'AMAZON' },
  { re: /^APPLE\.COM\/BILL\b.*$/, replacement: 'APPLE' },
  { re: /^UBER\s*\*\s*/, replacement: 'UBER ' }, // UBER *EATS → keep 'UBER EATS'
  { re: /^DD\s*\*\s*DOORDASH\s*/, replacement: '' },
  { re: /^TST\*\s*/, replacement: '' },
  { re: /^SQ\s*\*\s*/, replacement: '' },
  { re: /^PAYPAL\s*\*\s*/, replacement: '' },
  { re: /^PP\*\s*/, replacement: '' },
  { re: /^CASH APP\s*\*\s*/, replacement: '' },
  { re: /^VENMO\s*\*\s*/, replacement: '' },
  { re: /^GOOGLE\s*\*\s*/, replacement: '' },
  { re: /^SP\s*\*\s*/, replacement: '' },
]

/** Chase-checking ACH boilerplate: merchant lives in ORIG CO NAME:<X> */
const ACH_ORIG_CO_RE =
  /ORIG CO NAME:\s*(.*?)\s*(?:ORIG ID|DESC DATE|CO ENTRY|SEC:|IND ID|IND NAME|TRACE#|EED:|TRN:|$)/

/** payment-channel noise, e.g. 'POS DEBIT CARD 1234 <merchant>' */
const CHANNEL_NOISE_RE = /\bPOS DEBIT CARD \d+\b/g

/** ACH trailer ids: 'PPD ID: 4760039224', 'WEB ID: 9493560001', ... */
const ACH_TRAILER_ID_RE = /\b(?:PPD|WEB|CCD|ARC|POP)\s+ID:?\s*\d*/g

/** store numbers, phone numbers, reference numbers, date fragments: '#552', '0042', '866-579-7172', '07/02332' */
const NOISE_TOKEN_RE = /^#?\d+(?:[/.\-]\d+)*$/

/** standalone punctuation tokens: '#', '-', '*' */
const PUNCT_TOKEN_RE = /^[-–—#*&/.]+$/

export function normalizePayee(raw: string): string {
  const upper = collapseWhitespace(raw.toUpperCase())
  if (upper === '') return ''

  let work = upper

  const achMerchant = extractAchMerchant(work)
  if (achMerchant !== null) work = achMerchant

  work = work.replace(CHANNEL_NOISE_RE, ' ')
  work = applyProcessorPrefix(work)
  work = work.replace(ACH_TRAILER_ID_RE, ' ')

  let tokens = collapseWhitespace(work)
    .split(' ')
    .filter((t) => t !== '' && !NOISE_TOKEN_RE.test(t) && !PUNCT_TOKEN_RE.test(t))
  tokens = stripLocationTail(tokens)

  const cleaned = tokens.join(' ')
  // Fail-safe: if the pipeline stripped everything, fall back to the raw text
  // (title-cased) rather than returning an empty merchant name.
  return titleCase(cleaned === '' ? upper : cleaned)
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function extractAchMerchant(s: string): string | null {
  if (!s.includes('ORIG CO NAME:')) return null
  const m = ACH_ORIG_CO_RE.exec(s)
  return m?.[1] ?? null
}

function applyProcessorPrefix(s: string): string {
  for (const { re, replacement } of PROCESSOR_PREFIXES) {
    if (re.test(s)) return s.replace(re, replacement)
  }
  return s
}

/**
 * Trailing-location heuristic: drop a final US state code, then the preceding
 * city token (only when enough tokens remain that we are not eating the
 * merchant name), then a leftover city abbreviation ('WHOLEFDS SEA SEATTLE WA'
 * → SEA is a prefix of the dropped SEATTLE → drop it too → 'WHOLEFDS').
 * Documented tradeoff: a trailing 'CO' meaning Company reads as Colorado.
 */
function stripLocationTail(tokens: readonly string[]): string[] {
  const last = tokens[tokens.length - 1]
  if (tokens.length < 2 || last === undefined || !US_STATES.has(last)) {
    return [...tokens]
  }
  let out = tokens.slice(0, -1)

  if (out.length >= 3) {
    const city = out[out.length - 1]
    if (city !== undefined && /^[A-Z]+$/.test(city)) {
      out = out.slice(0, -1)
      const abbrev = out[out.length - 1]
      if (
        out.length >= 2 &&
        abbrev !== undefined &&
        abbrev.length >= 2 &&
        abbrev.length < city.length &&
        city.startsWith(abbrev)
      ) {
        out = out.slice(0, -1)
      }
    }
  }
  return out
}

function titleCase(s: string): string {
  return s
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}
