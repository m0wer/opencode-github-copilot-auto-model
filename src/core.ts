// Copilot Auto routing, independent of opencode's plugin API: tiers, the POST /auto
// call (plus the legacy /models/session fallback), which autos to inject and which
// server pick an auto can actually send.
import { randomUUID } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const PROVIDER_ID = "github-copilot"
export const MODEL_ID = "auto"
export const DEFAULT_BASE_URL = "https://api.githubcopilot.com"

// Matches `@vscode/copilot-api` 0.5.x (`_mixinHeaders`) and opencode's own Copilot provider.
const COPILOT_API_VERSION = "2026-08-01"

// Stand-ins for the per-install ids VS Code stamps on every gated Copilot request.
// Editor-Version / Editor-Plugin-Version / Copilot-Integration-Id are deliberately not
// sent: POST /auto answers without them, and they would impersonate VS Code.
const VSCODE_SESSION_ID = `${randomUUID()}${Date.now()}`
const VSCODE_MACHINE_ID = randomUUID().replace(/-/g, "")
const VSCODE_DEVICE_ID = randomUUID()

// VS Code's AutoV2Fetcher aborts POST /auto after 5s.
const AUTO_TIMEOUT_MS = 5000

// VS Code renews an auto session this long before its server expiry, so a long
// request cannot outlive its token.
export const SESSION_REFRESH_SKEW_MS = 5 * 60_000

// Routing profiles accepted by POST /auto (VS Code's autoModeTiers.ts). A tier is
// picked per session and biases which models the server may choose from.
export const AUTO_TIERS = ["efficiency", "balance", "intelligence", "fast"] as const
export type AutoTier = (typeof AUTO_TIERS)[number]
export const DEFAULT_TIER: AutoTier = "balance"
// Retired names the server still accepts; VS Code maps them forward on read.
const RETIRED_TIERS: Record<string, AutoTier> = { eco: "efficiency", balanced: "balance", max: "intelligence" }

// Request body shape a model is sent with. Picks on another wire API cannot be sent
// through an auto's endpoint: the bodies differ.
export type Wire = "responses" | "chat" | "messages"

// A Copilot model as routing needs it, independent of opencode's model shape.
export type CatalogModel = {
  // opencode's model id (the picker key).
  key: string
  // The id Copilot's API knows; POST /auto answers with these.
  apiID: string
  name: string
  family?: string
  // Models sharing a transport are sent by the same SDK to the same base URL.
  transport: string
  wire: Wire
  enabled: boolean
}

export type AutoConfig = {
  id?: string
  name?: string
  preferredModels?: string[]
  tier?: string
  /** @deprecated POST /auto returns no reasoning verdict; ignored. */
  reasoning?: string[]
  /** @deprecated POST /auto returns no reasoning verdict; ignored. */
  noReasoning?: string[]
}

export type Options = {
  // Ordered list of preferred model keys or API ids. The first one anchors the
  // auto's endpoint and is the fallback when the server's pick cannot be served.
  preferredModels?: string[]
  // Routing profile sent to POST /auto: efficiency | balance | intelligence | fast.
  tier?: string
  /** @deprecated POST /auto returns no reasoning verdict; ignored. */
  reasoning?: string[]
  /** @deprecated POST /auto returns no reasoning verdict; ignored. */
  noReasoning?: string[]
  // Additional injected autos. When omitted, one default auto is injected per
  // supported family (Claude, GPT) with at least two catalog models. Pass [] to
  // disable the defaults, or an explicit list to replace them.
  autos?: AutoConfig[]
}

// An auto as injected into the picker: cloned from its anchor model, whose endpoint
// carries every request it sends.
export type AutoSpec = {
  id: string
  name: string
  tier: AutoTier
  preferredAPIIDs: string[]
  anchor: CatalogModel
  // Clamp to one family label (e.g. "Claude"), even when another family shares the
  // transport (GPT, MAI and Gemini all ride the Copilot SDK).
  familyFilter?: string
}

// A server routing result: the model(s) the session may bill, plus the session token
// that places chat requests in Copilot's Auto pool (and its discount).
export type AutoSession = {
  // "auto": POST /auto picked exactly one model for the prompt.
  // "legacy": POST /models/session returned a pool; used only when /auto fails.
  source: "auto" | "legacy"
  models: string[]
  sessionToken: string
  expiresAtMs: number
}

