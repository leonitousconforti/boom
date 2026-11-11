import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TOKEN_KEY, fetchWithAuth } from "@/lib/api"
import {
  KeysError,
  chooseModel,
  fetchKeys,
  fetchOwnKeysConfig,
  removeAllKeys,
  removeKey,
  saveKey,
} from "@/lib/assistant-keys"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchWithAuth: vi.fn(),
}))

// Obviously fake; never a real key.
const FAKE_KEY = "sk-ant-api03-FAKE-FAKE-FAKE-FAKE-0000"

const SAVED = {
  provider: "anthropic",
  hint: "…0000",
  model: "claude-haiku-5-5",
  workspace_id: null,
  created_at: "2026-11-11T18:00:00Z",
  expires_at: "2026-12-11T18:00:00Z",
  last_used_at: null,
  state: "ok",
}

const OWN_KEYS = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
      default_model: "claude-haiku-5-5",
      key_url: "https://platform.claude.com/settings/keys",
      key_prefix: "sk-ant-api",
      workspace_field: true,
    },
  ],
  days: [1, 7, 30, 90],
  default_days: 30,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function stubFetch(respond: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => respond())
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function request(fetchMock: ReturnType<typeof stubFetch>, i = 0) {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
  return {
    url,
    method: init.method,
    headers: new Headers(init.headers),
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  }
}

async function failure(promise: Promise<unknown>): Promise<KeysError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(KeysError)
  return err as KeysError
}

beforeEach(() => {
  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({ access_token: "login-jwt", token_type: "Bearer", expires_at: Date.now() + 3_600_000 }),
  )
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.mocked(fetchWithAuth).mockClear()
})

