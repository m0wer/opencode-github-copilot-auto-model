import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import pkg from "../package.json"
import plugin from "../src/index"

const makeModel = (id: string, apiId: string, npm: string, url: string, name: string, reasoning = false, temperature = true) => ({
  id,
  providerID: "github-copilot",
  api: { id: apiId, url, npm },
  name,
  family: "gpt",
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 8192 },
  capabilities: {
    temperature,
    reasoning,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  release_date: "2026-01-01",
})

const COPILOT = "https://api.githubcopilot.com"

const sonnet = makeModel("claude-sonnet-4.6", "claude-sonnet-4.6", "@ai-sdk/anthropic", `${COPILOT}/v1`, "Claude Sonnet 4.6", true)
const haiku = makeModel("claude-haiku-4.5", "claude-haiku-4.5", "@ai-sdk/anthropic", `${COPILOT}/v1`, "Claude Haiku 4.5")
const gpt54 = makeModel("gpt-5.4", "gpt-5.4", "@ai-sdk/github-copilot", COPILOT, "GPT-5.4", true)
const gpt54mini = makeModel("gpt-5.4-mini", "gpt-5.4-mini", "@ai-sdk/github-copilot", COPILOT, "GPT-5.4 mini")
const gemini = makeModel("gemini-3.1-pro", "gemini-3.1-pro", "@ai-sdk/github-copilot", COPILOT, "Gemini 3.1 Pro")
const geminiFlash = makeModel("gemini-3.5-flash", "gemini-3.5-flash", "@ai-sdk/github-copilot", COPILOT, "Gemini 3.5 Flash")

const catalog = { [sonnet.id]: sonnet, [haiku.id]: haiku, [gpt54.id]: gpt54, [gpt54mini.id]: gpt54mini }

const oauth = {
  auth: { type: "oauth", refresh: "test-bearer", access: "test-access", expires: Date.now() + 3600_000 } as never,
}

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

async function setup(models: Record<string, unknown>, options: Record<string, unknown> = {}, ctx: object = oauth) {
  const hooks = await plugin.server({ client: { tui: { showToast: async () => {} } } } as never, options)
  const resolved = await hooks.provider!.models!({ id: "github-copilot", models } as never, ctx as never)
  async function turn(autoID: string, { sessionID = "ses_test", prompt = "test prompt", parts = [] as unknown[] } = {}) {
    await hooks["chat.message"]!({ sessionID } as never, { parts: [{ type: "text", text: prompt }, ...parts] } as never)
    const input = {
      sessionID,
      agent: "build",
      model: resolved[autoID],
      provider: { source: "config", info: {} as never, options: {} },
      message: {} as never,
    }
    const output = {
      temperature: 0.7 as number | undefined,
      topP: 0,
      topK: 0,
      maxOutputTokens: undefined as number | undefined,
      options: {} as Record<string, unknown>,
    }
    await hooks["chat.params"]!(input as never, output as never)
    const headers = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!(input as never, headers as never)
    return {
      model: headers.headers["x-copilot-auto-route"],
      options: output.options,
      temperature: output.temperature,
      token: headers.headers["Copilot-Session-Token"],
    }
  }
  return { hooks, resolved, turn }
}

