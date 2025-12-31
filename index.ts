import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

type ProxyConfig = {
  allowlist?: Array<string | RegExp>;
  denylist?: Array<string | RegExp>;
};

const DEFAULT_PORT = 3000;
const DEFAULT_CONFIG_FILENAME = "config.js";

async function loadConfig(configPath: string): Promise<ProxyConfig> {
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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveTargetUrl(requestUrl: URL): { targetUrl?: URL; error?: string } {
  const rawPath = requestUrl.pathname.replace(/^\/+/, "");
  if (!rawPath) {
    return { error: "Missing target URL. Use /https://example.com/path?query=1" };
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

function isAllowed(
  targetUrl: URL,
  allowlist: RegExp[],
  denylist: RegExp[],
): { allowed: boolean; reason?: string } {
  const target = targetUrl.href;

  if (denylist.some((pattern) => pattern.test(target))) {
    return { allowed: false, reason: "Blocked by denylist." };
  }

  if (allowlist.length > 0 && !allowlist.some((pattern) => pattern.test(target))) {
    return { allowed: false, reason: "Not permitted by allowlist." };
  }

  return { allowed: true };
}

const portEnv = Number(process.env.PORT ?? DEFAULT_PORT);
const port = Number.isFinite(portEnv) ? portEnv : DEFAULT_PORT;
const execPath = process.execPath ?? Bun.argv[0] ?? process.argv[0];
const execDir = execPath ? dirname(execPath) : process.cwd();
const defaultConfigPath = resolvePath(execDir, DEFAULT_CONFIG_FILENAME);
const configPath = process.env.CONFIG ? resolvePath(process.env.CONFIG) : defaultConfigPath;
const config = await loadConfig(configPath);
const allowlist = compileRegexList(config.allowlist, "allowlist");
const denylist = compileRegexList(config.denylist, "denylist");

const server = Bun.serve({
  port,
  fetch: async (request) => {
    if (request.method === "CONNECT") {
      return new Response("CONNECT is not supported.", { status: 405 });
    }

    const requestUrl = new URL(request.url);
    const { targetUrl, error } = resolveTargetUrl(requestUrl);
    if (!targetUrl) {
      return new Response(error ?? "Bad request.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const allowed = isAllowed(targetUrl, allowlist, denylist);
    if (!allowed.allowed) {
      return new Response(allowed.reason ?? "Forbidden.", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const headers = new Headers(request.headers);
    const hopByHopHeaders = [
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
    for (const header of hopByHopHeaders) {
      headers.delete(header);
    }
    headers.set("x-forwarded-host", requestUrl.host);
    headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));
    // Avoid compressed upstream responses to keep headers/body consistent.
    headers.delete("accept-encoding");

    try {
      const upstream = await fetch(targetUrl, {
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

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
      return new Response(`Upstream request failed: ${message}`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
});

console.log(`Forward proxy listening on ${server.url}`);
console.log(`Config path: ${configPath}`);
