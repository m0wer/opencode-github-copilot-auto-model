import { randomUUID } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"

const MODEL_ID = "auto"
const PROVIDER_ID = "github-copilot"

// Matches `@vscode/copilot-api` 0.5.x (`_mixinHeaders`), which VS Code uses for POST /auto.
const COPILOT_API_VERSION = "2026-08-01"

// VS Code (`@vscode/copilot-api` _mixinHeaders) ALWAYS stamps these on the gated
// /auto request — they are never omitted. Values are plausible stand-ins generated
// once per process.
// Editor-Version / Editor-Plugin-Version are currently NOT sent (testing whether the
// CAPI auto endpoints need them). Uncomment these + the header lines to restore the
// real VS Code baseline.
// const EDITOR_VERSION = "vscode/1.99.0"
// const EDITOR_PLUGIN_VERSION = "copilot-chat/0.40.0"
const VSCODE_SESSION_ID = `${randomUUID()}${Date.now()}`
const VSCODE_MACHINE_ID = randomUUID().replace(/-/g, "")
const VSCODE_DEVICE_ID = randomUUID()

// VS Code's AutoV2Fetcher aborts POST /auto after 5s.
const AUTO_TIMEOUT_MS = 5000

// VS Code renews an auto session this long before its server expiry, so a long
// request cannot outlive its token.
const SESSION_REFRESH_SKEW_MS = 5 * 60_000

// Routing profiles accepted by POST /auto (VS Code's autoModeTiers.ts). A tier is
// picked per session and biases which models the server may choose from.
const AUTO_TIERS = ["efficiency", "balance", "intelligence", "fast"] as const
type AutoTier = (typeof AUTO_TIERS)[number]
const DEFAULT_TIER: AutoTier = "balance"
// Retired names the server still accepts; VS Code maps them forward on read.
const RETIRED_TIERS: Record<string, AutoTier> = { eco: "efficiency", balanced: "balance", max: "intelligence" }

// A server routing result: the model(s) the auto session may bill, plus the session
// token that places chat requests in Copilot's auto pool (and its discount).
type AutoSession = {
  // "auto": POST /auto picked exactly one model for the prompt.
  // "legacy": POST /models/session returned a pool; used only when /auto fails.
  source: "auto" | "legacy"
  models: string[]
  sessionToken: string
  expiresAtMs: number
}

// The model a conversation is pinned to. `sessionToken` is only set when the server
// routed to that exact model; fallbacks are sent without it (out-of-session models
// are rejected when they carry the token).
type Route = {
  modelID: string
  sessionToken?: string
  expiresAtMs: number
}

// Everything we track per opencode conversation and auto: the pinned route plus the
// inputs for the next routing round.
type ConvState = {
  route?: Route
  routing?: Promise<Route>
  lastPrompt?: string
  hasImage?: boolean
  needsReEval?: boolean
}

type AutoConfig = {
  id?: string
  name?: string
  preferredModels?: string[]
  tier?: string
  /** @deprecated POST /auto returns no reasoning verdict; ignored. */
  reasoning?: string[]
  /** @deprecated POST /auto returns no reasoning verdict; ignored. */
  noReasoning?: string[]
}

type Options = {
  // Ordered list of preferred model keys or API ids. The first one anchors the
  // auto's endpoint and is the fallback when the server's pick cannot be served.
  preferredModels?: string[]
  // Routing profile sent to POST /auto: efficiency | balance | intelligence | fast.
  tier?: string
  /** @deprecated POST /auto returns no reasoning verdict; ignored. */
  reasoning?: string[]
  /** @deprecated POST /auto returns no reasoning verdict; ignored. */
  noReasoning?: string[]
  // Additional injected autos. Each one anchors independently based on its own
  // preferred model list and keeps its own routing/session cache.
  // When omitted, the plugin injects one default auto per supported family
  // (Claude, GPT) that has at least two catalog models. Pass [] to disable the
  // defaults, or an explicit list to replace them.
  autos?: AutoConfig[]
}

type AutoDraft = {
  requestedID?: string
  requestedName?: string
  preferredModels: string[]
  tier?: string
  legacy: boolean
  index: number
  // Clamp this auto to one family label (e.g. "Claude"). Used by the default
  // per-family autos so they never drift to another family that happens to share
  // the same transport endpoint (e.g. GPT and Gemini both ride @ai-sdk/github-copilot).
  familyFilter?: string
}

