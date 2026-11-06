/**
 * The gateway Claude Code talks to, as a pi provider (2026-11-04, the user: every Walnut engine
 * reaches models through the configured gateway when one is configured).
 *
 * When Claude Code names a base URL (ANTHROPIC_BEDROCK_BASE_URL on Bedrock, ANTHROPIC_BASE_URL
 * otherwise), "Import from Claude Code" adds ONE provider to pi's models.json, named
 * PI_GATEWAY_PROVIDER, whose baseUrl is that URL and whose models are the model ids Claude Code
 * uses, and makes it pi's default provider. pi's built-in providers carry their own cloud
 * endpoint in every catalog model, and its Bedrock client pins that endpoint whenever no region
 * is configured, so pointing pi's environment at the gateway alone could still send a turn
 * straight to the cloud with whatever credentials the machine has. A provider of its own sends
 * every request to the gateway, with nothing in pi's environment or catalog able to change that.
 *
 * pi's api names (pi-ai): `bedrock-converse-stream` puts a baseUrl that is not a standard
 * Bedrock runtime host on the AWS SDK client as its endpoint and calls the Bedrock runtime paths
 * (/model/<id>/converse-stream) there; `anthropic-messages` calls <baseUrl>/v1/messages, the
 * same base URL convention as Claude Code's ANTHROPIC_BASE_URL. pi lists a custom provider's
 * models only when it has a key, so the entry always names one: the variable Claude Code
 * authenticates with ("$NAME", read from pi's own environment at request time, which the
 * walnut-claude-code extension fills from Claude Code's settings), or a placeholder when Claude
 * Code sends none. No secret value is ever written into models.json.
 *
 * Pure functions: the preview and the write in claude-code-import.ts run them on a host's files.
 */

import { parseJsonObject, serializeJsonObject, type JsonObject } from './config-file-edit.js'
import { modelStringWindow } from '../../providers/context-window.js'

/**
 * The one provider entry in pi's models.json that Walnut owns. An import replaces this entry
 * whole and never touches any other provider, so a provider the user added (under any other
 * name, the same gateway included) stays exactly as they wrote it.
 */
export const PI_GATEWAY_PROVIDER = 'claude-code-gateway'
/** The key pi sends when Claude Code sends none (a gateway that needs no key ignores it). */
export const PI_GATEWAY_PLACEHOLDER_KEY = 'claude-code-gateway'
/** Output tokens a gateway model may write per turn: Claude Code's own default for current models. */
export const PI_GATEWAY_MAX_TOKENS = 32_000

export type PiGatewayApi = 'bedrock-converse-stream' | 'anthropic-messages'

export interface PiGatewayModel {
  id: string
  name?: string
  /** 1M when Claude Code asks for the model's `[1m]` variant, else 200K. */
  contextWindow: number
}

export interface PiGateway {
  /** The Claude Code variable that names the gateway. */
  from: 'ANTHROPIC_BEDROCK_BASE_URL' | 'ANTHROPIC_BASE_URL'
  api: PiGatewayApi
  baseUrl: string
  /** "$NAME" (pi reads it from its environment) or the placeholder. */
  apiKey: string
  /**
   * Where the key comes from: a Claude Code variable, Claude Code's CLAUDE_CODE_SKIP_BEDROCK_AUTH
   * (pi signs nothing either), or nowhere (the placeholder).
   */
  keyFrom: 'variable' | 'skip-auth' | 'none'
  /** Send the key as Authorization: Bearer too (Claude Code's ANTHROPIC_AUTH_TOKEN). */
  authHeader: boolean
  models: PiGatewayModel[]
  /** The model pi starts on when Claude Code names none. */
  defaultModel: string
}

type EnvLookup = (key: string) => string | undefined

/**
 * Claude Code's model variables, in the order the gateway lists them. The `_NAME` twin of each
 * (when set) becomes the model's display name in pi. ANTHROPIC_CUSTOM_MODEL_OPTION is left out:
 * Claude Code reaches it through the gateway's invoke paths, and a gateway may not serve it
 * through the Converse paths pi uses (one tested 2026-11-04 refused it as an invalid model id).
 */
const MODEL_VARS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const
/** Which one pi starts on when Claude Code names no model: Claude Code's own default is Sonnet. */
const DEFAULT_PICK = ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'] as const

const ONE_M = /\[1m\]$/i
const plainId = (raw: string): string => raw.trim().replace(ONE_M, '')
const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v ?? '').trim())

/** A gateway URL as pi takes it, or null when it is not an http(s) URL. */
function gatewayUrl(raw: string | undefined): string | null {
  const text = raw?.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  } catch {
    return null
  }
  return text.replace(/\/+$/, '')
}

/**
 * The gateway provider pi should use, from Claude Code's settings and environment (`env`
 * reads Claude Code's settings `env` first, then the host's). `chosenRaw` is the model id
 * Claude Code runs (its `model` setting or ANTHROPIC_MODEL, an alias already resolved), as
 * Claude Code writes it. `note` explains a gateway that could not be set up.
 */
