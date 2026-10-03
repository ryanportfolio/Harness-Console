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

test('tracker guard: loopback Host on every route; changes need same Origin and the custom header', async t => {
  const http = await import('node:http');
  const { localRequest } = await import('../usage/guard.mjs');
  const server = http.createServer((req, res) => { res.writeHead(localRequest(req, server.address().port) ? 204 : 403); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, self = `http://127.0.0.1:${port}`;
  // fetch cannot set Host or Sec-Fetch-Site, so send raw requests.
  const send = (method, headers) => new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, method, path: '/api/refresh', headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  const change = { origin: self, 'x-usage-request': '1' };
  assert.equal(await send('GET', {}), 204);
  assert.equal(await send('GET', { host: `localhost:${port}` }), 204);
  assert.equal(await send('POST', change), 204);
  assert.equal(await send('POST', { ...change, host: `localhost:${port}`, origin: `http://localhost:${port}` }), 204);
  assert.equal(await send('GET', { host: `evil.example:${port}` }), 403, 'DNS rebinding read');
  assert.equal(await send('GET', { origin: 'https://evil.example' }), 403);
  assert.equal(await send('GET', { 'sec-fetch-site': 'cross-site' }), 403);
  assert.equal(await send('POST', { ...change, origin: 'https://evil.example' }), 403, 'cross-site POST');
  assert.equal(await send('POST', { ...change, host: `evil.example:${port}`, origin: `http://evil.example:${port}` }), 403);
  assert.equal(await send('POST', { origin: self }), 403, 'simple POST without the custom header');
  assert.equal(await send('POST', { 'x-usage-request': '1' }), 403, 'POST without Origin');
  assert.equal(await send('POST', { ...change, origin: `http://localhost:${port}` }), 403, 'Origin must match Host');
});
