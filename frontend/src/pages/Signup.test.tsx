import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import SignupPage from "@/pages/Signup"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Answer `path` with `body`, and anything else (the OAuth provider list) with nothing. */
function stubApi(path: string, status: number, body: unknown) {
  const json = (code: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status: code, headers: { "Content-Type": "application/json" } })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (String(url).endsWith(path) ? json(status, body) : json(200, { data: [] }))),
  )
}

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <SignupPage />
    </MemoryRouter>,
  )
}

it("shows the API's message when sign-up is refused", async () => {
  stubApi("/signup", 409, { message: "Email already registered (and activated)", error: "DUPLICATE_EMAIL" })
  renderAt("/signup")
  fireEvent.change(screen.getByPlaceholderText("Your full name"), { target: { value: "Ada Lovelace" } })
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "ada@example.org" } })
  fireEvent.click(screen.getByRole("button", { name: "Send activation" }))

  expect(await screen.findByText("Email already registered (and activated)")).toBeTruthy()
})

it("shows the API's message when an activation link's code is wrong", async () => {
  stubApi("/activate", 400, { message: "Invalid activation code" })
  renderAt("/signup?email=ada@example.org&activation_code=000000")

  expect(await screen.findByText("Invalid activation code")).toBeTruthy()
})

it("shows the generated password once an activation link succeeds", async () => {
  stubApi("/activate", 200, {
    message: "Account activated",
    activated: true,
    username: "ada",
    email: "ada@example.org",
    password: "generated-password",
  })
  renderAt("/signup?email=ada@example.org&activation_code=123456")

  expect(await screen.findByText("generated-password")).toBeTruthy()
})
