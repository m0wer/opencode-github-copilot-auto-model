// opencode 2 plugin: injects Copilot Auto models into the picker and routes each
// conversation through POST /auto, like VS Code. Routing logic lives in core.ts.
import type { Plugin } from "@opencode/plugin"
import {
  type AutoSpec,
  type CatalogModel,
  type ConvKind,
  DEFAULT_BASE_URL,
  type Options,
  PROVIDER_ID,
  type Route,
  SESSION_REFRESH_SKEW_MS,
  type Wire,
  fetchAutoDecision,
  fetchLegacySession,
  log,
  pickRoute,
  resolveAutos,
  usesDeprecatedLabelLists,
} from "./core"

type Context = Plugin.Context

// The fields of opencode's Model.Info this plugin reads. Editor entries carry the full
// schema; the clone keeps every field.
type CopilotModel = {
  id: string
  modelID?: string
  name: string
  family?: string
  package?: string
  settings?: Record<string, unknown>
  enabled?: boolean
}

// Everything tracked per opencode session and auto: the pinned route plus the
// inputs for the next routing round.
type ConvState = {
  route?: Route
  routing?: Promise<Route>
  needsReEval?: boolean
}

// opencode's Copilot provider sends GPT-5+ (except gpt-5-mini), Grok and MAI Code
// over the Responses API and the rest over Chat Completions, unless the live model
// list advertised an endpoint (settings.endpoint).
function defaultWire(apiID: string): Wire {
  const gpt = /^gpt-(\d+)/.exec(apiID)
  const responses =
    (gpt !== null && Number(gpt[1]) >= 5 && !apiID.startsWith("gpt-5-mini")) ||
    apiID.startsWith("grok-") ||
    apiID.startsWith("mai-code-")
  return responses ? "responses" : "chat"
}

export function toCatalogModel(model: CopilotModel): CatalogModel {
  const apiID = model.modelID ?? model.id
  const pkg = model.package ?? ""
  const baseURL = typeof model.settings?.baseURL === "string" ? model.settings.baseURL : ""
  const endpoint = model.settings?.endpoint
  const wire: Wire =
    endpoint === "responses" || endpoint === "chat" || endpoint === "messages"
      ? endpoint
      : pkg.includes("anthropic")
        ? "messages"
        : defaultWire(apiID)
  return {
    key: model.id,
    apiID,
    name: model.name,
    family: model.family,
    transport: `${pkg} ${baseURL}`.trim(),
    wire,
    enabled: model.enabled !== false,
  }
}

