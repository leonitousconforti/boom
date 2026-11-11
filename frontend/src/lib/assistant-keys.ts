/**
 * Client for the assistant's personal AI key routes (boom-mcp's `/assistant/keys`
 * and `/assistant/choice`).
 *
 * A signed-in person can save one API key per provider, so that Ask Babamul
 * answers with their own model instead of the shared one. The service checks
 * the key once with the provider and keeps it encrypted. No route ever sends a
 * key back, so a key travels in exactly one request: the POST that saves it.
 *
 * Requests carry the web login token with plain fetch, not `fetchWithAuth`: a
 * 401 there logs the person out of Babamul, and the assistant refusing them is
 * no reason to.
 */
import { getTokenRecord } from "@/lib/api"
import { assistantBase, fetchHealth } from "@/lib/assistant"

/** The id of the Profile card, so the Ask panel can link straight to it. */
export const KEYS_CARD_ID = "ai-model"

export type OwnKeysProvider = {
  id: string
  /** For people, e.g. "Anthropic". */
  name: string
  /** The models the operator allows, the default first. */
  models: string[]
  default_model: string
  /** Where to make a key. */
  key_url: string
  /** How the provider's keys start, e.g. "sk-ant-api". */
  key_prefix: string
  /** Whether the provider takes an optional workspace id with the key. */
  workspace_field: boolean
}

export type OwnKeysConfig = {
  providers: OwnKeysProvider[]
  /** The lifetimes a key can be saved for, in days. */
  days: number[]
  default_days: number
}

export type KeyState = "ok" | "refused" | "unreadable"

/** A saved key as the service describes it; never the key itself. */
export type SavedKey = {
  provider: string
  /** "…" and the key's last 4 characters. */
  hint: string
  model: string
  workspace_id: string | null
  /** ISO 8601 UTC. */
  created_at: string
  expires_at: string
  last_used_at: string | null
  state: KeyState
}

export type KeysOverview = {
  /** "shared", or the provider whose key answers the person's questions. */
  use: string
  keys: SavedKey[]
}

export type SaveKeyRequest = {
  key: string
  model: string
  days: number
  workspace_id?: string
  /** Whether to answer with this key from now on. The service defaults to yes. */
  use?: boolean
}

export type KeysErrorCode =
  | "bad_format"
  | "bad_model"
  | "bad_days"
  | "bad_request"
  | "rejected"
  | "provider_unreachable"
  | "too_many_saves"
  | "login_required"
  | "no_key"
  | "auth"
  | "not_found"
  | "unavailable"

const DEFAULT_MESSAGES: Record<KeysErrorCode, string> = {
  bad_format: "That does not look like an API key for this provider.",
  bad_model: "That model is not offered for this provider.",
  bad_days: "Pick how long to keep the key from the list.",
  bad_request: "The assistant could not read that request.",
  rejected: "The provider did not accept this key. Nothing was saved.",
  provider_unreachable: "Could not reach the provider to check the key. Nothing was saved. Try again later.",
  too_many_saves: "That is a lot of saves in a short time. Try again in an hour.",
  login_required: "Log in to Babamul in this browser to manage AI keys.",
  no_key: "Save a working key for this provider first.",
  auth: "Your session has expired. Log in again.",
  not_found: "Personal AI keys are not turned on for this Babamul.",
  unavailable: "The assistant is unavailable right now. Try again later.",
}

const CODES = new Set(Object.keys(DEFAULT_MESSAGES))

export class KeysError extends Error {
  readonly code: KeysErrorCode
  readonly status?: number

  constructor(code: KeysErrorCode, message?: string, status?: number) {
    super(message || DEFAULT_MESSAGES[code])
    this.name = "KeysError"
    this.code = code
    this.status = status
  }
}

/**
 * What the assistant offers for personal keys, from `/health`. Null when the
 * assistant is down or the operator has not turned personal keys on; never throws.
 */
export async function fetchOwnKeysConfig(signal?: AbortSignal): Promise<OwnKeysConfig | null> {
  const health = await fetchHealth(signal)
  return health ? parseOwnKeysConfig(health.own_keys) : null
}

