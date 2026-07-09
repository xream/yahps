import { describe, expect, test } from "bun:test";

import {
  createProxyFetchHandler,
  normalizeConfig,
  type ProxyConfig,
  type ProxyFetch,
} from "../proxy";

const silentLog = () => {};

function createHandler(config: ProxyConfig, fetchImpl: ProxyFetch = fetch) {
  return createProxyFetchHandler(normalizeConfig(config), {
    fetch: fetchImpl,
    log: silentLog,
  });
}

async function responseText(response: Response) {
  return await response.text();
}

describe("normalizeConfig", () => {
  test("normalizes proxy path by default and when configured", () => {
    expect(normalizeConfig({}).proxyPath).toBe("/");
    expect(normalizeConfig({ proxyPath: "/secret/" }).proxyPath).toBe("/secret");
  });

  test("rejects invalid proxy path", () => {
    expect(() => normalizeConfig({ proxyPath: "secret" })).toThrow(/Invalid proxyPath/);
    expect(() => normalizeConfig({ proxyPath: "/secret?x=1" })).toThrow(/Invalid proxyPath/);
  });

  test("normalizes a valid local rejection response", () => {
    const config = normalizeConfig({
      userAgentAllowlist: ["^Mozilla/"],
      userAgentDenylist: [/bot/i],
      localRejectionResponse: {
        status: 451,
        body: "Unavailable for legal reasons.",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    });

    expect(config.localRejectionResponse).toEqual({
      status: 451,
      body: "Unavailable for legal reasons.",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
    expect(config.userAgentAllowlist[0]?.test("Mozilla/5.0")).toBe(true);
    expect(config.userAgentDenylist[0]?.source).toBe("bot");
    expect(config.userAgentDenylist[0]?.flags).toBe("i");
  });

  test("keeps local rejection response absent by default", () => {
    const config = normalizeConfig({});

    expect(config.localRejectionResponse).toBeUndefined();
    expect(config.requestHeaderRules).toEqual([]);
  });

  test("normalizes valid request header rules", () => {
    const config = normalizeConfig({
      requestHeaderRules: [
        {
          url: "^https://example\\.com/",
          methods: ["get", "HEAD"],
          overrideClientHeaders: false,
          headers: {
            Authorization: "Bearer token",
            "X-Custom": "ok",
          },
        },
      ],
    });

    expect(config.requestHeaderRules).toHaveLength(1);
    expect(config.requestHeaderRules[0]?.url.test("https://example.com/file")).toBe(true);
    expect(config.requestHeaderRules[0]?.methods).toEqual(["GET", "HEAD"]);
    expect(config.requestHeaderRules[0]?.overrideClientHeaders).toBe(false);
    expect(config.requestHeaderRules[0]?.headers).toEqual({
      authorization: "Bearer token",
      "x-custom": "ok",
    });
  });

  test("rejects invalid local rejection response status", () => {
    expect(() =>
      normalizeConfig({
        localRejectionResponse: {
          status: 199,
          body: "Nope.",
        },
      }),
    ).toThrow(/Invalid localRejectionResponse status/);
  });

  test("rejects invalid local rejection response object", () => {
    expect(() =>
      normalizeConfig({
        localRejectionResponse: null,
      } as unknown as ProxyConfig),
    ).toThrow(/Invalid localRejectionResponse/);
  });

  test("rejects invalid local rejection response body", () => {
    expect(() =>
      normalizeConfig({
        localRejectionResponse: {
          status: 451,
          body: { error: "blocked" },
        },
      } as unknown as ProxyConfig),
    ).toThrow(/Invalid localRejectionResponse body/);
  });

  test("rejects invalid local rejection response headers", () => {
    expect(() =>
      normalizeConfig({
        localRejectionResponse: {
          status: 451,
          body: "Blocked.",
          headers: {
            "x-reason": 123,
          },
        },
      } as unknown as ProxyConfig),
    ).toThrow(/Invalid localRejectionResponse header/);
  });

  test("rejects hop-by-hop, framing, and encoding local rejection response headers", () => {
    const baseConfig = {
      localRejectionResponse: {
        status: 451,
        body: "Blocked.",
      },
    };

    expect(() =>
      normalizeConfig({
        ...baseConfig,
        localRejectionResponse: {
          ...baseConfig.localRejectionResponse,
          headers: {
            "content-length": "999",
          },
        },
      }),
    ).toThrow(/hop-by-hop, framing, and encoding headers/);

    expect(() =>
      normalizeConfig({
        ...baseConfig,
        localRejectionResponse: {
          ...baseConfig.localRejectionResponse,
          headers: {
            "content-encoding": "gzip",
          },
        },
      }),
    ).toThrow(/hop-by-hop, framing, and encoding headers/);
  });

  test("rejects invalid request header rules", () => {
    expect(() =>
      normalizeConfig({
        requestHeaderRules: null,
      } as unknown as ProxyConfig),
    ).toThrow(/Invalid requestHeaderRules/);

    expect(() =>
      normalizeConfig({
        requestHeaderRules: [
          {
            url: "[",
            methods: ["GET"],
            headers: {
              authorization: "Bearer token",
            },
          },
        ],
      }),
    ).toThrow(/Invalid requestHeaderRules url/);

    expect(() =>
      normalizeConfig({
        requestHeaderRules: [
          {
            url: /^https:\/\/example\.com/,
            methods: [],
            headers: {
              authorization: "Bearer token",
            },
          },
        ],
      }),
    ).toThrow(/Invalid requestHeaderRules methods/);

    expect(() =>
      normalizeConfig({
        requestHeaderRules: [
          {
            url: /^https:\/\/example\.com/,
            methods: ["GET"],
            headers: {
              authorization: 123,
            },
          },
        ],
      } as unknown as ProxyConfig),
    ).toThrow(/Invalid requestHeaderRules header/);

    expect(() =>
      normalizeConfig({
        requestHeaderRules: [
          {
            url: /^https:\/\/example\.com/,
            methods: ["GET"],
            headers: {},
          },
        ],
      }),
    ).toThrow(/Invalid requestHeaderRules headers/);

    expect(() =>
      normalizeConfig({
        requestHeaderRules: [
          {
            url: /^https:\/\/example\.com/,
            methods: ["GET"],
            overrideClientHeaders: "no",
            headers: {
              authorization: "Bearer token",
            },
          },
        ],
      } as unknown as ProxyConfig),
    ).toThrow(/Invalid requestHeaderRules overrideClientHeaders/);
  });

  test("rejects unsafe request headers", () => {
    for (const header of [
      "host",
      "content-length",
      "transfer-encoding",
      "accept-encoding",
      "content-encoding",
      "x-forwarded-host",
      "x-forwarded-proto",
    ]) {
      expect(() =>
        normalizeConfig({
          requestHeaderRules: [
            {
              url: /^https:\/\/example\.com/,
              methods: ["GET"],
              headers: {
                [header]: "bad",
              },
            },
          ],
        }),
      ).toThrow(/hop-by-hop, framing, and encoding headers/);
    }
  });
});

describe("createProxyFetchHandler", () => {
  test("returns configured response for denylist rejection", async () => {
    const handler = createHandler({
      denylist: [/^https:\/\/example\.com\/private/],
      localRejectionResponse: {
        status: 451,
        body: "Blocked.",
        headers: {
          "x-yahps-rejection": "local",
        },
      },
    });

    const response = await handler(
      new Request("http://proxy.test/https://example.com/private"),
    );

    expect(response.status).toBe(451);
    expect(await responseText(response)).toBe("Blocked.");
    expect(response.headers.get("x-yahps-rejection")).toBe("local");
  });

  test("uses configured proxy path before resolving target URL", async () => {
    const handler = createHandler(
      {
        proxyPath: "/secret-path",
      },
      async (input) => {
        expect(input.toString()).toBe("https://example.com/ok");
        return new Response("proxied");
      },
    );

    const response = await handler(
      new Request("http://proxy.test/secret-path/https://example.com/ok"),
    );

    expect(response.status).toBe(200);
    expect(await responseText(response)).toBe("proxied");
  });

  test("rejects requests outside configured proxy path", async () => {
    const handler = createHandler({
      proxyPath: "/secret-path",
      localRejectionResponse: {
        status: 404,
        body: "Not Found.",
      },
    });

    const response = await handler(new Request("http://proxy.test/https://example.com/"));

    expect(response.status).toBe(404);
    expect(await responseText(response)).toBe("Not Found.");
  });

  test("returns built-in not found response outside configured proxy path without custom config", async () => {
    const handler = createHandler({
      proxyPath: "/secret-path",
    });

    const response = await handler(new Request("http://proxy.test/https://example.com/"));

    expect(response.status).toBe(404);
    expect(await responseText(response)).toBe("Proxy path not found.");
  });

  test("preserves root proxy path when proxyPath is not configured", async () => {
    const handler = createHandler(
      {},
      async (input) => {
        expect(input.toString()).toBe("https://example.com/root");
        return new Response("proxied");
      },
    );

    const response = await handler(new Request("http://proxy.test/https://example.com/root"));

    expect(response.status).toBe(200);
    expect(await responseText(response)).toBe("proxied");
  });

  test("returns configured response for allowlist miss", async () => {
    const handler = createHandler({
      allowlist: [/^https:\/\/allowed\.example\//],
      localRejectionResponse: {
        status: 451,
        body: "Blocked.",
      },
    });

    const response = await handler(new Request("http://proxy.test/https://example.com/"));

    expect(response.status).toBe(451);
    expect(await responseText(response)).toBe("Blocked.");
  });

  test("returns configured response for User-Agent denylist rejection", async () => {
    const handler = createHandler({
      userAgentDenylist: [/BadBot/i],
      localRejectionResponse: {
        status: 451,
        body: "Blocked.",
        headers: {
          "x-yahps-rejection": "local",
        },
      },
    });

    const response = await handler(
      new Request("http://proxy.test/https://example.com/", {
        headers: {
          "user-agent": "BadBot/1.0",
        },
      }),
    );

    expect(response.status).toBe(451);
    expect(await responseText(response)).toBe("Blocked.");
    expect(response.headers.get("x-yahps-rejection")).toBe("local");
  });

  test("returns configured response for User-Agent allowlist miss", async () => {
    const handler = createHandler({
      userAgentAllowlist: [/^Mozilla\//],
      localRejectionResponse: {
        status: 404,
        body: "Not Found.",
      },
    });

    const response = await handler(
      new Request("http://proxy.test/https://example.com/", {
        headers: {
          "user-agent": "curl/8.0",
        },
      }),
    );

    expect(response.status).toBe(404);
    expect(await responseText(response)).toBe("Not Found.");
  });

  test("logs User-Agent when User-Agent rules reject a request", async () => {
    const logs: string[] = [];
    const handler = createProxyFetchHandler(
      normalizeConfig({
        userAgentAllowlist: [/^Mozilla\//],
      }),
      {
        log: (message) => logs.push(message),
      },
    );

    const response = await handler(
      new Request("http://proxy.test/https://example.com/", {
        headers: {
          "user-agent": "curl/8.0",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("User-Agent not permitted by allowlist.");
    expect(logs[0]).toContain('userAgent="curl/8.0"');
  });

  test("keeps User-Agent regexes stable across repeated requests", async () => {
    const handler = createHandler({
      userAgentDenylist: [/BadBot/g],
    });
    const request = () =>
      new Request("http://proxy.test/https://example.com/", {
        headers: {
          "user-agent": "BadBot/1.0",
        },
      });

    const firstResponse = await handler(request());
    const secondResponse = await handler(request());

    expect(firstResponse.status).toBe(403);
    expect(await responseText(firstResponse)).toBe("Blocked by User-Agent denylist.");
    expect(secondResponse.status).toBe(403);
    expect(await responseText(secondResponse)).toBe("Blocked by User-Agent denylist.");
  });

  test("returns configured response for missing target URL", async () => {
    const handler = createHandler({
      localRejectionResponse: {
        status: 418,
        body: "Use the proxy path.",
      },
    });

    const response = await handler(new Request("http://proxy.test/"));

    expect(response.status).toBe(418);
    expect(await responseText(response)).toBe("Use the proxy path.");
  });

  test("returns configured response for invalid target URL scheme", async () => {
    const handler = createHandler({
      localRejectionResponse: {
        status: 418,
        body: "Use the proxy path.",
      },
    });

    const response = await handler(new Request("http://proxy.test/ftp://example.com/"));

    expect(response.status).toBe(418);
    expect(await responseText(response)).toBe("Use the proxy path.");
  });

  test("returns configured response for CONNECT", async () => {
    const handler = createHandler({
      localRejectionResponse: {
        status: 405,
        body: "Method not allowed.",
      },
    });

    const response = await handler(
      new Request("http://proxy.test/https://example.com/", { method: "CONNECT" }),
    );

    expect(response.status).toBe(405);
    expect(await responseText(response)).toBe("Method not allowed.");
  });

  test("preserves default local rejection responses without custom config", async () => {
    const handler = createHandler({
      denylist: [/^https:\/\/example\.com\/private/],
    });

    const connectResponse = await handler(
      new Request("http://proxy.test/https://example.com/", { method: "CONNECT" }),
    );
    expect(connectResponse.status).toBe(405);
    expect(await responseText(connectResponse)).toBe("CONNECT is not supported.");

    const invalidTargetResponse = await handler(new Request("http://proxy.test/"));
    expect(invalidTargetResponse.status).toBe(400);
    expect(await responseText(invalidTargetResponse)).toBe(
      "Missing target URL. Use /https://example.com/path?query=1",
    );

    const deniedResponse = await handler(
      new Request("http://proxy.test/https://example.com/private"),
    );
    expect(deniedResponse.status).toBe(403);
    expect(await responseText(deniedResponse)).toBe("Blocked by denylist.");

    const userAgentDeniedHandler = createHandler({
      userAgentDenylist: [/BadBot/],
    });
    const userAgentDeniedResponse = await userAgentDeniedHandler(
      new Request("http://proxy.test/https://example.com/", {
        headers: {
          "user-agent": "BadBot/1.0",
        },
      }),
    );
    expect(userAgentDeniedResponse.status).toBe(403);
    expect(await responseText(userAgentDeniedResponse)).toBe(
      "Blocked by User-Agent denylist.",
    );
  });

  test("keeps upstream failure diagnostic with custom local rejection response", async () => {
    const handler = createHandler(
      {
        localRejectionResponse: {
          status: 451,
          body: "Blocked.",
        },
      },
      async () => {
        throw new Error("network down");
      },
    );

    const response = await handler(new Request("http://proxy.test/https://example.com/"));

    expect(response.status).toBe(502);
    expect(await responseText(response)).toBe(
      "Upstream request failed: network down",
    );
  });

  test("continues proxying permitted upstream responses", async () => {
    const handler = createHandler(
      {},
      async () =>
        new Response("proxied", {
          status: 201,
          headers: {
            "content-encoding": "gzip",
            "content-length": "999",
          },
        }),
    );

    const response = await handler(new Request("http://proxy.test/https://example.com/ok"));

    expect(response.status).toBe(201);
    expect(await responseText(response)).toBe("proxied");
    expect(response.headers.get("x-proxy-target")).toBe("https://example.com/ok");
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
  });

  test("adds configured request headers for matching URL and method", async () => {
    let seenHeaders: Headers | undefined;
    const handler = createHandler(
      {
        requestHeaderRules: [
          {
            url: /^https:\/\/github\.com\/owner\/repo\//,
            methods: ["GET"],
            headers: {
              authorization: "Bearer token",
            },
          },
        ],
      },
      async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        return new Response("proxied");
      },
    );

    const response = await handler(
      new Request("http://proxy.test/https://github.com/owner/repo/archive.zip"),
    );

    expect(response.status).toBe(200);
    expect(seenHeaders?.get("authorization")).toBe("Bearer token");
  });

  test("does not add configured request headers unless URL and method both match", async () => {
    const seen: Array<string | null> = [];
    const handler = createHandler(
      {
        requestHeaderRules: [
          {
            url: /^https:\/\/github\.com\/owner\/repo\//,
            methods: ["GET"],
            headers: {
              authorization: "Bearer token",
            },
          },
        ],
      },
      async (_input, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return new Response("proxied");
      },
    );

    await handler(
      new Request("http://proxy.test/https://github.com/owner/repo/archive.zip", {
        method: "POST",
      }),
    );
    await handler(new Request("http://proxy.test/https://example.com/archive.zip"));

    expect(seen).toEqual([null, null]);
  });

  test("keeps request header URL regexes stable across repeated requests", async () => {
    const seen: Array<string | null> = [];
    const handler = createHandler(
      {
        requestHeaderRules: [
          {
            url: /^https:\/\/example\.com\//g,
            methods: ["GET"],
            headers: {
              authorization: "Bearer token",
            },
          },
        ],
      },
      async (_input, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return new Response("proxied");
      },
    );

    await handler(new Request("http://proxy.test/https://example.com/one"));
    await handler(new Request("http://proxy.test/https://example.com/two"));

    expect(seen).toEqual(["Bearer token", "Bearer token"]);
  });

  test("applies matching request header rules in order", async () => {
    let seenHeaders: Headers | undefined;
    const handler = createHandler(
      {
        requestHeaderRules: [
          {
            url: /^https:\/\/example\.com\//,
            methods: ["GET"],
            overrideClientHeaders: true,
            headers: {
              authorization: "Bearer first",
              "x-one": "1",
            },
          },
          {
            url: /^https:\/\/example\.com\//,
            methods: ["GET"],
            headers: {
              authorization: "Bearer second",
            },
          },
        ],
      },
      async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        return new Response("proxied");
      },
    );

    await handler(
      new Request("http://proxy.test/https://example.com/file", {
        headers: {
          authorization: "Bearer client",
        },
      }),
    );

    expect(seenHeaders?.get("authorization")).toBe("Bearer second");
    expect(seenHeaders?.get("x-one")).toBe("1");
  });

  test("keeps client request headers by default", async () => {
    let seenHeaders: Headers | undefined;
    const handler = createHandler(
      {
        requestHeaderRules: [
          {
            url: /^https:\/\/example\.com\//,
            methods: ["GET"],
            headers: {
              authorization: "Bearer config",
              "x-from-config": "1",
            },
          },
          {
            url: /^https:\/\/example\.com\//,
            methods: ["GET"],
            headers: {
              "x-rule-order": "first",
            },
          },
          {
            url: /^https:\/\/example\.com\//,
            methods: ["GET"],
            headers: {
              "x-rule-order": "second",
            },
          },
        ],
      },
      async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        return new Response("proxied");
      },
    );

    await handler(
      new Request("http://proxy.test/https://example.com/file", {
        headers: {
          Authorization: "Bearer client",
        },
      }),
    );

    expect(seenHeaders?.get("authorization")).toBe("Bearer client");
    expect(seenHeaders?.get("x-from-config")).toBe("1");
    expect(seenHeaders?.get("x-rule-order")).toBe("second");
  });

  test("does not apply request header rules to locally rejected requests", async () => {
    let fetchCalled = false;
    const handler = createHandler(
      {
        denylist: [/^https:\/\/example\.com\/private/],
        requestHeaderRules: [
          {
            url: /^https:\/\/example\.com\//,
            methods: ["GET"],
            headers: {
              authorization: "Bearer token",
            },
          },
        ],
      },
      async () => {
        fetchCalled = true;
        return new Response("proxied");
      },
    );

    const response = await handler(new Request("http://proxy.test/https://example.com/private"));

    expect(response.status).toBe(403);
    expect(fetchCalled).toBe(false);
  });

  test("applies request header rules independently for rewritten redirect targets", async () => {
    const seen: Array<[string, string | null]> = [];
    const handler = createHandler(
      {
        allowlist: [
          /^https:\/\/github\.com\//,
          /^https:\/\/codeload\.github\.com\//,
        ],
        requestHeaderRules: [
          {
            url: /^https:\/\/codeload\.github\.com\//,
            methods: ["GET"],
            headers: {
              authorization: "Bearer token",
            },
          },
        ],
      },
      async (input, init) => {
        seen.push([input.toString(), new Headers(init?.headers).get("authorization")]);

        if (input.toString() === "https://github.com/owner/repo/archive.zip") {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://codeload.github.com/owner/repo/zip/main",
            },
          });
        }

        return new Response("zip");
      },
    );

    await handler(new Request("http://proxy.test/https://github.com/owner/repo/archive.zip"));
    await handler(new Request("http://proxy.test/https://codeload.github.com/owner/repo/zip/main"));

    expect(seen).toEqual([
      ["https://github.com/owner/repo/archive.zip", null],
      ["https://codeload.github.com/owner/repo/zip/main", "Bearer token"],
    ]);
  });

  test("rewrites allowed redirect locations to the configured proxy path", async () => {
    const seenTargets: string[] = [];
    const handler = createHandler(
      {
        proxyPath: "/yahps",
        allowlist: [
          /^https:\/\/github\.com\/owner\/repo\/archive\//,
          /^https:\/\/github\.com\/owner\/repo\/releases\//,
        ],
      },
      async (input) => {
        seenTargets.push(input.toString());
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://github.com/owner/repo/releases/download/v1/file.zip",
          },
        });
      },
    );

    const response = await handler(
      new Request("http://proxy.test/yahps/https://github.com/owner/repo/archive/refs/heads/main.zip"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/yahps/https://github.com/owner/repo/releases/download/v1/file.zip",
    );
    expect(response.headers.get("x-proxy-target")).toBe(
      "https://github.com/owner/repo/archive/refs/heads/main.zip",
    );
    expect(seenTargets).toEqual([
      "https://github.com/owner/repo/archive/refs/heads/main.zip",
    ]);
  });

  test("rewrites allowed codeload redirects instead of exposing the upstream location", async () => {
    const seenTargets: string[] = [];
    const handler = createHandler(
      {
        allowlist: [
          /^https:\/\/github\.com\//,
          /^https:\/\/codeload\.github\.com\//,
        ],
      },
      async (input) => {
        seenTargets.push(input.toString());

        if (input.toString() === "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip") {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://codeload.github.com/MetaCubeX/metacubexd/zip/refs/heads/gh-pages",
            },
          });
        }

        throw new Error(`unexpected fetch: ${input.toString()}`);
      },
    );

    const response = await handler(
      new Request("http://proxy.test/https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/https://codeload.github.com/MetaCubeX/metacubexd/zip/refs/heads/gh-pages",
    );
    expect(response.headers.get("x-proxy-target")).toBe(
      "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip",
    );
    expect(seenTargets).toEqual([
      "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip",
    ]);
  });

  test("resolves and rewrites relative redirect locations against the current target", async () => {
    const seenTargets: string[] = [];
    const handler = createHandler({}, async (input) => {
      seenTargets.push(input.toString());

      if (input.toString() === "https://example.com/downloads/archive.zip") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "../files/archive.zip",
          },
        });
      }

      throw new Error(`unexpected fetch: ${input.toString()}`);
    });

    const response = await handler(
      new Request("http://proxy.test/https://example.com/downloads/archive.zip"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/https://example.com/files/archive.zip");
    expect(response.headers.get("x-proxy-target")).toBe("https://example.com/downloads/archive.zip");
    expect(seenTargets).toEqual([
      "https://example.com/downloads/archive.zip",
    ]);
  });

  test("keeps redirect responses with missing or malformed Location headers", async () => {
    const missingLocationHandler = createHandler({}, async () =>
      new Response("missing location", {
        status: 302,
      }),
    );
    const malformedLocationHandler = createHandler({}, async () =>
      new Response("malformed location", {
        status: 302,
        headers: {
          location: "https://[invalid",
        },
      }),
    );

    const missingLocationResponse = await missingLocationHandler(
      new Request("http://proxy.test/https://example.com/missing-location"),
    );
    const malformedLocationResponse = await malformedLocationHandler(
      new Request("http://proxy.test/https://example.com/malformed-location"),
    );

    expect(missingLocationResponse.status).toBe(302);
    expect(await responseText(missingLocationResponse)).toBe("missing location");
    expect(malformedLocationResponse.status).toBe(302);
    expect(await responseText(malformedLocationResponse)).toBe("malformed location");
  });

  test("rejects redirect targets that miss allowlist without fetching them", async () => {
    const seenTargets: string[] = [];
    const handler = createHandler(
      {
        allowlist: [/^https:\/\/allowed\.example\//],
        localRejectionResponse: {
          status: 404,
          body: "Not Found.",
        },
      },
      async (input) => {
        seenTargets.push(input.toString());
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://blocked.example/file.zip",
          },
        });
      },
    );

    const response = await handler(
      new Request("http://proxy.test/https://allowed.example/file.zip"),
    );

    expect(response.status).toBe(404);
    expect(await responseText(response)).toBe("Not Found.");
    expect(seenTargets).toEqual(["https://allowed.example/file.zip"]);
  });

  test("rejects redirect targets that match denylist without fetching them", async () => {
    const seenTargets: string[] = [];
    const handler = createHandler(
      {
        denylist: [/^https:\/\/blocked\.example\//],
      },
      async (input) => {
        seenTargets.push(input.toString());
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://blocked.example/file.zip",
          },
        });
      },
    );

    const response = await handler(
      new Request("http://proxy.test/https://allowed.example/file.zip"),
    );

    expect(response.status).toBe(403);
    expect(await responseText(response)).toBe("Blocked by denylist.");
    expect(seenTargets).toEqual(["https://allowed.example/file.zip"]);
  });

  test("rejects redirect targets with unsupported schemes without fetching them", async () => {
    const seenTargets: string[] = [];
    const handler = createHandler(
      {
        localRejectionResponse: {
          status: 418,
          body: "Use HTTP.",
        },
      },
      async (input) => {
        seenTargets.push(input.toString());
        return new Response(null, {
          status: 302,
          headers: {
            location: "ftp://example.com/file.zip",
          },
        });
      },
    );

    const response = await handler(
      new Request("http://proxy.test/https://allowed.example/file.zip"),
    );

    expect(response.status).toBe(418);
    expect(await responseText(response)).toBe("Use HTTP.");
    expect(seenTargets).toEqual(["https://allowed.example/file.zip"]);
  });

  test("rewrites one redirect hop per request", async () => {
    let fetchCount = 0;
    const handler = createHandler({}, async () => {
      fetchCount += 1;
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://example.com/loop",
        },
      });
    });

    const response = await handler(new Request("http://proxy.test/https://example.com/loop"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/https://example.com/loop");
    expect(fetchCount).toBe(1);
  });

  test("rewrites HEAD redirects without adding a body", async () => {
    const methods: string[] = [];
    const handler = createHandler({}, async (input, init) => {
      methods.push(init?.method ?? "");

      if (input.toString() === "https://example.com/archive.zip") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://example.com/final.zip",
          },
        });
      }

      throw new Error(`unexpected fetch: ${input.toString()}`);
    });

    const response = await handler(
      new Request("http://proxy.test/https://example.com/archive.zip", { method: "HEAD" }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/https://example.com/final.zip");
    expect(await responseText(response)).toBe("");
    expect(methods).toEqual(["HEAD"]);
  });

  test("rewrites non-GET and non-HEAD redirects without replaying the request body", async () => {
    let fetchCount = 0;
    const handler = createHandler({}, async () => {
      fetchCount += 1;
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://example.com/final",
        },
      });
    });

    const response = await handler(
      new Request("http://proxy.test/https://example.com/post", {
        method: "POST",
        body: "payload",
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/https://example.com/final");
    expect(fetchCount).toBe(1);
  });
});
