import { evaluateInCdpPage, recoverCookieBloatInCdp } from "./cdp";
import { chatGptOrigins } from "./cookies";
import { EXIT, ProError } from "./errors";

const DEFAULT_CDP_BASE = "http://127.0.0.1:9222";

export interface AccountSummary {
  planType: string | null;
  subscriptionPlan: string | null;
  hasActiveSubscription: boolean;
  expiresAt: string | null;
  renewsAt: string | null;
  cancelsAt: string | null;
  billingPeriod: string | null;
  willRenew: boolean | null;
  features: string[];
}

interface RawFetchResult {
  ok: boolean;
  status: number;
  body: string;
  code?: "CHATGPT_PAGE_MISSING" | "CHATGPT_PAGE_LOGGED_OUT" | "CHATGPT_PROBE_FAILED";
}

export async function fetchAccountSummary(cdpBase?: string): Promise<AccountSummary> {
  const resolvedCdpBase = cdpBase ?? DEFAULT_CDP_BASE;
  const expression = `(${async function pageFetch(): Promise<RawFetchResult> {
    if (location.origin !== "https://chatgpt.com") {
      return { ok: false, status: 0, code: "CHATGPT_PAGE_MISSING", body: location.href };
    }
    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include", referrerPolicy: "no-referrer" });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    if (!sessionResponse.ok && sessionResponse.status !== 401) {
      return {
        ok: false,
        status: sessionResponse.status,
        code: "CHATGPT_PROBE_FAILED",
        body: `ChatGPT auth session probe returned HTTP ${sessionResponse.status}.`,
      };
    }
    if (typeof session?.accessToken !== "string" || !session.accessToken) {
      return { ok: false, status: sessionResponse.status, code: "CHATGPT_PAGE_LOGGED_OUT", body: "" };
    }
    const response = await fetch("https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27", {
      method: "GET",
      credentials: "include",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        accept: "application/json",
      },
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  }})()`;

  let raw = await evaluateInCdpPage<RawFetchResult>(resolvedCdpBase, expression, 30_000);
  if (shouldRecoverCookieBloat(raw)) {
    const recovered = await recoverCookieBloatInCdp(resolvedCdpBase, chatGptOrigins(), 30_000).catch(() => null);
    if (recovered?.deleted) {
      raw = await evaluateInCdpPage<RawFetchResult>(resolvedCdpBase, expression, 30_000);
    }
  }
  if (raw.code === "CHATGPT_PAGE_MISSING") {
    throw new ProError("CHATGPT_PAGE_MISSING", "No logged-in ChatGPT page is available over CDP.", {
      exitCode: EXIT.auth,
      suggestions: [
        "Open the Chrome command from pro-cli auth command.",
        "Confirm the CDP Chrome window is on https://chatgpt.com/ and logged in.",
      ],
    });
  }
  if (raw.code === "CHATGPT_PAGE_LOGGED_OUT") {
    throw new ProError("CHATGPT_PAGE_LOGGED_OUT", "The ChatGPT CDP page is not logged in.", {
      exitCode: EXIT.auth,
      suggestions: ["Sign in to ChatGPT, then run pro-cli auth capture."],
    });
  }
  if (raw.code === "CHATGPT_PROBE_FAILED") {
    const status = raw.status;
    const suggestions =
      status === 431
        ? [
            "HTTP 431 indicates oversize request headers; the CDP Chrome profile likely has stale cookie buildup.",
            "Sign out of ChatGPT in the CDP window, sign back in, then run pro-cli auth capture.",
          ]
        : [
            `The ChatGPT auth session probe failed with HTTP ${status}; cannot determine login state.`,
            "Reload the CDP ChatGPT tab and retry.",
          ];
    throw new ProError(
      "CHATGPT_PROBE_FAILED",
      `Could not determine ChatGPT login state from the CDP page (HTTP ${status}).`,
      { exitCode: EXIT.auth, suggestions, details: { status } },
    );
  }
  if (!raw.ok) {
    throw new ProError("UPSTREAM_REJECTED", `accounts/check returned HTTP ${raw.status}.`, {
      exitCode: EXIT.upstream,
      details: { preview: raw.body.slice(0, 240) },
    });
  }
  return summarizeAccountResponse(raw.body);
}

function shouldRecoverCookieBloat(raw: RawFetchResult): boolean {
  return raw.status === 431 || raw.body.includes("chrome-error://chromewebdata/");
}

export interface ModelLimit {
  model: string;
  resetsAfter: string;
  /** ChatGPT's wording, e.g. "Capabilities reduced until November 3. Responses may have lower quality." */
  description: string | null;
}

/**
 * The page script that asks conversation/init which models have reached their usage limit, as
 * the ChatGPT page does before every new chat. It sends no prompt and spends no quota.
 */
