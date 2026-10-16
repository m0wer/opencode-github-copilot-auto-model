import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import plugin from "../src/index"

const COPILOT = "https://api.githubcopilot.com"
const COPILOT_SDK = "aisdk:@ai-sdk/github-copilot"
const ANTHROPIC = "@opencode/ai/providers/anthropic"

type Wire = "responses" | "chat" | "messages"
type FakeModel = {
  id: string
  modelID: string
  providerID: string
  name: string
  family: string
  package: string
  settings: Record<string, unknown>
  enabled: boolean
  variants: unknown[]
}

// Shaped like opencode 2's Copilot catalog (CopilotModels.derive).
const makeModel = (id: string, name: string, family: string, wire: Wire): FakeModel => ({
  id,
  modelID: id,
  providerID: "github-copilot",
  name,
  family,
  package: wire === "messages" ? ANTHROPIC : COPILOT_SDK,
  settings: { baseURL: wire === "messages" ? `${COPILOT}/v1` : COPILOT, endpoint: wire },
  enabled: true,
  variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
})

const sonnet = makeModel("claude-sonnet-5.5", "Claude Sonnet 5.5", "claude-sonnet-5.5", "messages")
const haiku = makeModel("claude-haiku-5.5", "Claude Haiku 5.5", "claude-haiku-5.5", "messages")
const gpt54 = makeModel("gpt-5.4", "GPT-5.4", "gpt-5.4", "responses")
const luna = makeModel("gpt-6-luna", "GPT-6 Luna", "gpt-6-luna", "responses")
const sol = makeModel("gpt-6.1-sol", "GPT-6.1 Sol", "gpt-6.1-sol", "responses")
const mai = makeModel("mai-code-1.1-flash", "MAI Code 1.1 Flash", "mai-code", "responses")
const gemini = makeModel("gemini-3.1-pro", "Gemini 3.1 Pro", "gemini-3.1-pro", "chat")
const geminiFlash = makeModel("gemini-3.5-flash", "Gemini 3.5 Flash", "gemini-3.5-flash", "chat")

const catalog = [sonnet, haiku, gpt54, luna, sol]

type Handler = (body: Record<string, unknown>) => unknown
type Call = { kind?: "auto" | "legacy"; body: Record<string, unknown>; headers: Record<string, string> }

// Replaces fetch for the duration of `fn`. A handler returning a number answers
// with that HTTP status; anything else is sent as a 200 JSON body.
async function withFetch<T>(handlers: { auto?: Handler; legacy?: Handler }, fn: (calls: Call[]) => Promise<T>) {
  const origFetch = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString()
    const kind = u.endsWith("/auto") ? "auto" : u.endsWith("/models/session") ? "legacy" : undefined
    const body = init?.body ? JSON.parse(init.body as string) : {}
    calls.push({ kind, body, headers: (init?.headers ?? {}) as Record<string, string> })
    const handler = kind && handlers[kind]
    if (!handler) return new Response("not found", { status: 404 })
    const reply = handler(body)
    if (typeof reply === "number") return new Response("error", { status: reply })
    return Response.json(reply)
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = origFetch
  }
}

const autoPicks = (id: string, ttlSeconds = 86_400) => () => ({
  session_token: `tok-${id}`,
  expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
  selected_model: { id },
})

const oauth = { type: "oauth", refresh: "test-bearer", access: "", expires: 0, metadata: {} }

type Hook = (event: any) => Promise<void> | void