describe("catalog injection", () => {
  test("anchors the legacy auto on the shared Copilot transport", async () => {
    const { resolved } = await setup(catalog)
    expect(resolved.auto.name).toBe("Auto")
    expect(resolved.auto.api.npm).toBe("@ai-sdk/github-copilot")
    expect(resolved.auto.family).toBe("github-copilot-auto")
  })

  test("anchors the legacy auto on an @ai-sdk/openai GPT model rather than Claude", async () => {
    const openaiGpt = { ...gpt54, api: { ...gpt54.api, npm: "@ai-sdk/openai" } }
    const { resolved } = await setup({ [sonnet.id]: sonnet, [haiku.id]: haiku, [openaiGpt.id]: openaiGpt })
    expect(resolved.auto.api.id).toBe("gpt-5.4")
  })

  test("routes to a new model the legacy pool never offered", async () => {
    const luna = makeModel("gpt-6-luna", "gpt-6-luna", "@ai-sdk/github-copilot", COPILOT, "GPT-6 Luna")
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async () => {
      const { turn } = await setup({ ...catalog, [luna.id]: luna })
      const result = await turn("auto-gpt")
      expect(result.model).toBe("gpt-6-luna")
      expect(result.token).toBe("tok-gpt-6-luna")
    })
  })

  test("drops temperature when the routed model does not support it", async () => {
    const luna = makeModel("gpt-6-luna", "gpt-6-luna", "@ai-sdk/github-copilot", COPILOT, "GPT-6 Luna", true, false)
    await withFetch({ auto: autoPicks("gpt-6-luna") }, async () => {
      const { turn } = await setup({ ...catalog, [luna.id]: luna })
      expect((await turn("auto")).temperature).toBeUndefined()
    })
    await withFetch({ auto: autoPicks("gpt-5.4-mini") }, async () => {
      const { turn } = await setup(catalog)
      expect((await turn("auto")).temperature).toBe(0.7)
    })
  })

  test("makes no network calls while building the catalog", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      await setup(catalog)
      expect(calls).toHaveLength(0)
    })
  })

  test("preserves /v1 in url for Claude autos (Anthropic SDK appends /messages)", async () => {
    const { resolved } = await setup(catalog)
    expect(resolved["auto-claude"].api.url).toBe(`${COPILOT}/v1`)
    expect(resolved["auto-claude"].api.npm).toBe("@ai-sdk/anthropic")
  })

  test("no-ops when auto already present", async () => {
    const existing = { ...gpt54, id: "auto" }
    const { resolved } = await setup({ ...catalog, auto: existing })
    expect(resolved.auto as unknown).toBe(existing)
  })

  test("preferredModels anchors by model key or api id, in order", async () => {
    const byKey = await setup(catalog, { preferredModels: ["claude-haiku-4.5", "gpt-5.4"] })
    expect(byKey.resolved.auto.api.id).toBe("claude-haiku-4.5")
    const skipsUnknown = await setup(catalog, { preferredModels: ["nope", "gpt-5.4-mini"] })
    expect(skipsUnknown.resolved.auto.api.id).toBe("gpt-5.4-mini")
  })

  test("injects default family autos when autos is not configured", async () => {
    const { resolved } = await setup(catalog)
    expect(resolved["auto-claude"].name).toBe("Auto Claude")
    expect(resolved["auto-gpt"].name).toBe("Auto GPT")
  })

  test("autos: [] disables the default family autos", async () => {
    const { resolved } = await setup(catalog, { autos: [] })
    expect(resolved["auto-claude"]).toBeUndefined()
    expect(resolved["auto-gpt"]).toBeUndefined()
    expect(resolved.auto).toBeDefined()
  })

  test("explicit autos replace the default family autos", async () => {
    const { resolved } = await setup(catalog, { autos: [{ name: "Smart", preferredModels: ["claude-sonnet-4.6"] }] })
    expect(resolved.smart.api.id).toBe("claude-sonnet-4.6")
    expect(resolved["auto-gpt"]).toBeUndefined()
  })

  test("skips a default auto for a family with fewer than two models", async () => {
    const { resolved } = await setup({ [sonnet.id]: sonnet, [gpt54.id]: gpt54, [gpt54mini.id]: gpt54mini })
    expect(resolved["auto-claude"]).toBeUndefined()
    expect(resolved["auto-gpt"]).toBeDefined()
  })

  test("does not inject a default gemini auto", async () => {
    const { resolved } = await setup({ ...catalog, [gemini.id]: gemini, [geminiFlash.id]: geminiFlash })
    expect(resolved["auto-gemini"]).toBeUndefined()
  })

  test("dedupes derived ids and names for same-family autos", async () => {
    const { resolved } = await setup(catalog, {
      autos: [{ preferredModels: ["claude-sonnet-4.6"] }, { preferredModels: ["claude-haiku-4.5"] }],
    })
    expect(resolved["auto-claude"].name).toBe("Auto Claude")
    expect(resolved["auto-claude-2"].name).toBe("Auto Claude 2")
  })

  test("derives a unique id when a configured name collides with the legacy auto", async () => {
    const { resolved } = await setup(catalog, { autos: [{ name: "Auto" }] })
    expect(resolved["auto-2"].name).toBe("Auto 2")
  })
})