export function buildModelLimitsExpression(): string {
  const requestBody = { requested_default_model: null };
  return `(${async function conversationInit(requestBody: Record<string, unknown>): Promise<RawFetchResult> {
    if (location.origin !== "https://chatgpt.com") {
      return { ok: false, status: 0, code: "CHATGPT_PAGE_MISSING", body: location.href };
    }
    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include", referrerPolicy: "no-referrer" });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    if (typeof session?.accessToken !== "string" || !session.accessToken) {
      return { ok: false, status: sessionResponse.status, code: "CHATGPT_PAGE_LOGGED_OUT", body: "" };
    }
    const response = await fetch("https://chatgpt.com/backend-api/conversation/init", {
      method: "POST",
      credentials: "include",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...requestBody,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezone_offset_min: new Date().getTimezoneOffset(),
      }),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }})(${JSON.stringify(requestBody)})`;
}

/**
 * Page code that a request's page script runs before it sends anything: asks conversation/init
 * about the request, as the ChatGPT page does before a new chat, and returns its answer when it
 * lists `model` as limited until a time still ahead. Null otherwise, also when the answer can't be
 * read, so a failed check never stops a request. It runs in the page, so it uses nothing from here.
 */
export async function pageModelLimitBody(
  model: string,
  request: Record<string, unknown>,
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await fetch("https://chatgpt.com/backend-api/conversation/init", {
      method: "POST",
      credentials: "include",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) return null;
    const body = await response.text();
    const limits = (JSON.parse(body) as { model_limits?: unknown } | null)?.model_limits;
    const listed = Array.isArray(limits) && limits.some((entry: { model_slug?: unknown; resets_after?: unknown } | null) =>
      entry?.model_slug === model && Date.parse(String(entry.resets_after)) > Date.now());
    return listed ? body : null;
  } catch {
    return null;
  }
}

/** The models a conversation/init response lists as limited whose reset is still ahead. */
export function readModelLimits(body: unknown, now = Date.now()): ModelLimit[] {
  if (!isRecord(body) || !Array.isArray(body.model_limits)) return [];
  const banner = isRecord(body.banner_info) ? body.banner_info : null;
  const blocked = Array.isArray(body.blocked_features) ? body.blocked_features.filter(isRecord) : [];
  return body.model_limits.filter(isRecord).flatMap((entry) => {
    const model = stringOrNull(entry.model_slug);
    const resetsAt = Date.parse(stringOrNull(entry.resets_after) ?? "");
    if (!model || !(resetsAt > now)) return [];
    const description = stringOrNull(entry.description)
      ?? (banner?.name === model ? stringOrNull(banner.description) : null)
      ?? stringOrNull(blocked.find((feature) => Date.parse(String(feature.resets_after)) === resetsAt)?.description);
    return [{ model, resetsAfter: new Date(resetsAt).toISOString(), description }];
  });
}

/** The models whose usage limit is reached; null when the page could not be asked. */
export async function fetchModelLimits(cdpBase?: string): Promise<ModelLimit[] | null> {
  const raw = await evaluateInCdpPage<RawFetchResult>(cdpBase ?? DEFAULT_CDP_BASE, buildModelLimitsExpression(), 30_000)
    .catch(() => null);
  if (!raw?.ok) return null;
  try {
    return readModelLimits(JSON.parse(raw.body));
  } catch {
    return null;
  }
}

export function summarizeAccountResponse(body: string): AccountSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new ProError("ACCOUNT_PARSE_FAILED", "Could not parse accounts/check response.", {
      exitCode: EXIT.upstream,
      cause: error,
    });
  }
  const accounts = isRecord(parsed) ? parsed.accounts : null;
  if (!isRecord(accounts)) {
    return emptySummary();
  }
  const ordering = isRecord(parsed) && Array.isArray((parsed as { account_ordering?: unknown }).account_ordering)
    ? ((parsed as { account_ordering: unknown[] }).account_ordering as unknown[])
    : [];
  const orderedKey = ordering.find((id): id is string => typeof id === "string" && id in accounts);
  const fallbackKey = Object.keys(accounts).find((key) => key !== "default") ?? "default";
  const key = orderedKey ?? fallbackKey;
  const account = accounts[key];
  if (!isRecord(account)) return emptySummary();

  const accountInfo = isRecord(account.account) ? account.account : {};
  const entitlement = isRecord(account.entitlement) ? account.entitlement : {};
  const lastSub = isRecord(account.last_active_subscription) ? account.last_active_subscription : {};
  const features = Array.isArray(account.features)
    ? (account.features as unknown[]).filter((value): value is string => typeof value === "string")
    : [];

  return {
    planType: stringOrNull(accountInfo.plan_type),
    subscriptionPlan: stringOrNull(entitlement.subscription_plan),
    hasActiveSubscription: entitlement.has_active_subscription === true,
    expiresAt: stringOrNull(entitlement.expires_at),
    renewsAt: stringOrNull(entitlement.renews_at),
    cancelsAt: stringOrNull(entitlement.cancels_at),
    billingPeriod: stringOrNull(entitlement.billing_period),
    willRenew: typeof lastSub.will_renew === "boolean" ? lastSub.will_renew : null,
    features,
  };
}

function emptySummary(): AccountSummary {
  return {
    planType: null,
    subscriptionPlan: null,
    hasActiveSubscription: false,
    expiresAt: null,
    renewsAt: null,
    cancelsAt: null,
    billingPeriod: null,
    willRenew: null,
    features: [],
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
