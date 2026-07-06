import type { CategorizerLlmPort } from '../ports'
import { buildSystemPrompt, buildUserPrompt, type FewShotExample } from './prompt'
import {
  categorizationArraySchema,
  chatEnvelopeSchema,
  RESPONSE_JSON_SCHEMA,
  type CategorizationItem,
} from './schema'

/**
 * Ollama categorization client — tier 4 of the resolver (plan §6).
 * Called once per genuinely new merchant ever; temperature 0; enum-constrained
 * JSON-schema output. Content errors NEVER throw (merchants fall back to
 * 'uncategorized' + warning); transport errors throw OllamaUnavailableError so
 * the caller keeps the transactions in the review queue.
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
export const DEFAULT_MODEL = 'qwen3:8b'
export const OLLAMA_BATCH_SIZE = 30

const UNCATEGORIZED_ID = 'uncategorized'

/** Ollama unreachable or returned a non-2xx status (transport failure) */
export class OllamaUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OllamaUnavailableError'
  }
}

export interface OllamaClientOptions {
  baseUrl?: string
  model?: string
  fetchImpl?: typeof fetch
}

/** port result plus an optional warning for degraded (fallback) entries */
export interface MerchantCategorization {
  merchant: string
  category: string
  confidence: number
  /** set when the model omitted this merchant or its output failed validation */
  warning?: string
}

export class OllamaClient implements CategorizerLlmPort {
  private readonly baseUrl: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL)
    this.model = options.model ?? DEFAULT_MODEL
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /**
   * Categorize merchants in sequential batches of OLLAMA_BATCH_SIZE.
   * Every requested merchant appears exactly once in the result, in input
   * order — merchants the model dropped come back as 'uncategorized' with
   * confidence 0 and a warning, never silently omitted.
   */
  async categorizeMerchants(
    merchants: string[],
    fewShot: Array<{ merchant: string; category: string }>,
  ): Promise<MerchantCategorization[]> {
    if (merchants.length === 0) return []
    const systemPrompt = buildSystemPrompt(fewShot)
    const results: MerchantCategorization[] = []
    for (const batch of chunk(merchants, OLLAMA_BATCH_SIZE)) {
      const batchResults = await this.categorizeBatch(batch, systemPrompt)
      results.push(...batchResults)
    }
    return results
  }

  /** GET /api/tags → reachable? Never throws by contract. */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, { method: 'GET' })
      return response.ok
    } catch {
      // Contract: availability probe never throws — unreachable means false.
      return false
    }
  }

  private async categorizeBatch(
    batch: readonly string[],
    systemPrompt: string,
  ): Promise<MerchantCategorization[]> {
    const requestBody = {
      model: this.model,
      stream: false,
      format: RESPONSE_JSON_SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserPrompt(batch) },
      ],
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
    } catch (error: unknown) {
      throw new OllamaUnavailableError(`ollama request failed: ${describeError(error)}`, {
        cause: error,
      })
    }
    if (!response.ok) {
      throw new OllamaUnavailableError(`ollama responded with HTTP ${response.status}`)
    }

    let rawBody: unknown
    try {
      rawBody = await response.json()
    } catch {
      return fallbackBatch(batch, 'ollama returned a non-JSON response body')
    }

    const envelope = chatEnvelopeSchema.safeParse(rawBody)
    if (!envelope.success) {
      return fallbackBatch(batch, 'ollama response was missing message.content')
    }

    let content: unknown
    try {
      content = JSON.parse(envelope.data.message.content)
    } catch {
      return fallbackBatch(batch, 'model output was not valid JSON')
    }

    const parsed = categorizationArraySchema.safeParse(content)
    if (!parsed.success) {
      return fallbackBatch(
        batch,
        `model output failed schema validation: ${summarizeZodIssues(parsed.error.issues)}`,
      )
    }

    return alignToRequested(batch, parsed.data)
  }
}

/* ------------------------------------------------------------------ */
/* helpers (pure, no input mutation)                                   */
/* ------------------------------------------------------------------ */

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function normalizeKey(merchant: string): string {
  return merchant.trim().toLowerCase()
}

function fallbackBatch(batch: readonly string[], warning: string): MerchantCategorization[] {
  return batch.map((merchant) => ({
    merchant,
    category: UNCATEGORIZED_ID,
    confidence: 0,
    warning,
  }))
}

/**
 * Map model output back onto the requested merchants, in request order.
 * First response entry wins on duplicates; hallucinated extras are ignored;
 * omitted merchants degrade to uncategorized + warning.
 */
function alignToRequested(
  requested: readonly string[],
  items: readonly CategorizationItem[],
): MerchantCategorization[] {
  const byKey = new Map<string, CategorizationItem>()
  for (const item of items) {
    const key = normalizeKey(item.merchant)
    if (!byKey.has(key)) byKey.set(key, item)
  }
  return requested.map((merchant) => {
    const match = byKey.get(normalizeKey(merchant))
    if (match === undefined) {
      return {
        merchant,
        category: UNCATEGORIZED_ID,
        confidence: 0,
        warning: 'merchant missing from model response',
      }
    }
    return { merchant, category: match.category, confidence: match.confidence }
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function summarizeZodIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  const shown = issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  const extra = issues.length > 3 ? ` (+${issues.length - 3} more)` : ''
  return shown.join('; ') + extra
}
