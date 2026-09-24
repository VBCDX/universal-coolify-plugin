// The `serve` command: a network-served MCP server (issue #22; port of
// forgejo-plugin's network mode, VBCDX/forgejo-plugin#10).
//
// Transport is MCP Streamable HTTP (responses streamed as Server-Sent Events) in
// stateless mode: a fresh MCP server and transport per request, so there is no
// process-wide session or credential state between requests.
//
// The Coolify API token arrives per request in the Authorization header, is
// resolved for that one request (credential-header.js) and is never cached or
// logged. Tool discovery works with no credential; an uncredentialed call returns
// a redacted, actionable refusal. The gate order, write gate, destructive
// confirmation, finite catalogue and redaction are identical to stdio — only the
// transport and the credential source change.

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CONTRACT, SERVICE } from './contract.js';
import { loadConfig } from './config.js';
import { executeTool, listTools, toolCount } from './registry.js';
import { credentialFromHeader } from './credential-header.js';
import { packageVersion } from './version.js';

export const DEFAULT_HTTP_PORT = 8080;
// Largest POST /mcp body accepted. The biggest tool argument is an env value or a
// compose snippet; 1 MiB is ample. The body is read before any credential is
// checked, so without a cap any caller could make the process buffer an
// arbitrarily large payload (PR #23 review, issue #24).
export const MAX_BODY_BYTES = 1024 * 1024;
const MCP_PATH = '/mcp';
const HEALTH_PATH = '/healthz';

function stderrLog(msg) {
  process.stderr.write(`[coolify-mcp] ${msg}\n`);
}

/** Network options from the environment. Credentials are deliberately absent. */
export function loadHttpOptions(env = process.env) {
  const trimmed = (k) => (env[k] !== undefined && String(env[k]).trim() !== '' ? String(env[k]).trim() : null);
  let port = DEFAULT_HTTP_PORT;
  let portError = null;
  const rawPort = trimmed('VBCDX_COOLIFY_HTTP_PORT');
  if (rawPort !== null) {
    if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
      portError = 'VBCDX_COOLIFY_HTTP_PORT must be an integer between 1 and 65535.';
    } else {
      port = Number(rawPort);
    }
  }
  return {
    port,
    host: trimmed('VBCDX_COOLIFY_HTTP_HOST') || '0.0.0.0',
    certPath: trimmed('VBCDX_COOLIFY_TLS_CERT'),
    keyPath: trimmed('VBCDX_COOLIFY_TLS_KEY'),
    portError,
  };
}

/**
 * Probe the local /healthz endpoint (container HEALTHCHECK and `healthcheck`).
 * Over TLS the loopback probe tolerates a self-signed certificate; this never
 * affects the outbound Coolify connection, whose TLS verification is unchanged.
 * @returns {Promise<boolean>}
 */