type TemplateAPI = {
  id: string
  npm: string
  url: string
}

type InjectedAuto = {
  id: string
  name: string
  preferredApiIDs: string[]
  tier: AutoTier
  template: Model
  templateApi: TemplateAPI
  catalogDefaultModelID: string
  familyFilter?: string
}

// Unclamped autos anchor on the shared Copilot transport when possible: GPT, MAI and
// Gemini all ride @ai-sdk/github-copilot (models.dev lists them as @ai-sdk/openai), so
// it can serve most of what /auto picks.
const SHARED_TRANSPORTS = ["@ai-sdk/github-copilot", "@ai-sdk/openai"]

function pickTemplate(models: Record<string, Model>, familyFilter?: string) {
  const candidates = Object.values(models).filter(
    (m) => m.providerID === PROVIDER_ID && (!familyFilter || familyLabel(m) === familyFilter),
  )
  for (const npm of SHARED_TRANSPORTS) {
    const match = candidates.find((m) => m.api.npm === npm)
    if (match) return match
  }
  return candidates[0]
}

function templateAPI(model: Model): TemplateAPI {
  return { id: model.api.id, npm: model.api.npm, url: model.api.url }
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

function normalizeTier(value: string | undefined): AutoTier {
  const raw = value?.trim().toLowerCase()
  if (!raw) return DEFAULT_TIER
  const tier = RETIRED_TIERS[raw] ?? raw
  if ((AUTO_TIERS as readonly string[]).includes(tier)) return tier as AutoTier
  log(`ignoring unknown tier "${value}"; using ${DEFAULT_TIER}`)
  return DEFAULT_TIER
}

function resolvePreferredApiIDs(models: Record<string, Model>, preferred: string[]): string[] {
  const resolved: string[] = []
  const entries = Object.values(models).filter((model) => model.providerID === PROVIDER_ID)
  for (const token of preferred) {
    const byKey = models[token]
    if (byKey?.providerID === PROVIDER_ID) {
      if (!resolved.includes(byKey.api.id)) resolved.push(byKey.api.id)
      continue
    }
    const byApiId = entries.find((model) => model.api.id === token)
    if (byApiId && !resolved.includes(byApiId.api.id)) resolved.push(byApiId.api.id)
  }
  return resolved
}

// Families injected as per-family autos when `autos` is not configured. Claude and
// GPT/Codex are the two families Copilot's Auto routes to; Gemini and others stay
// opt-in.
const DEFAULT_AUTO_FAMILIES = ["Claude", "GPT"]

// One default auto per supported family that has at least two catalog models
// (with a single model the auto adds nothing over picking that model directly).
function defaultFamilyDrafts(models: Record<string, Model>): AutoDraft[] {
  const counts = new Map<string, number>()
  for (const model of Object.values(models)) {
    if (model.providerID !== PROVIDER_ID) continue
    const label = familyLabel(model)
    if (!label) continue
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const drafts: AutoDraft[] = []
  for (const [index, label] of DEFAULT_AUTO_FAMILIES.entries()) {
    if ((counts.get(label) ?? 0) < 2) continue
    drafts.push({
      preferredModels: [],
      legacy: false,
      index: index + 1,
      familyFilter: label,
    })
  }
  return drafts
}

function autoDrafts(options: Options, models: Record<string, Model>): AutoDraft[] {
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
    // Default: inject one auto per supported family. `autos: []` opts out and an
    // explicit list replaces the defaults entirely.
    drafts.push(...defaultFamilyDrafts(models))
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

function usesDeprecatedLabelLists(options: Options): boolean {
  const configs: AutoConfig[] = [options, ...(options.autos ?? [])]
  return configs.some((c) => !!c.reasoning?.length || !!c.noReasoning?.length)
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

function familyLabel(model?: Model): string | undefined {
  if (!model) return undefined
  const fingerprint = `${model.id} ${model.name} ${model.family} ${model.api.id}`.toLowerCase()
  // Fingerprint checks first: on the github-copilot provider many families share the
  // same transport npm (e.g. GPT, Gemini and MAI can all ride @ai-sdk/github-copilot),
  // so the npm package alone cannot distinguish them.
  if (fingerprint.includes("claude")) return "Claude"
  if (fingerprint.includes("gemini")) return "Gemini"
  if (fingerprint.includes("microsoft") || fingerprint.includes("mai") || fingerprint.includes("raptor"))
    return "Microsoft"
  if (fingerprint.includes("gpt") || fingerprint.includes("codex")) return "GPT"
  if (model.api.npm === "@ai-sdk/anthropic") return "Claude"
  if (model.api.npm === "@ai-sdk/google") return "Gemini"
  if (model.api.npm === "@ai-sdk/github-copilot" || model.api.npm === "@ai-sdk/openai") return "GPT"
  if (model.family?.trim()) {
    return model.family
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ")
  }
  const npm = model.api.npm.split("/").pop()?.replace(/^@/, "")
  return npm ? npm[0].toUpperCase() + npm.slice(1) : undefined
}

function defaultAutoName(draft: AutoDraft, model?: Model): string {
  if (draft.legacy) return "Auto"
  const label = familyLabel(model)
  return label ? `Auto ${label}` : `Auto ${draft.index}`
}

function defaultAutoID(draft: AutoDraft, model?: Model): string {
  if (draft.legacy) return MODEL_ID
  if (draft.requestedName) return slugify(draft.requestedName)
  const label = familyLabel(model)
  return label ? `auto-${slugify(label)}` : `auto-${draft.index}`
}

// File logger — avoids polluting the TUI.
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
function log(msg: string) {
  const file = logFile()
  logReady ??= mkdir(path.dirname(file), { recursive: true }).then(() => undefined).catch(() => undefined)
  void logReady.then(() => appendFile(file, `${new Date().toISOString()} info ${msg}\n`).catch(() => undefined))
}

// --- module state -----------------------------------------------------------------------
// Auth/catalog-derived (same for every conversation):
let autoBearer: string | undefined
let autoKnownModels: Model[] = []

function capiBase(url: string) {
  const clean = url.replace(/\/+$/, "")
  return clean.endsWith("/v1") ? clean.slice(0, -3) : clean
}

// Headers VS Code attaches to the auto-mode CAPI calls. Verified against
// `@vscode/copilot-api`'s `_mixinHeaders`: every gated request (Auto, AutoModels,
// chat) ALWAYS carries Editor-Version, Editor-Plugin-Version and
// Copilot-Integration-Id — VS Code never omits them.
//
// Copilot-Integration-Id is the *gate*. Its value is a cascade: an unlicensed /
// open-source build sends "code-oss"; a licensed prod build sends "vscode-chat"
// (and a dev build "vscode-chat-dev" + a Request-Hmac). So "code-oss" is the
// honest, non-impersonating baseline — the minimum a real VS Code OSS build sends,
// and the value to try first if /auto 404s. We keep these lines commented to test
// the truly minimal set first, then add them back one by one.
function copilotHeaders(bearer: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
    // "Editor-Version": EDITOR_VERSION, // always sent by VS Code; uncomment with the consts above
    // "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    "VScode-SessionId": VSCODE_SESSION_ID,
    "VScode-MachineId": VSCODE_MACHINE_ID,
    "Editor-Device-Id": VSCODE_DEVICE_ID,
    // "Copilot-Integration-Id": "code-oss", // GATE: honest OSS-build value; "vscode-chat" impersonates licensed VS Code
  }
}

function expiresAtMs(value: unknown, fallbackMs: number): number {
  return typeof value === "number" ? value * 1000 : Date.now() + fallbackMs
}

// POST /auto — VS Code's Auto (AutoV2Fetcher.ts): routes the prompt, picks one model
// and mints the session token its chat request bills against, in a single call.
async function fetchAutoDecision(
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
// longer receives new models and is shrinking; kept only as a fallback for when
// POST /auto is unavailable.
async function fetchLegacySession(baseURL: string, bearer: string): Promise<AutoSession | undefined> {
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

// The cloned auto model points at ONE endpoint (template's npm + url). We can only
// override the model id (chat.params), not the endpoint, so every model we route to
// must share that endpoint family (cross-family would need a proxy — out of scope).
function modelByApiId(apiId: string): Model | undefined {
  return autoKnownModels.find((m) => m.providerID === PROVIDER_ID && m.api.id === apiId)
}

// opencode's github-copilot provider sends GPT-5+ (except gpt-5-mini) over the
// Responses API and everything else over Chat Completions. The request bodies
// differ, so a routed model must use the same wire API as the anchor whose language
// model actually builds the request.
function wireAPI(api: { id: string; npm: string }): string {
  if (api.npm === "@ai-sdk/anthropic") return "messages"
  const match = /^gpt-(\d+)/.exec(api.id)
  return match && Number(match[1]) >= 5 && !api.id.startsWith("gpt-5-mini") ? "responses" : "chat"
}

function isSameFamily(apiId: string | undefined, templateApi: TemplateAPI): boolean {
  if (!apiId) return false
  if (apiId === templateApi.id) return true
  const model = modelByApiId(apiId)
  return (
    !!model &&
    model.api.npm === templateApi.npm &&
    model.api.url === templateApi.url &&
    wireAPI(model.api) === wireAPI(templateApi)
  )
}

// Private header chat.headers uses to tell the fetch wrapper which model to send.
const ROUTE_HEADER = "x-copilot-auto-route"
const FETCH_WRAPPED = Symbol.for("opencode-github-copilot-auto-model.fetch")

// opencode builds the auto's language model once, from the anchor's api.id, and its
// Copilot/Anthropic SDKs take the request's model from that — they drop a `model`
// passed through chat.params options. So the routed id travels in a private header
// and is swapped into the JSON body here, just before the request leaves.
function rewriteRoutedRequest(init: RequestInit | undefined): RequestInit | undefined {
  if (!init?.headers) return init
  const headers = new Headers(init.headers)
  const model = headers.get(ROUTE_HEADER)
  if (!model) return init
  headers.delete(ROUTE_HEADER)
  let body = init.body
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { model?: unknown }
      if (typeof parsed.model === "string" && parsed.model !== model) {
        log(`request model ${parsed.model} -> ${model}`)
        parsed.model = model
        body = JSON.stringify(parsed)
      }
    } catch {
      /* not JSON: send as-is */
    }
  }
  return { ...init, headers, body }
}

// The Copilot auth loader and the SDKs resolve the global fetch per call, so one
// wrapper sees every outgoing request; it only acts on requests carrying ROUTE_HEADER.
function installRouteFetch() {
  const current = globalThis.fetch as typeof fetch & { [FETCH_WRAPPED]?: true }
  if (current[FETCH_WRAPPED]) return
  const wrapped = (input: RequestInfo | URL, init?: RequestInit) => current(input, rewriteRoutedRequest(init))
  globalThis.fetch = Object.assign(wrapped, current, { [FETCH_WRAPPED]: true }) as unknown as typeof fetch
}

// Whether this auto can send `apiId`: same endpoint as its anchor and, for
// family-clamped autos, the same family label (GPT and Gemini can share a transport).
function servable(auto: InjectedAuto, apiId: string): boolean {
  if (!isSameFamily(apiId, auto.templateApi)) return false
  return !auto.familyFilter || familyLabel(modelByApiId(apiId)) === auto.familyFilter
}

// Raise the routed model's effort on the "intelligence" tier, in the same flat shape
// opencode's effort *variants* use (merged into options). Other tiers keep the model
// default.
function reasoningOptions(apiId: string, tier: AutoTier): Record<string, unknown> | undefined {
  if (tier !== "intelligence") return undefined
  const model = modelByApiId(apiId)
  if (!model || !model.capabilities?.reasoning) return undefined
  if (model.api.npm === "@ai-sdk/anthropic") {
    // Anthropic SDK uses an extended-thinking budget (opencode uses 16000 for "high").
    return { thinking: { type: "enabled", budgetTokens: 16000 } }
  }
  if (model.api.npm === "@ai-sdk/github-copilot" || model.api.npm === "@ai-sdk/openai") {
    // Match opencode's GPT/Copilot reasoning extras.
    return { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }
  }
  return undefined
}

function withAutoModels(models: Record<string, Model>, autos: InjectedAuto[]) {
  const injected = { ...models }
  for (const auto of autos) {
    if (injected[auto.id]) {
      if (auto.id !== MODEL_ID) log(`skip inject ${auto.id}: model id already exists`)
      continue
    }
    const template = auto.template
    // Copy the template's api (id, npm, url) exactly — they already point to the right endpoint.
    // Claude models: url="…/v1" + npm="@ai-sdk/anthropic" → appends /messages → correct.
    // GPT models:   url="…"    + npm="@ai-sdk/github-copilot" → appends /chat/completions → correct.
    // Do NOT strip /v1 from the url; the Anthropic SDK appends /messages (not /v1/messages).
    log(`injected ${auto.id} (${auto.name}, tier=${auto.tier}) -> ${template.id} (api.id=${template.api.id}, npm=${template.api.npm}, url=${template.api.url})`)
    injected[auto.id] = {
      ...template,
      id: auto.id,
      name: auto.name,
      family: "github-copilot-auto",
      variants: undefined,
    }
  }
  return injected
}

const CopilotAutoModelPlugin: Plugin = async ({ client }, options) => {
  const opts = (options ?? {}) as Options
  installRouteFetch()
  if (usesDeprecatedLabelLists(opts))
    log("reasoning/noReasoning options are ignored: POST /auto returns no reasoning verdict (use tier instead)")
  const conversations = new Map<string, Map<string, ConvState>>()
  let injectedAutoByID = new Map<string, InjectedAuto>()

  function getConv(sessionID: string, autoID: string): ConvState {
    let sessionAutos = conversations.get(sessionID)
    if (!sessionAutos) {
      sessionAutos = new Map<string, ConvState>()
      conversations.set(sessionID, sessionAutos)
    }
    let conv = sessionAutos.get(autoID)
    if (!conv) {
      conv = {}
      sessionAutos.set(autoID, conv)
    }
    return conv
  }

  // One routing round: ask POST /auto (or the legacy pool when /auto is down) and
  // pin the conversation to a model this auto's endpoint can serve.
  async function resolveRoute(auto: InjectedAuto, conv: ConvState): Promise<Route> {
    const fallback = auto.catalogDefaultModelID
    const prompt = conv.lastPrompt
    // expiresAtMs 0 → nothing to stick to; route again next turn.
    if (!autoBearer || !prompt) return { modelID: fallback, expiresAtMs: 0 }
    const baseURL = capiBase(auto.templateApi.url)
    const session =
      (await fetchAutoDecision(baseURL, autoBearer, prompt, auto.tier, !!conv.hasImage)) ??
      (await fetchLegacySession(baseURL, autoBearer))
    if (!session) return { modelID: fallback, expiresAtMs: 0 }
    const usable = session.models.filter((id) => servable(auto, id))
    const picked = auto.preferredApiIDs.find((id) => usable.includes(id)) ?? usable[0]
    if (picked) {
      log(`${auto.id} routed (${session.source}) -> ${picked}`)
      return { modelID: picked, sessionToken: session.sessionToken, expiresAtMs: session.expiresAtMs }
    }
    // The server chose a model this auto's endpoint/family cannot send (or one missing
    // from the opencode catalog). Stick with the catalog anchor for this session, sent
    // without the token — it would be rejected for a model the session did not pick.
    log(
      `${auto.id}: server offered [${session.models.join(", ")}] (${session.source}), none servable via ${auto.templateApi.npm}${auto.familyFilter ? ` in family ${auto.familyFilter}` : ""}; using ${fallback} without Copilot-Session-Token`,
    )
    return { modelID: fallback, expiresAtMs: session.expiresAtMs }
  }

  // The status bar can't show the per-turn route, so surface it as a transient toast
  // whenever the model is (re)picked. Fire-and-forget; never let it break a turn.
  const toast = (message: string, variant: "info" | "success" | "warning" | "error") => {
    try {
      void Promise.resolve(client.tui.showToast({ body: { message, variant } })).catch(() => {})
    } catch {
      /* ignore */
    }
  }
  return {
    // After compaction the conversation shape changed, so re-run routing on the
    // next turn (mirrors VS Code's invalidateRouterCache).
    event: async ({ event }) => {
      if (event.type !== "session.compacted") return
      const autos = conversations.get(event.properties.sessionID)
      if (autos?.size) {
        for (const conv of autos.values()) conv.needsReEval = true
        log(`route invalidated by compaction for ${event.properties.sessionID}`)
      }
    },
    // Capture the prompt text per conversation; chat.params has the message but
    // not its parts, so we stash the text here for the routing call.
    "chat.message": async (input, output) => {
      const text = output.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("\n")
        .trim()
      const hasImage = output.parts.some(
        (p) => p.type === "file" && ((p as { mime?: string }).mime ?? "").startsWith("image/"),
      )
      for (const autoID of injectedAutoByID.keys()) {
        const conv = getConv(input.sessionID, autoID)
        conv.lastPrompt = text
        conv.hasImage = hasImage
      }
    },
    "chat.params": async (incoming, output) => {
      if (incoming.model.providerID !== PROVIDER_ID) return
      const auto = injectedAutoByID.get(incoming.model.id)
      if (!auto) return

      const conv = getConv(incoming.sessionID, auto.id)
      // Route once per conversation and stick with it so the model — and its prompt
      // KV cache — stays stable (VS Code reuses the endpoint for the rest of the
      // conversation). Re-route after compaction, on token expiry, or after a failed
      // round.
      const stale =
        !conv.route || conv.needsReEval || Date.now() >= conv.route.expiresAtMs - SESSION_REFRESH_SKEW_MS
      if (stale) {
        conv.routing ??= resolveRoute(auto, conv).finally(() => {
          conv.routing = undefined
        })
        const route = await conv.routing
        if (route.modelID !== conv.route?.modelID) {
          toast(
            `${auto.name} → ${route.modelID}${route.sessionToken ? "" : " · no Auto session"}`,
            route.sessionToken ? "info" : "warning",
          )
        }
        conv.route = route
        conv.needsReEval = false
      }

      // The model itself is swapped in by the fetch wrapper (see chat.headers).
      const decided = conv.route!.modelID
      log(`chat.params route ${auto.id} -> ${decided}`)
      // opencode sized the params for the anchor; the routed model may reject
      // temperature (e.g. gpt-6-luna 400s with "not supported"). opencode itself passes
      // undefined for such models, despite the hook's `number` type.
      if (modelByApiId(decided)?.capabilities?.temperature === false && output.temperature !== undefined) {
        ;(output as { temperature?: number }).temperature = undefined
        log(`temperature dropped for ${decided}`)
      }
      const effort = reasoningOptions(decided, auto.tier)
      if (effort) {
        Object.assign(output.options, effort)
        log(`reasoning effort -> ${JSON.stringify(effort)} for ${decided}`)
      }
    },
    "chat.headers": async (incoming, output) => {
      if (incoming.model.providerID !== PROVIDER_ID) return
      const auto = injectedAutoByID.get(incoming.model.id)
      if (!auto) return
      const route = getConv(incoming.sessionID, auto.id).route
      if (!route) return
      output.headers[ROUTE_HEADER] = route.modelID
      if (!route.sessionToken) return
      output.headers["Copilot-Session-Token"] = route.sessionToken
      log(`chat.headers added Copilot-Session-Token for ${auto.id}`)
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        autoKnownModels = Object.values(provider.models)
        autoBearer = ctx.auth?.type === "oauth" ? ctx.auth.refresh : undefined
        const drafts = autoDrafts(opts, provider.models)
        const usedIDs = new Set<string>([...Object.keys(provider.models), MODEL_ID])
        const usedNames = new Set<string>(["Auto"])
        const resolvedAutos: InjectedAuto[] = []

        // No network here: POST /auto needs a prompt, so routing happens per turn.
        // Each auto anchors on its first preferred model, else on the catalog.
        for (const draft of drafts) {
          const preferredApiIDs = resolvePreferredApiIDs(provider.models, draft.preferredModels)
          const preferredTemplate = preferredApiIDs.map(modelByApiId).find((model): model is Model => !!model)
          const template = preferredTemplate ?? pickTemplate(provider.models, draft.familyFilter)
          if (!template) continue
          if (preferredTemplate)
            log(`preference anchor${draft.legacy ? "" : ` (${draft.requestedName ?? draft.requestedID ?? draft.index})`} -> ${preferredTemplate.api.id}`)

          const baseName = draft.requestedName || defaultAutoName(draft, template)
          const baseID = draft.requestedID || defaultAutoID(draft, template)
          resolvedAutos.push({
            id: draft.legacy ? MODEL_ID : uniqueValue(baseID, usedIDs),
            name: draft.legacy ? "Auto" : uniqueValue(baseName, usedNames, " "),
            preferredApiIDs,
            tier: normalizeTier(draft.tier),
            template,
            templateApi: templateAPI(template),
            catalogDefaultModelID: template.api.id,
            familyFilter: draft.familyFilter,
          })
        }

        injectedAutoByID = new Map(resolvedAutos.map((auto) => [auto.id, auto]))
        return withAutoModels(provider.models, resolvedAutos)
      },
    },
  }
}

export default { server: CopilotAutoModelPlugin, id: "opencode-github-copilot-auto-model" }
