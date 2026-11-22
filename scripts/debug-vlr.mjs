import * as cheerio from 'cheerio';
const get = async p => (await fetch('https://www.vlr.gg' + p, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PersonalDashboard/1.0)', 'accept-language': 'en' } })).text();
const c = s => s.replace(/\s+/g, ' ').trim();
for (const path of ['/792907', '/792908']) {
  const $ = cheerio.load(await get(path));
  console.log('=== MATCH', path, c($('title').text()).slice(0, 60));
  $('.vm-stats-game').slice(0, 2).each((_, g) => {
    const G = $(g), mp = G.find('.mod-player').first();
    console.log('GAME', G.attr('data-game-id'), 'header score:', c(G.find('.vm-stats-game-header .score').text()));
    let a = mp, chain = [];
    for (let i = 0; i < 6 && a.length; i++) { chain.push((a.get(0).tagName || '') + '.' + (a.attr('class') || '').replace(/\s+/g, '.')); a = a.parent(); }
    console.log('  chain:', chain.join(' < '));
    const row = mp.parent();
    console.log('  ROW html:', c($.html(row)).slice(0, 1800));
    console.log('  row siblings with mod-player:', row.parent().children().length, '| row class:', row.attr('class'));
  });
}
