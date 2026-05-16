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
});
