import test from 'node:test';
import assert from 'node:assert/strict';

test('/api/tracker and CSP frame-src use the configured USAGE_PORT; page declares an icon', async t => {
  process.env.USAGE_PORT = '4599';
  const { createApp } = await import('../server.mjs');
  const server = await createApp({ adapter: { account: async () => ({ connected: true, login: 'fixture' }), repositories: async () => [] }, preferences: 'nonexistent-fixture-preferences' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tracker = await (await fetch(`${origin}/api/tracker`)).json();
  assert.equal(tracker.url, 'http://127.0.0.1:4599');
  const page = await fetch(`${origin}/`);
  assert.match(page.headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:4599;/);
  const html = await page.text();
  assert.match(html, /<link rel="icon" href="data:,">/);
  assert.doesNotMatch(html, /port 4545/);
});
