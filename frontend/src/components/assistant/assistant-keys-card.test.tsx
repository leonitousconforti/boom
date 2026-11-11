import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { Link, MemoryRouter } from "react-router-dom"
import { toast } from "sonner"
import { AssistantKeysCard } from "@/components/assistant/assistant-keys-card"
import { TOKEN_KEY } from "@/lib/api"

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

// Obviously fake; never a real key.
const FAKE_KEY = "sk-ant-api03-FAKE-FAKE-FAKE-FAKE-wxyz"

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
    {
      id: "openrouter",
      name: "OpenRouter",
      models: ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"],
      default_model: "anthropic/claude-haiku-5.5",
      key_url: "https://openrouter.ai/settings/keys",
      key_prefix: "sk-or-",
      workspace_field: false,
    },
  ],
  days: [1, 7, 30, 90],
  default_days: 30,
}

const SAVED = {
  provider: "anthropic",
  hint: "…wxyz",
  model: "claude-haiku-5-5",
  workspace_id: null,
  created_at: "2026-11-11T18:00:00Z",
  expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  last_used_at: null,
  state: "ok",
}

type Route = (init: RequestInit) => Response | Promise<Response>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** Answers "METHOD /path" (under /api/assistant) from `routes`, and 404 for anything else. */
function stubAssistant(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const route = routes[`${init.method ?? "GET"} ${url.replace(/^\/api\/assistant/, "")}`]
    return route ? route(init) : new Response("Not Found", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const health = (ownKeys: unknown = OWN_KEYS) => () => json({ status: "ok", model: "qwen", vision: false, own_keys: ownKeys })

function calls(fetchMock: ReturnType<typeof stubAssistant>, method: string, path: string) {
  return fetchMock.mock.calls
    .filter(([url, init]) => (init?.method ?? "GET") === method && url === `/api/assistant${path}`)
    .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : undefined))
}

/** Lets pending fetches and the renders they cause finish. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Renders the card on Profile at `path`, under a router as Profile.tsx has it, with anything else in `extra`. */
async function renderCard(path = "/profile", extra?: ReactNode) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AssistantKeysCard />
      {extra}
    </MemoryRouter>,
  )
  await settle()
  return view
}

async function providerSection(name: string) {
  return screen.findByRole("region", { name })
}

/** Nothing on the page, in storage or in a toast holds the key. */
function expectKeyGone() {
  expect(document.body.innerHTML).not.toContain(FAKE_KEY)
  for (const input of document.querySelectorAll("input")) expect(input.value).not.toContain(FAKE_KEY)
  expect(JSON.stringify({ ...localStorage })).not.toContain(FAKE_KEY)
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(FAKE_KEY)
  expect(JSON.stringify([vi.mocked(toast).mock.calls, vi.mocked(toast.success).mock.calls, vi.mocked(toast.error).mock.calls])).not.toContain(FAKE_KEY)
}