// Loads the plugin against a minimal stand-in for opencode 2's plugin context: a
// model editor over `models` and a recorder for session hooks.
async function setup(models: FakeModel[], options: Record<string, unknown> = {}, credential: unknown = oauth) {
  const store = new Map(models.map((m) => [m.id, structuredClone(m)]))
  const hooks = new Map<string, { callback: Hook; providerID?: string }>()
  const transforms: Array<(editor: unknown) => void> = []
  const registration = { dispose: async () => {} }
  const ctx = {
    options,
    integration: {
      connection: {
        active: async () => (credential ? { integrationID: "github-copilot" } : undefined),
        resolve: async () => credential,
      },
    },
    model: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push(callback)
        runTransforms()
        return registration
      },
    },
    session: {
      hook: async (name: string, callback: Hook, opts?: { providerID?: string }) => {
        hooks.set(name, { callback, providerID: opts?.providerID })
        return registration
      },
    },
  }
  // opencode replays transforms over the source catalog whenever it changes.
  function runTransforms() {
    const data = new Map(models.map((m) => [m.id, structuredClone(m)]))
    const editor = {
      list: () => Array.from(data.values()),
      get: (_p: string, id: string) => data.get(id),
      update: (_p: string, id: string, fn: (draft: Record<string, unknown>) => void) => {
        const draft = (data.get(id) ?? {}) as Record<string, unknown>
        fn(draft)
        draft.id = id
        draft.providerID = "github-copilot"
        data.set(id, draft as FakeModel)
      },
      remove: (_p: string, id: string) => data.delete(id),
    }
    for (const transform of transforms) transform(editor)
    store.clear()
    for (const [id, model] of data) store.set(id, model)
  }
  await plugin.setup(ctx as never)

  const call = async (name: string, event: Record<string, unknown>) => hooks.get(name)?.callback(event)

  // One model call as opencode 2 issues it: prompt admission (when `prompt` is set),
  // context, model.request, then the native HTTP request built for the model's modelID.
  async function turn(
    modelKey: string,
    { sessionID = "ses_test", prompt = "test prompt" as string | undefined, files = [] as unknown[], kind = "primary" } = {},
  ) {
    const model = store.get(modelKey)!
    const ref = { providerID: "github-copilot", id: modelKey }
    if (prompt !== undefined) await call("prompt", { sessionID, prompt: { text: prompt, files } })
    const context = { sessionID, agent: "build", model: ref, system: [], messages: [], tools: {}, options: {} as Record<string, unknown> }
    if (kind === "primary") await call("context", context)
    if (kind === "compaction") await call("compaction", context)
    const modelRequest = { sessionID, agent: "build", model: ref, kind, headers: {} as Record<string, string> }
    await call("model.request", modelRequest)
    const request = new Request(`${COPILOT}/responses`, {
      method: "POST",
      headers: { ...modelRequest.headers, "content-type": "application/json", "content-length": "999" },
      body: JSON.stringify({ model: model.modelID, input: [], temperature: 0.7 }),
    })
    const http = { sessionID, agent: "build", model: ref, kind, request }
    await call("http.request", http)
    const sent = JSON.parse(await http.request.text()) as { model: string; temperature?: number }
    return {
      model: sent.model,
      temperature: sent.temperature,
      token: modelRequest.headers["Copilot-Session-Token"],
      options: context.options,
      contentLength: http.request.headers.get("content-length"),
    }
  }

  return { store, hooks, turn, call, runTransforms }
}

