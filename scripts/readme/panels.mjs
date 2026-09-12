// README masthead, computed from the facts in facts.mjs.
//
// Conceit: a departures board. Everything the tracker reports is a clock:
// rate-limit windows and their reset times, poll cadence, token expiry,
// transcript retention. So the masthead is a schedule board, one row per
// clock, each with a ring clock that drains as its window would.
//
// Style: the Monad reference. One parchment card with a 40px radius and a
// 1px ash hairline, serif title at weight 400, every other string in mono,
// uppercase tracked column heads, pill tags, one soft gradient wash.
//
// Contract (a violation is a bug, not a taste call):
// - Numbers: every figure comes from facts.mjs, never typed here.
// - Type: SERIF for the title only, at weight 400. Everything else MONO.
//   Tabular figures always. No bold anywhere.
// - Colour: ink, body, mute, rule, track on the card. The ok/warn/bad trio
//   means dashboard utilization thresholds and appears only in the legend.
//   Provider hues mark provider rows and nothing else. The coral-to-sky
//   wash is decorative, appears once, behind the title, and carries no data.
// - Motion: one looping animation, the ring clocks draining at one second
//   per hour of window. Reduced motion shows the clocks full.
// - Surface: no external fonts, images, scripts or hover.
// - Width: the narrow variant is a different composition, not a scaled copy.

import { collectFacts } from "./facts.mjs";
import { MONO, SERIF, THEMES, esc, monoWidth, svg, writeAsset } from "./lib.mjs";

const F = collectFacts();

const SECONDS_PER_HOUR_OF_WINDOW = 1; // animation scale: 1 s of loop per hour of window
const windowHours = (label) => (label === "Weekly" || label.startsWith("Weekly ") ? 7 * 24 : 5);
const hoursText = (h) => (h >= 24 ? `${h / 24} d` : `${h} h`);

// A ring clock: the stroke is the time left in the window and drains once per
// loop, starting at twelve and emptying clockwise.
const RING_R = 8;
const RING_C = +(2 * Math.PI * RING_R).toFixed(2);
function ring(cx, cy, seconds) {
  return `<g transform="rotate(-90 ${cx} ${cy})"><circle cx="${cx}" cy="${cy}" r="${RING_R}" class="face"/><circle cx="${cx}" cy="${cy}" r="${RING_R}" class="hand" style="animation-duration:${seconds}s"/></g>`;
}

function css(t) {
  return `
.ttl{font-family:${SERIF};font-weight:400;fill:${t.ink};letter-spacing:-0.02em}
.lbl{font-family:${MONO};fill:${t.ink};letter-spacing:-0.02em}
.bdy{font-family:${MONO};fill:${t.body};letter-spacing:-0.02em}
.mut{font-family:${MONO};fill:${t.mute};letter-spacing:-0.02em}
.hd{font-family:${MONO};fill:${t.mute};letter-spacing:0.08em}
.num{font-family:${MONO};fill:${t.ink};font-variant-numeric:tabular-nums}
.rule{stroke:${t.rule};stroke-width:1}
.card{fill:${t.canvas};stroke:${t.rule};stroke-width:1}
.pill{fill:none;stroke:${t.rule};stroke-width:1}
.face{fill:none;stroke:${t.track};stroke-width:3}
.hand{fill:none;stroke:${t.ink};stroke-width:3;stroke-dasharray:${RING_C};stroke-dashoffset:0;animation-name:drain;animation-timing-function:linear;animation-iteration-count:infinite}
@keyframes drain{from{stroke-dashoffset:0}to{stroke-dashoffset:${RING_C}}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}.hand{stroke-dashoffset:0}}`;
}

function boardRows() {
  const rows = [];
  rows.push({ group: "Claude Code", color: "claude", host: F.endpoints[0].host });
  for (const w of F.claudeWindows) rows.push({ label: w, hours: [windowHours(w)], poll: `${F.claudePollSeconds} s`, source: F.endpoints[0].path, note: w.startsWith("Weekly ") ? "when the plan reports it" : "" });
  rows.push({ group: "Codex", color: "codex", host: F.endpoints[3].host });
  rows.push({ label: "Session (5h)", hours: [5], poll: `${F.codexPollSeconds} s`, source: F.endpoints[3].path, note: "" });
  rows.push({ label: "Weekly", hours: [7 * 24], poll: `${F.codexPollSeconds} s`, source: F.endpoints[3].path, note: "" });
  rows.push({ group: "Tokens", color: null, host: "local transcripts" });
  rows.push({ label: "Last 7 / 30 / 90 d", hours: [7 * 24, 30 * 24, 90 * 24], poll: `${F.tokenScanSeconds} s`, source: ".state/tokens/", note: "" });
  rows.push({ label: "Claude token refresh", hours: [], poll: "on expiry", source: F.endpoints[2].path, note: "the only write" });
  return rows;
}

