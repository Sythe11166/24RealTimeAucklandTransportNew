// Fetches VCT live + upcoming matches from vlr.gg and writes data/valorant.json.
// Runs inside a GitHub Action every 5 minutes (and repeats every ~100s while a match is live). No keys, no proxies.
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

const live = list.filter(m => m.live).slice(0, 8).map(({ live, ...m }) => ({ ...m, ts: m.ts || oldTs[m.id] || null }));
const upcoming = list.filter(m => !m.live && m.ts && m.ts > Date.now() - 36e5 && !isTbd(m.a) && !isTbd(m.b))
  .sort((x, y) => x.ts - y.ts).slice(0, 12).map(({ live, ...m }) => m);

const results = pastList.filter(m => !isTbd(m.a) && !isTbd(m.b) && m.sa !== '' && m.sb !== '').slice(0, 9).map(({ live, ...m }) => m);


// ---- per-map scores + live player K/D from a match page (all defensive: any miss just means "no detail") ----
const num = s => { const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n; };
const mapDone = m => m.a != null && m.b != null && Math.max(m.a, m.b) >= 13 && Math.abs(m.a - m.b) >= 2;
const abs = x => !x ? '' : x.startsWith('//') ? 'https:' + x : x.startsWith('/') ? BASE + x : x;
async function fetchMatch(path, live, sa, sb) {
  const $ = cheerio.load(await get(path));
  const evl = abs($('.match-header-event img').first().attr('src') || '');
  const evu = $('.match-header-event').first().attr('href') || $('a.match-header-event').first().attr('href') || '';
  const bo = (/\bbo\s?(\d)\b/i.exec(txt($('.match-header-vs-note'))) || [])[1] || '';
  // map veto, e.g. "Fnatic ban Lotus; NAVI ban Haven; Fnatic pick Ascent; ...; Bind remains"  ->  [['x','Fnatic','Lotus'],['p',..],['d','','Bind']]
  const notes = $('.match-header-note').map((_, e) => txt($(e))).get().join('; ');
  const vt = [];
  for (const part of notes.split(/;|\|/).map(x => x.trim()).filter(Boolean)) {
    let r = /^(.+?)\s+(ban|pick)\s+(.+)$/i.exec(part);
    if (r) { vt.push([r[2].toLowerCase() === 'ban' ? 'x' : 'p', r[1], r[3]]); continue; }
    r = /^(.+?)\s+remains?$/i.exec(part);
    if (r) vt.push(['d', '', r[1]]);
  }
  // head to head, from the first team's point of view
  let hw = 0, hl = 0;
  $('.match-h2h-matches a').each((_, a) => {
    const rf = num(txt($(a).find('.rf').first())), ra = num(txt($(a).find('.ra').first()));
    if (rf != null && ra != null && rf !== ra) rf > ra ? hw++ : hl++;
  });
  const fsm = /(\d+)\s*:\s*(\d+)/.exec(txt($('.match-header-vs-score').first()));
  const common = { evl, evu, bo, ...(fsm ? { fsc: [fsm[1], fsm[2]] } : {}), ...(vt.length ? { vt } : {}), ...(hw + hl ? { h2h: { a: hw, b: hl } } : {}) };
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
  // players: names always (from any stat table), K/D only when vlr is publishing numbers for the map being played right now
  // vlr's current markup: .ovw-table blocks (one per team) of .ovw-row players; stat cells stay blank until a map finishes
  const rowsNew = g => {
    const rows = [], val = c => { let n = parseInt(txt(c.find('.mod-both').first()).replace(/[^\d]/g, ''), 10); if (isNaN(n)) n = parseInt((/\d+/.exec(txt(c)) || [''])[0], 10); return isNaN(n) ? null : n; };
    g.find('.ovw-table').each((_, tb) => {
      $(tb).find('.ovw-row').not('.mod-head').each((_, tr) => {
        const t = $(tr), nm = txt(t.find('.ovw-player-name').first());
        const ag = (/agents\/([a-z0-9]+)\.(?:png|webp)/i.exec(t.find('.ovw-agents img').first().attr('src') || '') || [])[1];
        let k = val(t.find('.ovw-kda-stat[data-col="kills"]').first()), d = val(t.find('.ovw-kda-stat[data-col="deaths"]').first());
        if (k == null || d == null) { const m3 = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/.exec(txt(t.find('.mod-kda').first())); if (m3) { k = +m3[1]; d = +m3[2]; } }
        if (nm) rows.push({ n: nm, k, d, ag: ag || '' });
      });
    });
    return rows;
  };
  const rowsOf = g => {
    const nr = rowsNew(g);
    if (nr.length) return nr;
    const rows = [];
    g.find('table.wf-table-inset tbody tr').each((_, tr) => {
      const t = $(tr), tds = t.find('td');
      const nm = txt(t.find('.mod-player .text-of').first()) || txt(t.find('.mod-player').first()).split(' ')[0];
      const val = (cls, idx) => {
        let c = t.find('td.' + cls).first();
        if (!c.length) c = tds.eq(idx);
        const b = c.find('.mod-both').first(), sp = c.find('span').first();
        return num((/-?\d+/.exec(txt(b.length ? b : sp.length ? sp : c)) || [])[0]);
      };
      const ag = (/agents\/([a-z0-9]+)\.png/i.exec(t.find('td.mod-agents img, img[src*="/agents/"]').first().attr('src') || '') || [])[1];
      if (nm) rows.push({ n: nm, k: val('mod-vlr-kills', 4), d: val('mod-vlr-deaths', 5), ag: ag || '' });
    });
    return rows;
  };
  const rdOf = g => {   // round by round: who won it and how (e elimination, b spike detonated, d defused, t time)
    const rd = [];
    g.find('.vlr-rounds-row-col').each((_, c) => {
      const sq = $(c).find('.rnd-sq').toArray();
      if (sq.length < 2) return;
      const w = sq.findIndex(x => $(x).hasClass('mod-win') || $(x).find('img').length);
      if (w < 0) return;
      const src = $(sq[w]).find('img').attr('src') || '';
      rd.push([w ? 'b' : 'a', /defuse/i.test(src) ? 'd' : /boom|spike|detonat/i.test(src) ? 'b' : /time/i.test(src) ? 't' : 'e']);
    });
    return rd;
  };
  const started = m => m.a != null && m.b != null && m.a + m.b > 0;
  if (!live) {
    const pm = games.filter(m => m.n && started(m));
    // post-match summary: every played map with both rosters (agent, K/D) and the round-by-round result (overtime included)
    const sm = pm.map(m => {
      const o = { n: m.n, a: m.a, b: m.b }, r = rowsOf(m.g);
      if (r.length >= 10) { const top = x => x.slice().sort((p, q) => (q.k ?? -1) - (p.k ?? -1) || (p.d ?? 0) - (q.d ?? 0)); o.pa = top(r.slice(0, 5)); o.pb = top(r.slice(5, 10)); }
      const rd = rdOf(m.g); if (rd.length) o.rd = rd;
      return o;
    });
    const withKd = sm.filter(x => x.pa && x.pa.some(p => p.k != null)).length;
    console.log('summary', path.split('/')[1], 'maps', sm.length, '| with K/D:', withKd, '| with rounds:', sm.filter(x => x.rd).length, '| sample:', sm[0] && sm[0].pa ? JSON.stringify(sm[0].pa[0]) : 'none');
    return { mp: pm.map(m => ({ n: m.n, a: m.a, b: m.b })), sm, ...common };
  }

  // live: every map of the series. d = played, l = being played (or about to start), n = still to come
  const need = Math.ceil(games.length / 2);
  let li = games.findIndex(m => !mapDone(m));
  if (+sa >= need || +sb >= need) li = -1;
  const mp = games.map((m, i) => {
    const st = li === -1 || i < li ? 'd' : i === li ? 'l' : 'n';
    return st === 'n' ? { n: m.n || 'TBD', st } : { n: m.n || 'TBD', a: m.a ?? 0, b: m.b ?? 0, st };
  });

  let rows = li >= 0 ? rowsOf(games[li].g) : [];
  const liveRows = rows.length >= 10;
  const kd = liveRows && rows.every(r => r.k != null && r.d != null) && rows.some(r => r.k || r.d);
  for (let i = games.length - 1; i >= 0 && rows.length < 10; i--) rows = rowsOf(games[i].g);
  if (rows.length < 10) rows = rowsOf($('.vm-stats-game[data-game-id="all"]').first());
  const rd = li >= 0 ? rdOf(games[li].g) : [];
  console.log('live detail', path.split('/')[1], 'bo' + bo, 'maps', games.length, 'live#', li, 'player rows:', rows.length, kd ? '-> live K/D' : rows.length >= 10 ? '-> names only (no live K/D on vlr)' : '-> no players', '| rounds:', rd.length, '| veto:', vt.length, '| h2h:', hw + '-' + hl);
  const out = { mp, ...common };
  if (rows.length >= 10) {
    const top = r => r.slice().sort((x, y) => y.k - x.k || x.d - y.d);
    const cut = r => r.map(({ n, ag }) => ({ n, ag: liveRows ? ag : '' }));
    out.pl = kd ? { a: top(rows.slice(0, 5)), b: top(rows.slice(5, 10)) } : { a: cut(rows.slice(0, 5)), b: cut(rows.slice(5, 10)) };
    if (kd) out.plm = games[li].n; else out.nk = 1;
  }
  if (rd.length) { out.rd = rd; out.rdm = games[li].n; }
  return out;
}
const evlogos = { ...(old.evlogos || {}) };
const oldRes = Object.fromEntries((old.results || []).map(m => [m.id, m]));
const oldLive = Object.fromEntries((old.live || []).map(m => [m.id, m]));
for (const m of live) {
  try { let x; try { x = await fetchMatch(m.url.replace(BASE, ''), true, m.sa, m.sb); } catch (e1) { await sleep(2500); x = await fetchMatch(m.url.replace(BASE, ''), true, m.sa, m.sb); } const { evl, fsc, ...r } = x; if (evl) evlogos[m.ev] = evl; Object.assign(m, r); if (m.vt && !m.vt.length) delete m.vt; }
  catch (e) { console.log('LIVE DETAIL FAILED, showing older map data for', m.a, 'v', m.b, '-', e.message); const o = oldLive[m.id]; if (o) { for (const k of ['mp', 'pl', 'plm', 'nk', 'rd', 'rdm', 'bo', 'vt', 'h2h', 'evu']) if (o[k] !== undefined) m[k] = o[k]; } }
  await sleep(600);
}
for (const m of results) {
  const o = oldRes[m.id];
  if (o && o.mp && o.mp.length) { m.mp = o.mp; for (const k of ['sm', 'vt', 'h2h', 'bo', 'smt']) if (o[k] !== undefined) m[k] = o[k]; continue; }
  try { const x = await fetchMatch(m.url.replace(BASE, ''), false); if (x.mp.length) m.mp = x.mp; if (x.sm) m.sm = x.sm; if (x.evl) evlogos[m.ev] = x.evl; for (const k of ['vt', 'h2h', 'bo']) if (x[k]) m[k] = x[k]; m.smt = Date.now(); }
  catch (e) { console.log('map detail skipped:', m.url, e.message); }
  await sleep(1200);
}

