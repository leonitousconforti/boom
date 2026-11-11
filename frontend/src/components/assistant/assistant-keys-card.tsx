import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { toast } from "sonner"
import { ExternalLink, Loader2, Trash } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  KEYS_CARD_ID,
  KeysError,
  chooseModel,
  fetchKeys,
  fetchOwnKeysConfig,
  removeKey,
  saveKey,
  type KeysOverview,
  type OwnKeysConfig,
  type OwnKeysProvider,
  type SaveKeyRequest,
  type SavedKey,
} from "@/lib/assistant-keys"
import { cn } from "@/lib/utils"

const SHARED = "shared"
const DAY_MS = 86_400_000

// How to cap spending, for the providers that have a way.
const SPEND_LIMITS: Record<string, string> = {
  anthropic: "on Anthropic, a key in a workspace with a spend limit",
  openrouter: "on OpenRouter, a key with a credit limit",
}

/**
 * The Profile card where a person saves their own AI keys and picks which
 * model answers in Ask Babamul.
 *
 * It asks the assistant for itself and shows nothing unless the assistant is
 * up with personal keys turned on, so a missing assistant leaves Profile as it
 * was. Key text lives only in the password box until it is sent, and is never
 * put in state, toasts, analytics or storage. `ph-no-capture` keeps PostHog's
 * autocapture and session replay out of the whole card.
 */