// Which session flow issued a model request (opencode's SessionRequestKind).
export type ConvKind = "primary" | "compaction" | "title" | "generate"

// The model a conversation is pinned to. `sessionToken` is only set when the server
// routed to that exact model; fallbacks go without it (Copilot rejects a token for a
// model the session did not pick).
export type Route = {
  modelID: string
  sessionToken?: string
  expiresAtMs: number
}

// --- logging ----------------------------------------------------------------------------
// File logger — keeps the TUI clean.
// Tail ~/.local/state/opencode-github-copilot-auto-model/plugin.log to observe.
function logFile() {
  if (process.platform === "win32")
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "opencode-github-copilot-auto-model",
      "plugin.log",
    )
  const xdg = process.env.XDG_STATE_HOME
  return path.join(xdg ?? path.join(homedir(), ".local", "state"), "opencode-github-copilot-auto-model", "plugin.log")
}

let logReady: Promise<void> | undefined
export function log(msg: string) {
  const file = logFile()
  logReady ??= mkdir(path.dirname(file), { recursive: true }).then(() => undefined).catch(() => undefined)
  void logReady.then(() => appendFile(file, `${new Date().toISOString()} info ${msg}\n`).catch(() => undefined))
}

// --- configuration ----------------------------------------------------------------------
export function normalizeTier(value: string | undefined): AutoTier {
  const raw = value?.trim().toLowerCase()
  if (!raw) return DEFAULT_TIER
  const tier = RETIRED_TIERS[raw] ?? raw
  if ((AUTO_TIERS as readonly string[]).includes(tier)) return tier as AutoTier
  log(`ignoring unknown tier "${value}"; using ${DEFAULT_TIER}`)
  return DEFAULT_TIER
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values?.length) return []
  const deduped: string[] = []
  for (const v of values) {
    const s = v.trim()
    if (s && !deduped.includes(s)) deduped.push(s)
  }
  return deduped
}

export function usesDeprecatedLabelLists(options: Options): boolean {
  const configs: AutoConfig[] = [options, ...(options.autos ?? [])]
  return configs.some((c) => !!c.reasoning?.length || !!c.noReasoning?.length)
}

