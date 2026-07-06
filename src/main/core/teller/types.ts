import { z } from 'zod'

/**
 * Zod schemas for Teller API payloads. Validated at the boundary — the rest of
 * the app never sees an unvalidated Teller response (plan §5a: never trust
 * external data; unknown shapes fail loudly).
 *
 * Notes:
 * - Teller amounts are SIGNED DECIMAL STRINGS (e.g. "-6.75"), never numbers.
 * - Dates are 'YYYY-MM-DD' strings, kept opaque (plan §3 invariant 4).
 * - Unknown keys (e.g. `links`) are stripped by default so transport noise
 *   never leaks downstream.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SIGNED_AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/

const isoDateString = z.string().regex(ISO_DATE_RE, "expected 'YYYY-MM-DD' date string")
const signedAmountString = z
  .string()
  .regex(SIGNED_AMOUNT_RE, 'expected signed decimal amount string, e.g. "-6.75"')

export const tellerInstitutionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
})

export const tellerAccountSchema = z.object({
  id: z.string().min(1),
  enrollment_id: z.string().min(1),
  institution: tellerInstitutionSchema,
  type: z.enum(['depository', 'credit']),
  subtype: z.string(),
  name: z.string(),
  last_four: z.string(),
  currency: z.string(),
  status: z.string().min(1),
})

export const tellerAccountsSchema = z.array(tellerAccountSchema)

export const tellerCounterpartySchema = z.object({
  name: z.string().nullable(),
  type: z.string().nullable(),
})

export const tellerTransactionDetailsSchema = z.object({
  processing_status: z.string(),
  category: z.string().nullable(),
  counterparty: tellerCounterpartySchema.nullable(),
})

export const tellerTransactionSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  date: isoDateString,
  description: z.string(),
  amount: signedAmountString,
  status: z.enum(['posted', 'pending']),
  type: z.string(),
  running_balance: signedAmountString.nullable(),
  details: tellerTransactionDetailsSchema,
})

export const tellerTransactionsSchema = z.array(tellerTransactionSchema)

export const tellerBalancesSchema = z.object({
  account_id: z.string().min(1),
  available: signedAmountString.nullable(),
  ledger: signedAmountString.nullable(),
})

export const tellerErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
  }),
})

export type TellerAccount = z.infer<typeof tellerAccountSchema>
export type TellerTransaction = z.infer<typeof tellerTransactionSchema>
export type TellerBalances = z.infer<typeof tellerBalancesSchema>
export type TellerError = z.infer<typeof tellerErrorSchema>
