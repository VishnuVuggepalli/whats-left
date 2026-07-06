import type { AccountType, Source, TxnDraft } from '../../../shared/types'
import type { MerchantCachePort } from '../ports'
import { applyDefaultRules } from './defaultRules'
import { mapSourceCategory } from './maps'
import { CATEGORY_IDS } from './taxonomy'

/**
 * 4-tier category resolver (plan §6): rules → cache → source label → LLM.
 * The LLM tier is represented by { needsLlm: true } — the caller batches those
 * merchants to Ollama and feeds the answers back via applyLlmResults.
 *
 * A LOCKED cache row is a user's "always for this merchant" decision and wins
 * over everything, including shipped rules; it is never overwritten here.
 */

export interface ResolveInput {
  draft: TxnDraft
  accountType: AccountType
  normalizedMerchant: string
}

export interface ResolveDeps {
  cache: MerchantCachePort
}

export interface ResolvedCategory {
  categoryId: string
  categorySource: 'rule' | 'cache' | 'source'
  confidence?: number
}

export type ResolveOutcome = ResolvedCategory | { needsLlm: true }

export function resolveCategory(input: ResolveInput, deps: ResolveDeps): ResolveOutcome {
  const { draft, accountType } = input
  const merchant = input.normalizedMerchant.trim()
  const cached = merchant === '' ? null : deps.cache.get(merchant)

  // Locked user rows always win — even over shipped rules.
  if (cached !== null && cached.locked) {
    return { categoryId: cached.categoryId, categorySource: 'cache' }
  }

  // (1) shipped default rules
  const ruleHit = applyDefaultRules(draft, accountType)
  if (ruleHit !== null) {
    writeCacheRow(deps.cache, merchant, ruleHit.categoryId, 'rule')
    return { categoryId: ruleHit.categoryId, categorySource: 'rule' }
  }

  // (2) merchant cache — also the refund guard: a positive amount on a credit
  // account with a cache-known merchant inherits that category, never income.
  if (cached !== null) {
    return { categoryId: cached.categoryId, categorySource: 'cache' }
  }

  // (3) source label mapping
  const mapped = mapSourceCategory(draft.source, draft.sourceCategory)
  if (mapped !== null) {
    if (mapped === 'income' && accountType === 'credit' && draft.amountCents > 0) {
      // Refund guard, part 2: a positive row on a credit account is a refund or
      // rebate, never income (plan §5d). Unknown merchant → let the LLM decide.
      return { needsLlm: true }
    }
    const cacheSource = cacheSourceFor(draft.source)
    if (cacheSource !== null) writeCacheRow(deps.cache, merchant, mapped, cacheSource)
    return { categoryId: mapped, categorySource: 'source' }
  }

  // (4) genuinely new merchant → LLM batch
  return { needsLlm: true }
}

/**
 * Feed LLM batch answers into the merchant cache (source='llm' + confidence).
 * Locked rows are skipped — user categorizations win forever. Invalid LLM
 * output (category outside the taxonomy, bad confidence) throws: the Ollama
 * schema-enum makes it impossible in practice, so reaching it is a bug.
 */
export function applyLlmResults(
  results: ReadonlyArray<{ merchant: string; category: string; confidence: number }>,
  deps: ResolveDeps,
): { written: number; skippedLocked: number } {
  let written = 0
  let skippedLocked = 0

  for (const result of results) {
    const merchant = result.merchant.trim()
    if (merchant === '') {
      throw new Error('applyLlmResults: empty merchant name in LLM result')
    }
    if (!CATEGORY_IDS.includes(result.category)) {
      throw new Error(
        `applyLlmResults: category ${JSON.stringify(result.category)} for merchant ` +
          `${JSON.stringify(merchant)} is not in the taxonomy`,
      )
    }
    if (!(result.confidence >= 0 && result.confidence <= 1)) {
      throw new Error(
        `applyLlmResults: confidence ${String(result.confidence)} for merchant ` +
          `${JSON.stringify(merchant)} is not in [0, 1]`,
      )
    }

    const existing = deps.cache.get(merchant)
    if (existing !== null && existing.locked) {
      skippedLocked += 1
      continue
    }
    deps.cache.set({
      normalizedMerchant: merchant,
      categoryId: result.category,
      source: 'llm',
      confidence: result.confidence,
      locked: false,
    })
    written += 1
  }

  return { written, skippedLocked }
}

function cacheSourceFor(source: Source): 'teller' | 'chase' | 'amex' | null {
  switch (source) {
    case 'plaid':
      // merchant_category_cache.source has no 'plaid' value (frozen schema
      // CHECK) and every plaid row already carries its PFC label, so tier 3
      // always resolves plaid rows without a cache row — skip the write
      // instead of widening the CHECK constraint.
      return null
    case 'teller':
      return 'teller'
    case 'chase_csv':
      return 'chase'
    case 'amex_csv':
      return 'amex'
    default:
      return assertNever(source)
  }
}

function writeCacheRow(
  cache: MerchantCachePort,
  merchant: string,
  categoryId: string,
  source: 'rule' | 'teller' | 'chase' | 'amex',
): void {
  if (merchant === '') return // nothing to key a cache row on
  const existing = cache.get(merchant)
  if (existing !== null && existing.locked) return // user decision is immutable
  cache.set({ normalizedMerchant: merchant, categoryId, source, confidence: null, locked: false })
}

function assertNever(x: never): never {
  throw new Error(`Unhandled source: ${JSON.stringify(x)}`)
}