// Same resolution as opencode's Copilot provider (copilotBaseURL).
function copilotBaseURL(metadata?: Readonly<Record<string, unknown>>): string {
  const endpoint = metadata?.apiEndpoint
  if (typeof endpoint === "string" && endpoint) return endpoint
  const enterprise = metadata?.enterpriseUrl
  if (typeof enterprise !== "string" || !enterprise) return DEFAULT_BASE_URL
  return `https://copilot-api.${enterprise.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
}

async function copilotCredential(ctx: Context): Promise<{ bearer: string; baseURL: string } | undefined> {
  const connection = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined)
  if (!connection) return undefined
  const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined)
  if (credential?.type !== "oauth") return undefined
  return { bearer: credential.refresh, baseURL: copilotBaseURL(credential.metadata) }
}

const IMAGE = /^data:image\/|\.(png|jpe?g|gif|webp|bmp)$/i

const plugin: Plugin.Plugin = {
  id: "opencode-github-copilot-auto-model",
  async setup(ctx) {
    const opts = (ctx.options ?? {}) as Options
    if (usesDeprecatedLabelLists(opts))
      log("reasoning/noReasoning options are ignored: POST /auto returns no reasoning verdict (use tier instead)")

    let catalog: CatalogModel[] = []
    let autos = new Map<string, AutoSpec>()
    let injectedSignature = ""
    const prompts = new Map<string, { text: string; hasImage: boolean }>()
    const conversations = new Map<string, Map<string, ConvState>>()

    function getConv(sessionID: string, autoID: string): ConvState {
      let sessionAutos = conversations.get(sessionID)
      if (!sessionAutos) {
        sessionAutos = new Map()
        conversations.set(sessionID, sessionAutos)
      }
      let conv = sessionAutos.get(autoID)
      if (!conv) {
        conv = {}
        sessionAutos.set(autoID, conv)
      }
      return conv
    }

    // One routing round: ask POST /auto (or the legacy pool when /auto is down).
    async function resolveRoute(sessionID: string, auto: AutoSpec): Promise<Route> {
      const prompt = prompts.get(sessionID)
      const credential = await copilotCredential(ctx)
      const session =
        credential && prompt?.text
          ? ((await fetchAutoDecision(credential.baseURL, credential.bearer, prompt.text, auto.tier, prompt.hasImage)) ??
            (await fetchLegacySession(credential.baseURL, credential.bearer)))
          : undefined
      // opencode swaps in the account's live catalog (e.g. a business endpoint) while
      // the first request is underway; judge the pick against the current transform's
      // auto and catalog, not the ones this round started with.
      return pickRoute(autos.get(auto.id) ?? auto, session, catalog)
    }

    // Route once per conversation and stick with it so the model — and its prompt KV
    // cache — stays stable (VS Code reuses the endpoint for the rest of the
    // conversation). Re-route on the next agent turn after compaction, on token
    // expiry, or after a failed round.
    async function ensureRoute(sessionID: string, auto: AutoSpec, kind: ConvKind): Promise<Route> {
      const conv = getConv(sessionID, auto.id)
      const route = conv.route
      const stale =
        !route || (conv.needsReEval && kind === "primary") || Date.now() >= route.expiresAtMs - SESSION_REFRESH_SKEW_MS
      if (!stale) return route
      conv.routing ??= resolveRoute(sessionID, auto).finally(() => {
        conv.routing = undefined
      })
      const next = await conv.routing
      if (next.modelID !== conv.route?.modelID)
        log(`${auto.id} → ${next.modelID}${next.sessionToken ? "" : " (no Auto session)"} for ${sessionID}`)
      conv.route = next
      if (kind === "primary") conv.needsReEval = false
      return next
    }

    // Inject one picker model per auto, cloned from its anchor (same SDK, endpoint
    // and modelID, so opencode builds requests exactly as for the anchor). Runs again
    // whenever the Copilot catalog changes; keep it synchronous and cheap.
    await ctx.model.transform((editor) => {
      const models = editor.list(PROVIDER_ID) as unknown as CopilotModel[]
      // Leave out autos from an earlier run so they never anchor another auto.
      const real = models.filter((m) => !autos.has(m.id))
      catalog = real.map(toCatalogModel)
      const resolved = resolveAutos(
        opts,
        catalog,
        real.map((m) => m.id),
      )
      autos = new Map(resolved.map((auto) => [auto.id, auto]))
      for (const auto of resolved) {
        const source = real.find((m) => m.id === auto.anchor.key)
        if (!source) continue
        editor.update(PROVIDER_ID, auto.id, (draft) => {
          // The anchor's family is kept: opencode may key prompts and quirks on it.
          Object.assign(draft, structuredClone(source), { name: auto.name, enabled: true, variants: [] })
        })
      }
      const signature = resolved.map((a) => `${a.id}:${a.anchor.apiID}:${a.tier}`).join(",")
      if (signature !== injectedSignature) {
        injectedSignature = signature
        for (const auto of resolved)
          log(
            `injected ${auto.id} (${auto.name}, tier=${auto.tier}) -> ${auto.anchor.apiID} (${auto.anchor.transport}, ${auto.anchor.wire})`,
          )
      }
    })

    // Capture the user's prompt per session: only POST /auto sees it.
    await ctx.session.hook("prompt", (event) => {
      const files = event.prompt.files ?? []
      prompts.set(event.sessionID, {
        text: event.prompt.text.trim(),
        hasImage: files.some((file) => IMAGE.test(file.uri)),
      })
    })

    // After compaction the conversation shape changed, so re-route on the next agent
    // turn (mirrors VS Code's invalidateRouterCache). The compaction request itself
    // keeps the current route.
    await ctx.session.hook(
      "compaction",
      (event) => {
        if (!autos.has(event.model.id)) return
        for (const conv of conversations.get(event.sessionID)?.values() ?? []) conv.needsReEval = true
        log(`route invalidated by compaction for ${event.sessionID}`)
      },
      { providerID: PROVIDER_ID },
    )

    // Raise effort on the "intelligence" tier, in the shape opencode's Copilot
    // variants use for the auto's wire API. Other tiers keep the model default.
    await ctx.session.hook(
      "context",
      (event) => {
        const auto = autos.get(event.model.id)
        if (!auto || auto.tier !== "intelligence" || event.model.variant) return
        if (auto.anchor.wire === "messages") event.options.thinking = { type: "enabled", budgetTokens: 16000 }
        else Object.assign(event.options, { reasoningEffort: "high", reasoningSummary: "auto" })
      },
      { providerID: PROVIDER_ID },
    )

    // Pin the conversation to a route and bill it against the Auto session.
    await ctx.session.hook(
      "model.request",
      async (event) => {
        const auto = autos.get(event.model.id)
        if (!auto) return
        const route = await ensureRoute(event.sessionID, auto, event.kind)
        if (route.sessionToken) event.headers["Copilot-Session-Token"] = route.sessionToken
      },
      { providerID: PROVIDER_ID },
    )

    // opencode built the request for the anchor's modelID; swap in the routed model.
    // Servable routes share the anchor's endpoint and wire API, so only `model` changes.
    await ctx.session.hook(
      "http.request",
      async (event) => {
        const auto = autos.get(event.model.id)
        if (!auto) return
        const modelID = conversations.get(event.sessionID)?.get(auto.id)?.route?.modelID
        if (!modelID) return
        const text = await event.request.clone().text().catch(() => "")
        let body: Record<string, unknown>
        try {
          body = JSON.parse(text) as Record<string, unknown>
        } catch {
          return
        }
        if (typeof body.model !== "string" || body.model === modelID) return
        log(`request model ${body.model} -> ${modelID}`)
        body.model = modelID
        // Settings were resolved for the anchor; routed models such as gpt-6-luna
        // reject `temperature` with a 400, and opencode 2 does not say which do.
        if ("temperature" in body) {
          delete body.temperature
          log(`temperature dropped for ${modelID}`)
        }
        const headers = new Headers(event.request.headers)
        headers.delete("content-length")
        event.request = new Request(event.request.url, {
          method: event.request.method,
          headers,
          body: JSON.stringify(body),
          signal: event.request.signal,
        })
      },
      { providerID: PROVIDER_ID },
    )
  },
}

export default plugin
