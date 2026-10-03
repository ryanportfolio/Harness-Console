// Loopback binding alone lets any web page post to the tracker (a no-body POST needs no preflight)
// and lets DNS rebinding read its API. Every route needs a loopback Host; any Origin must match it,
// and a cross-site fetch is refused. Changes also need that exact Origin plus a custom header, which
// forces a preflight the tracker never answers. The Usage tab iframe loads the tracker's own origin,
// so the page's fetches pass.
export const CHANGE_HEADER = "x-usage-request";

export function localRequest(req, port) {
  const host = req.headers.host, origin = req.headers.origin;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if ((origin && origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") return false;
  return req.method === "GET" || (origin === `http://${host}` && req.headers[CHANGE_HEADER] === "1");
}
