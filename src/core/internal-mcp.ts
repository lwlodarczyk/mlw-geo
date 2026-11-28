// Worker-to-worker MCP access for shoper-growth-mcp (our own server), without the OAuth consent flow.
// POST /internal/mcp with X-Seed-Secret: the same shared secret that already gates /admin/*, which can do more
// (seed brands, run scans). The request is handed to the hosted /mcp handler on the canonical host.

// Constant-time string comparison so the secret check doesn't leak
// match-prefix length through response timing. (Length inequality still
// short-circuits, which is fine — the length of a high-entropy secret
// is not useful to an attacker.)
export function safeEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** null: not an internal call. Response: refused. Request: forward to the hosted /mcp handler. */
export function internalMcpRequest(request: Request, env: { SEED_SECRET?: string; SELF_URL?: string }): Request | Response | null {
  const url = new URL(request.url);
  if (url.pathname !== '/internal/mcp') return null;
  const provided = request.headers.get('X-Seed-Secret') ?? '';
  if (!env.SEED_SECRET || !safeEquals(provided, env.SEED_SECRET)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const headers = new Headers(request.headers);
  headers.delete('X-Seed-Secret');
  // duplex: Node needs it for a streamed body; Workers ignore it.
  return new Request(new URL('/mcp', env.SELF_URL || url.origin), { method: request.method, headers, body: request.body, duplex: 'half' } as RequestInit);
}
