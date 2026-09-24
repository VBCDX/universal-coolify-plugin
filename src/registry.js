// Tool registry and execution harness.
//
// One registry is the single source for the tool catalog, the manifest, and the
// runtime. There are no hand-maintained parallel lists — the count and the schemas
// come from here, so a new tool cannot be registered without also appearing in the
// manifest and the tests that read the registry.
//
// Gate order (§4, §5): validate inputs → write gate → confirmation → server
// config → credential file → HTTP. Gates run before any file read or network
// call, so a disabled write or a bad confirmation never touches the credential
// file or the instance.

import { readTools } from './tools/reads.js';
import { writeTools } from './tools/writes.js';
import { destructiveTools } from './tools/destructive.js';
import { envelopeSchema } from './tools/common.js';
import { loadConfig } from './config.js';
import { readCredentialFile } from './credential.js';
import { validateArgs } from './validate.js';
import { RefusedError, refused, req, toMcpResult } from './envelope.js';
import { unregisterSecret } from './redact.js';
import { CoolifyClient, createDeadline } from './http.js';

const CREDENTIAL_FILE_FIELD = {
  type: 'string',
  description: 'Absolute path to the credential file (mode 0600, in a 0700 parent) holding VBCDX_AGENTS_ROLE and VBCDX_AGENTS_TOKEN.',
};

/**
 * Assemble the full tool list. Non-public tools get an explicit credential_file
 * input; the input and output schemas are finalized here so the manifest and the
 * runtime share exactly one definition per tool.
 */
function buildTools() {
  const raw = [...readTools, ...writeTools, ...destructiveTools];
  const tools = raw.map((tool) => {
    const inputSchema = withCredentialFile(tool);
    return {
      ...tool,
      inputSchema,
      outputSchema: envelopeSchema(tool.dataSchema || {}),
    };
  });
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

function withCredentialFile(tool) {
  if (tool.publicRoute) return tool.inputSchema;
  const schema = tool.inputSchema;
  const properties = { ...schema.properties, credential_file: CREDENTIAL_FILE_FIELD };
  const required = Array.from(new Set([...(schema.required || []), 'credential_file']));
  return { ...schema, properties, required };
}

const TOOLS = buildTools();
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Over the network transport the credential arrives in the Authorization header,
// so the per-tool credential_file argument is neither required nor accepted.
// Derived once per tool; the stdio catalogue (and the manifest) are untouched.
const HTTP_INPUT = new Map(
  TOOLS.map((t) => {
    const properties = { ...t.inputSchema.properties };
    delete properties.credential_file;
    const required = (t.inputSchema.required || []).filter((r) => r !== 'credential_file');
    return [t.name, { ...t.inputSchema, properties, required }];
  }),
);

/**
 * Public tool metadata for tools/list and the manifest.
 * @param {{ transport?: 'stdio'|'http' }} [opts] http = schemas without credential_file
 */
export function listTools({ transport = 'stdio' } = {}) {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: transport === 'http' ? HTTP_INPUT.get(t.name) : t.inputSchema,
    outputSchema: t.outputSchema,
    effect: t.effect,
    required_permissions: t.permissions,
  }));
}

/** @returns {number} the tool count. */
export function toolCount() {
  return TOOLS.length;
}

/** @param {string} name */
export function hasTool(name) {
  return BY_NAME.has(name);
}

/** Compute the nonsecret reported path for a refusal envelope. */
function reportedPath(config, tool, args) {
  let route;
  try {
    route = tool.route ? tool.route(args || {}) : { method: 'POST', segments: [tool.name] };
  } catch {
    route = { method: 'POST', segments: [tool.name] };
  }
  const base = config.apiBase || 'http://unconfigured.invalid/api/v1';
  const client = new CoolifyClient({ apiBase: base });
  return { method: route.method, path: client.pathFor(route.segments, route.query || {}) };
}

function refusalRequest(config, tool, args) {
  const { method, path } = reportedPath(config, tool, args);
  return req(method, path, false);
}

