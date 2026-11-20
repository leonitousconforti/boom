import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import api, { Alert } from "@/lib/api"
import Query from "@/pages/Query"

beforeAll(() => {
  // jsdom implements neither scrolling into view nor watching for it.
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function searchAlerts(objectId: string, candidate: Record<string, unknown>) {
  const alert = { candid: "1", objectId, candidate: { jd: 2461000.5, ...candidate } }
  vi.spyOn(api, "fetchAlerts").mockResolvedValue([alert as unknown as Alert])
  render(
    <MemoryRouter>
      <Query />
    </MemoryRouter>,
  )
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Alerts" }), { button: 0 })
  fireEvent.click(screen.getByRole("button", { name: "Search Alerts" }))
  return screen.findByText(objectId)
}

it("opens a result in the survey that was searched after the toggle changes", async () => {
  const open = vi.spyOn(window, "open").mockImplementation(() => null)
  const card = await searchAlerts("ZTF18aaaaaaa", {})

  fireEvent.click(screen.getByRole("button", { name: "LSST" }))
  fireEvent.click(card)

  expect(open).toHaveBeenCalledWith("/objects/ZTF/ZTF18aaaaaaa", "_blank")
})

it("shows the band of an alert that has no fid", async () => {
  await searchAlerts("313953718093332480", { band: "r" })

  expect(screen.getByText("Band:")).toBeTruthy()
})
