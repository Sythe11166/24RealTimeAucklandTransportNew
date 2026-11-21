// Fetches VCT live + upcoming matches from vlr.gg and writes data/valorant.json.
// Runs inside a GitHub Action every ~10 minutes. No keys, no proxies.
import fs from 'node:fs';
import * as cheerio from 'cheerio';

const BASE = 'https://www.vlr.gg';
const UA = 'Mozilla/5.0 (compatible; PersonalDashboard/1.0)';
const VCT = /vct|champions tour|kickoff|valorant champions|masters/i;
const FILE = 'data/valorant.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async p => {
  const r = await fetch(BASE + p, { headers: { 'user-agent': UA, 'accept-language': 'en' } });
  if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status);
  return r.text();
};
const txt = el => el.text().replace(/\s+/g, ' ').trim();
const isTbd = n => !n || /^tbd$/i.test(n);

// "1d 4h", "5h 46m", "35m" -> milliseconds
function agoMs(s) {
  const d = /(\d+)\s*d/.exec(s), h = /(\d+)\s*h/.exec(s), m = /(\d+)\s*m(?!o)/.exec(s);
  if (!d && !h && !m) return null;
  return ((d ? +d[1] : 0) * 1440 + (h ? +h[1] : 0) * 60 + (m ? +m[1] : 0)) * 60000;
}
function etaMs(s) {
  if (!s || /ago/i.test(s)) return null;
  const d = /(\d+)\s*d/.exec(s), h = /(\d+)\s*h/.exec(s), m = /(\d+)\s*m(?!o)/.exec(s);
  if (!d && !h && !m) return null;
  return ((d ? +d[1] : 0) * 1440 + (h ? +h[1] : 0) * 60 + (m ? +m[1] : 0)) * 60000;
}