export function piGatewayFromClaudeCode(env: EnvLookup, bedrock: boolean, chosenRaw: string | undefined): { gateway?: PiGateway; note?: string } {
  const from = bedrock ? 'ANTHROPIC_BEDROCK_BASE_URL' : 'ANTHROPIC_BASE_URL'
  const raw = env(from)
  if (!raw?.trim()) return {}
  const baseUrl = gatewayUrl(raw)
  if (!baseUrl) return { note: `Claude Code's ${from} (${raw.trim()}) is not an http or https address, so pi was not pointed at it.` }

  const byId = new Map<string, PiGatewayModel>()
  const add = (rawId: string | undefined, name?: string): void => {
    if (!rawId?.trim()) return
    const id = plainId(rawId)
    // `[1m]`, or a model with 1M built in (Opus 5.5 as `claude-opus-5-5`, 2026-11-06).
    const contextWindow = ONE_M.test(rawId.trim()) ? 1_000_000 : (modelStringWindow(rawId.trim()) ?? 200_000)
    const known = byId.get(id)
    if (known) {
      known.contextWindow = Math.max(known.contextWindow, contextWindow)
      if (!known.name && name) known.name = name
      return
    }
    byId.set(id, { id, ...(name ? { name } : {}), contextWindow })
  }
  add(chosenRaw)
  for (const key of MODEL_VARS) add(env(key), env(`${key}_NAME`)?.trim() || undefined)
  const models = [...byId.values()]
  if (models.length === 0) {
    return { note: `Claude Code reaches models through ${baseUrl} but names no model id, so pi was not pointed at it. Set ANTHROPIC_MODEL or ANTHROPIC_DEFAULT_SONNET_MODEL in Claude Code's settings and import again.` }
  }
  const pick = DEFAULT_PICK.map((k) => env(k)).find((v) => v?.trim())
  const defaultModel = chosenRaw?.trim() ? plainId(chosenRaw) : pick ? plainId(pick) : models[0].id

  let apiKey = PI_GATEWAY_PLACEHOLDER_KEY
  let keyFrom: PiGateway['keyFrom'] = 'none'
  let authHeader = false
  if (bedrock) {
    // With CLAUDE_CODE_SKIP_BEDROCK_AUTH the extension sets AWS_BEDROCK_SKIP_AUTH, and pi then
    // signs nothing, so the key only makes the provider usable.
    if (truthy(env('CLAUDE_CODE_SKIP_BEDROCK_AUTH'))) keyFrom = 'skip-auth'
    else if (env('AWS_BEARER_TOKEN_BEDROCK')) { apiKey = '$AWS_BEARER_TOKEN_BEDROCK'; keyFrom = 'variable' }
  } else if (env('ANTHROPIC_API_KEY')) {
    apiKey = '$ANTHROPIC_API_KEY'
    keyFrom = 'variable'
  } else if (env('ANTHROPIC_AUTH_TOKEN')) {
    apiKey = '$ANTHROPIC_AUTH_TOKEN'
    keyFrom = 'variable'
    authHeader = true
  }
  return {
    gateway: {
      from, api: bedrock ? 'bedrock-converse-stream' : 'anthropic-messages', baseUrl, apiKey, keyFrom, authHeader, models, defaultModel,
    },
  }
}

/** Claude models that take only adaptive thinking (the same families pi's Bedrock client knows). */
const ADAPTIVE = /(opus-4-[678]|opus-5|sonnet-4-6|sonnet-5|haiku-5|fable-5)/

/** The provider entry Walnut writes under PI_GATEWAY_PROVIDER in pi's models.json. */
export function piGatewayEntry(gateway: PiGateway): JsonObject {
  return {
    name: 'Claude Code gateway',
    baseUrl: gateway.baseUrl,
    api: gateway.api,
    apiKey: gateway.apiKey,
    ...(gateway.authHeader ? { authHeader: true } : {}),
    models: gateway.models.map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: m.contextWindow,
      maxTokens: PI_GATEWAY_MAX_TOKENS,
      // The Bedrock client picks adaptive thinking from the id itself; the Anthropic one needs it said.
      ...(gateway.api === 'anthropic-messages' && ADAPTIVE.test(m.id.toLowerCase().replace(/[\s_.:]+/g, '-'))
        ? { compat: { forceAdaptiveThinking: true } }
        : {}),
    })),
  }
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The `providers` table of a parsed models.json; throws when it is there and not an object. */
function providersOf(doc: JsonObject, label: string): JsonObject {
  if (doc.providers === undefined) return {}
  if (!isObject(doc.providers)) throw new Error(`${label} has a "providers" value that is not an object`)
  return doc.providers
}

/**
 * What the import does to models.json: add Walnut's entry, update it, or nothing. Throws when
 * the file cannot be read as JSON (Walnut never writes over bytes it could not read).
 */
export function gatewayChange(text: string | undefined, gateway: PiGateway, label: string): 'add' | 'update' | 'none' {
  const providers = providersOf(text ? parseJsonObject(text, label) : {}, label)
  const current = providers[PI_GATEWAY_PROVIDER]
  if (current === undefined) return 'add'
  return JSON.stringify(current) === JSON.stringify(piGatewayEntry(gateway)) ? 'none' : 'update'
}

/** models.json with Walnut's entry set and every other byte of meaning kept. */
export function withGatewayEntry(text: string | null, gateway: PiGateway, label: string): string {
  const doc = text ? parseJsonObject(text, label) : {}
  const providers = providersOf(doc, label)
  const next: JsonObject = { ...doc, providers: { ...providers, [PI_GATEWAY_PROVIDER]: piGatewayEntry(gateway) } }
  return serializeJsonObject(next, text ?? undefined) + (text === null ? '\n' : '')
}
