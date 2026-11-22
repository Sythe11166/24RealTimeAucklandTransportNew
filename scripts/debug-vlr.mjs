import * as cheerio from 'cheerio';
const get = async p => (await fetch('https://www.vlr.gg' + p, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PersonalDashboard/1.0)', 'accept-language': 'en' } })).text();
const c = s => s.replace(/\s+/g, ' ').trim();
const $ = cheerio.load(await get('/792907'));
console.log('title:', c($('title').text()).slice(0, 100));
console.log('team links:', $('.match-header-link').map((_, a) => $(a).attr('href')).get().join(' | '));
console.log('nav items:', $('.vm-stats-gamesnav-item').map((_, e) => ($(e).attr('data-game-id') || '') + ':' + c($(e).text()).slice(0, 25)).get().join(' | '));
$('.vm-stats-game').each((_, g) => {
  const G = $(g);
  console.log('GAME', G.attr('data-game-id'), 'tables:', G.find('table').length, 'tr:', G.find('tr').length, 'mod-player:', G.find('.mod-player').length, 'text-of:', G.find('.text-of').length, 'a[href^="/player"]:', G.find('a[href^="/player"]').length, 'rounds cols:', G.find('.vlr-rounds-row-col').length);
  const t = G.find('table').first();
  if (t.length) console.log('  table class:', t.attr('class'), '| html:', c($.html(t)).slice(0, 700));
});
console.log('page-wide a[href^="/player"]:', $('a[href^="/player"]').length, 'tables:', $('table').length);
console.log('first player anchors:', $('a[href^="/player"]').slice(0, 12).map((_, a) => c($(a).text()).slice(0, 30)).get().join(' | '));
for (const t of ['/team/23892/oafs']) {
  const T = cheerio.load(await get(t));
  console.log('TEAM', t, 'roster-items:', T('.team-roster-item').length);
  T('.team-roster-item').each((_, e) => console.log('  ', c(T(e).text()).slice(0, 80), '| alias:', c(T(e).find('.team-roster-item-name-alias').text()), '| role:', c(T(e).find('.team-roster-item-name-role').text())));
  console.log('  headings:', T('.wf-label').map((_, e) => c(T(e).text())).get().slice(0, 12).join(' | '));
}