let old = {};
try { old = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const oldTs = Object.fromEntries([...(old.live || []), ...(old.upcoming || []), ...(old.results || [])].map(m => [m.id, m.ts]));

function parse(html, past) {
  const $ = cheerio.load(html);
  if (!$('a.match-item').length) throw new Error('No matches found on vlr.gg (page layout changed or request blocked)');
  const out = [];
  $('a.match-item').each((_, a) => {
    const el = $(a), href = el.attr('href') || '';
    const names = el.find('.match-item-vs-team-name').map((_, n) => txt($(n))).get();
    const scores = el.find('.match-item-vs-team-score').map((_, n) => txt($(n))).get();
    const series = txt(el.find('.match-item-event-series').first());
    const evEl = el.find('.match-item-event').first().clone();
    evEl.find('.match-item-event-series').remove();
    const ev = txt(evEl);
    const etaTxt = txt(el.find('.match-item-eta').first());
    const live = !past && /live/i.test(etaTxt);
    const id = (href.match(/^\/(\d+)/) || [])[1] || href;
    const utc = el.find('[data-utc-ts]').first().attr('data-utc-ts');
    let ts = utc ? Date.parse(utc.replace(' ', 'T') + 'Z') : NaN;
    if (isNaN(ts)) {
      if (past) { const e = agoMs(etaTxt); ts = e != null ? Math.round((Date.now() - e) / 3e5) * 3e5 : (oldTs[id] || null); }
      else { const e = etaMs(etaTxt); ts = e != null ? Math.round((Date.now() + e) / 3e5) * 3e5 : (oldTs[id] || null); }
    }
    if (names.length < 2 || !VCT.test(ev + ' ' + href)) return;
    out.push({ id, a: names[0], b: names[1], sa: scores[0] || '0', sb: scores[1] || '0', ev, ph: series, ts, live, url: BASE + href });
  });
  return out;
}
const list = parse(await get('/matches'), false);
let pastList = [];
try { await sleep(1200); pastList = parse(await get('/matches/results'), true); }
catch (e) { console.log('results skipped:', e.message); pastList = (old.results || []).map(m => ({ ...m })); }

const live = list.filter(m => m.live).slice(0, 6).map(({ live, ...m }) => ({ ...m, ts: m.ts || oldTs[m.id] || null }));
const upcoming = list.filter(m => !m.live && m.ts && m.ts > Date.now() - 36e5 && !isTbd(m.a) && !isTbd(m.b))
  .sort((x, y) => x.ts - y.ts).slice(0, 12).map(({ live, ...m }) => m);

const results = pastList.filter(m => !isTbd(m.a) && !isTbd(m.b) && m.sa !== '' && m.sb !== '').slice(0, 6).map(({ live, ...m }) => m);


// ---- per-map scores + live player K/D from a match page (all defensive: any miss just means "no detail") ----
const num = s => { const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n; };
const mapDone = m => m.a != null && m.b != null && Math.max(m.a, m.b) >= 13 && Math.abs(m.a - m.b) >= 2;
async function fetchMatch(path, live) {
  const $ = cheerio.load(await get(path));
  const games = [];
  $('.vm-stats-gamesnav-item').each((_, e) => {
    const id = $(e).attr('data-game-id');
    if (!id || id === 'all') return;
    const g = $('.vm-stats-game[data-game-id="' + id + '"]').first();
    const sc = g.find('.vm-stats-game-header .score').map((_, x) => num(txt($(x)))).get();
    let n = txt($(e)).replace(/^\d+\s*/, '');
    n = (/[A-Za-z][A-Za-z ]*[A-Za-z]/.exec(n) || [''])[0].trim();
    if (!n) n = (/[A-Za-z][A-Za-z ]*[A-Za-z]/.exec(txt(g.find('.vm-stats-game-header .map span').first())) || [''])[0].trim();
    games.push({ g, n, a: sc.length > 1 ? sc[0] : null, b: sc.length > 1 ? sc[1] : null });
  });
  const started = games.filter(m => m.n && m.a != null && m.b != null && m.a + m.b > 0);
  const mp = started.map(m => {
    const o = { n: m.n, a: m.a, b: m.b };
    if (live && !mapDone(m)) o.lv = true;
    return o;
  });
  const out = { mp };
  if (live && started.length) {
    const cur = started[started.length - 1], rows = [];
    cur.g.find('table.wf-table-inset tbody tr').each((_, tr) => {
      const t = $(tr), nm = txt(t.find('.mod-player .text-of').first()) || txt(t.find('.mod-player').first()).split(' ')[0];
      const k = num(txt(t.find('td.mod-vlr-kills .mod-both').first()) || txt(t.find('td.mod-vlr-kills').first()));
      const d = num(txt(t.find('td.mod-vlr-deaths .mod-both').first()) || txt(t.find('td.mod-vlr-deaths').first()));
      const ag = (/agents\/([a-z0-9]+)\.png/i.exec(t.find('td.mod-agents img, img[src*="/agents/"]').first().attr('src') || '') || [])[1];
      if (nm && k != null && d != null) rows.push({ n: nm, k, d, ag: ag || '' });
    });
    if (rows.length >= 10) {
      const top = r => r.slice().sort((x, y) => y.k - x.k || x.d - y.d).slice(0, 5);
      out.pl = { a: top(rows.slice(0, 5)), b: top(rows.slice(5, 10)) };
    }
  }
  return out;
}
const oldRes = Object.fromEntries((old.results || []).map(m => [m.id, m]));
const oldLive = Object.fromEntries((old.live || []).map(m => [m.id, m]));
for (const m of live) {
  try { Object.assign(m, await fetchMatch(m.url.replace(BASE, ''), true)); }
  catch (e) { console.log('live detail skipped:', m.url, e.message); const o = oldLive[m.id]; if (o) { m.mp = o.mp; m.pl = o.pl; } }
  await sleep(1200);
}
for (const m of results) {
  const o = oldRes[m.id];
  if (o && o.mp && o.mp.length) { m.mp = o.mp; continue; }
  try { const x = await fetchMatch(m.url.replace(BASE, ''), false); if (x.mp.length) m.mp = x.mp; }
  catch (e) { console.log('map detail skipped:', m.url, e.message); }
  await sleep(1200);
}

// team logos: one match page per match with a missing logo, cached in the JSON so it rarely repeats
const logos = { ...(old.logos || {}) };
const show = [...live, ...upcoming.slice(0, 8), ...results.slice(0, 6)];
const need = show.filter(m => !(logos[m.a] && logos[m.b])).slice(0, 6);
for (const m of need) {
  try {
    const $m = cheerio.load(await get(m.url.replace(BASE, '')));
    const imgs = $m('.match-header-link').map((_, l) => $m(l).find('img').first().attr('src')).get().filter(Boolean)
      .map(s => s.startsWith('//') ? 'https:' + s : s);
    if (imgs.length >= 2) { logos[m.a] = imgs[0]; logos[m.b] = imgs[1]; }
  } catch (e) { console.log('logo skipped:', m.url, e.message); }
  await sleep(1200);
}
// team colours: dominant saturated colour of each logo (needs the optional "sharp" package; without it the page derives a colour from the team name)
let sharp = null; try { sharp = (await import('sharp')).default; } catch {}
async function logoColor(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) return '';
  const { data } = await sharp(Buffer.from(await r.arrayBuffer())).resize(48, 48, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const B = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, sat = mx ? (mx - mn) / mx : 0;
    if (a < 128 || v < 0.25 || sat < 0.3) continue;
    let h = mx === mn ? 0 : mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
    const k = B[Math.floor(h * 2) % 12], w = sat * v;
    k.w += w; k.r += r * w; k.g += g * w; k.b += b * w;
  }
  const t = B.sort((x, y) => y.w - x.w)[0];
  if (!t || t.w < 3) return '';
  return '#' + [t.r, t.g, t.b].map(x => Math.round(x / t.w).toString(16).padStart(2, '0')).join('');
}
const colors = { ...(old.colors || {}) };
if (sharp) {
  let n = 0;
  for (const m of show) for (const t of [m.a, m.b]) {
    if (colors[t] !== undefined || !logos[t] || n >= 8) continue;
    n++;
    try { colors[t] = await logoColor(logos[t]); } catch (e) { console.log('colour skipped:', t, e.message); }
  }
}
const keep = new Set(show.flatMap(m => [m.a, m.b]));
for (const k of Object.keys(colors)) if (!keep.has(k)) delete colors[k];
for (const k of Object.keys(logos)) if (!keep.has(k)) delete logos[k];