function parseOwnKeysConfig(v: unknown): OwnKeysConfig | null {
  if (!isObject(v) || !Array.isArray(v.providers)) return null
  const providers = v.providers.flatMap((p): OwnKeysProvider[] => {
    if (!isObject(p) || !isText(p.id) || !Array.isArray(p.models)) return []
    const models = p.models.filter(isText)
    if (models.length === 0) return []
    return [
      {
        id: p.id,
        name: isText(p.name) ? p.name : p.id,
        models,
        default_model: isText(p.default_model) && models.includes(p.default_model) ? p.default_model : models[0],
        // Only ever a link out to the provider's own site.
        key_url: isText(p.key_url) && p.key_url.startsWith("https://") ? p.key_url : "",
        key_prefix: isText(p.key_prefix) ? p.key_prefix : "",
        workspace_field: p.workspace_field === true,
      },
    ]
  })
  const days = Array.isArray(v.days) ? v.days.filter((d): d is number => Number.isInteger(d) && d > 0) : []
  if (providers.length === 0 || days.length === 0) return null
  const defaultDays = typeof v.default_days === "number" && days.includes(v.default_days) ? v.default_days : days[0]
  return { providers, days, default_days: defaultDays }
}

/** The person's saved keys and which model answers them. */
export async function fetchKeys(signal?: AbortSignal): Promise<KeysOverview> {
  const body = await readJson(await send("GET", "/keys", undefined, signal))
  if (!isObject(body)) throw new KeysError("unavailable")
  return {
    use: isText(body.use) ? body.use : "shared",
    keys: Array.isArray(body.keys) ? body.keys.flatMap((k) => parseSavedKey(k) ?? []) : [],
  }
}

/**
 * Checks a key with the provider and saves it. The key goes in this one body
 * and nowhere else; a message that would repeat it is replaced.
 */
export async function saveKey(provider: string, request: SaveKeyRequest): Promise<SavedKey> {
  const key = request.key.trim()
  try {
    const saved = parseSavedKey(await readJson(await send("POST", `/keys/${encodeURIComponent(provider)}`, { ...request, key })))
    if (!saved) throw new KeysError("unavailable")
    return saved
  } catch (err) {
    if (err instanceof KeysError && key && err.message.includes(key)) throw new KeysError(err.code, undefined, err.status)
    throw err
  }
}

/** Answers with the shared model, or with a saved key and optionally another of its models. */
export async function chooseModel(use: string, model?: string): Promise<string> {
  const body = await readJson(await send("POST", "/choice", model ? { use, model } : { use }))
  return isObject(body) && isText(body.use) ? body.use : use
}

/** Deletes one saved key. If it was answering, the shared model answers again. */
export async function removeKey(provider: string): Promise<void> {
  await send("DELETE", `/keys/${encodeURIComponent(provider)}`)
}

/** Deletes every saved key. */
export async function removeAllKeys(): Promise<void> {
  await send("DELETE", "/keys")
}

async function send(method: "GET" | "POST" | "DELETE", path: string, body?: object, signal?: AbortSignal) {
  const token = getTokenRecord()
  if (!token) throw new KeysError("auth")
  const headers: Record<string, string> = { Authorization: `Bearer ${token.access_token}` }
  if (body) headers["Content-Type"] = "application/json"
  let res: Response
  try {
    res = await fetch(`${assistantBase()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (err) {
    // A caller that gave up does not want an error to show.
    if (signal?.aborted) throw err
    throw new KeysError("unavailable")
  }
  if (!res.ok) throw await errorFor(res)
  return res
}

/**
 * The service's own `{error, code}` when it sent one. Otherwise the status
 * decides, and only loosely: a proxy's 502 means the assistant is down, not
 * the provider.
 */
async function errorFor(res: Response): Promise<KeysError> {
  const body = await readJson(res)
  const message = isObject(body) && isText(body.error) ? body.error : undefined
  if (isObject(body) && isText(body.code) && CODES.has(body.code)) {
    return new KeysError(body.code as KeysErrorCode, message, res.status)
  }
  const code = CODE_FOR_STATUS[res.status] ?? (res.status < 500 ? "bad_request" : "unavailable")
  return new KeysError(code, message, res.status)
}

const CODE_FOR_STATUS: Record<number, KeysErrorCode> = {
  401: "auth",
  // Also what a server without the key routes answers.
  404: "not_found",
  409: "no_key",
  429: "too_many_saves",
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text())
  } catch {
    return null
  }
}

const STATES = new Set<KeyState>(["ok", "refused", "unreadable"])

function parseSavedKey(v: unknown): SavedKey | null {
  if (!isObject(v) || !isText(v.provider) || !isText(v.expires_at)) return null
  const str = (x: unknown) => (typeof x === "string" ? x : "")
  return {
    provider: v.provider,
    hint: str(v.hint),
    model: str(v.model),
    workspace_id: isText(v.workspace_id) ? v.workspace_id : null,
    created_at: str(v.created_at),
    expires_at: v.expires_at,
    last_used_at: isText(v.last_used_at) ? v.last_used_at : null,
    // A state this client does not know cannot be trusted to work.
    state: STATES.has(v.state as KeyState) ? (v.state as KeyState) : "unreadable",
  }
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}