describe("catalog injection", () => {
  test("injects Auto cloned from a GPT Responses anchor", async () => {
    const { store } = await setup(catalog)
    const auto = store.get("auto")!
    expect(auto.name).toBe("Auto")
    expect(auto.modelID).toBe("gpt-5.4")
    expect(auto.package).toBe(COPILOT_SDK)
    expect(auto.settings.endpoint).toBe("responses")
    expect(auto.family).toBe("gpt-5.4")
    expect(auto.variants).toEqual([])
  })

  test("makes no network calls while building the catalog", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      await setup(catalog)
      expect(calls).toHaveLength(0)
    })
  })

  test("family autos keep their anchor's endpoint", async () => {
    const { store } = await setup(catalog)
    expect(store.get("auto-claude")!.settings.baseURL).toBe(`${COPILOT}/v1`)
    expect(store.get("auto-claude")!.package).toBe(ANTHROPIC)
    expect(store.get("auto-gpt")!.modelID).toBe("gpt-5.4")
  })

  test("replaying the transform never anchors an auto on another auto", async () => {
    const { store, runTransforms } = await setup(catalog)
    runTransforms()
    runTransforms()
    expect(store.get("auto")!.modelID).toBe("gpt-5.4")
    expect(store.get("auto-2")).toBeUndefined()
  })

  test("preferredModels anchors by model key, in order", async () => {
    const { store } = await setup(catalog, { preferredModels: ["nope", "gpt-6-luna"] })
    expect(store.get("auto")!.modelID).toBe("gpt-6-luna")
  })

  test("injects default family autos when autos is not configured", async () => {
    const { store } = await setup(catalog)
    expect(store.get("auto-claude")!.name).toBe("Auto Claude")
    expect(store.get("auto-gpt")!.name).toBe("Auto GPT")
  })

  test("autos: [] disables the default family autos", async () => {
    const { store } = await setup(catalog, { autos: [] })
    expect(store.get("auto-claude")).toBeUndefined()
    expect(store.get("auto-gpt")).toBeUndefined()
    expect(store.get("auto")).toBeDefined()
  })

  test("explicit autos replace the defaults", async () => {
    const { store } = await setup(catalog, { autos: [{ name: "Smart", preferredModels: ["claude-sonnet-5.5"] }] })
    expect(store.get("smart")!.modelID).toBe("claude-sonnet-5.5")
    expect(store.get("auto-gpt")).toBeUndefined()
  })

  test("skips a default auto for a family with fewer than two models", async () => {
    const { store } = await setup([sonnet, gpt54, luna])
    expect(store.get("auto-claude")).toBeUndefined()
    expect(store.get("auto-gpt")).toBeDefined()
  })

  test("does not inject a default gemini auto", async () => {
    const { store } = await setup([...catalog, gemini, geminiFlash])
    expect(store.get("auto-gemini")).toBeUndefined()
  })

  test("dedupes derived ids and names", async () => {
    const { store } = await setup(catalog, {
      autos: [{ preferredModels: ["claude-sonnet-5.5"] }, { preferredModels: ["claude-haiku-5.5"] }, { name: "Auto" }],
    })
    expect(store.get("auto-claude")!.name).toBe("Auto Claude")
    expect(store.get("auto-claude-2")!.name).toBe("Auto Claude 2")
    expect(store.get("auto-2")!.name).toBe("Auto 2")
  })

  test("scopes request hooks to the Copilot provider", async () => {
    const { hooks } = await setup(catalog)
    for (const name of ["context", "compaction", "model.request", "http.request"])
      expect(hooks.get(name)?.providerID).toBe("github-copilot")
  })
})