function pill(x, y, text, size, cls = "mut") {
  const w = monoWidth(text, size) + 24;
  return { w, svg: `<rect x="${x}" y="${y - size - 5}" width="${w}" height="${size + 12}" rx="${size + 6}" class="pill"/><text x="${x + 12}" y="${y}" class="${cls}" font-size="${size}">${esc(text)}</text>` };
}

function masthead(t, narrow) {
  const rows = boardRows();
  const W = narrow ? 390 : 900;
  const px = narrow ? 24 : 40;
  const rowH = narrow ? 40 : 42;
  const body = [];
  let y = narrow ? 64 : 92;

  // the one decorative wash, behind the title
  body.push(`<defs><filter id="w" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${narrow ? 28 : 40}"/></filter><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${t.wash1}" stop-opacity="0.55"/><stop offset="1" stop-color="${t.wash2}" stop-opacity="0.55"/></linearGradient><clipPath id="c"><rect x="0.5" y="0.5" width="${W - 1}" height="HEIGHT" rx="${narrow ? 24 : 40}"/></clipPath></defs>`);
  body.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="HEIGHT" rx="${narrow ? 24 : 40}" class="card"/>`);
  body.push(`<ellipse cx="${narrow ? W - 40 : W - 140}" cy="${narrow ? 30 : 40}" rx="${narrow ? 120 : 220}" ry="${narrow ? 60 : 90}" fill="url(#g)" filter="url(#w)" clip-path="url(#c)"/>`);

  body.push(`<text x="${px}" y="${y}" class="ttl" font-size="${narrow ? 36 : 48}">UsageTracker</text>`);
  y += narrow ? 30 : 36;
  const sub = "Rate-limit windows, reset clocks and token totals for every Claude Code and Codex account on this machine, on one local page.";
  const subSize = narrow ? 13 : 16;
  for (const line of wrap(sub, narrow ? W - 2 * px : 620, subSize)) { body.push(`<text x="${px}" y="${y}" class="bdy" font-size="${subSize}">${esc(line)}</text>`); y += subSize * 1.5; }

  // tags as pills
  y += narrow ? 14 : 18;
  let tx = px;
  for (const tag of ["READ-ONLY", `127.0.0.1:${F.port}`, "0 DEPENDENCIES"]) {
    const p = pill(tx, y, tag, narrow ? 11 : 12);
    body.push(p.svg); tx += p.w + 8;
  }

  // column heads
  y += narrow ? 40 : 48;
  const col = narrow ? { win: px, len: 236, poll: W - px } : { win: px, len: 340, poll: 590, src: 690 };
  const hd = (x, s, anchor = "start") => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="hd" font-size="11">${s}</text>`;
  body.push(hd(col.win, "WINDOW"), hd(col.len, "LENGTH"));
  if (!narrow) body.push(hd(col.poll, "POLLED"), hd(col.src, "SOURCE"));
  else body.push(hd(col.poll, "POLLED", "end"));
  y += 10;
  body.push(`<line x1="${px}" x2="${W - px}" y1="${y}" y2="${y}" class="rule"/>`);

  const labelSize = narrow ? 13 : 15;
  for (const r of rows) {
    if (r.group) {
      y += narrow ? 32 : 36;
      let lx = px;
      if (r.color) { body.push(`<circle cx="${px + 5}" cy="${y - 5}" r="5" fill="${t[r.color]}"/>`); lx = px + 18; }
      body.push(`<text x="${lx}" y="${y}" class="lbl" font-size="${narrow ? 13 : 15}">${esc(r.group)}</text>`);
      const hx = narrow ? W - px : col.src;
      body.push(`<text x="${hx}" y="${y}" text-anchor="${narrow ? "end" : "start"}" class="mut" font-size="${narrow ? 11 : 13}">${esc(r.host)}</text>`);
      continue;
    }
    y += rowH;
    body.push(`<text x="${col.win}" y="${y}" class="lbl" font-size="${labelSize}">${esc(r.label)}</text>`);
    if (r.note && r.hours.length && !narrow) body.push(`<text x="${col.win + monoWidth(r.label, labelSize) + 10}" y="${y}" class="mut" font-size="12">${esc(r.note)}</text>`);
    // Narrow: a row with several clocks, or a note instead of a clock, gets a second line.
    const twoLine = narrow && r.hours.length !== 1;
    if (twoLine) { body.push(`<text x="${col.poll}" y="${y}" text-anchor="end" class="num" font-size="12">${esc(r.poll)}</text>`); y += 24; }
    let x = twoLine ? col.win : col.len;
    for (const h of r.hours) {
      body.push(ring(x + RING_R, y - 5, h * SECONDS_PER_HOUR_OF_WINDOW));
      x += 2 * RING_R + 8;
      body.push(`<text x="${x}" y="${y}" class="num" font-size="${narrow ? 12 : 14}">${hoursText(h)}</text>`);
      x += monoWidth(hoursText(h), narrow ? 12 : 14) + 14;
    }
    if (!r.hours.length) body.push(`<text x="${twoLine ? col.win : col.len}" y="${y}" class="mut" font-size="${narrow ? 11 : 13}">${esc(r.note)}</text>`);
    if (!twoLine) body.push(`<text x="${col.poll}" y="${y}" text-anchor="${narrow ? "end" : "start"}" class="num" font-size="${narrow ? 12 : 14}">${esc(r.poll)}</text>`);
    if (!narrow) body.push(`<text x="${col.src}" y="${y}" class="mut" font-size="13">${esc(r.source)}</text>`);
    body.push(`<line x1="${px}" x2="${W - px}" y1="${y + 14}" y2="${y + 14}" class="rule"/>`);
  }

  // legend: the dashboard's bar colours, then the clock scale
  y += narrow ? 24 : 26;
  body.push(`<line x1="${px}" x2="${W - px}" y1="${y}" y2="${y}" class="rule"/>`);
  y += narrow ? 26 : 28;
  const lsize = narrow ? 11 : 12;
  body.push(`<text x="${px}" y="${y}" class="hd" font-size="11">DASHBOARD BARS</text>`);
  let lx = narrow ? px : px + monoWidth("DASHBOARD BARS", 11) * 1.1 + 16;
  if (narrow) y += 22;
  for (const [k, label] of [["ok", `under ${F.warnAt}% used`], ["warn", `${F.warnAt}% and over`], ["bad", `${F.badAt}% and over`]]) {
    body.push(`<rect x="${lx}" y="${y - 8}" width="${narrow ? 20 : 30}" height="6" rx="3" fill="${t[k]}"/>`);
    lx += narrow ? 26 : 38;
    body.push(`<text x="${lx}" y="${y}" class="mut" font-size="${lsize}">${esc(label)}</text>`);
    lx += monoWidth(label, lsize) + (narrow ? 10 : 24);
  }
  y += narrow ? 26 : 28;
  const scale = `Clocks drain at ${SECONDS_PER_HOUR_OF_WINDOW} s per hour of window: a 5 h window empties every ${5 * SECONDS_PER_HOUR_OF_WINDOW} s, 7 days every ${168 * SECONDS_PER_HOUR_OF_WINDOW} s, 90 days every ${90 * 24 * SECONDS_PER_HOUR_OF_WINDOW} s.`;
  for (const line of wrap(scale, W - 2 * px, lsize)) { body.push(`<text x="${px}" y="${y}" class="mut" font-size="${lsize}">${esc(line)}</text>`); y += lsize * 1.5; }

  const H = Math.ceil(y + (narrow ? 24 : 32));
  const label = `UsageTracker schedule board: ${F.claudeWindows.length} Claude Code rate-limit windows polled every ${F.claudePollSeconds} seconds, 2 Codex windows polled every ${F.codexPollSeconds} seconds, token totals over 7, 30 and 90 days rescanned every ${F.tokenScanSeconds} seconds, and one write, the Claude token refresh.`;
  return svg(W, H, label, body.join("\n").replaceAll("HEIGHT", String(H - 1)), css(t));
}

function wrap(text, width, size) {
  const lines = [];
  let cur = "";
  for (const w of text.split(" ")) {
    const next = cur ? `${cur} ${w}` : w;
    if (monoWidth(next, size) > width && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

export const PANELS = { masthead };

for (const [name, build] of Object.entries(PANELS)) {
  for (const th of ["light", "dark"]) {
    writeAsset(`${name}-${th}.svg`, build(THEMES[th], false));
    writeAsset(`${name}-narrow-${th}.svg`, build(THEMES[th], true));
  }
}
console.log(`panels: ${Object.keys(PANELS).length} x 4 variants written to assets/readme/`);
