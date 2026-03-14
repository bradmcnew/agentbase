/**
 * LLM chat abstraction — routes to the correct provider based on endpoint mode.
 *
 * Platform mode: uses our Azure OpenAI (with optional model override)
 * BYOK mode: uses customer's OpenAI or Anthropic key
 * External mode: not used (query.ts handles webhook forwarding directly)
 */

import { createOpenAIClient } from './azure-openai'
import type { EndpointRow } from '../middleware/resolve-endpoint'
import { ENDPOINT_MODE } from '../types'
import { decrypt } from '../utils/encrypt'
import type { Env } from '../types'

export interface ChatResult {
  answer: string
  promptTokens: number
  completionTokens: number
}

/** Route chat to the correct provider based on endpoint config */
export async function chatWithProvider(
  endpoint: EndpointRow,
  env: Env,
  systemPrompt: string,
  context: string,
  query: string
): Promise<ChatResult> {
  if (endpoint.mode === ENDPOINT_MODE.BYOK && endpoint.llmApiKey) {
    // Decrypt the customer's API key (stored encrypted at rest)
    const apiKey = await decrypt(endpoint.llmApiKey, env.ENCRYPTION_SECRET)
    if (endpoint.llmProvider === 'anthropic') {
      return anthropicChat(apiKey, endpoint.llmModel || 'claude-sonnet-4-20250514', systemPrompt, context, query)
    }
    return openaiChat(apiKey, endpoint.llmModel || 'gpt-4o', systemPrompt, context, query)
  }

  // Platform mode — use our Azure with optional model override
  const client = createOpenAIClient(env)
  return client.chat(systemPrompt, context, query, endpoint.llmModel || undefined)
}

/** Call OpenAI's API directly (for BYOK customers with OpenAI keys) */
async function openaiChat(apiKey: string, model: string, systemPrompt: string, context: string, query: string): Promise<ChatResult> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${context}\n\n---\n\nQuestion: ${query}` },
      ],
      max_completion_tokens: 1024,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI API error ${res.status}: ${body}`)
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>
    usage: { prompt_tokens: number; completion_tokens: number }
  }

  return {
    answer: data.choices[0]?.message?.content ?? '',
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  }
}

/** Call Anthropic's API directly (for BYOK customers with Anthropic keys) */
async function anthropicChat(apiKey: string, model: string, systemPrompt: string, context: string, query: string): Promise<ChatResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `${context}\n\n---\n\nQuestion: ${query}` },
      ],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${body}`)
  }

  const data = await res.json() as {
    content: Array<{ text: string }>
    usage: { input_tokens: number; output_tokens: number }
  }

  return {
    answer: data.content[0]?.text ?? '',
    promptTokens: data.usage?.input_tokens ?? 0,
    completionTokens: data.usage?.output_tokens ?? 0,
  }
}
