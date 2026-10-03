// Loopback binding alone lets any web page post to the tracker (a no-body POST needs no preflight)
// and lets DNS rebinding read its API. Every route needs a loopback Host; any Origin must match it,
// and a cross-site fetch is refused. Changes also need that exact Origin plus a custom header, which
// forces a preflight the tracker never answers. The Usage tab iframe loads the tracker's own origin,
// so the page's fetches pass.
export const CHANGE_HEADER = "x-usage-request";

export function localRequest(req, port) {
  const host = req.headers.host, origin = req.headers.origin;
  // URL drops a default port the way browsers do, so port 80 matches a bare "127.0.0.1".
  if (!["127.0.0.1", "localhost"].some((name) => host === new URL(`http://${name}:${port}`).host)) return false;
  if ((origin && origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") return false;
  return req.method === "GET" || (origin === `http://${host}` && req.headers[CHANGE_HEADER] === "1");
}
