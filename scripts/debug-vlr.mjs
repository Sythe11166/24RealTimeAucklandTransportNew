import * as cheerio from 'cheerio';
const get = async p => (await fetch('https://www.vlr.gg' + p, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PersonalDashboard/1.0)', 'accept-language': 'en' } })).text();
const c = s => s.replace(/\s+/g, ' ').trim();
for (const path of ['/792907', '/792908']) {
  const $ = cheerio.load(await get(path));
  console.log('=== MATCH', path, c($('title').text()).slice(0, 60));
  $('.vm-stats-game').slice(0, 3).each((_, g) => {
    const G = $(g), rows = G.find('.ovw-row').not('.mod-head');
    console.log('GAME', G.attr('data-game-id'), 'score:', c(G.find('.vm-stats-game-header .score').text()), 'data rows:', rows.length, 'tables:', G.find('.ovw-table').length);
    if (rows.length) {
      console.log('  ROW0 html:', c($.html(rows.first())).slice(0, 2200));
      if (rows.length > 5) console.log('  ROW5 text:', c(rows.eq(5).text()).slice(0, 200));
    }
  });
}