export function familyLabel(model?: Pick<CatalogModel, "key" | "apiID" | "name" | "family" | "wire">): string | undefined {
  if (!model) return undefined
  const fingerprint = `${model.key} ${model.name} ${model.family ?? ""} ${model.apiID}`.toLowerCase()
  // Fingerprint first: many families share the Copilot transport, so it cannot tell
  // them apart.
  if (fingerprint.includes("claude")) return "Claude"
  if (fingerprint.includes("gemini")) return "Gemini"
  if (fingerprint.includes("microsoft") || fingerprint.includes("mai") || fingerprint.includes("raptor"))
    return "Microsoft"
  if (fingerprint.includes("gpt") || fingerprint.includes("codex")) return "GPT"
  if (model.wire === "messages") return "Claude"
  return undefined
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function uniqueValue(base: string, used: Set<string>, suffix = "-"): string {
  let value = base || "auto"
  let counter = 2
  while (used.has(value)) {
    value = `${base}${suffix}${counter}`
    counter += 1
  }
  used.add(value)
  return value
}

type AutoDraft = {
  requestedID?: string
  requestedName?: string
  preferredModels: string[]
  tier?: string
  legacy: boolean
  index: number
  familyFilter?: string
}

// Families injected as per-family autos when `autos` is not configured; Gemini and
// others stay opt-in.
const DEFAULT_AUTO_FAMILIES = ["Claude", "GPT"]

function autoDrafts(options: Options, catalog: CatalogModel[]): AutoDraft[] {
  const drafts: AutoDraft[] = [
    {
      requestedID: MODEL_ID,
      requestedName: "Auto",
      preferredModels: normalizeList(options.preferredModels),
      tier: options.tier,
      legacy: true,
      index: 0,
    },
  ]
  if (options.autos === undefined) {
    // One default auto per supported family with at least two catalog models (with a
    // single model the auto adds nothing over picking that model directly).
    for (const [index, label] of DEFAULT_AUTO_FAMILIES.entries()) {
      if (catalog.filter((m) => familyLabel(m) === label).length < 2) continue
      drafts.push({ preferredModels: [], legacy: false, index: index + 1, familyFilter: label })
    }
    return drafts
  }
  for (const [index, auto] of options.autos.entries()) {
    drafts.push({
      requestedID: auto.id?.trim() || undefined,
      requestedName: auto.name?.trim() || undefined,
      preferredModels: normalizeList(auto.preferredModels),
      tier: auto.tier,
      legacy: false,
      index: index + 1,
    })
  }
  return drafts
}

function resolvePreferred(catalog: CatalogModel[], preferred: string[]): CatalogModel[] {
  const resolved: CatalogModel[] = []
  for (const token of preferred) {
    const model = catalog.find((m) => m.key === token) ?? catalog.find((m) => m.apiID === token)
    if (model && !resolved.includes(model)) resolved.push(model)
  }
  return resolved
}

// Unclamped autos anchor on a GPT model sent over the Responses API when possible:
// that is what POST /auto picks most, so it keeps the most picks servable.
function pickAnchor(catalog: CatalogModel[], familyFilter?: string): CatalogModel | undefined {
  const candidates = catalog.filter((m) => !familyFilter || familyLabel(m) === familyFilter)
  const enabled = candidates.filter((m) => m.enabled)
  const pool = enabled.length ? enabled : candidates
  if (familyFilter) return pool[0]
  return pool.find((m) => familyLabel(m) === "GPT" && m.wire === "responses") ?? pool.find((m) => m.wire !== "messages") ?? pool[0]
}

// Which autos to inject for this catalog. `taken` holds model ids already in use, so
// derived ids never collide with real models.
export function resolveAutos(options: Options, catalog: CatalogModel[], taken: Iterable<string>): AutoSpec[] {
  const usedIDs = new Set<string>([...taken, MODEL_ID])
  const usedNames = new Set<string>(["Auto"])
  const autos: AutoSpec[] = []
  for (const draft of autoDrafts(options, catalog)) {
    const preferred = resolvePreferred(catalog, draft.preferredModels)
    const anchor = preferred[0] ?? pickAnchor(catalog, draft.familyFilter)
    if (!anchor) continue
    const label = familyLabel(anchor)
    const baseName = draft.requestedName || (draft.legacy ? "Auto" : label ? `Auto ${label}` : `Auto ${draft.index}`)
    const baseID =
      draft.requestedID ||
      (draft.requestedName ? slugify(draft.requestedName) : label ? `auto-${slugify(label)}` : `auto-${draft.index}`)
    autos.push({
      id: draft.legacy ? MODEL_ID : uniqueValue(baseID, usedIDs),
      name: draft.legacy ? "Auto" : uniqueValue(baseName, usedNames, " "),
      tier: normalizeTier(draft.tier),
      preferredAPIIDs: preferred.map((m) => m.apiID),
      anchor,
      familyFilter: draft.familyFilter,
    })
  }
  return autos
}

// --- routing ----------------------------------------------------------------------------
// Whether an auto can send `apiID`: same transport and wire API as its anchor (the
// anchor's endpoint carries the request) and, for clamped autos, the same family.
export function servable(auto: AutoSpec, apiID: string, catalog: CatalogModel[]): boolean {
  if (apiID === auto.anchor.apiID) return true
  const model = catalog.find((m) => m.apiID === apiID)
  if (!model || model.transport !== auto.anchor.transport || model.wire !== auto.anchor.wire) return false
  return !auto.familyFilter || familyLabel(model) === auto.familyFilter
}

// Turns a routing result into the route an auto pins its conversation to.
export function pickRoute(auto: AutoSpec, session: AutoSession | undefined, catalog: CatalogModel[]): Route {
  const fallback = auto.anchor.apiID
  // expiresAtMs 0 → nothing to stick to; route again next turn.
  if (!session) return { modelID: fallback, expiresAtMs: 0 }
  const usable = session.models.filter((id) => servable(auto, id, catalog))
  const picked = auto.preferredAPIIDs.find((id) => usable.includes(id)) ?? usable[0]
  if (picked) {
    log(`${auto.id} routed (${session.source}) -> ${picked}`)
    return { modelID: picked, sessionToken: session.sessionToken, expiresAtMs: session.expiresAtMs }
  }
  // The server chose a model this auto cannot send (other endpoint, wire API or family,
  // or missing from the catalog). Stick with the anchor for this session, without the
  // token.
  log(
    `${auto.id}: server offered [${session.models.join(", ")}] (${session.source}), none servable via ${auto.anchor.transport} (${auto.anchor.wire})${auto.familyFilter ? ` in family ${auto.familyFilter}` : ""}; using ${fallback} without Copilot-Session-Token`,
  )
  return { modelID: fallback, expiresAtMs: session.expiresAtMs }
}

function copilotHeaders(bearer: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
    "VScode-SessionId": VSCODE_SESSION_ID,
    "VScode-MachineId": VSCODE_MACHINE_ID,
    "Editor-Device-Id": VSCODE_DEVICE_ID,
  }
}