// a match that just finished disappears from /matches before vlr lists it under results: keep it (with its final score) so it never just vanishes or sits "live"
const resIds = new Set(results.map(m => m.id));
for (const o of old.results || []) if (o.g && !resIds.has(o.id) && !live.some(m => m.id === o.id) && Date.now() - (o.ts || 0) < 3 * 36e5) results.unshift(o);
for (const o of old.live || []) {
  if (live.some(m => m.id === o.id) || resIds.has(o.id)) continue;
  const g = { id: o.id, a: o.a, b: o.b, sa: o.sa, sb: o.sb, ev: o.ev, ph: o.ph, ts: o.ts, url: o.url, g: 1, mp: (o.mp || []).filter(x => x.a != null).map(x => ({ n: x.n, a: x.a, b: x.b })) };
  try {
    const x = await fetchMatch(o.url.replace(BASE, ''), false);
    if (x.fsc) { g.sa = x.fsc[0]; g.sb = x.fsc[1]; }
    if (x.mp.length) g.mp = x.mp;
    console.log('finished:', o.a, g.sa + '-' + g.sb, o.b, '(kept until vlr lists it)');
  } catch (e) { console.log('finished match detail skipped:', e.message); }
  results.unshift(g);
  await sleep(900);
}

// post-match summaries: (re)fetch until every map shows K/D, retrying at most every 8 minutes, and only for matches from the last 30 hours
for (const m of results) {
  const o = oldRes[m.id];
  if (o) for (const k of ['sm', 'vt', 'h2h', 'bo', 'smt']) if (m[k] === undefined && o[k] !== undefined) m[k] = o[k];
  const full = m.sm && m.sm.length && m.sm.every(x => x.pa && x.pa.some(p => p.k != null));
  if (full || (m.smt && Date.now() - m.smt < 8 * 60000) || Date.now() - (m.ts || 0) > 30 * 36e5) continue;
  try {
    const x = await fetchMatch(m.url.replace(BASE, ''), false);
    if (x.sm && x.sm.length) m.sm = x.sm;
    if (x.mp.length) m.mp = x.mp;
    for (const k of ['vt', 'h2h', 'bo']) if (x[k]) m[k] = x[k];
  } catch (e) { console.log('summary skipped:', m.url, e.message); }
  m.smt = Date.now();
  await sleep(900);
}