// Valorant news (vlr.gg/news): title, one-line summary, date, link
const DATE_RE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}, \d{4}/;
async function fetchNews() {
  const $ = cheerio.load(await get('/news'));
  const out = [];
  $('a.wf-module-item').each((_, a) => {
    const el = $(a), href = el.attr('href') || '';
    if (!/^\/\d+\//.test(href)) return;
    const leaf = el.find('div').filter((_, d) => $(d).children('div').length === 0).map((_, d) => txt($(d))).get().filter(Boolean);
    const dm = DATE_RE.exec(txt(el)), t = leaf[0] || '';
    const d = leaf.find((x, i) => i > 0 && x.length > 20 && !DATE_RE.test(x) && !/^by\b/i.test(x)) || '';
    if (!t) return;
    out.push({ t: t.slice(0, 160), d: d.slice(0, 220), ts: dm ? Date.parse(dm[0].replace('.', '') + ' 12:00:00 UTC') : null, url: BASE + href });
  });
  return out.slice(0, 6);
}
let news = old.news || [];
try { await sleep(1200); const n = await fetchNews(); if (n.length) news = n; else console.log('news: no articles found'); }
catch (e) { console.log('news skipped:', e.message); }

// agent artwork (valorant-api.com): looked up once, cached in the JSON, so the page never calls a third-party API
const agents = { ...(old.agents || {}) };
const needAg = [...new Set(live.flatMap(m => [...((m.pl || {}).a || []), ...((m.pl || {}).b || [])].map(x => x.ag).filter(Boolean)))].filter(a => !agents[a]);
if (needAg.length) {
  try {
    const j = await (await fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true')).json();
    for (const a of j.data || []) agents[a.displayName.toLowerCase().replace(/[^a-z0-9]/g, '')] = { i: a.displayIcon, p: a.bustPortrait || a.fullPortraitV2 || a.displayIcon };
  } catch (e) { console.log('agent art skipped:', e.message); }
}
const out = { live, upcoming, results: results.slice(0, 6), news, logos, colors, agents };
const before = JSON.stringify({ live: old.live || [], upcoming: old.upcoming || [], results: old.results || [], news: old.news || [], logos: old.logos || {}, colors: old.colors || {}, agents: old.agents || {} });
if (before === JSON.stringify(out)) { console.log('No change'); process.exit(0); }
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), ...out }, null, 1));
console.log(`Wrote ${live.length} live, ${upcoming.length} upcoming, ${out.results.length} results`);