beforeEach(() => {
  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({ access_token: "login-jwt", token_type: "Bearer", expires_at: Date.now() + 3_600_000 }),
  )
  // Radix Select scrolls the chosen option into view, which jsdom does not do.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("AssistantKeysCard", () => {
  it("shows nothing when the assistant has personal keys turned off", async () => {
    const fetchMock = stubAssistant({ "GET /health": health(null) })
    const { container } = await renderCard()

    expect(container.innerHTML).toBe("")
    expect(calls(fetchMock, "GET", "/keys")).toHaveLength(0)
  })

  it("shows nothing when the assistant does not answer", async () => {
    stubAssistant({ "GET /health": () => new Response("<html>Bad Gateway</html>", { status: 502 }) })
    const { container } = await renderCard()
    expect(container.innerHTML).toBe("")

    cleanup()
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))))
    const again = await renderCard()
    expect(again.container.innerHTML).toBe("")
  })

  it("shows nothing when the key routes are missing", async () => {
    stubAssistant({ "GET /health": health() })
    const { container } = await renderCard()
    expect(container.innerHTML).toBe("")
  })

  it("says why the keys did not load, and tries again", async () => {
    let fail = true
    stubAssistant({
      "GET /health": health(),
      "GET /keys": () =>
        fail ? json({ error: "Could not reach Babamul. Try again in a minute." }, 503) : json({ use: "shared", keys: [] }),
    })
    await renderCard()

    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach Babamul. Try again in a minute.")
    fail = false
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByRole("textbox", { name: "Workspace ID (optional)" })).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("scrolls to itself when Profile opens at its link", async () => {
    stubAssistant({ "GET /health": health(), "GET /keys": () => json({ use: "shared", keys: [] }) })
    await renderCard("/profile#ai-model")

    const card = await screen.findByText("AI model for Ask Babamul")
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toEqual([card.closest("#ai-model")])
  })

  it("scrolls to itself each time its link is followed on Profile", async () => {
    stubAssistant({ "GET /health": health(), "GET /keys": () => json({ use: "shared", keys: [] }) })
    // Like the Ask panel's "Fix on Profile", with the panel open over Profile.
    await renderCard("/profile", <Link to="/profile#ai-model">Fix on Profile</Link>)
    const card = (await screen.findByText("AI model for Ask Babamul")).closest("#ai-model")
    const scroll = vi.mocked(Element.prototype.scrollIntoView)
    expect(scroll).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("link", { name: "Fix on Profile" }))
    await waitFor(() => expect(scroll.mock.contexts).toEqual([card]))
    fireEvent.click(screen.getByRole("link", { name: "Fix on Profile" }))
    await waitFor(() => expect(scroll.mock.contexts).toEqual([card, card]))
  })

  it("saves and checks a key, then keeps it nowhere on the page", async () => {
    const fetchMock = stubAssistant({
      "GET /health": health(),
      "GET /keys": () => json({ use: "shared", keys: [] }),
      "POST /keys/anthropic": () => json(SAVED),
    })
    const { container } = await renderCard()

    expect(screen.getByText("AI model for Ask Babamul")).toBeTruthy()
    expect((container.firstElementChild as HTMLElement).className).toContain("ph-no-capture")
    const section = await providerSection("Anthropic")
    expect(within(section).getByRole("link", { name: "Get an API key from Anthropic" }).getAttribute("href")).toBe(
      "https://platform.claude.com/settings/keys",
    )
    const input = within(section).getByLabelText("Anthropic API key") as HTMLInputElement
    expect(input.type).toBe("password")
    expect(input.getAttribute("autocomplete")).toBe("off")
    expect(input.getAttribute("spellcheck")).toBe("false")
    expect(input.className).toContain("ph-no-capture")

    const save = within(section).getByRole("button", { name: "Save and check" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(input, { target: { value: FAKE_KEY } })
    fireEvent.change(within(section).getByRole("textbox", { name: "Workspace ID (optional)" }), {
      target: { value: "wrkspc_01FAKE" },
    })
    fireEvent.click(save)
    expect(input.value).toBe("")

    expect(await within(section).findByText("…wxyz")).toBeTruthy()
    expect(calls(fetchMock, "POST", "/keys/anthropic")).toEqual([
      { key: FAKE_KEY, model: "claude-haiku-5-5", days: 30, workspace_id: "wrkspc_01FAKE", use: true },
    ])
    expect(within(section).queryByLabelText("Anthropic API key")).toBeNull()
    expect(within(section).getByText("In use")).toBeTruthy()
    expect(within(section).getByText(/Expires in 30 days/)).toBeTruthy()
    expect((screen.getByRole("radio", { name: "My Anthropic key" }) as HTMLInputElement).checked).toBe(true)
    expect(toast.success).toHaveBeenCalled()
    // The form that had focus is gone; focus is on the provider's heading, not lost to the page.
    expect(document.activeElement).toBe(within(section).getByRole("heading", { name: "Anthropic" }))
    expectKeyGone()
  })

  it.each([
    [422, "rejected", "Anthropic did not accept this key."],
    [502, "provider_unreachable", "Could not reach Anthropic to check the key. Nothing was saved."],
    [429, "too_many_saves", "That is a lot of saves. Try again in an hour."],
    [400, "bad_format", "This is not a Console API key."],
  ])("shows the service's message for %i %s, clears the box and saves nothing", async (status, code, message) => {
    stubAssistant({
      "GET /health": health(),
      "GET /keys": () => json({ use: "shared", keys: [] }),
      "POST /keys/anthropic": () => json({ error: message, code }, status),
    })
    await renderCard()
    const section = await providerSection("Anthropic")
    const input = within(section).getByLabelText("Anthropic API key") as HTMLInputElement

    fireEvent.change(input, { target: { value: FAKE_KEY } })
    fireEvent.click(within(section).getByRole("button", { name: "Save and check" }))

    expect((await within(section).findByRole("alert")).textContent).toBe(message)
    expect(input.value).toBe("")
    expect(document.activeElement).toBe(input)
    expect(within(section).queryByText("…wxyz")).toBeNull()
    expect(toast.success).not.toHaveBeenCalled()
    expectKeyGone()
  })

  it("removes a key after asking, and goes back to the shared model", async () => {
    const fetchMock = stubAssistant({
      "GET /health": health(),
      "GET /keys": () => json({ use: "anthropic", keys: [SAVED] }),
      "DELETE /keys/anthropic": () => new Response(null, { status: 204 }),
    })
    await renderCard()
    const section = await providerSection("Anthropic")
    expect(within(section).getByText("…wxyz")).toBeTruthy()

    fireEvent.click(within(section).getByRole("button", { name: "Remove your Anthropic key" }))
    const dialog = await screen.findByRole("dialog", { name: "Remove your Anthropic key?" })
    expect(calls(fetchMock, "DELETE", "/keys/anthropic")).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(within(section).queryByText("…wxyz")).toBeNull())
    expect(calls(fetchMock, "DELETE", "/keys/anthropic")).toHaveLength(1)
    expect(within(section).getByLabelText("Anthropic API key")).toBeTruthy()
    expect((screen.getByRole("radio", { name: "Shared Babamul model (default)" }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole("radio", { name: "My Anthropic key" })).toBeNull()
    await waitFor(() =>
      expect(document.activeElement).toBe(within(section).getByRole("heading", { name: "Anthropic" })),
    )
  })

  it("sends focus back to the Remove button when removing is cancelled", async () => {
    const fetchMock = stubAssistant({
      "GET /health": health(),
      "GET /keys": () => json({ use: "anthropic", keys: [SAVED] }),
    })
    await renderCard()
    const section = await providerSection("Anthropic")
    const button = within(section).getByRole("button", { name: "Remove your Anthropic key" })

    button.focus()
    fireEvent.click(button)
    const dialog = await screen.findByRole("dialog", { name: "Remove your Anthropic key?" })
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(button))
    expect(calls(fetchMock, "DELETE", "/keys/anthropic")).toHaveLength(0)
  })

  it("keeps the choices usable and focused while a change is sent, and drops extra picks", async () => {
    let answer: (response: Response) => void = () => {}
    const fetchMock = stubAssistant({
      "GET /health": health(),
      "GET /keys": () => json({ use: "anthropic", keys: [SAVED] }),
      "POST /choice": () => new Promise<Response>((resolve) => (answer = resolve)),
    })
    await renderCard()
    const shared = (await screen.findByRole("radio", { name: "Shared Babamul model (default)" })) as HTMLInputElement
    const mine = screen.getByRole("radio", { name: "My Anthropic key" }) as HTMLInputElement
    const group = screen.getByRole("group", { name: "Which model answers your questions" }) as HTMLFieldSetElement

    shared.focus()
    fireEvent.click(shared)
    await settle()
    // A disabled fieldset would blur the radio that has focus.
    expect(group.disabled).toBe(false)
    expect(group.getAttribute("aria-busy")).toBe("true")
    fireEvent.click(mine)
    await settle()
    expect(calls(fetchMock, "POST", "/choice")).toEqual([{ use: "shared" }])

    await act(async () => answer(json({ use: "shared" })))
    await waitFor(() => expect(shared.checked).toBe(true))
    expect(mine.checked).toBe(false)
    expect(group.getAttribute("aria-busy")).toBeNull()
    expect(document.activeElement).toBe(shared)
  })

  it("switches between the shared model and a saved key", async () => {
    const fetchMock = stubAssistant({
      "GET /health": health(),
      "GET /keys": () => json({ use: "anthropic", keys: [SAVED] }),
      "POST /choice": (init) => json({ use: JSON.parse(String(init.body)).use }),
    })
    await renderCard()
    const shared = (await screen.findByRole("radio", { name: "Shared Babamul model (default)" })) as HTMLInputElement
    expect(shared.checked).toBe(false)
    // No key saved for OpenRouter, so it is not offered.
    expect(screen.queryByRole("radio", { name: "My OpenRouter key" })).toBeNull()

    fireEvent.click(shared)

    await waitFor(() => expect(shared.checked).toBe(true))
    expect(calls(fetchMock, "POST", "/choice")).toEqual([{ use: "shared" }])
  })

  it("changes the model of the key in use", async () => {
    const fetchMock = stubAssistant({
      "GET /health": health(),
      "GET /keys": () => json({ use: "anthropic", keys: [SAVED] }),
      "POST /choice": () => json({ use: "anthropic" }),
    })
    await renderCard()
    const section = await providerSection("Anthropic")

    fireEvent.keyDown(within(section).getByRole("combobox", { name: "Model" }), { key: "Enter" })
    fireEvent.click(await screen.findByRole("option", { name: "claude-sonnet-5-5" }))

    await waitFor(() => expect(calls(fetchMock, "POST", "/choice")).toEqual([{ use: "anthropic", model: "claude-sonnet-5-5" }]))
    await waitFor(() =>
      expect(within(section).getByRole("combobox", { name: "Model" }).textContent).toBe("claude-sonnet-5-5"),
    )
    expect((screen.getByRole("radio", { name: "My Anthropic key" }) as HTMLInputElement).checked).toBe(true)
    expect(toast.success).toHaveBeenCalledWith("Ask Babamul now answers with claude-sonnet-5-5.")
  })

  it("does not offer a model change on a saved key that is not in use", async () => {
    const fetchMock = stubAssistant({
      "GET /health": health(),
      "GET /keys": () => json({ use: "shared", keys: [SAVED] }),
      "POST /choice": () => json({ use: "anthropic" }),
    })
    await renderCard()
    const section = await providerSection("Anthropic")

    // Changing the model would also switch the person from the shared model to their paid key.
    expect(within(section).queryByRole("combobox", { name: "Model" })).toBeNull()
    expect(within(section).getByText("claude-haiku-5-5")).toBeTruthy()
    expect(within(section).getByText(/first choose "My Anthropic key" above/)).toBeTruthy()
    expect((screen.getByRole("radio", { name: "Shared Babamul model (default)" }) as HTMLInputElement).checked).toBe(true)
    expect(calls(fetchMock, "POST", "/choice")).toHaveLength(0)
  })

  it("asks for a key the provider refused again, and keeps it the choice until then", async () => {
    stubAssistant({
      "GET /health": health(),
      "GET /keys": () => json({ use: "anthropic", keys: [{ ...SAVED, state: "refused" }] }),
    })
    await renderCard()
    const section = await providerSection("Anthropic")

    expect(within(section).getByText("Refused")).toBeTruthy()
    expect(within(section).getByText(/Enter it again/)).toBeTruthy()
    expect(within(section).getByLabelText("New Anthropic API key")).toBeTruthy()
    const mine = screen.getByRole("radio", { name: /My Anthropic key/ }) as HTMLInputElement
    expect([mine.checked, mine.disabled]).toEqual([true, true])
  })
})
