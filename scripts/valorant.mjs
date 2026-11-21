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
function etaMs(s) {
  if (!s || /ago/i.test(s)) return null;
  const d = /(\d+)\s*d/.exec(s), h = /(\d+)\s*h/.exec(s), m = /(\d+)\s*m(?!o)/.exec(s);
  if (!d && !h && !m) return null;
  return ((d ? +d[1] : 0) * 1440 + (h ? +h[1] : 0) * 60 + (m ? +m[1] : 0)) * 60000;
}

let old = {};
try { old = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const oldTs = Object.fromEntries([...(old.live || []), ...(old.upcoming || [])].map(m => [m.id, m.ts]));

const $ = cheerio.load(await get('/matches'));
if (!$('a.match-item').length) throw new Error('No matches found on vlr.gg/matches (page layout changed or request blocked)');
const list = [];
$('a.match-item').each((_, a) => {
  const el = $(a), href = el.attr('href') || '';
  const names = el.find('.match-item-vs-team-name').map((_, n) => txt($(n))).get();
  const scores = el.find('.match-item-vs-team-score').map((_, n) => txt($(n))).get();
  const series = txt(el.find('.match-item-event-series').first());
  const evEl = el.find('.match-item-event').first().clone();
  evEl.find('.match-item-event-series').remove();
  const ev = txt(evEl);
  const etaTxt = txt(el.find('.match-item-eta').first());
  const live = /live/i.test(etaTxt);
  const id = (href.match(/^\/(\d+)/) || [])[1] || href;
  // exact UTC start time if vlr.gg provides it, otherwise estimate from the countdown (rounded to 5 min so the file stays stable)
  const utc = el.find('[data-utc-ts]').first().attr('data-utc-ts');
  let ts = utc ? Date.parse(utc.replace(' ', 'T') + 'Z') : NaN;
  if (isNaN(ts)) {
    const e = etaMs(etaTxt);
    ts = e != null ? Math.round((Date.now() + e) / 3e5) * 3e5 : (oldTs[id] || null);
  }
  if (names.length < 2 || !VCT.test(ev + ' ' + href)) return;
  list.push({ id, a: names[0], b: names[1], sa: scores[0] || '0', sb: scores[1] || '0', ev, ph: series, ts, live, url: BASE + href });
});

const live = list.filter(m => m.live).slice(0, 4).map(({ live, ...m }) => ({ ...m, ts: m.ts || oldTs[m.id] || null }));
const upcoming = list.filter(m => !m.live && m.ts && m.ts > Date.now() - 36e5 && !isTbd(m.a) && !isTbd(m.b))
  .sort((x, y) => x.ts - y.ts).slice(0, 12).map(({ live, ...m }) => m);

// team logos: one match page per match with a missing logo, cached in the JSON so it rarely repeats
const logos = { ...(old.logos || {}) };
const show = [...live, ...upcoming.slice(0, 8)];
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
const keep = new Set(show.flatMap(m => [m.a, m.b]));
for (const k of Object.keys(logos)) if (!keep.has(k)) delete logos[k];

const out = { live, upcoming, logos };
const before = JSON.stringify({ live: old.live || [], upcoming: old.upcoming || [], logos: old.logos || {} });
if (before === JSON.stringify(out)) { console.log('No change'); process.exit(0); }
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), ...out }, null, 1));
console.log(`Wrote ${live.length} live, ${upcoming.length} upcoming`);
