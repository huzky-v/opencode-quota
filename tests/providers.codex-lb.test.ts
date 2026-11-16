import { expect, it } from "vite-plus/test";

import { rowsFromProviderResult } from "../src/core/rows.js";
import { codexLbProvider as provider } from "../src/providers/codex-lb.js";
import { defaultSettings } from "../src/settings/index.js";
import { lineText, statusLayout, statusLineInput } from "../src/view/text.js";
import { fakeHttp, requestHeader, useProviderWorld } from "./helpers/provider-fetch.js";

useProviderWorld();

const usage = {
  limits: [
    {
      limit_type: "credits",
      limit_window: "5h",
      max_value: 450,
      current_value: 54,
      remaining_value: 396,
      model_filter: null,
      reset_at: "2026-11-16T17:33:19Z",
    },
    {
      limit_type: "credits",
      limit_window: "7d",
      max_value: 15120,
      current_value: 8165,
      remaining_value: 6955,
      model_filter: null,
      reset_at: "2026-11-19T10:13:17Z",
    },
  ],
  upstream_limits: [],
  account_pool_usage: { primary: 88, secondary: 46 },
};

function context(entries: unknown[]) {
  return {
    client: { config: { providers: async () => ({ data: { providers: entries } }) } },
    config: { requestTimeoutMs: 5000 },
  } as never;
}

const service = (id: string, baseURL: string, apiKey = "fixture-key") => ({
  id: `codex-lb-${id}`,
  settings: { baseURL, apiKey },
});

it("reports 5h and 7d aggregate credit limits per service, without double-counting pool or upstream", async () => {
  const http = fakeHttp(() => usage);
  const ctx = context([service("primary", "https://lb.example/v1/")]);
  expect(await provider.isAvailable(ctx)).toBe(true);
  const result = await provider.fetch(ctx);
  expect(result.accounts).toHaveLength(1);
  expect(result.accounts[0].name).toBe("Codex LB (primary)");
  expect(
    result.accounts[0].rows.map((row) => [row.key, row.percentRemaining, row.resetsAt]),
  ).toEqual([
    ["five_hour", 88, "2026-11-16T17:33:19.000Z"],
    ["weekly", 46, "2026-11-19T10:13:17.000Z"],
  ]);
  expect(http).toHaveBeenCalledTimes(1);
  expect(String(http.mock.calls[0][0])).toBe("https://lb.example/v1/usage");
  expect(requestHeader(http.mock.calls[0][1], "Authorization")).toBe("Bearer fixture-key");
});

it("keeps services separate and skips missing windows", async () => {
  const ctx = context([service("a", "https://a.example/v1"), service("b", "https://b.example/v1")]);
  fakeHttp((url) => (url.includes("a.example") ? usage : { limits: [usage.limits[1]] }));
  const result = await provider.fetch(ctx);
  expect(
    result.accounts.map((account) => [account.name, account.rows.map((row) => row.key)]),
  ).toEqual([
    ["Codex LB (a)", ["five_hour", "weekly"]],
    ["Codex LB (b)", ["weekly"]],
  ]);
});

it("shows both 5h and 7d on the bottom status bar", async () => {
  const ctx = context([service("primary", "https://lb.example/v1")]);
  fakeHttp(() => usage);
  const fetched = rowsFromProviderResult(provider.id, await provider.fetch(ctx), 0);
  const snapshot = {
    version: 6 as const,
    providers: [
      {
        providerId: provider.id,
        label: "Codex LB",
        rows: fetched.rows,
        refreshing: false,
        debug: [],
        checkedAtMs: 0,
      },
    ],
    resetNotices: [],
    generatedAtMs: 0,
    serverId: "test",
    revision: 1,
  };
  const input = statusLineInput(snapshot, defaultSettings(), 0);
  expect(input.groups.map((group) => group.id)).toEqual(["codex-lb.five_hour", "codex-lb.weekly"]);
  const bar = statusLayout(input, 200, 0, "numbers").shown.map(lineText).join(" | ");
  expect(bar).toContain("Codex LB (5h)");
  expect(bar).toContain("Codex LB (7d)");
  expect(bar).toContain("88%");
  expect(bar).toContain("46%");
});

it("never requests an unconfigured service or an unsafe URL", async () => {
  const http = fakeHttp(() => usage);
  const ctx = context([
    service("unsafe", "http://remote.example/v1"),
    service("missing", "https://lb.example/v1", ""),
  ]);
  expect(await provider.isAvailable(ctx)).toBe(false);
  expect((await provider.fetch(ctx)).attempted).toBe(false);
  expect(http).not.toHaveBeenCalled();
});

it("reports invalid limits and HTTP errors without leaking credentials", async () => {
  const ctx = context([service("primary", "https://lb.example/v1")]);
  fakeHttp(() => ({ limits: [{ ...usage.limits[0], remaining_value: "396" }] }));
  expect((await provider.fetch(ctx)).accounts[0].errors[0].facts?.code).toBe("bad_response");
  fakeHttp(() => new Response("secret fixture-key", { status: 401 }));
  const result = await provider.fetch(ctx);
  expect(result.accounts[0].errors[0].facts?.code).toBe("login_expired");
  expect(JSON.stringify(result)).not.toContain("fixture-key");
});

it("matches only Codex LB models", () => {
  expect(provider.matchesCurrentModel?.("codex-lb-primary/gpt-6")).toBe(true);
  expect(provider.matchesCurrentModel?.("openai/gpt-6")).toBe(false);
  expect(provider.matchesCurrentModel?.("codex-lb-primary")).toBe(false);
});
