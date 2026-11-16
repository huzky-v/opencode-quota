/** Quota for services injected by opencode-codex-lb. */
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { clampPercent } from "../lib/format-utils.js";
import { failureFacts, requestJson } from "../lib/http.js";
import { isRecord } from "../lib/json-guards.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
} from "../lib/resolved-auth-identity.js";
import {
  failedAccount,
  fetchError,
  FIVE_HOUR,
  type ProviderRow,
  WEEKLY,
  windowRows,
} from "./contract.js";

const PREFIX = "codex-lb-";
type Service = { id: string; url: string; key: string };

function usageUrl(baseURL: string): string | null {
  try {
    const url = new URL(baseURL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return null;
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/usage`;
    return url.toString();
  } catch {
    return null;
  }
}

async function services(ctx: QuotaProviderContext): Promise<Service[]> {
  const response = await ctx.client.config.providers();
  return (response.data?.providers ?? []).flatMap((provider) => {
    if (!provider.id.startsWith(PREFIX)) return [];
    const settings = provider.settings;
    if (!isRecord(settings)) return [];
    const baseURL = settings.baseURL;
    const key = settings.apiKey;
    const url = typeof baseURL === "string" ? usageUrl(baseURL) : null;
    return url && typeof key === "string" && key.trim()
      ? [{ id: provider.id, url, key: key.trim() }]
      : [];
  });
}

function parseRows(json: unknown): ProviderRow[] | null {
  if (!isRecord(json) || !Array.isArray(json.limits)) return null;
  const rows: ProviderRow[] = [];
  for (const [windowName, slot] of [
    ["5h", FIVE_HOUR],
    ["7d", WEEKLY],
  ] as const) {
    const matches = json.limits.filter(
      (entry) =>
        isRecord(entry) &&
        entry.limit_type === "credits" &&
        entry.limit_window === windowName &&
        entry.model_filter === null,
    );
    if (matches.length > 1) return null;
    const entry = matches[0];
    if (!entry) continue;
    const max = entry.max_value;
    const remaining = entry.remaining_value;
    const reset = entry.reset_at;
    if (
      typeof max !== "number" ||
      !Number.isFinite(max) ||
      max <= 0 ||
      typeof remaining !== "number" ||
      !Number.isFinite(remaining) ||
      typeof reset !== "string" ||
      !Number.isFinite(Date.parse(reset))
    )
      return null;
    rows.push(
      ...windowRows([
        {
          slot,
          value: {
            percentRemaining: clampPercent((remaining / max) * 100),
            resetTimeIso: new Date(reset).toISOString(),
          },
        },
      ]),
    );
  }
  return rows;
}

export const codexLbProvider: QuotaProvider = {
  id: "codex-lb",
  cachePolicy: {
    kind: "resolved-auth",
    async resolveIdentity(ctx) {
      const configured = await services(ctx);
      if (!configured.length) return null;
      const identities = await Promise.all(
        configured.map(({ id, url, key }) =>
          deriveResolvedAuthIdentity({
            providerId: "codex-lb",
            principal: { kind: "credential", value: key },
            qualifiers: [id, url],
          }),
        ),
      );
      if (identities.some((identity) => identity === null)) return null;
      return composeResolvedAuthIdentities({
        providerId: "codex-lb",
        identities: identities as Exclude<(typeof identities)[number], null>[],
      });
    },
  },
  async isAvailable(ctx) {
    return (await services(ctx)).length > 0;
  },
  matchesCurrentModel(model) {
    const [providerId, modelId] = model.toLowerCase().split("/", 2);
    return Boolean(modelId) && providerId.startsWith(PREFIX) && providerId.length > PREFIX.length;
  },
  async fetch(ctx) {
    const configured = await services(ctx);
    if (!configured.length) return { attempted: false, accounts: [], debug: [] };
    const accounts = await Promise.all(
      configured.map(async ({ id, url, key }) => {
        const name = `Codex LB (${id.slice(PREFIX.length)})`;
        const reply = await requestJson(url, {
          headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
          secrets: [key],
          redirect: "manual",
          timeoutMs: ctx.config.requestTimeoutMs,
          maxBytes: 256 * 1024,
        });
        if (!reply.ok)
          return failedAccount(
            name,
            `Codex LB usage request failed (${reply.failure.kind})`,
            failureFacts(reply.failure),
          );
        const rows = parseRows(reply.json);
        return rows === null
          ? {
              name,
              rows: [],
              errors: [
                fetchError("Codex LB usage returned an invalid limits response", {
                  code: "bad_response",
                }),
              ],
            }
          : { name, rows, errors: [] };
      }),
    );
    return { attempted: true, accounts, debug: [] };
  },
};
