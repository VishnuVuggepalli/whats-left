import { describe, expect, it } from 'vitest'

import type { CategorizerLlmPort } from '../ports'
import { CATEGORY_IDS } from '../categorize/taxonomy'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  OLLAMA_BATCH_SIZE,
  OllamaClient,
  OllamaUnavailableError,
} from './client'

/* ------------------------------------------------------------------ */
/* fake fetch helpers                                                  */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  url: string
  method: string | undefined
  body: unknown
}

type Handler = (call: RecordedCall, callIndex: number) => Response | Promise<Response>

function makeFakeFetch(handler: Handler): { impl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const impl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    const call: RecordedCall = { url, method: init?.method, body }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return { impl, calls }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** wrap model output items as an Ollama /api/chat envelope */
function chatReply(content: unknown, status = 200): Response {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return jsonResponse({ message: { role: 'assistant', content: text } }, status)
}

/** handler that categorizes every requested merchant as food_and_drink */
function echoHandler(call: RecordedCall): Response {
  const body = call.body as { messages: Array<{ role: string; content: string }> }
  const userMessage = body.messages[1]
  if (!userMessage) throw new Error('test handler: missing user message')
  const merchants = JSON.parse(userMessage.content) as string[]
  return chatReply(
    merchants.map((merchant) => ({ merchant, category: 'food_and_drink', confidence: 0.9 })),
  )
}

function requestedMerchants(call: RecordedCall): string[] {
  const body = call.body as { messages: Array<{ role: string; content: string }> }
  const userMessage = body.messages[1]
  if (!userMessage) throw new Error('test handler: missing user message')
  return JSON.parse(userMessage.content) as string[]
}

/* ------------------------------------------------------------------ */
/* request shape                                                       */
/* ------------------------------------------------------------------ */

describe('OllamaClient request shape', () => {
  it('POSTs to /api/chat with model, stream:false, temperature 0, enum format schema', async () => {
    const { impl, calls } = makeFakeFetch(echoHandler)
    const client = new OllamaClient({ fetchImpl: impl })

    await client.categorizeMerchants(['Starbucks'], [])

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(`${DEFAULT_BASE_URL}/api/chat`)
    expect(call.method).toBe('POST')

    const body = call.body as Record<string, unknown>
    expect(body['model']).toBe(DEFAULT_MODEL)
    expect(body['stream']).toBe(false)
    expect(body['options']).toEqual({ temperature: 0 })

    const format = body['format'] as {
      type: string
      items: { properties: { category: { enum: string[] }; confidence: unknown }; required: string[] }
    }
    expect(format.type).toBe('array')
    expect(format.items.properties.category.enum).toEqual(CATEGORY_IDS)
    expect(format.items.required).toEqual(['merchant', 'category', 'confidence'])
  })

  it('sends a system prompt with taxonomy + few-shot, and a user prompt = JSON merchant array', async () => {
    const { impl, calls } = makeFakeFetch(echoHandler)
    const client = new OllamaClient({ fetchImpl: impl })
    const fewShot = [{ merchant: 'Blue Bottle Coffee', category: 'food_and_drink' }]

    await client.categorizeMerchants(['STARBUCKS #123', 'DELTA AIR'], fewShot)

    const body = calls[0]!.body as { messages: Array<{ role: string; content: string }> }
    expect(body.messages).toHaveLength(2)
    const [system, user] = body.messages
    expect(system!.role).toBe('system')
    expect(system!.content).toContain('- food_and_drink:')
    expect(system!.content).toContain('- uncategorized:')
    expect(system!.content).toContain('Blue Bottle Coffee')
    expect(user!.role).toBe('user')
    expect(JSON.parse(user!.content)).toEqual(['STARBUCKS #123', 'DELTA AIR'])
  })

  it('respects custom baseUrl (trailing slash stripped) and model', async () => {
    const { impl, calls } = makeFakeFetch(echoHandler)
    const client = new OllamaClient({
      baseUrl: 'http://localhost:9999/',
      model: 'qwen3:4b',
      fetchImpl: impl,
    })

    await client.categorizeMerchants(['Starbucks'], [])

    expect(calls[0]!.url).toBe('http://localhost:9999/api/chat')
    expect((calls[0]!.body as Record<string, unknown>)['model']).toBe('qwen3:4b')
  })

  it('makes no request for an empty merchant list', async () => {
    const { impl, calls } = makeFakeFetch(echoHandler)
    const client = new OllamaClient({ fetchImpl: impl })
    await expect(client.categorizeMerchants([], [])).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* happy path parsing                                                  */
/* ------------------------------------------------------------------ */

describe('OllamaClient response parsing', () => {
  it('returns categorizations in input order', async () => {
    const { impl } = makeFakeFetch(() =>
      chatReply([
        { merchant: 'Delta Air', category: 'travel', confidence: 0.95 },
        { merchant: 'Starbucks', category: 'food_and_drink', confidence: 0.8 },
      ]),
    )
    const client = new OllamaClient({ fetchImpl: impl })

    const results = await client.categorizeMerchants(['Starbucks', 'Delta Air'], [])

    expect(results).toEqual([
      { merchant: 'Starbucks', category: 'food_and_drink', confidence: 0.8 },
      { merchant: 'Delta Air', category: 'travel', confidence: 0.95 },
    ])
  })

  it('matches response merchants case-insensitively with trimming, keeping the requested string', async () => {
    const { impl } = makeFakeFetch(() =>
      chatReply([{ merchant: '  STARBUCKS #123 ', category: 'food_and_drink', confidence: 0.7 }]),
    )
    const client = new OllamaClient({ fetchImpl: impl })

    const results = await client.categorizeMerchants(['Starbucks #123'], [])

    expect(results).toEqual([
      { merchant: 'Starbucks #123', category: 'food_and_drink', confidence: 0.7 },
    ])
  })

  it('takes the first entry when the model repeats a merchant', async () => {
    const { impl } = makeFakeFetch(() =>
      chatReply([
        { merchant: 'Costco', category: 'groceries', confidence: 0.9 },
        { merchant: 'Costco', category: 'general_merchandise', confidence: 0.5 },
      ]),
    )
    const client = new OllamaClient({ fetchImpl: impl })

    const results = await client.categorizeMerchants(['Costco'], [])

    expect(results).toEqual([{ merchant: 'Costco', category: 'groceries', confidence: 0.9 }])
  })

  it('ignores hallucinated merchants that were never requested', async () => {
    const { impl } = makeFakeFetch(() =>
      chatReply([
        { merchant: 'Starbucks', category: 'food_and_drink', confidence: 0.9 },
        { merchant: 'Never Asked LLC', category: 'travel', confidence: 0.9 },
      ]),
    )
    const client = new OllamaClient({ fetchImpl: impl })

    const results = await client.categorizeMerchants(['Starbucks'], [])

    expect(results).toEqual([{ merchant: 'Starbucks', category: 'food_and_drink', confidence: 0.9 }])
  })

  it('never drops a merchant the model omitted: uncategorized, confidence 0, with warning', async () => {
    const { impl } = makeFakeFetch(() =>
      chatReply([{ merchant: 'Starbucks', category: 'food_and_drink', confidence: 0.9 }]),
    )
    const client = new OllamaClient({ fetchImpl: impl })

    const results = await client.categorizeMerchants(['Starbucks', 'Mystery Shop'], [])

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ merchant: 'Starbucks', category: 'food_and_drink', confidence: 0.9 })
    expect(results[1]).toMatchObject({ merchant: 'Mystery Shop', category: 'uncategorized', confidence: 0 })
    expect(results[1]!.warning).toMatch(/missing/i)
  })

  it('does not mutate the merchants input array', async () => {
    const { impl } = makeFakeFetch(echoHandler)
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = ['B Shop', 'A Shop']
    await client.categorizeMerchants(merchants, [])
    expect(merchants).toEqual(['B Shop', 'A Shop'])
  })
})

/* ------------------------------------------------------------------ */
/* malformed model output → uncategorized fallback, never a throw      */
/* ------------------------------------------------------------------ */

describe('OllamaClient content errors', () => {
  const expectAllUncategorized = (
    results: Array<{ merchant: string; category: string; confidence: number; warning?: string }>,
    merchants: string[],
  ): void => {
    expect(results.map((r) => r.merchant)).toEqual(merchants)
    for (const result of results) {
      expect(result.category).toBe('uncategorized')
      expect(result.confidence).toBe(0)
      expect(result.warning).toBeTruthy()
    }
  }

  it('maps all merchants to uncategorized+warning when content is not JSON', async () => {
    const { impl } = makeFakeFetch(() => chatReply('sure! here are the categories: ...'))
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = ['Starbucks', 'Delta Air']

    expectAllUncategorized(await client.categorizeMerchants(merchants, []), merchants)
  })

  it('maps all merchants to uncategorized+warning when the category is outside the enum', async () => {
    const { impl } = makeFakeFetch(() =>
      chatReply([
        { merchant: 'Starbucks', category: 'coffee_shops', confidence: 0.9 },
        { merchant: 'Delta Air', category: 'travel', confidence: 0.9 },
      ]),
    )
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = ['Starbucks', 'Delta Air']

    expectAllUncategorized(await client.categorizeMerchants(merchants, []), merchants)
  })

  it('maps all merchants to uncategorized+warning when confidence is out of range', async () => {
    const { impl } = makeFakeFetch(() =>
      chatReply([{ merchant: 'Starbucks', category: 'food_and_drink', confidence: 1.5 }]),
    )
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = ['Starbucks']

    expectAllUncategorized(await client.categorizeMerchants(merchants, []), merchants)
  })

  it('maps all merchants to uncategorized+warning when content is JSON but not an array', async () => {
    const { impl } = makeFakeFetch(() =>
      chatReply({ merchant: 'Starbucks', category: 'food_and_drink', confidence: 0.9 }),
    )
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = ['Starbucks']

    expectAllUncategorized(await client.categorizeMerchants(merchants, []), merchants)
  })

  it('maps all merchants to uncategorized+warning when the envelope lacks message.content', async () => {
    const { impl } = makeFakeFetch(() => jsonResponse({ done: true }))
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = ['Starbucks']

    expectAllUncategorized(await client.categorizeMerchants(merchants, []), merchants)
  })

  it('maps all merchants to uncategorized+warning when the HTTP body is not JSON', async () => {
    const { impl } = makeFakeFetch(() => new Response('<html>proxy error</html>', { status: 200 }))
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = ['Starbucks']

    expectAllUncategorized(await client.categorizeMerchants(merchants, []), merchants)
  })

  it('content errors are batch-scoped: a good batch still returns real categories', async () => {
    const { impl } = makeFakeFetch((call, index) =>
      index === 0 ? echoHandler(call) : chatReply('not json at all'),
    )
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = Array.from({ length: OLLAMA_BATCH_SIZE + 2 }, (_, i) => `Shop ${i}`)

    const results = await client.categorizeMerchants(merchants, [])

    expect(results).toHaveLength(merchants.length)
    expect(results[0]).toEqual({ merchant: 'Shop 0', category: 'food_and_drink', confidence: 0.9 })
    expect(results[OLLAMA_BATCH_SIZE]).toMatchObject({
      merchant: `Shop ${OLLAMA_BATCH_SIZE}`,
      category: 'uncategorized',
      confidence: 0,
    })
    expect(results[OLLAMA_BATCH_SIZE]!.warning).toBeTruthy()
  })
})

/* ------------------------------------------------------------------ */
/* batching                                                            */
/* ------------------------------------------------------------------ */

describe('OllamaClient batching', () => {
  it('splits 65 merchants into sequential batches of 30/30/5, concatenated in order', async () => {
    const { impl, calls } = makeFakeFetch(echoHandler)
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = Array.from({ length: 65 }, (_, i) => `Merchant ${i}`)

    const results = await client.categorizeMerchants(merchants, [])

    expect(calls).toHaveLength(3)
    expect(requestedMerchants(calls[0]!)).toEqual(merchants.slice(0, 30))
    expect(requestedMerchants(calls[1]!)).toEqual(merchants.slice(30, 60))
    expect(requestedMerchants(calls[2]!)).toEqual(merchants.slice(60))
    expect(results.map((r) => r.merchant)).toEqual(merchants)
  })

  it('sends exactly one request for exactly 30 merchants', async () => {
    const { impl, calls } = makeFakeFetch(echoHandler)
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = Array.from({ length: 30 }, (_, i) => `Merchant ${i}`)

    await client.categorizeMerchants(merchants, [])

    expect(calls).toHaveLength(1)
  })

  it('runs batches sequentially — the second request starts only after the first resolves', async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { impl, calls } = makeFakeFetch(async (call, index) => {
      if (index === 0) await gate
      return echoHandler(call)
    })
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = Array.from({ length: 31 }, (_, i) => `Merchant ${i}`)

    const pending = client.categorizeMerchants(merchants, [])
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toHaveLength(1)

    releaseFirst()
    const results = await pending
    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(31)
  })
})

/* ------------------------------------------------------------------ */
/* transport errors                                                    */
/* ------------------------------------------------------------------ */

describe('OllamaClient transport errors', () => {
  it('throws OllamaUnavailableError when fetch rejects', async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    }
    const client = new OllamaClient({ fetchImpl: impl })

    await expect(client.categorizeMerchants(['Starbucks'], [])).rejects.toBeInstanceOf(
      OllamaUnavailableError,
    )
  })

  it('throws OllamaUnavailableError on a non-2xx HTTP status', async () => {
    const { impl } = makeFakeFetch(() => new Response('oops', { status: 500 }))
    const client = new OllamaClient({ fetchImpl: impl })

    await expect(client.categorizeMerchants(['Starbucks'], [])).rejects.toThrow(
      OllamaUnavailableError,
    )
  })

  it('a transport failure on a later batch fails the whole call', async () => {
    const { impl, calls } = makeFakeFetch((call, index) =>
      index === 0 ? echoHandler(call) : new Response('down', { status: 503 }),
    )
    const client = new OllamaClient({ fetchImpl: impl })
    const merchants = Array.from({ length: 40 }, (_, i) => `Merchant ${i}`)

    await expect(client.categorizeMerchants(merchants, [])).rejects.toBeInstanceOf(
      OllamaUnavailableError,
    )
    expect(calls).toHaveLength(2)
  })

  it('the unavailable error carries a useful message and name', async () => {
    const { impl } = makeFakeFetch(() => new Response('oops', { status: 404 }))
    const client = new OllamaClient({ fetchImpl: impl })

    const error = await client.categorizeMerchants(['Starbucks'], []).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OllamaUnavailableError)
    expect((error as Error).name).toBe('OllamaUnavailableError')
    expect((error as Error).message).toContain('404')
  })
})

