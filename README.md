# @vbcdx/coolify-plugin

An MCP server for a **bounded, write-controlled** subset of the [Coolify](https://coolify.io)
v4 API. Contract `vbcdx.coolify/1`. It gives an agent per-call credential-file
selection, a fixed catalog of 27 tools, honest result reporting, and explicit
accidental-write controls.

> This README covers what the package needs to be installed and run. Exhaustive
> tool-by-tool documentation and independent runtime verification are tracked
> separately.

## What it is (and is not)

Coolify ships a native MCP endpoint. This package deliberately adds per-call
credential-file selection, a bounded catalog, and an accidental-write interlock.
It does **not** replace every native capability or provide stronger authorization
than the OS and the service token allow. Native endpoint enablement,
infrastructure provisioning, backup/restore, arbitrary shell/API calls,
private-key/cloud-token management, and rollback/pin-to-SHA are **out of scope in
v1**.

## Coolify's native MCP server

Coolify has shipped its own MCP server since **v4.1.0** (18 May 2026), which added
instance-level MCP with read-only tools over Coolify resources plus API/UI
enablement controls. **v4.2.0** (21 Jul 2026) added per-team MCP, and later 4.3.x
releases extended the tool surface (deploy and cancellation operations, gated by
token scope). Coolify's release cadence is its own; for the authoritative, current
capability list, follow the vendor docs rather than this README.

**Enabling it (self-hosted).** Settings → Configuration → Advanced → **API and
MCP**: enable **API access**, then set **MCP server** to **Enabled**. It must
*also* be enabled for the active team ("Enabled for this team" in that team's
settings). Coolify Cloud has instance MCP enabled already, with team access on by
default.

**Connecting.** Endpoint `https://<your-coolify-host>/mcp`, transport **Streamable
HTTP**, header `Authorization: Bearer <token>`. Tokens come from **Keys & Tokens →
API Tokens** while the target team is active. Scope the token to the least
privilege the client needs: `read` for inspection, `read:sensitive` for sensitive
values and log summaries, `deploy` for deploy/start/stop/restart/cancel. Coolify's
docs advise against using `root` for ordinary clients. A client denied by team
settings gets `403`; consult the docs for the current, exact failure modes.

- <https://coolify.io/docs/mcp/what-is-mcp>
- <https://coolify.io/docs/mcp/setup>

### Native MCP vs. this package

If you want direct, full-surface access to a Coolify instance from a single team's
token, and you trust the caller with whatever that token permits, **the native MCP
server is sufficient** — reach for it first. This package exists for a narrower
situation: several agents that each present their own credential file per call, a
fixed and auditable catalog rather than Coolify's evolving full surface, an
accidental-write interlock (`off` / `write` / `full`, plus a confirmation string on
destructive tools), and result envelopes that refuse to over-claim an unverified
outcome. It deliberately covers *less* than native MCP; use it when per-call
credential isolation and write-blast-radius control matter more than breadth.

## Requirements

- Node.js **>= 22** (tested on Node 22 and 24).
- Runnable JavaScript, no build step. One runtime dependency: the maintained
  `@modelcontextprotocol/sdk` (pinned).

## Install

This package is not yet published to a public npm registry. Once a version is
published and tested, the supported install will be:

```sh
npm install @vbcdx/coolify-plugin
```

Until then, install a packed, reviewed artifact into a clean prefix and register
the absolute entrypoint. From an immutable reviewed commit of your own checkout or
mirror:

```sh
npx --yes --package='<git-remote-url>#<reviewed-commit>' vbcdx-coolify mcp
```

Substitute your git remote and the delivered commit, not a moving branch. An npm
name/version launch command is advertised only after that version is published to
a registry and tested.


## Network mode (`serve`): MCP over Streamable HTTP

`vbcdx-coolify serve` runs the same finite tool catalogue as an MCP server over the
**Streamable HTTP** transport (stateless: a fresh server per request), for hosts that
cannot run the stdio companion next to the agent — e.g. an MCP gateway (LiteLLM
`true_passthrough`) or a harness container without Node.js.

```sh
VBCDX_COOLIFY_URL=https://coolify.example \
VBCDX_COOLIFY_WRITES=off \
npx vbcdx-coolify serve
# → MCP endpoint:  POST http://0.0.0.0:8080/mcp
# → liveness:      GET  http://0.0.0.0:8080/healthz
```

**Credentials per request, by header.** There is no credential file and no
`credential_file` argument in this mode — the tool schemas drop it. The Coolify API
token arrives in `Authorization: Bearer <token>` (or `token <token>`), is used for that
one request, registered with the redactor and never cached or logged. Coolify has no
password authentication, so there is no Basic scheme. Tool discovery works without a
credential; a call without one returns a redacted `credential_missing` refusal before
any Coolify request. The gate order (inputs → write gate → confirmation → server
config → credential → HTTP), the write gate and the destructive confirmation are
identical to stdio.

A `POST /mcp` body larger than 1 MiB is refused with `413` before it is buffered
(checked against `Content-Length` and, for chunked bodies, while reading); a body
that is not JSON gets `400`. Both happen before any credential check or Coolify
request.

| Setting | Meaning |
| --- | --- |
| `VBCDX_COOLIFY_HTTP_PORT` | Listen port (default `8080`). |
| `VBCDX_COOLIFY_HTTP_HOST` | Bind address (default `0.0.0.0`). `healthcheck` always probes `127.0.0.1`, so a specific non-loopback address makes the container report unhealthy; keep `0.0.0.0` (or a loopback address) in a container. |
| `VBCDX_COOLIFY_TLS_CERT` / `VBCDX_COOLIFY_TLS_KEY` | Serve HTTPS directly (both or neither). |

**Container.** `Dockerfile` builds `vbcdx-coolify serve` on a pinned Node 22 Alpine
image as the unprivileged `node` user, with a `HEALTHCHECK` (`vbcdx-coolify
healthcheck`, which probes `127.0.0.1:<port>/healthz`). No credential is baked into
any layer. Plain HTTP is for trusted networks only; put TLS in front otherwise.

## Configuration (environment only)

The server takes **no** secret, URL, role, or credential CLI options.
Configuration comes from the environment:

| Variable | Meaning |
| --- | --- |
| `VBCDX_COOLIFY_URL` | Coolify instance URL. Required for any API call. An optional deployment path prefix and an optional trailing `/api/v1` are accepted; the API suffix is appended exactly once. Userinfo/query/fragment are rejected. Plain HTTP is allowed on a trusted network (noted once); TLS verification is never disabled. |
| `VBCDX_COOLIFY_WRITES` | `off` (default), `write`, or `full`. `off` permits reads only; `write` also permits ordinary configuration/deploy writes; `full` additionally permits destructive tools. An invalid value behaves as `off`. |
| `VBCDX_COOLIFY_TIMEOUT_MS` | Total per-call budget, integer 1000–120000 (default 30000). Spans the credential read, any preflight, the mutation, and verification. |

## Credentials

Every tool except public `health` takes an explicit absolute `credential_file`
argument at call time. The file is read fresh on each call (one snapshot per call
so a rotation cannot switch identity midway). There is no token/URL/role option,
directory scan, home-directory search, ambient secret, or between-call cache.

The file must be a regular, non-symlink file owned by you at mode `0600`, in an
immediate parent directory owned by you at mode `0700`, with no symlink component
in the path. It contains `VBCDX_AGENTS_ROLE` (descriptive) and a nonblank
`VBCDX_AGENTS_TOKEN`. The token is sent as `Authorization: Bearer <token>`;
Coolify has no password fallback. See
[`examples/credential-file.env.example`](examples/credential-file.env.example).
Every environment variable the server reads is listed in [`.env.example`](.env.example).

Token permissions (`read`, `read:sensitive`, `write`, `deploy`, `root`) are the
token's, scoped to its team and role. A deploy-only token is legitimate. The
server never infers permission from the role, decodes token authority, or retries
a 403 with another identity.

## Commands

```sh
vbcdx-coolify mcp        # stdio MCP server (protocol frames on stdout; diagnostics on stderr)
vbcdx-coolify manifest   # deterministic nonsecret JSON tool contract (no network, no credential reads)
vbcdx-coolify --help
vbcdx-coolify --version
```

Unknown commands or options exit `2`.

## Registration

The MCP identity is `coolify`. See
[`examples/mcp-registration.md`](examples/mcp-registration.md) for Claude Code,
Codex, OpenCode, and DSH. The tool catalog is discoverable without credentials; a
call without credentials returns an actionable error, not a crash.

## Write controls and honest results

- Every tool declares an effect: `read`, `write`, or `destructive`. Gates run
  before any file read or HTTP call, and all tools remain listed even when
  disabled.
- Destructive tools (`restart_application`, `stop_application`,
  `cancel_deployment`, `delete_application_env`, `delete_application`) require
  `VBCDX_COOLIFY_WRITES=full` and an exact confirmation string that binds the
  normalized target and options. The confirmation is an **accident interlock**,
  not proof of human approval, and is never sent upstream.
- Results never over-claim. HTTP status is checked before body shape (a `403`
  with `success:true` is a failure). A `2xx` alone is not completion. A read never
  turns an error into an empty list. A mutation whose outcome cannot be confirmed
  is `unverified` or `indeterminate` and is **never** replayed.

Each result carries `outcome`, `effect`, `request:{method,path,attempted}`,
`verification`, and — for failures — a fixed `reason` and a secret-free `message`.

## Tool catalog (27)

Reads (17): `health`, `version`, `list_applications`, `get_application`,
`get_application_logs`, `list_application_envs`, `list_databases`, `get_database`,
`list_services`, `get_service`, `list_projects`, `get_project`, `list_servers`,
`get_server`, `list_resources`, `list_deployments`, `get_deployment`.

Writes (5): `create_application`, `deploy`, `start_application`,
`create_application_env`, `update_application_env`.

Destructive (5): `restart_application`, `stop_application`, `cancel_deployment`,
`delete_application_env`, `delete_application`.

Run `vbcdx-coolify manifest` for the exact input/output schemas, effects, and
required permissions.

## Development

```sh
npm ci
npm test        # node --test; route-level fixtures, adversarial cases, no network
```

## Continuous integration

CI (`.forgejo/workflows/ci.yml`) runs on a self-hosted runner chosen by the
`CI_RUNNER_LABEL` repository (or org) variable, so the runner's label is not
baked into the published source. If you fork this repo and run its Forgejo
workflows, set `CI_RUNNER_LABEL` to a label your runner advertises (for a
GitHub-parity self-hosted runner, `self-hosted`). If it is left unset the jobs
are silently skipped — an empty `runs-on` matches no runner.

## License

MIT — see [`LICENSE`](LICENSE).