describe("routing via POST /auto", () => {
  test("without Copilot OAuth falls back to the catalog anchor and sends no token", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog, {}, {})
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
      expect(calls).toHaveLength(0)
    })
  })

  test("sends the prompt and default tier, then uses the selected model and token", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4-mini") }, async (calls) => {
      const { turn } = await setup(catalog)
      const result = await turn("auto", { prompt: "rename this variable" })
      expect(calls).toHaveLength(1)
      expect(calls[0].body).toEqual({ prompt: "rename this variable", tier: "balance" })
      expect(calls[0].headers["X-GitHub-Api-Version"]).toBe("2026-08-01")
      expect(calls[0].headers.Authorization).toBe("Bearer test-bearer")
      expect(result.model).toBe("gpt-5.4-mini")
      expect(result.token).toBe("tok-gpt-5.4-mini")
      expect(result.options.reasoningEffort).toBeUndefined()
    })
  })

  test("sends the configured tier (retired names mapped forward) and boosts effort on intelligence", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog, { tier: "max" })
      const result = await turn("auto")
      expect(calls[0].body.tier).toBe("intelligence")
      expect(result.options.reasoningEffort).toBe("high")
    })
  })

  test("per-auto tier applies to that auto only", async () => {
    await withFetch({ auto: autoPicks("claude-sonnet-4.6") }, async (calls) => {
      const { turn } = await setup(catalog, {
        autos: [{ name: "Claude Max", preferredModels: ["claude-sonnet-4.6"], tier: "intelligence" }],
      })
      const result = await turn("claude-max")
      expect(calls[0].body.tier).toBe("intelligence")
      expect(result.options.thinking).toEqual({ type: "enabled", budgetTokens: 16000 })
    })
  })

  test("unknown tier falls back to balance", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog, { tier: "turbo" })
      await turn("auto")
      expect(calls[0].body.tier).toBe("balance")
    })
  })

  test("flags image attachments with has_image", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto", { parts: [{ type: "file", mime: "image/png", url: "data:," }] })
      expect(calls[0].body.has_image).toBe(true)
    })
  })

  test("sticks with the first route for the rest of the conversation", async () => {
    let pick = "gpt-5.4"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { turn } = await setup(catalog)
      const first = await turn("auto")
      pick = "gpt-5.4-mini"
      const second = await turn("auto", { prompt: "follow-up" })
      expect(calls).toHaveLength(1)
      expect(second.model).toBe(first.model)
      expect(second.token).toBe("tok-gpt-5.4")
    })
  })

  test("re-routes after compaction", async () => {
    let pick = "gpt-5.4"
    await withFetch({ auto: () => autoPicks(pick)() }, async (calls) => {
      const { hooks, turn } = await setup(catalog)
      await turn("auto")
      await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "ses_test" } } } as never)
      pick = "gpt-5.4-mini"
      const after = await turn("auto")
      expect(calls).toHaveLength(2)
      expect(after.model).toBe("gpt-5.4-mini")
    })
  })

  test("re-routes when the session token is about to expire", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4", 60) }, async (calls) => {
      const { turn } = await setup(catalog)
      await turn("auto")
      await turn("auto")
      expect(calls).toHaveLength(2)
    })
  })

  test("routes each auto separately within one session", async () => {
    await withFetch({ auto: autoPicks("claude-haiku-4.5") }, async (calls) => {
      const { turn } = await setup(catalog)
      const claude = await turn("auto-claude")
      await turn("auto-claude")
      const gpt = await turn("auto-gpt")
      expect(calls).toHaveLength(2)
      expect(claude.model).toBe("claude-haiku-4.5")
      expect(claude.token).toBe("tok-claude-haiku-4.5")
      // GPT auto cannot send a Claude pick: catalog anchor, no token.
      expect(gpt.model).toBe("gpt-5.4")
      expect(gpt.token).toBeUndefined()
    })
  })

  test("cross-endpoint pick falls back to the anchor without a token and stays sticky", async () => {
    await withFetch({ auto: autoPicks("gpt-5.4") }, async (calls) => {
      const { turn } = await setup(catalog)
      const first = await turn("auto-claude")
      const second = await turn("auto-claude")
      expect(first.model).toBe("claude-sonnet-4.6")
      expect(first.token).toBeUndefined()
      expect(second.model).toBe("claude-sonnet-4.6")
      expect(calls).toHaveLength(1)
    })
  })

  test("family-clamped auto ignores a pick from another family on the same transport", async () => {
    await withFetch({ auto: autoPicks("gemini-3.1-pro") }, async () => {
      const { turn } = await setup({ ...catalog, [gemini.id]: gemini })
      const result = await turn("auto-gpt")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
    })
  })

  test("unclamped auto accepts another family on the same transport and wire API", async () => {
    const mai = makeModel("mai-code-1.1-flash", "mai-code-1.1-flash", "@ai-sdk/github-copilot", COPILOT, "MAI Code 1.1 Flash")
    await withFetch({ auto: autoPicks("mai-code-1.1-flash") }, async () => {
      const { turn } = await setup({ ...catalog, [gemini.id]: gemini, [mai.id]: mai }, { preferredModels: ["gemini-3.1-pro"] })
      const result = await turn("auto")
      expect(result.model).toBe("mai-code-1.1-flash")
      expect(result.token).toBe("tok-mai-code-1.1-flash")
    })
  })

  test("a pick on another wire API (chat vs responses) falls back to the anchor", async () => {
    const mai = makeModel("mai-code-1.1-flash", "mai-code-1.1-flash", "@ai-sdk/github-copilot", COPILOT, "MAI Code 1.1 Flash")
    await withFetch({ auto: autoPicks("mai-code-1.1-flash") }, async () => {
      const { turn } = await setup({ ...catalog, [mai.id]: mai })
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
    })
  })

  test("a pick missing from the opencode catalog falls back to the anchor", async () => {
    await withFetch({ auto: autoPicks("gpt-9") }, async () => {
      const { turn } = await setup(catalog)
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBeUndefined()
    })
  })

  test("leaves models of other providers alone", async () => {
    const { hooks } = await setup(catalog)
    const output = { options: {} as Record<string, unknown> }
    await hooks["chat.params"]!({ sessionID: "s", model: { providerID: "anthropic", id: "auto" } } as never, output as never)
    expect(output.options.model).toBeUndefined()
  })
})