export function AssistantKeysCard({ className }: { className?: string }) {
  const [config, setConfig] = useState<OwnKeysConfig | null>(null)
  const [overview, setOverview] = useState<KeysOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [turnedOff, setTurnedOff] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // What a request is changing right now: SHARED for the choice, or a provider id.
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [removeTarget, setRemoveTarget] = useState<OwnKeysProvider | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const choiceName = useId()

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    fetchOwnKeysConfig(signal).then(async (found) => {
      if (signal.aborted) return
      setConfig(found)
      if (!found) return
      try {
        const keys = await fetchKeys(signal)
        setOverview(keys)
        setLoadError(null)
      } catch (err) {
        if (signal.aborted) return
        // The assistant answers /health but not /keys: personal keys were turned off.
        if (err instanceof KeysError && err.code === "not_found") setTurnedOff(true)
        else setLoadError(messageOf(err))
      }
    })
    return () => controller.abort()
  }, [attempt])

  const ready = !!overview || !!loadError
  useEffect(() => {
    // The Ask panel's "Fix on Profile" links here; the page loads before this card does.
    if (ready && window.location.hash === `#${KEYS_CARD_ID}`) rootRef.current?.scrollIntoView?.({ block: "start" })
  }, [ready])

  if (!config || turnedOff) return null

  const setError = (id: string, message: string | null) =>
    setErrors((all) => {
      const next = { ...all }
      if (message) next[id] = message
      else delete next[id]
      return next
    })

  async function choose(use: string, model?: string) {
    const target = model ? use : SHARED
    setBusy(target)
    setError(target, null)
    try {
      const now = await chooseModel(use, model)
      setOverview((o) => o && { use: now, keys: o.keys.map((k) => (model && k.provider === use ? { ...k, model } : k)) })
      if (model) toast.success(`Ask Babamul now answers with ${model}.`)
    } catch (err) {
      setError(target, messageOf(err))
      // The key went bad or away since the list was loaded.
      if (err instanceof KeysError && err.code === "no_key") fetchKeys().then(setOverview, () => {})
    } finally {
      setBusy(null)
    }
  }

  async function save(provider: OwnKeysProvider, request: SaveKeyRequest): Promise<boolean> {
    setBusy(provider.id)
    setError(provider.id, null)
    try {
      const saved = await saveKey(provider.id, request)
      setOverview(
        (o) =>
          o && {
            use: request.use === false ? o.use : provider.id,
            keys: [...o.keys.filter((k) => k.provider !== provider.id), saved],
          },
      )
      toast.success(`${provider.name} accepted your key. Ask Babamul answers with it now.`)
      return true
    } catch (err) {
      setError(provider.id, messageOf(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  async function remove(provider: OwnKeysProvider) {
    setRemoveOpen(false)
    setBusy(provider.id)
    setError(provider.id, null)
    try {
      await removeKey(provider.id)
      setOverview(
        (o) =>
          o && {
            use: o.use === provider.id ? SHARED : o.use,
            keys: o.keys.filter((k) => k.provider !== provider.id),
          },
      )
      toast.success(`Your ${provider.name} key is removed.`)
    } catch (err) {
      setError(provider.id, messageOf(err))
    } finally {
      setBusy(null)
    }
  }

  const providers = config.providers
  const anthropic = providers.some((p) => p.id === "anthropic")
  const limits = providers.flatMap((p) => SPEND_LIMITS[p.id] ?? [])
  const keyFor = (id: string) => overview?.keys.find((k) => k.provider === id)
  // A key that stopped working stays listed while it is the choice, so the choice is never hidden.
  const choices = providers.filter((p) => keyFor(p.id)?.state === "ok" || overview?.use === p.id)

  return (
    <Card id={KEYS_CARD_ID} ref={rootRef} className={cn("ph-no-capture scroll-mt-4", className)}>
      <CardHeader>
        <CardTitle>AI model for Ask Babamul</CardTitle>
        <CardDescription>
          Ask Babamul answers with a shared model that Babamul runs. You can have it answer with your own{" "}
          {orList(providers.map((p) => p.name))} account instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            Your key is checked once with the provider, then stored encrypted on the assistant server. It is never
            shown again.
          </li>
          <li>Questions answered with your key are billed to your account with that provider.</li>
          {limits.length > 0 && <li>Use a key with a spending limit: {limits.join("; ")}.</li>}
          {anthropic && (
            <li>
              A Claude Pro or Max subscription is not an API key. Max, Ultra and Team plans include monthly API
              credits you can claim in the Claude Console.
            </li>
          )}
          <li>The people running the assistant server could technically use this key.</li>
          <li>Babamul data you look up, including data only your account can see, is sent to that provider.</li>
        </ul>

        {loadError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            {loadError}
            <Button
              size="sm"
              variant="outline"
              className="text-foreground"
              onClick={() => {
                setLoadError(null)
                setAttempt((n) => n + 1)
              }}
            >
              Try again
            </Button>
          </div>
        ) : !overview ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Loading your AI keys
          </p>
        ) : (
          <>
            <fieldset className="space-y-2" disabled={busy !== null}>
              <legend className="mb-2 text-sm font-medium">Which model answers your questions</legend>
              <Choice
                name={choiceName}
                value={SHARED}
                checked={overview.use === SHARED}
                label="Shared Babamul model (default)"
                onPick={() => choose(SHARED)}
              />
              {choices.map((p) => (
                <Choice
                  key={p.id}
                  name={choiceName}
                  value={p.id}
                  checked={overview.use === p.id}
                  disabled={keyFor(p.id)?.state !== "ok"}
                  label={`My ${p.name} key`}
                  onPick={() => choose(p.id)}
                />
              ))}
              {errors[SHARED] && (
                <p role="alert" className="text-sm text-destructive">
                  {errors[SHARED]}
                </p>
              )}
            </fieldset>

            {providers.map((p) => (
              <ProviderKey
                key={p.id}
                provider={p}
                config={config}
                saved={keyFor(p.id)}
                inUse={overview.use === p.id}
                busy={busy !== null}
                saving={busy === p.id}
                error={errors[p.id]}
                onSave={(request) => save(p, request)}
                onModel={(model) => choose(p.id, model)}
                onRemove={() => {
                  setRemoveTarget(p)
                  setRemoveOpen(true)
                }}
              />
            ))}
          </>
        )}
      </CardContent>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove your {removeTarget?.name} key?</DialogTitle>
            <DialogDescription>
              It is deleted from the assistant server. If Ask Babamul answers with it, the shared Babamul model
              answers again. The key itself keeps working with {removeTarget?.name} until you delete it there.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => removeTarget && remove(removeTarget)}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function Choice({
  name,
  value,
  checked,
  disabled,
  label,
  onPick,
}: {
  name: string
  value: string
  checked: boolean
  disabled?: boolean
  label: string
  onPick: () => void
}) {
  return (
    <label className={cn("flex items-center gap-2 text-sm", disabled && "text-muted-foreground")}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
        className="size-4 accent-primary"
      />
      {label}
      {disabled && " (enter the key again to use it)"}
    </label>
  )
}

function ProviderKey({
  provider,
  config,
  saved,
  inUse,
  busy,
  saving,
  error,
  onSave,
  onModel,
  onRemove,
}: {
  provider: OwnKeysProvider
  config: OwnKeysConfig
  saved?: SavedKey
  inUse: boolean
  busy: boolean
  saving: boolean
  error?: string
  onSave: (request: SaveKeyRequest) => Promise<boolean>
  onModel: (model: string) => void
  onRemove: () => void
}) {
  const titleId = useId()
  const modelId = useId()
  // A model the operator has since dropped still shows as what the key uses.
  const models = saved && saved.model && !provider.models.includes(saved.model) ? [...provider.models, saved.model] : provider.models

  return (
    <section aria-labelledby={titleId} className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="font-semibold">
          {provider.name}
        </h3>
        {provider.key_url && (
          <a
            href={provider.key_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
          >
            Get an API key from {provider.name}
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        )}
      </div>

      {saved && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">
              Key <span className="font-mono">{saved.hint}</span>
            </span>
            {inUse && saved.state === "ok" && <Badge variant="secondary">In use</Badge>}
            {saved.state !== "ok" && (
              <Badge variant="destructive">{saved.state === "refused" ? "Refused" : "Unreadable"}</Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-destructive"
              onClick={onRemove}
              disabled={busy}
              aria-label={`Remove your ${provider.name} key`}
            >
              <Trash aria-hidden />
              Remove
            </Button>
          </div>
          {saved.state !== "ok" && (
            <p className="text-sm text-destructive">
              {saved.state === "refused"
                ? `${provider.name} refused this key the last time it was used. Enter it again, or a new one.`
                : "The assistant server can no longer read this key. Enter it again."}
            </p>
          )}
          {saved.state === "ok" && (
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={modelId}>Model</Label>
              <Select value={saved.model} onValueChange={onModel} disabled={busy}>
                <SelectTrigger id={modelId} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            <span title={whenText(saved.expires_at)}>{expiresText(saved.expires_at)}</span>
            {" · "}
            {saved.last_used_at ? `Last used ${whenText(saved.last_used_at)}` : "Not used yet"}
            {saved.workspace_id && ` · Workspace ${saved.workspace_id}`}
          </p>
        </div>
      )}

      {(!saved || saved.state !== "ok") && (
        <KeyForm provider={provider} config={config} replacing={!!saved} busy={busy} saving={saving} onSave={onSave} />
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

function KeyForm({
  provider,
  config,
  replacing,
  busy,
  saving,
  onSave,
}: {
  provider: OwnKeysProvider
  config: OwnKeysConfig
  replacing: boolean
  busy: boolean
  saving: boolean
  onSave: (request: SaveKeyRequest) => Promise<boolean>
}) {
  // The key is read from the box when sent and never kept in state; only whether the box is empty is.
  const keyRef = useRef<HTMLInputElement>(null)
  const [filled, setFilled] = useState(false)
  const [model, setModel] = useState(provider.default_model)
  const [days, setDays] = useState(String(config.default_days))
  const [workspace, setWorkspace] = useState("")
  const keyId = useId()
  const modelId = useId()
  const daysId = useId()
  const workspaceId = useId()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const input = keyRef.current
    const key = input?.value.trim() ?? ""
    // Emptied before the check starts, so the key is not left on screen whatever the answer.
    if (input) input.value = ""
    setFilled(false)
    if (!key) return
    const saved = await onSave({
      key,
      model,
      days: Number(days),
      workspace_id: workspace.trim() || undefined,
      use: true,
    })
    if (saved) {
      setModel(provider.default_model)
      setDays(String(config.default_days))
      setWorkspace("")
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={keyId}>{replacing ? `New ${provider.name} API key` : `${provider.name} API key`}</Label>
        <Input
          id={keyId}
          ref={keyRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          // Keeps password managers from offering to save it as a site password.
          data-1p-ignore
          data-lpignore="true"
          placeholder={provider.key_prefix ? `${provider.key_prefix}…` : undefined}
          className="ph-no-capture font-mono"
          onChange={(e) => setFilled(e.target.value.trim() !== "")}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={modelId}>Model</Label>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger id={modelId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {provider.models.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={daysId}>Delete the key after</Label>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger id={daysId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {config.days.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d === 1 ? "1 day" : `${d} days`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {provider.workspace_field && (
        <div className="space-y-1.5">
          <Label htmlFor={workspaceId}>Workspace ID (optional)</Label>
          <Input
            id={workspaceId}
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Only if your key is not tied to one workspace"
          />
        </div>
      )}
      <Button type="submit" disabled={!filled || busy}>
        {saving && <Loader2 aria-hidden className="animate-spin" />}
        Save and check
      </Button>
    </form>
  )
}

function messageOf(err: unknown): string {
  return err instanceof KeysError ? err.message : new KeysError("unavailable").message
}

function orList(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`
}

function expiresText(iso: string, now = Date.now()): string {
  const days = Math.round((Date.parse(iso) - now) / DAY_MS)
  if (Number.isNaN(days)) return "Expiry unknown"
  if (days < 1) return "Expires in less than a day"
  return days === 1 ? "Expires in 1 day" : `Expires in ${days} days`
}

function whenText(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
