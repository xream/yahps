export default {
  proxyPath: "/yahps-secret-path",
  allowlist: [],
  denylist: [],
  userAgentAllowlist: [],
  userAgentDenylist: [],
  requestHeaderRules: [],
  localRejectionResponse: {
    status: 404,
    body: "Not Found.",
    headers: {
      "cache-control": "no-store",
    },
  },
};
