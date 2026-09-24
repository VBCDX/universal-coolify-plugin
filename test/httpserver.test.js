// Network mode (serve): issue #22. Real MCP HTTP client against runHttpServer on an
// ephemeral port, with the programmable mock Coolify from helpers.js as upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'node:http';
import { runHttpServer, MAX_BODY_BYTES } from '../src/httpserver.js';
import { runCli } from '../src/cli.js';
import { listTools } from '../src/registry.js';
import { mockCoolify, envelopeOf } from './helpers.js';

const TOKEN = 'SECRET-coolify-token-xyz789';

async function withServe(routes, fn, { writes = 'off' } = {}) {
  const mock = await mockCoolify(routes);
  const env = { VBCDX_COOLIFY_URL: mock.url, VBCDX_COOLIFY_WRITES: writes };
  const logs = [];
  const srv = await runHttpServer({ env, http: { port: 0, host: '127.0.0.1', certPath: null, keyPath: null }, log: (m) => logs.push(m), installSignals: false });
  const base = `http://127.0.0.1:${srv.port}`;
  const client = async (authorization) => {
    const headers = authorization ? { Authorization: authorization } : {};
    const c = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    return c;
  };
  try {
    await fn({ base, mock, client, logs, port: srv.port });
  } finally {
    await srv.close();
    await mock.close();
  }
}

test('serve: /healthz, 404 for other paths, 405 for GET /mcp', async () => {
  await withServe({}, async ({ base }) => {
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200);
    const body = await h.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.tools, listTools().length);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const g = await fetch(`${base}/mcp`);
    assert.equal(g.status, 405);
    assert.equal(g.headers.get('allow'), 'POST');
  });
});

test('serve: tools/list works without a credential and drops credential_file', async () => {
  await withServe({}, async ({ client }) => {
    const c = await client();
    const { tools } = await c.listTools();
    assert.equal(tools.length, listTools().length);
    for (const t of tools) {
      assert.equal(t.inputSchema.properties?.credential_file, undefined, t.name);
      assert.ok(!(t.inputSchema.required || []).includes('credential_file'), t.name);
    }
    await c.close();
  });
  // The stdio catalogue (and so the manifest) is unchanged.
  assert.ok(listTools().filter((t) => t.name !== 'health').every((t) => t.inputSchema.required.includes('credential_file')));
});

test('serve: a call without Authorization is refused before any Coolify request', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ client, mock }) => {
    const c = await client();
    const r = await c.callTool({ name: 'version', arguments: {} });
    assert.equal(r.isError, true);
    assert.equal(envelopeOf(r).reason, 'credential_missing');
    assert.equal(mock.requests.length, 0);
    await c.close();
  });
});

test('serve: a malformed or non-Bearer header is refused and never echoed', async () => {
  for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', `Bearer ${TOKEN} extra`]) {
    await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ client, mock }) => {
      const c = await client(header);
      const r = await c.callTool({ name: 'version', arguments: {} });
      assert.equal(r.isError, true, header);
      assert.equal(envelopeOf(r).reason, 'credential_malformed', header);
      assert.doesNotMatch(JSON.stringify(r), /dXNlcjpwYXNz|SECRET-coolify/);
      assert.equal(mock.requests.length, 0);
      await c.close();
    });
  }
});

test('serve: the Bearer token is forwarded upstream and never appears in results or logs', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2\n' } }, async ({ client, mock, logs }) => {
    const c = await client(`Bearer ${TOKEN}`);
    const r = await c.callTool({ name: 'version', arguments: {} });
    assert.notEqual(r.isError, true);
    assert.equal(envelopeOf(r).data.version, '4.1.2');
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.doesNotMatch(JSON.stringify(r), /SECRET-coolify/);
    assert.doesNotMatch(logs.join('\n'), /SECRET-coolify/);
    await c.close();
  });
});

test('serve: a credential_file argument is rejected over HTTP', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ client, mock }) => {
    const c = await client(`Bearer ${TOKEN}`);
    const r = await c.callTool({ name: 'version', arguments: { credential_file: '/etc/passwd' } });
    assert.equal(r.isError, true);
    assert.equal(mock.requests.length, 0);
    await c.close();
  });
});

test('serve: the write gate still runs first (writes=off refuses before the credential)', async () => {
  await withServe({}, async ({ client, mock }) => {
    const c = await client(); // no credential at all
    const r = await c.callTool({ name: 'start_application', arguments: { uuid: 'abc' } });
    assert.equal(r.isError, true);
    assert.equal(envelopeOf(r).reason, 'write_gate_disabled');
    assert.equal(mock.requests.length, 0);
    await c.close();
  });
});

test('cli: serve/healthcheck reject options; healthcheck probes a running serve', async () => {
  assert.equal(await runCli(['serve', '--port=1']), 2);
  assert.equal(await runCli(['healthcheck', 'x']), 2);
  await withServe({}, async ({ port }) => {
    const prev = process.env.VBCDX_COOLIFY_HTTP_PORT;
    process.env.VBCDX_COOLIFY_HTTP_PORT = String(port);
    try {
      assert.equal(await runCli(['healthcheck']), 0);
    } finally {
      if (prev === undefined) delete process.env.VBCDX_COOLIFY_HTTP_PORT;
      else process.env.VBCDX_COOLIFY_HTTP_PORT = prev;
    }
  });
});