function expiresAtMs(value: unknown, fallbackMs: number): number {
  return typeof value === "number" ? value * 1000 : Date.now() + fallbackMs
}

// POST /auto — VS Code's Auto (AutoV2Fetcher.ts): routes the prompt, picks one model
// and mints the session token its chat request bills against, in a single call.
export async function fetchAutoDecision(
  baseURL: string,
  bearer: string,
  prompt: string,
  tier: AutoTier,
  hasImage: boolean,
): Promise<AutoSession | undefined> {
  const body: Record<string, unknown> = { prompt, tier }
  if (hasImage) body.has_image = true
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), AUTO_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseURL}/auto`, {
      method: "POST",
      headers: copilotHeaders(bearer),
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      log(`auto fetch non-ok: ${response.status} ${text}`)
      return undefined
    }
    const data = (await response.json().catch(() => undefined)) as
      | {
          session_token?: unknown
          expires_at?: unknown
          selected_model?: { id?: unknown }
          hydra_scores?: unknown
          discounted_costs?: unknown
        }
      | undefined
    const modelID = data?.selected_model?.id
    if (!data || typeof data.session_token !== "string" || typeof modelID !== "string") {
      log("auto fetch invalid payload (missing session_token or selected_model.id)")
      return undefined
    }
    log(
      `auto decision: selected_model=${modelID}, tier=${tier}, prompt_chars=${prompt.length}, hydra_scores=${JSON.stringify(data.hydra_scores ?? {})}, discounted_costs=${JSON.stringify(data.discounted_costs ?? {})}`,
    )
    // The token lasts 24h with no refresh flow.
    return {
      source: "auto",
      models: [modelID],
      sessionToken: data.session_token,
      expiresAtMs: expiresAtMs(data.expires_at, 24 * 60 * 60_000),
    }
  } catch (error) {
    log(`auto fetch failed: ${String(error)}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// POST /models/session — Auto V1, which VS Code deleted in Aug 2026. Its pool no
// longer receives new models; kept only as a fallback for when POST /auto fails.
export async function fetchLegacySession(baseURL: string, bearer: string): Promise<AutoSession | undefined> {
  const response = await fetch(`${baseURL}/models/session`, {
    method: "POST",
    headers: copilotHeaders(bearer),
    body: JSON.stringify({ auto_mode: { model_hints: [MODEL_ID] } }),
  }).catch((error) => {
    log(`legacy session fetch failed: ${String(error)}`)
    return undefined
  })
  if (!response) return undefined
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    log(`legacy session fetch non-ok: ${response.status} ${body}`)
    return undefined
  }
  const data = (await response.json().catch(() => undefined)) as
    | { session_token?: unknown; available_models?: unknown; expires_at?: unknown }
    | undefined
  if (!data || typeof data.session_token !== "string") {
    log("legacy session fetch invalid payload (missing session_token)")
    return undefined
  }
  const models = Array.isArray(data.available_models)
    ? (data.available_models.filter((m) => typeof m === "string") as string[])
    : []
  log(`legacy session parsed: available_models=[${models.join(", ")}]`)
  return {
    source: "legacy",
    models,
    sessionToken: data.session_token,
    expiresAtMs: expiresAtMs(data.expires_at, 30 * 60_000),
  }
}