/* ------------------------------------------------------------------ */
/* isAvailable                                                         */
/* ------------------------------------------------------------------ */

describe('OllamaClient.isAvailable', () => {
  it('GETs /api/tags and returns true on 200', async () => {
    const { impl, calls } = makeFakeFetch(() => jsonResponse({ models: [] }))
    const client = new OllamaClient({ fetchImpl: impl })

    await expect(client.isAvailable()).resolves.toBe(true)
    expect(calls[0]!.url).toBe(`${DEFAULT_BASE_URL}/api/tags`)
    expect(calls[0]!.method).toBe('GET')
  })

  it('returns false on a non-2xx status', async () => {
    const { impl } = makeFakeFetch(() => new Response('down', { status: 503 }))
    const client = new OllamaClient({ fetchImpl: impl })
    await expect(client.isAvailable()).resolves.toBe(false)
  })

  it('returns false (never throws) when fetch rejects', async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    }
    const client = new OllamaClient({ fetchImpl: impl })
    await expect(client.isAvailable()).resolves.toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* port conformance                                                    */
/* ------------------------------------------------------------------ */

describe('CategorizerLlmPort conformance', () => {
  it('OllamaClient is assignable to the frozen port', async () => {
    const { impl } = makeFakeFetch(echoHandler)
    const port: CategorizerLlmPort = new OllamaClient({ fetchImpl: impl })
    const results = await port.categorizeMerchants(['Starbucks'], [])
    expect(results).toEqual([{ merchant: 'Starbucks', category: 'food_and_drink', confidence: 0.9 }])
  })
})
