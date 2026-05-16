import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

export type LocalRejectionResponseConfig = {
  status: number;
  body: string;
  headers?: Record<string, string>;
};

export type ProxyConfig = {
  proxyPath?: string;
  allowlist?: Array<string | RegExp>;
  denylist?: Array<string | RegExp>;
  userAgentAllowlist?: Array<string | RegExp>;
  userAgentDenylist?: Array<string | RegExp>;
  localRejectionResponse?: LocalRejectionResponseConfig;
};

export type NormalizedProxyConfig = {
  proxyPath: string;
  allowlist: RegExp[];
  denylist: RegExp[];
  userAgentAllowlist: RegExp[];
  userAgentDenylist: RegExp[];
  localRejectionResponse?: LocalRejectionResponseConfig;
};

type ProxyFetchHandlerOptions = {
  fetch?: ProxyFetch;
  log?: (message: string) => void;
};

export type ProxyFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8" };
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
];
const DISALLOWED_LOCAL_REJECTION_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
]);

export async function loadConfig(configPath: string): Promise<ProxyConfig> {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const fileUrl = pathToFileURL(resolvePath(configPath)).href;
    const module = (await import(fileUrl)) as { default?: ProxyConfig; config?: ProxyConfig };
    return module.default ?? module.config ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load ${configPath}: ${message}`);
  }
}

export function normalizeConfig(config: ProxyConfig): NormalizedProxyConfig {
  return {
    proxyPath: normalizeProxyPath(config.proxyPath),
    allowlist: compileRegexList(config.allowlist, "allowlist"),
    denylist: compileRegexList(config.denylist, "denylist"),
    userAgentAllowlist: compileRegexList(config.userAgentAllowlist, "userAgentAllowlist"),
    userAgentDenylist: compileRegexList(config.userAgentDenylist, "userAgentDenylist"),
    localRejectionResponse: normalizeLocalRejectionResponse(config.localRejectionResponse),
  };
}

function normalizeProxyPath(proxyPath: ProxyConfig["proxyPath"]): string {
  if (proxyPath === undefined) {
    return "/";
  }

  if (typeof proxyPath !== "string") {
    throw new Error("Invalid proxyPath: expected a string.");
  }

  const normalized = proxyPath.trim().replace(/\/+$/, "") || "/";
  if (!normalized.startsWith("/")) {
    throw new Error('Invalid proxyPath: expected a path starting with "/".');
  }
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new Error("Invalid proxyPath: query strings and fragments are not supported.");
  }

  return normalized;
}

function compileRegexList(
  patterns: Array<string | RegExp> | undefined,
  label: string,
): RegExp[] {
  if (!patterns?.length) {
    return [];
  }

  return patterns.map((pattern) => {
    if (pattern instanceof RegExp) {
      return pattern;
    }
    try {
      return new RegExp(pattern);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid ${label} regex "${pattern}": ${message}`);
    }
  });
}

function normalizeLocalRejectionResponse(
  response: ProxyConfig["localRejectionResponse"],
): LocalRejectionResponseConfig | undefined {
  if (response === undefined) {
    return undefined;
  }

  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Invalid localRejectionResponse: expected an object.");
  }

  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    throw new Error("Invalid localRejectionResponse status: expected an integer from 200 to 599.");
  }

  if (typeof response.body !== "string") {
    throw new Error("Invalid localRejectionResponse body: expected a string.");
  }

  const normalizedResponse: LocalRejectionResponseConfig = {
    status: response.status,
    body: response.body,
  };
  const headers = normalizeLocalRejectionHeaders(response.headers);
  if (headers) {
    normalizedResponse.headers = headers;
  }

  return normalizedResponse;
}

function normalizeLocalRejectionHeaders(
  headers: LocalRejectionResponseConfig["headers"],
): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }

  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("Invalid localRejectionResponse headers: expected an object.");
  }

  const normalizedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (DISALLOWED_LOCAL_REJECTION_HEADERS.has(normalizedName)) {
      throw new Error(
        `Invalid localRejectionResponse header "${name}": hop-by-hop, framing, and encoding headers are not configurable.`,
      );
    }

    if (typeof value !== "string") {
      throw new Error(`Invalid localRejectionResponse header "${name}": expected a string value.`);
    }

    try {
      new Headers({ [name]: value });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid localRejectionResponse header "${name}": ${message}`);
    }

    normalizedHeaders[normalizedName] = value;
  }

  return normalizedHeaders;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function targetPathFromProxyPath(pathname: string, proxyPath: string): string | undefined {
  if (proxyPath === "/") {
    return pathname.replace(/^\/+/, "");
  }

  if (pathname === proxyPath) {
    return "";
  }

  if (pathname.startsWith(`${proxyPath}/`)) {
    return pathname.slice(proxyPath.length).replace(/^\/+/, "");
  }

  return undefined;
}

function resolveTargetUrl(
  requestUrl: URL,
  proxyPath: string,
): { targetUrl?: URL; error?: string; status?: number } {
  const rawPath = targetPathFromProxyPath(requestUrl.pathname, proxyPath);
  if (rawPath === undefined) {
    return { error: "Proxy path not found.", status: 404 };
  }

  if (!rawPath) {
    const usagePath = proxyPath === "/" ? "" : proxyPath;
    return { error: `Missing target URL. Use ${usagePath}/https://example.com/path?query=1` };
  }

  const decodedPath = safeDecode(rawPath);
  const targetCandidate = `${decodedPath}${requestUrl.search}`;
  if (!/^https?:\/\//i.test(targetCandidate)) {
    return { error: "Target URL must start with http:// or https://." };
  }

  try {
    return { targetUrl: new URL(targetCandidate) };
  } catch {
    return { error: "Target URL is not a valid URL." };
  }
}