/**
 * Execute a tool call and return an MCP tool result. Never throws for an expected
 * failure — those come back as isError:true envelopes.
 *
 * @param {string} name
 * @param {Record<string, unknown>} rawArgs
 * @param {{ env?: Record<string,string|undefined>, signal?: AbortSignal,
 *   resolveCredential?: () => { role: string|null, token: string },
 *   transport?: 'stdio'|'http' }} [ctx]
 *   resolveCredential: alternative credential source (network header mode). It
 *   runs at the same gate position as the credential file read (after the write
 *   and confirmation gates and the server-config check). transport 'http'
 *   validates against the schema without credential_file.
 */
export async function executeTool(name, rawArgs, ctx = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) {
    // The server guards against unknown tools; this is a defensive fallback.
    return toMcpResult(refused('read', req('GET', '/', false), 'unsupported_operation', `Unknown tool "${name}".`));
  }
  const config = loadConfig(ctx.env || process.env);

  let deadline;
  let cred = null;
  try {
    // 1. Validate inputs.
    let args;
    try {
      args = validateArgs(ctx.transport === 'http' ? HTTP_INPUT.get(tool.name) : tool.inputSchema, rawArgs);
    } catch (err) {
      return refusalFrom(err, config, tool, rawArgs);
    }

    // 2. Write gate (before any file read or HTTP).
    if (tool.effect === 'write' && config.writes === 'off') {
      return toMcpResult(refused(tool.effect, refusalRequest(config, tool, args), 'write_gate_disabled',
        'Writes are disabled (VBCDX_COOLIFY_WRITES=off). Set it to "write" to allow this operation.'));
    }
    if (tool.effect === 'destructive' && config.writes !== 'full') {
      return toMcpResult(refused(tool.effect, refusalRequest(config, tool, args), 'write_gate_disabled',
        'Destructive operations require VBCDX_COOLIFY_WRITES=full.'));
    }

    // 3. Confirmation gate for destructive tools.
    if (tool.effect === 'destructive') {
      const expected = tool.confirmString(args);
      const supplied = typeof args.confirm === 'string' ? args.confirm.trim() : '';
      if (supplied === '') {
        return toMcpResult(refused(tool.effect, refusalRequest(config, tool, args), 'confirmation_required',
          `This destructive operation requires an exact confirmation string: "${expected}".`));
      }
      if (supplied !== expected) {
        return toMcpResult(refused(tool.effect, refusalRequest(config, tool, args), 'confirmation_mismatch',
          `The confirmation string does not match the target. Expected exactly: "${expected}".`));
      }
    }

    // 4. Server configuration.
    if (config.configError) {
      return toMcpResult(refused(tool.effect, refusalRequest(config, tool, args), config.configError.reason, config.configError.message));
    }
    if (!config.apiBase) {
      return toMcpResult(refused(tool.effect, refusalRequest(config, tool, args), 'server_not_configured',
        'VBCDX_COOLIFY_URL is not set; no Coolify request can be made.'));
    }

    // Start the shared deadline: it spans the credential read, preflight,
    // mutation, and verification.
    deadline = createDeadline(config.timeoutMs, ctx.signal);

    // 5. Credential (every tool except public health): the per-call file in stdio
    // mode, or the request's Authorization header in network mode.
    if (!tool.publicRoute) {
      try {
        cred = ctx.resolveCredential ? ctx.resolveCredential() : readCredentialFile(args.credential_file);
      } catch (err) {
        return refusalFrom(err, config, tool, args);
      }
    }

    // 6. Dispatch.
    const client = new CoolifyClient({ apiBase: config.apiBase, token: cred ? cred.token : undefined, deadline: deadline.deadline });
    const envelope = await tool.run({ args, client, cred, config });
    return toMcpResult(envelope);
  } finally {
    if (deadline) deadline.dispose();
    if (cred) unregisterSecret(cred.token);
  }
}

function refusalFrom(err, config, tool, args) {
  if (err instanceof RefusedError) {
    return toMcpResult(refused(tool.effect, refusalRequest(config, tool, args), err.reason, err.message, { evidence: err.evidence }));
  }
  throw err;
}