describe("assistant key routes", () => {
  it("lists keys with the web login token, by plain fetch", async () => {
    const fetchMock = stubFetch(() => json({ use: "anthropic", keys: [SAVED] }))

    expect(await fetchKeys()).toEqual({ use: "anthropic", keys: [SAVED] })

    const { url, method, headers } = request(fetchMock)
    expect(url).toBe("/api/assistant/keys")
    expect(method).toBe("GET")
    expect(headers.get("Authorization")).toBe("Bearer login-jwt")
    expect(fetchWithAuth).not.toHaveBeenCalled()
  })

  it("saves a key in the POST body only, trimmed", async () => {
    const fetchMock = stubFetch(() => json(SAVED))

    const saved = await saveKey("anthropic", { key: `  ${FAKE_KEY}\n`, model: "claude-haiku-5-5", days: 30, use: true })

    expect(saved).toEqual(SAVED)
    const { url, method, headers, body } = request(fetchMock)
    expect(url).toBe("/api/assistant/keys/anthropic")
    expect(method).toBe("POST")
    expect(headers.get("Authorization")).toBe("Bearer login-jwt")
    expect(headers.get("Content-Type")).toBe("application/json")
    expect(body).toEqual({ key: FAKE_KEY, model: "claude-haiku-5-5", days: 30, use: true })
    expect(url).not.toContain(FAKE_KEY)
    expect(fetchWithAuth).not.toHaveBeenCalled()
  })

  it("chooses a model and deletes keys with GET, POST and DELETE only", async () => {
    const fetchMock = stubFetch(() => json({ use: "anthropic" }))

    expect(await chooseModel("anthropic", "claude-sonnet-5-5")).toBe("anthropic")
    await removeKey("openrouter")
    await removeAllKeys()

    expect(request(fetchMock, 0)).toMatchObject({
      url: "/api/assistant/choice",
      method: "POST",
      body: { use: "anthropic", model: "claude-sonnet-5-5" },
    })
    expect(request(fetchMock, 1)).toMatchObject({ url: "/api/assistant/keys/openrouter", method: "DELETE" })
    expect(request(fetchMock, 2)).toMatchObject({ url: "/api/assistant/keys", method: "DELETE" })
  })

  it("keeps the person logged in when the assistant answers 401", async () => {
    stubFetch(() => json({ error: "Babamul did not accept your login. Log in again." }, 401))

    const err = await failure(fetchKeys())

    expect(err.code).toBe("auth")
    expect(err.message).toBe("Babamul did not accept your login. Log in again.")
    expect(localStorage.getItem(TOKEN_KEY)).not.toBeNull()
    expect(fetchWithAuth).not.toHaveBeenCalled()
  })

  it("does not ask without a login", async () => {
    localStorage.clear()
    const fetchMock = stubFetch(() => json({}))

    expect((await failure(fetchKeys())).code).toBe("auth")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [400, "bad_format", "This is not a Console API key."],
    [422, "rejected", "Anthropic did not accept this key."],
    [502, "provider_unreachable", "Could not reach Anthropic. Nothing was saved."],
    [429, "too_many_saves", "Too many saves. Try again in an hour."],
    [403, "login_required", "Manage AI keys from the Babamul web app."],
  ])("maps %i %s to a typed error with the service's message", async (status, code, message) => {
    stubFetch(() => json({ error: message, code }, status))

    const err = await failure(saveKey("anthropic", { key: FAKE_KEY, model: "claude-haiku-5-5", days: 30 }))

    expect(err.code).toBe(code)
    expect(err.status).toBe(status)
    expect(err.message).toBe(message)
  })

  it("never passes on a message that repeats the key", async () => {
    stubFetch(() => json({ error: `Bad key ${FAKE_KEY}`, code: "rejected" }, 422))

    const err = await failure(saveKey("anthropic", { key: FAKE_KEY, model: "claude-haiku-5-5", days: 30 }))

    expect(err.code).toBe("rejected")
    expect(err.message).not.toContain(FAKE_KEY)
  })

  it("reads a proxy's error page by status, and a 502 there as the assistant being down", async () => {
    stubFetch(() => new Response("<html>Bad Gateway</html>", { status: 502 }))
    expect((await failure(fetchKeys())).code).toBe("unavailable")

    stubFetch(() => new Response("Not Found", { status: 404 }))
    expect((await failure(fetchKeys())).code).toBe("not_found")

    stubFetch(() => json({ error: "Save a key first.", code: "no_key" }, 409))
    const err = await failure(chooseModel("openrouter"))
    expect([err.code, err.message]).toEqual(["no_key", "Save a key first."])
  })

  it("maps a network failure to unavailable", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")))
    expect((await failure(removeKey("anthropic"))).code).toBe("unavailable")
  })
})

describe("fetchOwnKeysConfig", () => {
  it("reads the providers from /health", async () => {
    const fetchMock = stubFetch(() => json({ status: "ok", model: "qwen", vision: false, own_keys: OWN_KEYS }))

    expect(await fetchOwnKeysConfig()).toEqual(OWN_KEYS)
    expect(request(fetchMock).url).toBe("/api/assistant/health")
  })

  it("is null when personal keys are off or the assistant is not there", async () => {
    stubFetch(() => json({ status: "ok", model: "qwen", vision: false, own_keys: null }))
    expect(await fetchOwnKeysConfig()).toBeNull()

    stubFetch(() => json({ status: "ok", model: "qwen", vision: false }))
    expect(await fetchOwnKeysConfig()).toBeNull()

    stubFetch(() => new Response("<!doctype html>", { status: 200 }))
    expect(await fetchOwnKeysConfig()).toBeNull()

    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")))
    expect(await fetchOwnKeysConfig()).toBeNull()
  })

  it("drops a key page that is not https", async () => {
    const provider = { ...OWN_KEYS.providers[0], key_url: "javascript:alert(1)" }
    stubFetch(() => json({ status: "ok", own_keys: { ...OWN_KEYS, providers: [provider] } }))

    expect((await fetchOwnKeysConfig())?.providers[0].key_url).toBe("")
  })
})
