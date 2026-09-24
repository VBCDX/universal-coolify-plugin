// Per-request credential resolution for the network transport (issue #22).
//
// The stdio server reads a credential *file*; the network server instead takes
// the Coolify API token from the request's `Authorization` header — one header,
// one token, resolved fresh for every request and never cached. It returns the
// same `{ role, token }` shape readCredentialFile returns, so nothing downstream
// changes. Coolify has no password authentication, so only the Bearer (or
// `token`) scheme is accepted; there is no Basic.
//
// The token is registered with the redactor exactly like a file token (the
// registry unregisters it when the call ends). No part of the header value is
// ever echoed in an error: a malformed header could put the secret where a scheme
// name is expected.

import { RefusedError } from './envelope.js';
import { registerSecret } from './redact.js';

const GUIDANCE =
  ' Supply the Coolify API token per request: Authorization: Bearer <token>. No Coolify request was attempted.';

/**
 * @param {string|undefined} headerValue raw Authorization header value
 * @returns {{ role: null, token: string }}
 * @throws {RefusedError} credential_missing | credential_malformed
 */
export function credentialFromHeader(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw new RefusedError('credential_missing', 'No Authorization header was provided.' + GUIDANCE);
  }
  const trimmed = headerValue.trim();
  const sp = trimmed.indexOf(' ');
  const scheme = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const token = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  if (scheme !== 'bearer' && scheme !== 'token') {
    throw new RefusedError('credential_malformed', 'Unsupported Authorization scheme; use Bearer.' + GUIDANCE);
  }
  if (token === '' || /[\s\x00-\x1f\x7f]/.test(token)) {
    throw new RefusedError('credential_malformed', 'The Authorization header did not carry a single token value.' + GUIDANCE);
  }
  registerSecret(token);
  return { role: null, token };
}
