import assert from 'node:assert/strict';
import { startHarness } from './harness.mjs';
const token = 'local-test-only-not-a-cloud-secret';
const { mf, origin } = await startHarness({
  bindings: { LOCAL_MUTATIONS: 'false', PUBLISH_TOKEN: token },
});
try {
  for (const path of ['/api/decks/auth%2Fdemo', '/api/thumbnail/auth%2Fdemo']) {
    for (const method of path.includes('thumbnail') ? ['POST', 'PUT'] : ['POST'])
      for (const authorization of [undefined, 'Bearer wrong']) {
        const headers = authorization ? { authorization } : {};
        assert.equal((await fetch(origin + path, { method, headers, body: '{}' })).status, 401);
      }
  }
  const published = await fetch(origin + '/api/decks/auth%2Fdemo', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ markdown: '# Authorized' }),
  });
  assert.equal(published.status, 200);
  assert.equal((await fetch(origin + '/api/decks/auth%2Fdemo')).status, 200);
  assert.equal(
    (
      await fetch(origin + '/api/thumbnail/auth%2Fdemo', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
      })
    ).status,
    503,
  );
  console.log(
    'PASS cloud-style auth: unauthorized requests rejected, valid publish allowed, public read allowed, thumbnail reaches binding guard',
  );
} finally {
  await mf.dispose();
}
