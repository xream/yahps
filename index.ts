import { dirname, resolve as resolvePath } from "node:path";
import { createProxyFetchHandler, loadConfig, normalizeConfig } from "./proxy";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_CONFIG_FILENAME = "config.js";

const portEnv = Number(process.env.PORT ?? DEFAULT_PORT);
const port = Number.isFinite(portEnv) ? portEnv : DEFAULT_PORT;
const hostEnv = process.env.HOST?.trim();
const host = hostEnv ? hostEnv : DEFAULT_HOST;
const execPath = process.execPath ?? Bun.argv[0] ?? process.argv[0];
const execDir = execPath ? dirname(execPath) : process.cwd();
const defaultConfigPath = resolvePath(execDir, DEFAULT_CONFIG_FILENAME);
const configPath = process.env.CONFIG ? resolvePath(process.env.CONFIG) : defaultConfigPath;
const config = normalizeConfig(await loadConfig(configPath));

const server = Bun.serve({
  hostname: host,
  port,
  fetch: createProxyFetchHandler(config),
});

console.log(`Forward proxy listening on ${server.url}`);
console.log(`Config path: ${configPath}`);