function matchesAny(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    const matches = pattern.test(value);
    pattern.lastIndex = 0;
    return matches;
  });
}

function isAllowedByRules(
  value: string,
  allowlist: RegExp[],
  denylist: RegExp[],
  denyReason: string,
  allowMissReason: string,
): { allowed: boolean; reason?: string } {
  if (matchesAny(denylist, value)) {
    return { allowed: false, reason: denyReason };
  }

  if (allowlist.length > 0 && !matchesAny(allowlist, value)) {
    return { allowed: false, reason: allowMissReason };
  }

  return { allowed: true };
}

function isTargetAllowed(
  targetUrl: URL,
  allowlist: RegExp[],
  denylist: RegExp[],
): { allowed: boolean; reason?: string } {
  return isAllowedByRules(
    targetUrl.href,
    allowlist,
    denylist,
    "Blocked by denylist.",
    "Not permitted by allowlist.",
  );
}

function isUserAgentAllowed(
  userAgent: string,
  allowlist: RegExp[],
  denylist: RegExp[],
): { allowed: boolean; reason?: string } {
  return isAllowedByRules(
    userAgent,
    allowlist,
    denylist,
    "Blocked by User-Agent denylist.",
    "User-Agent not permitted by allowlist.",
  );
}

function textResponse(
  body: string,
  status: number,
  headers?: LocalRejectionResponseConfig["headers"],
): Response {
  const responseHeaders = new Headers(TEXT_HEADERS);
  for (const [name, value] of Object.entries(headers ?? {})) {
    responseHeaders.set(name, value);
  }

  return new Response(body, {
    status,
    headers: responseHeaders,
  });
}

function localRejectionResponse(
  config: NormalizedProxyConfig,
  defaultStatus: number,
  defaultBody: string,
): Response {
  const response = config.localRejectionResponse;

  return textResponse(
    response?.body ?? defaultBody,
    response?.status ?? defaultStatus,
    response?.headers,
  );
}

export function createProxyFetchHandler(
  config: NormalizedProxyConfig,
  options: ProxyFetchHandlerOptions = {},
) {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? console.log;

  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    const logRequest = (
      status: number,
      note: string,
      targetUrl?: URL,
      details = "",
    ) => {
      const durationMs = Date.now() - startedAt;
      const targetInfo = targetUrl ? ` target=${targetUrl.href}` : "";
      const detailInfo = details ? ` ${details}` : "";
      log(`${request.method} ${request.url} -> ${status} ${note}${targetInfo}${detailInfo} ${durationMs}ms`);
    };

    if (request.method === "CONNECT") {
      const response = localRejectionResponse(config, 405, "CONNECT is not supported.");
      logRequest(response.status, "connect_not_supported");
      return response;
    }

    const requestUrl = new URL(request.url);
    const { targetUrl, error, status } = resolveTargetUrl(requestUrl, config.proxyPath);
    if (!targetUrl) {
      const response = localRejectionResponse(config, status ?? 400, error ?? "Bad request.");
      logRequest(response.status, error ?? "bad_request");
      return response;
    }

    const allowed = isTargetAllowed(targetUrl, config.allowlist, config.denylist);
    if (!allowed.allowed) {
      const response = localRejectionResponse(config, 403, allowed.reason ?? "Forbidden.");
      logRequest(response.status, allowed.reason ?? "forbidden", targetUrl);
      return response;
    }

    const userAgent = request.headers.get("user-agent") ?? "";
    const userAgentAllowed = isUserAgentAllowed(
      userAgent,
      config.userAgentAllowlist,
      config.userAgentDenylist,
    );
    if (!userAgentAllowed.allowed) {
      const response = localRejectionResponse(
        config,
        403,
        userAgentAllowed.reason ?? "Forbidden.",
      );
      logRequest(
        response.status,
        userAgentAllowed.reason ?? "forbidden_user_agent",
        targetUrl,
        `userAgent=${JSON.stringify(userAgent)}`,
      );
      return response;
    }

    const headers = new Headers(request.headers);
    for (const header of HOP_BY_HOP_HEADERS) {
      headers.delete(header);
    }
    headers.set("x-forwarded-host", requestUrl.host);
    headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));
    // Avoid compressed upstream responses to keep headers/body consistent.
    headers.delete("accept-encoding");

    try {
      const upstream = await fetchImpl(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });

      const responseHeaders = new Headers(upstream.headers);
      // Bun fetch may decompress; remove encoding/length headers to prevent mismatch.
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      responseHeaders.delete("transfer-encoding");
      responseHeaders.set("x-proxy-target", targetUrl.href);

      logRequest(upstream.status, "upstream", targetUrl);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
      logRequest(502, "upstream_error", targetUrl);
      return textResponse(`Upstream request failed: ${message}`, 502);
    }
  };
}
