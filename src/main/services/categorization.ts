import type { AccountType, CategorySource, TxnDraft } from '../../shared/types'
import { normalizePayee } from '../core/categorize/normalizer'
import { applyLlmResults, resolveCategory } from '../core/categorize/resolver'
import { OllamaUnavailableError } from '../core/ollama/client'
import type { MerchantCachePort } from '../core/ports'

/**
 * Categorization pipeline for freshly ingested rows (plan §6): each row runs
 * the 4-tier resolver; rows the resolver defers to the LLM are batched to
 * Ollama when it is reachable, otherwise they stay uncategorized and surface
 * in Review. NEVER called for rows that already have a category
 * (plan §3 invariant 5) — callers filter first.
 */

/** the LLM slice AppService needs (implemented by OllamaClient) */
export interface LlmPort {
  isAvailable(): Promise<boolean>
  categorizeMerchants(
    merchants: string[],
    fewShot: Array<{ merchant: string; category: string }>,
  ): Promise<Array<{ merchant: string; category: string; confidence: number }>>
}

/** one freshly inserted, still-uncategorized row + the draft it came from */
export interface CategorizableRow {
  txnId: string
  draft: TxnDraft
  accountType: AccountType
}

/** repo slice: merchant cache + the row-category writer */
export interface CategorizeSink extends MerchantCachePort {
  setTxnCategory(txnId: string, categoryId: string, source: CategorySource, confidence?: number): void
}

export interface CategorizeResult {
  resolved: number
  llmCategorized: number
  leftUncategorized: number
}

export async function categorizeRows(
  rows: readonly CategorizableRow[],
  deps: { cache: CategorizeSink; llm: LlmPort | null },
): Promise<CategorizeResult> {
  const { cache, llm } = deps
  let resolved = 0
  const pendingLlm = new Map<string, string[]>() // normalized merchant → txn ids
  let unresolvableMerchant = 0

  for (const row of rows) {
    const merchant = normalizePayee(row.draft.importedPayee)
    const outcome = resolveCategory(
      { draft: row.draft, accountType: row.accountType, normalizedMerchant: merchant },
      { cache },
    )
    if ('needsLlm' in outcome) {
      if (merchant === '') {
        unresolvableMerchant += 1 // nothing to key a cache row on — Review handles it
        continue
      }
      pendingLlm.set(merchant, [...(pendingLlm.get(merchant) ?? []), row.txnId])
      continue
    }
    cache.setTxnCategory(row.txnId, outcome.categoryId, outcome.categorySource)
    resolved += 1
  }

  if (pendingLlm.size === 0) {
    return { resolved, llmCategorized: 0, leftUncategorized: unresolvableMerchant }
  }

  const llmCategorized = await runLlmTier(pendingLlm, cache, llm)
  const queued = [...pendingLlm.values()].reduce((n, ids) => n + ids.length, 0)
  return {
    resolved,
    llmCategorized,
    leftUncategorized: unresolvableMerchant + (queued - llmCategorized),
  }
}

/**
 * Tier 4: batch the deduplicated merchants to Ollama. Transport failure is a
 * degraded mode, not a crash — rows stay uncategorized for Review. Content
 * errors were already degraded by OllamaClient to 'uncategorized' entries
 * with confidence 0, which land in the review queue via low confidence.
 */
async function runLlmTier(
  pendingLlm: ReadonlyMap<string, readonly string[]>,
  cache: CategorizeSink,
  llm: LlmPort | null,
): Promise<number> {
  if (llm === null) return 0
  try {
    if (!(await llm.isAvailable())) return 0
    const merchants = [...pendingLlm.keys()]
    const results = await llm.categorizeMerchants(merchants, [])
    applyLlmResults(results, { cache })
    let categorized = 0
    for (const result of results) {
      const txnIds = pendingLlm.get(result.merchant)
      if (txnIds === undefined) {
        throw new Error(
          `categorizeRows: LLM returned unrequested merchant ${JSON.stringify(result.merchant)}`,
        )
      }
      for (const txnId of txnIds) {
        cache.setTxnCategory(txnId, result.category, 'llm', result.confidence)
        categorized += 1
      }
    }
    return categorized
  } catch (err) {
    if (err instanceof OllamaUnavailableError) return 0
    throw err
  }
}