describe("request rewrite", () => {
  test("swaps the routed model into the body and strips the private header", async () => {
    await withFetch({}, async (calls) => {
      await setup(catalog)
      await fetch(`${COPILOT}/responses`, {
        method: "POST",
        headers: { "X-Copilot-Auto-Route": "gpt-6-luna", "Copilot-Session-Token": "tok" },
        body: JSON.stringify({ model: "gpt-5.4", input: [] }),
      })
      expect(calls[0].body).toEqual({ model: "gpt-6-luna", input: [] })
      const sent = new Headers(calls[0].headers)
      expect(sent.has("x-copilot-auto-route")).toBe(false)
      expect(sent.get("copilot-session-token")).toBe("tok")
    })
  })

  test("leaves requests without the route header untouched", async () => {
    await withFetch({}, async (calls) => {
      await setup(catalog)
      const init = { method: "POST", headers: { Authorization: "x" }, body: JSON.stringify({ model: "gpt-5.4" }) }
      await fetch(`${COPILOT}/responses`, init)
      expect(calls[0].body).toEqual({ model: "gpt-5.4" })
      expect(calls[0].headers).toBe(init.headers)
    })
  })

  test("wraps fetch only once across plugin instances", async () => {
    await withFetch({}, async (calls) => {
      await setup(catalog)
      await setup(catalog)
      await fetch(`${COPILOT}/responses`, {
        method: "POST",
        headers: { "x-copilot-auto-route": "gpt-6-luna" },
        body: JSON.stringify({ model: "gpt-5.4" }),
      })
      expect(calls).toHaveLength(1)
      expect(calls[0].body.model).toBe("gpt-6-luna")
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
    await withFetch({ auto: () => 404, legacy: legacyPool(["claude-haiku-4.5", "gpt-5.4-mini", "gpt-5.4"]) }, async (calls) => {
      const { turn } = await setup(catalog)
      const result = await turn("auto")
      expect(calls.map((c) => c.kind)).toEqual(["auto", "legacy"])
      expect(result.model).toBe("gpt-5.4-mini")
      expect(result.token).toBe("tok-legacy")
    })
  })

  test("prefers a configured model from the legacy pool", async () => {
    await withFetch({ auto: () => 503, legacy: legacyPool(["gpt-5.4-mini", "gpt-5.4"]) }, async () => {
      const { turn } = await setup(catalog, { preferredModels: ["gpt-5.4"] })
      const result = await turn("auto")
      expect(result.model).toBe("gpt-5.4")
      expect(result.token).toBe("tok-legacy")
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

// Packaging guards for the supported (local-path) install. opencode loads the
// plugin from the file referenced in config: dist/index.js (after `bun run build`)
// or src/index.ts dropped into ~/.config/opencode/plugins/. Either way opencode's
// loader requires a default export of `{ id, server: <function> }`. (The `github:`
// install path is intentionally unsupported: opencode git-clones the repo on every
// launch and disposes short-lived commands before the clone finishes, so arborist
// rolls the partial install back — a local path resolves with a cheap stat instead.)
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

  test("default export has the shape opencode loads (id + server function)", () => {
    expect(typeof plugin).toBe("object")
    expect(typeof plugin.id).toBe("string")
    expect(plugin.id.length).toBeGreaterThan(0)
    expect(typeof plugin.server).toBe("function")
  })
})