// upcoming: veto + head-to-head for the next few matches (veto is re-checked every run once a match is within 90 min)
const oldUp = Object.fromEntries((old.upcoming || []).map(m => [m.id, m]));
for (const m of upcoming.slice(0, 3)) {
  const o = oldUp[m.id], soon = m.ts && m.ts - Date.now() < 90 * 60000;
  if (o && o.fz && !soon) { for (const k of ['vt', 'h2h', 'bo', 'evu']) if (o[k] !== undefined) m[k] = o[k]; m.fz = 1; continue; }
  try {
    const x = await fetchMatch(m.url.replace(BASE, ''), false);
    for (const k of ['vt', 'h2h', 'bo', 'evu']) if (x[k]) m[k] = x[k];
    if (x.evl) evlogos[m.ev] = x.evl;
    m.fz = 1;
    console.log('upcoming detail', m.a, 'v', m.b, '| veto:', (x.vt || []).length, '| h2h:', x.h2h ? x.h2h.a + '-' + x.h2h.b : 'none');
  } catch (e) { console.log('upcoming detail skipped:', m.url, e.message); }
  await sleep(900);
}

// event bracket: every match of the event of the live (else next) match, grouped by round
function parseBracket(html) {
  const $ = cheerio.load(html), rounds = new Map(), done = [];
  let order = 0;
  $('a.match-item').each((_, a) => {
    const el = $(a);
    const names = el.find('.match-item-vs-team-name').map((_, n) => txt($(n))).get();
    const scores = el.find('.match-item-vs-team-score').map((_, n) => num(txt($(n)))).get();
    if (names.length < 2) return;
    const series = txt(el.find('.match-item-event-series').first()) || 'Matches';
    const status = txt(el.find('.ml-status').first()) + ' ' + txt(el.find('.match-item-eta').first());
    const isLive = /live/i.test(status);
    const fin = !isLive && scores.length > 1 && scores[0] != null && scores[1] != null && (/complete|ago/i.test(status) || scores[0] + scores[1] > 0 && !/upcoming|in \d/i.test(status));
    const utc = el.find('[data-utc-ts]').first().attr('data-utc-ts'), t = utc ? Date.parse(utc.replace(' ', 'T') + 'Z') : NaN;
    const r = rounds.get(series) || { r: series, t: isNaN(t) ? Infinity : t, i: order++, m: [] };
    if (!isNaN(t)) r.t = Math.min(r.t, t);
    r.m.push([names[0], names[1], scores[0] ?? 0, scores[1] ?? 0, isLive ? 'l' : fin ? 'd' : 'u']);
    rounds.set(series, r);
    if (fin) done.push({ series, w: scores[0] > scores[1] ? names[0] : names[1], l: scores[0] > scores[1] ? names[1] : names[0] });
  });
  const arr = [...rounds.values()].sort((x, y) => (x.t === y.t ? x.i - y.i : x.t - y.t));
  // knocked out: lost a lower-bracket / elimination / final match, or lost twice in a double-elim bracket, or 3 swiss losses
  const lc = {}, out = new Set();
  for (const d of done) {
    lc[d.l] = (lc[d.l] || 0) + 1;
    const sw = /swiss/i.test(d.series);
    if ((/lower|elimination|decider|consolation|last chance|semi|quarter|final/i.test(d.series) && !/upper/i.test(d.series)) || (!sw && /upper|lower|bracket|playoff/i.test(d.series) && lc[d.l] >= 2) || (sw && lc[d.l] >= 3)) out.add(d.l);
  }
  return { r: arr.map(r => ({ r: r.r, m: r.m })), x: [...out] };
}
let br = old.br || null;
try {
  const evu = (live.find(m => m.evu) || upcoming.find(m => m.evu) || {}).evu || (br && br.u) || '';
  const mm = /^\/event\/(\d+)\/?(.*)$/.exec(evu);
  const evName = (live[0] || upcoming[0] || {}).ev || '';
  if (mm && !(br && br.u === evu && Date.now() - br.at < (live.length ? 4 : 30) * 60000)) {
    await sleep(900);
    const b = parseBracket(await get('/event/matches/' + mm[1] + '/' + mm[2].replace(/\/$/, '') + '/?series_id=all&group=all'));
    const n = b.r.reduce((k, r) => k + r.m.length, 0);
    console.log('bracket', evu, 'rounds', b.r.length, 'matches', n, 'knocked out', b.x.length);
    if (n) br = { u: evu, ev: evName, at: Date.now(), r: b.r, x: b.x };
  }
} catch (e) { console.log('bracket skipped:', e.message); }