export function httpHealthcheck({ env = process.env } = {}) {
  const { port, certPath, keyPath } = loadHttpOptions(env);
  const tls = !!(certPath && keyPath);
  const lib = tls ? https : http;
  const options = { host: '127.0.0.1', port, path: HEALTH_PATH, method: 'GET', timeout: 3000 };
  if (tls) options.rejectUnauthorized = false; // loopback self-check only
  return new Promise((resolve) => {
    const req = lib.request(options, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function toolListPayload() {
  return listTools({ transport: 'http' }).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: { readOnlyHint: t.effect === 'read', destructiveHint: t.effect === 'destructive' },
    _meta: { 'vbcdx.coolify/effect': t.effect, 'vbcdx.coolify/required_permissions': t.required_permissions },
  }));
}

function buildServer({ env, authHeader, shutdownSignal }) {
  const server = new Server({ name: `@vbcdx/coolify-plugin (${SERVICE})`, version: packageVersion() }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolListPayload() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const signal = extra?.signal ? AbortSignal.any([extra.signal, shutdownSignal]) : shutdownSignal;
    return executeTool(name, args || {}, {
      env,
      signal,
      transport: 'http',
      resolveCredential: () => credentialFromHeader(authHeader),
    });
  });
  return server;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendJsonRpcError(res, status, code, message, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

class BodyTooLarge extends Error {}

/**
 * Read the request body, refusing past MAX_BODY_BYTES: up front from
 * Content-Length, and while streaming for chunked bodies that carry none.
 * Only the capped bytes are ever buffered.
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return Promise.reject(new BodyTooLarge());
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.off('data', onData);
        req.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

async function handle(req, res, { env, shutdownController }) {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === HEALTH_PATH) {
    return sendJson(res, 200, { status: 'ok', service: SERVICE, contract: CONTRACT, tools: toolCount() });
  }
  if (path !== MCP_PATH) {
    return sendJson(res, 404, { error: 'not_found', message: `Use POST ${MCP_PATH} or GET ${HEALTH_PATH}.` });
  }
  // Stateless Streamable HTTP: only POST carries a request (no server stream, no session).
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJsonRpcError(res, 405, -32000, `Method not allowed. Use POST ${MCP_PATH}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (err) {
    // close the connection: the rest of an oversized body is never read
    if (err instanceof BodyTooLarge) {
      return sendJsonRpcError(res, 413, -32000, `Request body exceeds ${MAX_BODY_BYTES} bytes.`, { connection: 'close' });
    }
    return sendJsonRpcError(res, 400, -32700, 'Parse error: the request body is not valid JSON.');
  }
  const server = buildServer({ env, authHeader: req.headers.authorization, shutdownSignal: shutdownController.signal });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  // The capped, parsed body is handed over, so the SDK never reads the request itself.
  // Nothing here logs a header value or the body.
  await transport.handleRequest(req, res, parsed);
}

// Any thrown error becomes a generic 500, never an unhandled rejection or a leaked stack.
function wrap(ctx) {
  return (req, res) => {
    handle(req, res, ctx).catch(() => {
      if (ctx.log) ctx.log('request handling error (details withheld).');
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error.');
      else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
  };
}

/**
 * Start the network-served MCP server.
 * @returns {Promise<{ server: import('node:http').Server, port: number, close: () => Promise<void> }>}
 */
export async function runHttpServer({ env = process.env, http: httpOpts = loadHttpOptions(env), log = stderrLog, installSignals = true } = {}) {
  if (httpOpts.portError) throw new Error(httpOpts.portError);
  if (!!httpOpts.certPath !== !!httpOpts.keyPath) {
    throw new Error('TLS requires both VBCDX_COOLIFY_TLS_CERT and VBCDX_COOLIFY_TLS_KEY, or neither.');
  }
  const shutdownController = new AbortController();
  const ctx = { env, shutdownController, log };
  let listener;
  let tls = false;
  if (httpOpts.certPath) {
    let cert;
    let key;
    try {
      cert = readFileSync(httpOpts.certPath);
      key = readFileSync(httpOpts.keyPath);
    } catch {
      throw new Error('TLS certificate or key could not be read from the configured paths.');
    }
    listener = https.createServer({ cert, key }, wrap(ctx));
    tls = true;
  } else {
    listener = http.createServer(wrap(ctx));
  }
  const config = loadConfig(env);
  if (config.insecure) log('VBCDX_COOLIFY_URL uses plain HTTP; proceeding on the assumption of a trusted network.');
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(httpOpts.port, httpOpts.host, () => {
      listener.removeListener('error', reject);
      resolve();
    });
  });
  const boundPort = listener.address().port;
  log(`ready: MCP over Streamable HTTP at ${tls ? 'https' : 'http'}://${httpOpts.host}:${boundPort}${MCP_PATH} — ${toolCount()} tools, writes=${config.writes} (contract ${CONTRACT}).`);
  if (!tls) log('serving plain HTTP; put a TLS-terminating proxy in front or run only on a trusted network.');
  const close = async () => {
    shutdownController.abort();
    await new Promise((resolve) => listener.close(() => resolve()));
  };
  if (installSignals) {
    const shutdown = () => close().finally(() => process.exit(0));
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
  return { server: listener, port: boundPort, close };
}