describe("routing via POST /auto", () => {
  test("without a Copilot OAuth connection uses the anchor and sends no token", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog, {}, null)
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
      expect(calls).toHaveLength(0)
    })
  })

  test("sends prompt and default tier, then routes the request to the selected model", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog)
      const result = await turn("auto", { prompt: "rename this variable" })
      expect(calls).toHaveLength(1)
      expect(calls[0].body).toEqual({ prompt: "rename this variable", tier: "balance" })
      expect(calls[0].headers["X-GitHub-Api-Version"]).toBe("2026-08-01")
      expect(calls[0].headers.Authorization).toBe("Bearer test-bearer")
      expect(result.model).toBe("gpt-6-luna")
      expect(result.token).toBe("tok-gpt-6-luna")
      expect(result.contentLength).toBeNull()
      expect(result.temperature).toBeUndefined()
      expect(result.options).toEqual({})
    })
  })

  test("uses the enterprise endpoint from the credential", async () => {
    const urls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(url.toString())
      return Response.json(autoPicks("gpt-6-luna")())
    }) as typeof fetch
    try {
      const { turn } = await setup(catalog, {}, { ...oauth, metadata: { enterpriseUrl: "https://acme.ghe.com/" } })
      await turn("auto")
      expect(urls).toEqual(["https://copilot-api.acme.ghe.com/auto"])
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test("sends the configured tier (retired names mapped forward) and boosts effort on intelligence", async () => {
    await withFetch({ auto: autoPicks("gpt-6.1-sol") }, async (calls) => {
      const { turn } = await setup(catalog, { tier: "max" })
      const result = await turn("auto")
      expect(calls[0].body.tier).toBe("intelligence")
      expect(result.options).toEqual({ reasoningEffort: "high", reasoningSummary: "auto" })
    })
  })

  test("intelligence tier on a Claude auto enables extended thinking", async () => {
    await withFetch({ auto: autoPicks("claude-sonnet-5.5") }, async () => {
      const { turn } = await setup(catalog, { autos: [{ name: "Claude Max", preferredModels: ["claude-sonnet-5.5"], tier: "intelligence" }] })
      const result = await turn("claude-max")
      expect(result.options.thinking).toEqual({ type: "enabled", budgetTokens: 16000 })
    })
  })

  test("flags image attachments with has_image", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto", { files: [{ uri: "file:///tmp/screenshot.png" }] })
      expect(calls[0].body.has_image).toBe(true)
    })
  })

  test("sticks with the first route for the rest of the conversation", async () => {
    let pick = "gpt-6-luna"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto")
      pick = "gpt-6.1-sol"
      const second = await turn("auto", { prompt: "follow-up" })
      const toolStep = await turn("auto", { prompt: undefined })
      expect(calls).toHaveLength(1)
      expect(second.model).toBe("gpt-6-luna")
      expect(toolStep.token).toBe("tok-gpt-6-luna")
    })
  })

  test("re-routes on the next agent turn after compaction, not for the compaction itself", async () => {
    let pick = "gpt-6-luna"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto")
      pick = "gpt-6.1-sol"
      const compaction = await turn("auto", { prompt: undefined, kind: "compaction" })
      expect(compaction.model).toBe("gpt-6-luna")
      const after = await turn("auto")
      expect(calls).toHaveLength(2)
      expect(after.model).toBe("gpt-6.1-sol")
    })
  })

  test("re-routes when the session token is about to expire", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna", 60) }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto")
      await turn("auto")
      expect(calls).toHaveLength(2)
    })
  })

  test("routes each auto separately within one session", async () => {
    await withFetch({ auto: autoPicks("claude-haiku-5.5") }, async (calls) => {
      const { turn } = await setup(catalog)
      const claude = await turn("auto-claude")
      await turn("auto-claude")
      const gpt = await turn("auto-gpt")
      expect(calls).toHaveLength(2)
      expect(claude.model).toBe("claude-haiku-5.5")
      expect(claude.token).toBe("tok-claude-haiku-5.5")
      expect(gpt.model).toBe("gpt-5.4")
      expect(gpt.token).toBeUndefined()
    })
  })

  test("a pick on another endpoint falls back to the anchor without a token and stays sticky", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog)
      const first = await turn("auto-claude")
      const second = await turn("auto-claude")
      expect(first.model).toBe("claude-sonnet-5.5")
      expect(first.token).toBeUndefined()
      expect(second.model).toBe("claude-sonnet-5.5")
      expect(calls).toHaveLength(1)
    })
  })

  test("judges the pick against a catalog swapped in while routing", async () => {
    // opencode first builds the catalog without an account endpoint, then replays
    // the transform with the live one (e.g. a business endpoint) during the request.
    const BUSINESS = "https://api.business.githubcopilot.com"
    const models: FakeModel[] = catalog.map((m) => ({ ...structuredClone(m), settings: { endpoint: m.settings.endpoint } }))
    const live = () => {
      models.splice(0, models.length, ...catalog.map((m) => ({ ...structuredClone(m), settings: { ...m.settings, baseURL: BUSINESS } })))
      runTransforms()
      return autoPicks("gpt-6-luna")()
    }
    let runTransforms = () => {}
    await withFetch({ auto: live }, async () => {
      const harness = await setup(models)
      runTransforms = harness.runTransforms
      const result = await harness.turn("auto")
      expect(result.model).toBe("gpt-6-luna")
      expect(result.token).toBe("tok-gpt-6-luna")
    })
  })

  test("a pick on another wire API falls back to the anchor", async () => {
    await withFetch({ auto: autoPicks("gemini-3.1-pro") }, async () => {
      const { turn } = await setup([...catalog, gemini])
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
    })
  })

  test("a family-clamped auto ignores another family on the same endpoint", async () => {
    await withFetch({ auto: autoPicks("mai-code-1.1-flash") }, async () => {
      const { turn } = await setup([...catalog, mai])
      const gpt = await turn("auto-gpt", { sessionID: "a" })
      const unclamped = await turn("auto", { sessionID: "b" })
      expect(gpt.model).toBe("gpt-5.4")
      expect(gpt.token).toBeUndefined()
      expect(unclamped.model).toBe("mai-code-1.1-flash")
      expect(unclamped.token).toBe("tok-mai-code-1.1-flash")
    })
  })

  test("a pick missing from the catalog falls back to the anchor", async () => {
    await withFetch({ auto: autoPicks("gpt-9") }, async () => {
      const { turn } = await setup(catalog)
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
    })
  })

  test("leaves non-auto models alone", async () => {
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async (calls) => {
      const { turn } = await setup(catalog)
      const result = await turn("gpt-5.4")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
      expect(result.contentLength).toBe("999")
      expect(result.temperature).toBe(0.7)
      expect(calls).toHaveLength(0)
    })
  })
})