// team logos: one match page per match with a missing logo, cached in the JSON so it rarely repeats
const logos = { ...(old.logos || {}) };
const show = [...live, ...upcoming.slice(0, 8), ...results.slice(0, 9)];
const need = show.filter(m => !((m.a in logos) && (m.b in logos)) || !(m.ev in evlogos)).slice(0, 8);
for (const m of need) {
  try {
    const $m = cheerio.load(await get(m.url.replace(BASE, '')));
    const real = x => (!x || /\/tmp\/|vlr\.png|placeholder/i.test(x)) ? '' : (x.startsWith('//') ? 'https:' + x : x.startsWith('/') ? BASE + x : x);
    const imgs = $m('.match-header-link').map((_, l) => $m(l).find('img').first().attr('src') || '').get().map(real);
    if (imgs.length >= 2) { logos[m.a] = imgs[0]; logos[m.b] = imgs[1]; }
    const evx = $m('.match-header-event img').first().attr('src') || '';
    if (evx) evlogos[m.ev] = evx.startsWith('//') ? 'https:' + evx : evx.startsWith('/') ? BASE + evx : evx;
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
const evKeep = new Set(show.map(m => m.ev));
for (const k of Object.keys(evlogos)) if (!evKeep.has(k)) delete evlogos[k];
const vct = Object.entries(evlogos).find(([k]) => /vct/i.test(k))?.[1] || Object.values(evlogos)[0] || old.vct || '';

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
const out = { live, upcoming, results: results.slice(0, 9), news, logos, colors, agents, evlogos, vct, br };
const before = JSON.stringify({ live: old.live || [], upcoming: old.upcoming || [], results: old.results || [], news: old.news || [], logos: old.logos || {}, colors: old.colors || {}, agents: old.agents || {}, evlogos: old.evlogos || {}, vct: old.vct || '', br: old.br || null });
const flat = o => JSON.stringify({ ...o, br: o.br && { ...o.br, at: 0 } });
const fresh = old.updated && Date.now() - Date.parse(old.updated) < (live.length ? 3 : 20) * 60000;
if (fresh && flat(JSON.parse(before)) === flat(out)) { console.log('No change'); process.exit(0); }
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), ...out }, null, 1));
console.log(`Wrote ${live.length} live, ${upcoming.length} upcoming, ${out.results.length} results`);