test('serve: one server keeps each caller\'s token to its own request (never cached)', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ client, mock }) => {
    const a = await client('Bearer TOKEN-A');
    assert.notEqual((await a.callTool({ name: 'version', arguments: {} })).isError, true);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].headers.authorization, 'Bearer TOKEN-A');
    // the next caller sends no header: refused, and A's token is not reused
    const anon = await client();
    const r = await anon.callTool({ name: 'version', arguments: {} });
    assert.equal(envelopeOf(r).reason, 'credential_missing');
    assert.equal(mock.requests.length, 1);
    // a third caller with another token: upstream sees that token, not A's
    const b = await client('Bearer TOKEN-B');
    assert.notEqual((await b.callTool({ name: 'version', arguments: {} })).isError, true);
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1].headers.authorization, 'Bearer TOKEN-B');
    // and A again, after B
    assert.notEqual((await a.callTool({ name: 'version', arguments: {} })).isError, true);
    assert.equal(mock.requests[2].headers.authorization, 'Bearer TOKEN-A');
    for (const c of [a, anon, b]) await c.close();
  });
});

// Raw POST: resolves with the response even if the server closes before the
// whole body was sent (that is the point of the cap).
function rawPost(port, { chunks, contentLength }) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer TOKEN-A' };
    if (contentLength !== undefined) headers['content-length'] = String(contentLength);
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', () => resolve({ status: res.statusCode, body }));
    });
    let answered = false;
    req.on('response', () => { answered = true; });
    req.on('error', (err) => { if (!answered) reject(err); });
    (async () => {
      for (const c of chunks) {
        if (req.destroyed) return;
        if (!req.write(c)) {
          await new Promise((r) => {
            const done = () => { req.off('drain', done); req.off('close', done); r(); };
            req.once('drain', done);
            req.once('close', done);
          });
        }
      }
      if (!req.destroyed) req.end();
    })();
  });
}

test('serve: an oversized body is refused with 413 before any Coolify request', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ port, mock }) => {
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const n = Math.ceil((2 * MAX_BODY_BYTES) / chunk.length);
    const chunks = Array.from({ length: n }, () => chunk);
    // declared too large
    const declared = await rawPost(port, { chunks, contentLength: n * chunk.length });
    assert.equal(declared.status, 413);
    assert.equal(JSON.parse(declared.body).error.code, -32000);
    // chunked, no Content-Length: caught while streaming
    const streamed = await rawPost(port, { chunks });
    assert.equal(streamed.status, 413);
    assert.equal(mock.requests.length, 0);
  });
});

// Stream more than the cap and never end the request: only a server that refuses
// mid-stream answers. One that buffers until 'end' and then checks the size
// (the #24 bug in another form) never responds, and the bounded wait fails.
function postUnterminated(port, bytes, waitMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(result);
    };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer TOKEN-A' };
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => {
      res.resume();
      done({ status: res.statusCode, requestStillOpen: !req.writableEnded });
    });
    req.on('error', () => done({ status: null, error: true }));
    const timer = setTimeout(() => done({ status: null, timedOut: true }), waitMs);
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    (async () => {
      for (let sent = 0; sent < bytes && !settled; sent += chunk.length) {
        if (!req.write(chunk)) {
          await new Promise((r) => {
            const go = () => { req.off('drain', go); req.off('close', go); r(); };
            req.once('drain', go);
            req.once('close', go);
          });
        }
      }
      // deliberately no req.end()
    })();
  });
}

test('serve: an over-cap chunked body gets 413 while the request is still open', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ port, mock }) => {
    const r = await postUnterminated(port, MAX_BODY_BYTES + 64 * 1024, 3000);
    assert.equal(r.status, 413, `expected 413 before the request ended, got ${JSON.stringify(r)}`);
    assert.equal(r.requestStillOpen, true);
    assert.equal(mock.requests.length, 0);
  });
});

test('serve: a body under the cap still works; a non-JSON body gets 400', async () => {
  await withServe({ 'GET /api/v1/version': { text: '4.1.2' } }, async ({ port, mock }) => {
    const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'version', arguments: {} } });
    // padded with whitespace to just under the cap, so the limit is not off by a lot
    const body = Buffer.from(call + ' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(call)));
    assert.equal(body.length, MAX_BODY_BYTES);
    const ok = await rawPost(port, { chunks: [body], contentLength: body.length });
    assert.equal(ok.status, 200);
    assert.equal(mock.requests.length, 1);
    const bad = await rawPost(port, { chunks: [Buffer.from('{not json')] });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, -32700);
    assert.equal(mock.requests.length, 1);
  });
});

test('cli: healthcheck fails (exit 1) when nothing is listening', async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r)); // port now closed
  const prev = process.env.VBCDX_COOLIFY_HTTP_PORT;
  process.env.VBCDX_COOLIFY_HTTP_PORT = String(port);
  try {
    assert.equal(await runCli(['healthcheck']), 1);
  } finally {
    if (prev === undefined) delete process.env.VBCDX_COOLIFY_HTTP_PORT;
    else process.env.VBCDX_COOLIFY_HTTP_PORT = prev;
  }
});