describe("legacy /models/session fallback", () => {
  const legacyPool = (models: string[]) => () => ({
    session_token: "tok-legacy",
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    available_models: models,
  })

  test("uses the legacy pool when POST /auto fails", async () => {
    await withFetch({ auto: () => 404, legacy: legacyPool(["claude-haiku-5.5", "gpt-5.4"]) }, async (calls) => {
      const { turn } = await setup(catalog)
      const result = await turn("auto")
      expect(calls.map((c) => c.kind)).toEqual(["auto", "legacy"])
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBe("tok-legacy")
    })
  })

  test("prefers a configured model from the legacy pool", async () => {
    await withFetch({ auto: () => 503, legacy: legacyPool(["gpt-5.4", "gpt-6-luna"]) }, async () => {
      const { turn } = await setup(catalog, { preferredModels: ["gpt-6-luna"] })
      const result = await turn("auto")
      expect(result.model).toBe("gpt-6-luna")
    })
  })

  test("falls back to the anchor and retries next turn when both calls fail", async () => {
    await withFetch({ auto: () => 500, legacy: () => 500 }, async (calls) => {
      const { turn } = await setup(catalog)
      const first = await turn("auto")
      expect(first.model).toBe("gpt-5.4")
      expect(first.token).toBeUndefined()
      await turn("auto")
      expect(calls.filter((c) => c.kind === "auto")).toHaveLength(2)
    })
  })
})

// Packaging guards: opencode 2 loads the package entry and requires a default export
// of `{ id, setup }` (Plugin.define's shape).
describe("packaging", () => {
  const root = path.join(import.meta.dir, "..")
  const entry = (pkg as { exports?: { ["."]?: { import?: string } }; main?: string }).exports?.["."]?.import ?? pkg.main
  const rel = (entry ?? "").replace(/^\.\//, "")

  test("declares a package entry", () => {
    expect(rel.length).toBeGreaterThan(0)
  })

  test("entry file exists on disk", () => {
    expect(existsSync(path.join(root, rel))).toBe(true)
  })

  test("default export has the shape opencode 2 loads (id + setup function)", () => {
    expect(typeof plugin.id).toBe("string")
    expect(plugin.id.length).toBeGreaterThan(0)
    expect(typeof plugin.setup).toBe("function")
  })

  test("declares no runtime dependencies", () => {
    expect((pkg as { dependencies?: object }).dependencies).toBeUndefined()
  })
})
