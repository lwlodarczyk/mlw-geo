import assert from 'node:assert/strict';
import test from 'node:test';
import { internalMcpRequest } from '../../src/core/internal-mcp.js';

const env = { SEED_SECRET: 's3cret', SELF_URL: 'https://mlw-geo.example.workers.dev' };
const req = (path: string, secret?: string) =>
  new Request(`https://anything.internal${path}`, {
    method: 'POST',
    headers: { host: 'localhost:8788', 'content-type': 'application/json', ...(secret === undefined ? {} : { 'X-Seed-Secret': secret }) },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });

test('other paths pass through to OAuth', () => {
  assert.equal(internalMcpRequest(req('/mcp', 's3cret'), env), null);
});

test('wrong, missing or unset secret is 401', async () => {
  for (const r of [internalMcpRequest(req('/internal/mcp', 'nope'), env), internalMcpRequest(req('/internal/mcp'), env), internalMcpRequest(req('/internal/mcp', ''), { SEED_SECRET: '' })]) {
    assert.ok(r instanceof Response);
    assert.equal(r.status, 401);
  }
});

test('right secret becomes a /mcp request on the canonical host, body and headers kept, secret dropped', async () => {
  const r = internalMcpRequest(req('/internal/mcp', 's3cret'), env);
  assert.ok(r instanceof Request);
  assert.equal(r.url, 'https://mlw-geo.example.workers.dev/mcp');
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('X-Seed-Secret'), null);
  assert.equal(r.headers.get('host'), 'mlw-geo.example.workers.dev'); // the hosted handler checks Host against SELF_URL
  assert.equal(await r.text(), '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
});
