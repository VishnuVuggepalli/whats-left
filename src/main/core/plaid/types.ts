import { z } from 'zod'

/**
 * Zod schemas for Plaid API payloads. Validated at the boundary — the rest of
 * the app never sees an unvalidated Plaid response (plan §5a: never trust
 * external data; unknown shapes fail loudly).
 *
 * Notes:
 * - Plaid amounts are JSON NUMBERS in dollars, and the sign convention is the
 *   OPPOSITE of ours: POSITIVE = money out. The mapper (sync.ts) converts to
 *   integer cents and inverts.
 * - Dates are 'YYYY-MM-DD' strings, kept opaque (plan §3 invariant 4).
 *   `date` is the posted date (or expected date while pending);
 *   `authorized_date` is the swipe date, nullable.
 * - Unknown keys (request_id, payment_channel, …) are stripped by default so
 *   transport noise never leaks downstream.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const isoDateString = z.string().regex(ISO_DATE_RE, "expected 'YYYY-MM-DD' date string")

export const plaidPersonalFinanceCategorySchema = z.object({
  primary: z.string().min(1),
  detailed: z.string().min(1),
  confidence_level: z.string().nullish(),
})

export const plaidTransactionSchema = z.object({
  transaction_id: z.string().min(1),
  account_id: z.string().min(1),
  /** dollars as a NUMBER; Plaid convention: POSITIVE = money OUT */
  amount: z.number(),
  iso_currency_code: z.string().nullable(),
  /** posted date, or the expected date while pending */
  date: isoDateString,
  /** the swipe date; often null for ACH/checking activity */
  authorized_date: isoDateString.nullable(),
  name: z.string(),
  merchant_name: z.string().nullable(),
  pending: z.boolean(),
  /** links a posted txn to the pending row it replaces */
  pending_transaction_id: z.string().nullable(),
  personal_finance_category: plaidPersonalFinanceCategorySchema.nullable(),
})

export const plaidRemovedTransactionSchema = z.object({
  transaction_id: z.string().min(1),
  /** present on current API versions; tolerate its absence defensively */
  account_id: z.string().min(1).nullish(),
})

export const plaidSyncResponseSchema = z.object({
  added: z.array(plaidTransactionSchema),
  modified: z.array(plaidTransactionSchema),
  removed: z.array(plaidRemovedTransactionSchema),
  next_cursor: z.string(),
  has_more: z.boolean(),
})

export const plaidAccountBalancesSchema = z.object({
  available: z.number().nullable(),
  current: z.number().nullable(),
  iso_currency_code: z.string().nullable(),
})

export const plaidAccountSchema = z.object({
  account_id: z.string().min(1),
  name: z.string(),
  official_name: z.string().nullish(),
  mask: z.string().nullable(),
  /** 'depository' | 'credit' | 'loan' | 'investment' | … — filtered at upsert */
  type: z.string().min(1),
  subtype: z.string().nullable(),
  balances: plaidAccountBalancesSchema,
})

export const plaidItemSchema = z.object({
  item_id: z.string().min(1),
  institution_id: z.string().nullish(),
})

export const plaidAccountsGetResponseSchema = z.object({
  accounts: z.array(plaidAccountSchema),
  item: plaidItemSchema,
})

export const plaidLinkTokenResponseSchema = z.object({
  link_token: z.string().min(1),
  expiration: z.string().optional(),
})

export const plaidExchangeResponseSchema = z.object({
  access_token: z.string().min(1),
  item_id: z.string().min(1),
})

export const plaidErrorSchema = z.object({
  error_type: z.string().min(1),
  error_code: z.string().min(1),
  error_message: z.string().optional(),
})

export type PlaidTransaction = z.infer<typeof plaidTransactionSchema>
export type PlaidRemovedTransaction = z.infer<typeof plaidRemovedTransactionSchema>
export type PlaidSyncResponse = z.infer<typeof plaidSyncResponseSchema>
export type PlaidAccount = z.infer<typeof plaidAccountSchema>
export type PlaidAccountsGetResponse = z.infer<typeof plaidAccountsGetResponseSchema>
export type PlaidError = z.infer<typeof plaidErrorSchema>
