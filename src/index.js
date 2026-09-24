// Programmatic entry points. The package is primarily a CLI/MCP server, but the
// registry, manifest, and server are exported for tests and for DSH's in-process
// use where applicable.

export { listTools, executeTool, toolCount, hasTool } from './registry.js';
export { buildManifest, manifestJson } from './manifest.js';
export { startServer } from './server.js';
export { runHttpServer, httpHealthcheck, loadHttpOptions, DEFAULT_HTTP_PORT } from './httpserver.js';
export { credentialFromHeader } from './credential-header.js';
export { loadConfig, normalizeCoolifyUrl } from './config.js';
export { CONTRACT, SERVICE, SCHEMA_VERSION } from './contract.js';
export { packageVersion } from './version.js';
