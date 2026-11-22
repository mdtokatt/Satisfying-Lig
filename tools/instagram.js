#!/usr/bin/env node
/*
  Instagram günü — canlı ligin BİR ÖNCEKİ GÜNÜNDEN (İstanbul saatiyle 00:00–24:00) kritik maçları seçer ve videolarını üretir:
    • 2 Reels videosu  (tam maç, ~105 sn: giriş, maç, animasyonlu tablo; ilk 3 saniyede "neden kritik" yazısı)
    • 3 Story videosu  (aynı maçın kısa kesiti, ≤ 50 sn: kanca yazısı, goller, son düdük ve tablo)
  ve her biri için hazır açıklama metni (İngilizce + Türkçe, etiketler, maçın tekrar bağlantısı).

  Kullanım:  node tools/instagram.js [--date YYYY-MM-DD] [--out KLASÖR] [--reels 2] [--stories 3] [--no-render] [--bitrate MBPS]
    --date       hangi gün (İstanbul); varsayılan: dün
    --no-render  yalnızca seçim (summary.json, captions.txt); video üretmez
  Ortam:     LIVE_URL (varsayılan https://mdtokatt.github.io/Satisfying-Lig/) — maçlar yayındaki sitenin KENDİ koduyla hesaplanır.

  Kritik maç ölçütleri (puanlar KRITIK içinde): şampiyonluğu belirleyen maç, yükselme finali, lideri değiştiren maç, farklı skor
  (5+ fark), çok gollü maç (14+ gol; ortalama ~9), geriden gelme (2+ farkı çevirme), son saniye golü (son 10 sn'de galibiyet ya da
  beraberlik golü), altın gol / penaltılar, zirve maçı (ilk 3'ün maçı), sürpriz (8+ sıra aşağıdaki takımın galibiyeti).
  Çeşitlilik: bir kulüp en fazla 2 içerikte; aynı türden ikinci maç biraz geri düşer. Seçilen beş maçın en yüksek puanlı ikisi Reels, diğer üçü Story olur.

  Lig durumu: maçları hesaplamak için günün başındaki lig durumu gerekir. Araç, günün sonundaki durumu data/instagram/state.json'a
  yazar; tools/instagram-save.sh onu instagram-data dalına kaydeder, ertesi gün oradan (state-branch.json) devam edilir (~1 dk).
  Geçerli bir durum yoksa (başka kurallar, ilk çalıştırma) yayındaki sitenin tabanından hesaplar (gün başına ~1 dk daha).
  Videolar repodaki kodla (index.html) üretilir; yayındaki sitenin simülasyonu farklıysa (parmak izi) araç durur.

  Çıktı: out/instagram/<tarih>/ reel-1.mp4, reel-2.mp4, story-1.mp4 … story-3.mp4, captions.txt, summary.json
  Gereken: Node 18+, Playwright + Chromium, ffmpeg.
*/
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { loadPage } = require('./live-node.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const SITE = (process.env.LIVE_URL || 'https://mdtokatt.github.io/Satisfying-Lig/').replace(/\/?$/, '/');
const TZ = 3 * 3600e3;                                            // İstanbul (UTC+3, yaz saati yok)
const istDay = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const day = opt('--date', istDay(Date.now() - 864e5));
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { console.error('--date YYYY-MM-DD olmalı'); process.exit(2); }
const dayStart = Date.parse(day + 'T00:00:00+03:00'), dayEnd = dayStart + 864e5;
const N_REELS = +opt('--reels', 2), N_STORIES = +opt('--stories', 3), RENDER = !args.includes('--no-render');
const bitrate = +opt('--bitrate', 10) * 1e6;
const outDir = path.resolve(ROOT, opt('--out', path.join('out', 'instagram', day)));
const stateFile = path.join(ROOT, 'data', 'instagram', 'state.json');
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/* --- what makes a match critical --------------------------------------------------------------------------------------------
   every tag: weight (w), the hook on the video (title, color) and a line for the caption (en, tr). The hook never gives away the result. */
const KRITIK = {
  title:    { w: () => 100, title: 'TITLE DECIDER', color: '#FFD54F' },     // the champion played this match
  titleBy:  { w: () => 40, title: 'TITLE DECIDED', color: '#FFD54F' },      // this result made another club champion
  promoFin: { w: () => 70, title: 'PROMOTION FINAL', color: '#00E676' },
  leader:   { w: () => 60, title: 'NEW LEADER!', color: '#FFD54F' },
  promoLdr: { w: () => 30, title: 'NEW LEADER!', color: '#00E676' },
  margin:   { w: (x) => 20 + 8 * (x - 5), title: 'TOTAL DOMINATION', color: '#FF5252' },
  goals:    { w: (x) => 20 + 5 * (x - 14), title: (x) => `${x} GOALS!`, color: '#FF9100' },
  comeback: { w: (x) => 25 + 12 * (x - 2), title: 'EPIC COMEBACK', color: '#40C4FF' },
  cbDraw:   { w: () => 20, title: 'COMEBACK!', color: '#40C4FF' },
  late:     { w: () => 25, title: 'LAST-SECOND DRAMA', color: '#FF4081' },
  pens:     { w: () => 30, title: 'PENALTY SHOOTOUT', color: '#E040FB' },
  golden:   { w: () => 20, title: 'GOLDEN GOAL', color: '#FFD54F' },
  top:      { w: () => 15, title: 'TOP-OF-THE-TABLE CLASH', color: '#FFD54F' },
  upset:    { w: () => 15, title: 'GIANT KILLING', color: '#69F0AE' },
};

(async () => {
  /* 1) the live league exactly as the site plays it: the published page's own code, start and base */
  log(`Gün: ${day} (İstanbul) · site: ${SITE}`);
  const html = await (await fetch(SITE, { cache: 'no-store' })).text();
  const L = loadPage(html), { Live, League, CONFIG } = L;
  const simLive = Live.sim();
  /* the goals of every computed match (time, side, score): Live.computeNext times each new game with timeGame */
  const timeGame = Live.timeGame.bind(Live);
  Live.timeGame = (g) => { const goals = []; g.__goals = goals; const ev = g.onEvent; g.onEvent = (t, d) => { if (ev) ev(t, d); if (t === 'goal') goals.push({ clock: g.clock, side: d.benefit, score: d.score.slice(), golden: !!d.golden }); }; return timeGame(g); };

  /* 2) the league at the start of the day: the furthest saved state that ended by then (our own file, the site's checkpoint, the site's base) */
  const cands = [];
  /* state.json: the repo's (and this run's); state-branch.json: the newest one, kept on the instagram-data branch (tools/instagram-save.sh) */
  for (const f of [stateFile, path.join(path.dirname(stateFile), 'state-branch.json')]) {
    if (fs.existsSync(f)) cands.push([path.relative(ROOT, f), Live.parseState(fs.readFileSync(f, 'utf8'))]);
  }
  try { const r = await fetch(new URL('live-state.json', SITE), { cache: 'no-store' }); if (r.ok) cands.push(['sitenin checkpoint\'i', Live.parseState(await r.text())]); } catch (e) { /* none */ }
  cands.push(['sitenin tabanı', Live.baseState()]);
  const ok = cands.filter(([, d]) => d && (d.liveLastEnd || 0) <= dayStart).sort((a, b) => (b[1].liveCount || 0) - (a[1].liveCount || 0));
  if (ok.length) Live.adopt(ok[0][1]); else Live.adopt(null);
  log(`Başlangıç: ${ok.length ? ok[0][0] : 'ligin başı'} (${League.data.liveCount} maç)`);
  const t0 = Date.now();
  await Live.catchUp(0, () => dayStart);
  log(`Günün başına gelindi: ${League.data.liveCount} maç (${((Date.now() - t0) / 1000).toFixed(0)} sn)`);

  /* 3) the day, slot by slot: every match with the table before and after it */
  Live.snapshot();
  let safe = Live.lastClean;                                     // the last state whose matches had all ended by the day's end (saved for tomorrow)
  const recs = [], t1 = Date.now();
  const rankOf = (div) => (div === 'promo' ? (League.promoOn() ? League.promoRanking() : []) : League.ranking());
  /* the title is decided: the leader can no longer be caught (or the league's last match is played) */
  const clinched = () => {
    const d = League.data, rk = League.ranking();
    if (League.mainOver()) return true;
    return rk.length > 1 && rk[0].r.pts - rk[1].r.pts > (d.seasonLength - rk[1].r.played) * d.points[0];
  };
  while (Live.nextStart() < dayEnd) {
    const before = Live.lastClean, m = Live.computeNext();
    for (const M of m.ms) {
      const s = M.s, div = s.div === 'promo' ? 'promo' : 'main', cup = s.cup || null, g = M.g;
      const rb = cup ? [] : rankOf(div), cb = div === 'main' && !cup && clinched();
      Live.recordOne(M);
      const ra = cup ? [] : rankOf(div), ca = div === 'main' && !cup && clinched();
      const [H, A] = g.teams, res = g.getResult();
      recs.push({ n: m.n, start: M.start, ch: M.ch, div, cup, season: League.data.season, week: s.week, wm: s.weekMatch, seed: s.seed, theme: s.theme,
        home: { id: H.id, name: H.name, code: H.code }, away: { id: A.id, name: A.name, code: A.code }, hs: H.score, as: A.score,
        winner: g.winner, pens: g.pens ? [H.pen, A.pen] : null, golden: !!res.golden && !g.pens, goals: g.__goals || [],
        before: { rank: rb.map(x => x.t.id), pts: rb.map(x => x.r.pts), played: rb.map(x => x.r.played) },
        after: { rank: ra.map(x => x.t.id), pts: ra.map(x => x.r.pts), played: ra.map(x => x.r.played) },
        clinch: !cb && ca, champion: !cb && ca ? League.ranking()[0].t.name : null, championId: !cb && ca ? League.ranking()[0].t.id : null,
        state: before, inDay: M.start >= dayStart });
    }
    Live.closeMatch(m);
    if ((League.data.liveLastEnd || 0) <= dayEnd) safe = Live.lastClean;
  }
  log(`Günün maçları: ${recs.filter(r => r.inDay).length} (${((Date.now() - t1) / 1000).toFixed(0)} sn) · lig: Sezon ${League.data.season}, ${League.data.liveCount} maç`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, safe);

  /* 4) how critical is each match */
  const MT = CONFIG.MATCH_TIME;
  for (const r of recs) {
    const tags = [], add = (k, x) => tags.push({ k, x, w: KRITIK[k].w(x) });
    const tot = r.hs + r.as, mar = Math.abs(r.hs - r.as), win = r.winner;      // winner: 0 home, 1 away, -1 draw
    if (r.clinch) add(r.championId === r.home.id || r.championId === r.away.id ? 'title' : 'titleBy');
    if (r.div === 'promo' && r.cup === 'FIN') add('promoFin');
    const lb = r.before.rank[0], la = r.after.rank[0];
    if (!r.cup && lb && la && lb !== la && r.before.played[0] > 0) add(r.div === 'main' ? 'leader' : 'promoLdr');
    if (mar >= 5) add('margin', mar);
    if (tot >= 14) add('goals', tot);
    /* the biggest deficit the winner (or a drawing side) came back from */
    let worst = [0, 0];
    for (const gl of r.goals) { const [a, b] = gl.score; worst[0] = Math.max(worst[0], b - a); worst[1] = Math.max(worst[1], a - b); }
    if (win >= 0 && worst[win] >= 2) add('comeback', worst[win]);
    else if (win < 0 && Math.max(...worst) >= 3) add('cbDraw', Math.max(...worst));
    /* a goal in the last 10 s of normal time that won or saved the match */
    const lastG = r.goals.filter(gl => !gl.golden).slice(-1)[0];
    if (lastG && lastG.clock >= MT - 10) { const [a, b] = lastG.score; if ((win >= 0 && Math.abs(a - b) === 1 && (a > b ? 0 : 1) === win) || (win < 0 && a === b)) add('late'); }
    if (r.pens) add('pens'); else if (r.golden) add('golden');
    const pos = (id) => r.before.rank.indexOf(id), pl = (id) => r.before.played[pos(id)] || 0;
    if (!r.cup && pos(r.home.id) >= 0 && pos(r.home.id) < 3 && pos(r.away.id) < 3 && pl(r.home.id) >= 3) add('top');
    if (!r.cup && win >= 0 && pl(r.home.id) >= 3 && pl(r.away.id) >= 3) { const w = win === 0 ? r.home.id : r.away.id, l = win === 0 ? r.away.id : r.home.id; if (pos(w) - pos(l) >= 8) add('upset'); }
    tags.sort((a, b) => b.w - a.w);
    r.tags = tags;
    r.score = tags.reduce((s, t) => s + t.w, 0) * (r.div === 'promo' ? 0.85 : 1) + tot * 0.1;   // goals break ties
  }

  /* 5) the day's picks: the most critical first, a club at most twice, the same kind of story a bit later */
  const pool = recs.filter(r => r.inDay).sort((a, b) => b.score - a.score), picks = [], clubs = new Map(), kinds = new Map();
  const want = N_REELS + N_STORIES;
  while (picks.length < want && pool.length) {
    let best = -1, bs = -1;
    pool.forEach((r, i) => {
      if ((clubs.get(r.home.id) || 0) >= 2 || (clubs.get(r.away.id) || 0) >= 2) return;
      const k = r.tags.length ? r.tags[0].k : 'none', v = r.score * Math.pow(0.75, kinds.get(k) || 0);
      if (v > bs) { bs = v; best = i; }
    });
    if (best < 0) break;
    const r = pool.splice(best, 1)[0];
    picks.push(r);
    for (const id of [r.home.id, r.away.id]) clubs.set(id, (clubs.get(id) || 0) + 1);
    const k = r.tags.length ? r.tags[0].k : 'none'; kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  picks.sort((a, b) => b.score - a.score);                       // the five chosen, the two most critical are the Reels
  picks.forEach((r, i) => { r.kind = i < N_REELS ? 'reel' : 'story'; r.file = r.kind === 'reel' ? `reel-${i + 1}.mp4` : `story-${i - N_REELS + 1}.mp4`; r.replay = replayLink(r); });
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of picks) log(`${r.kind === 'reel' ? '🎬 Reels' : '📱 Story'} · ${label(r)} · ${r.home.name} ${r.hs}–${r.as} ${r.away.name} · puan ${r.score.toFixed(0)} · ${r.tags.map(t => t.k).join(', ') || '—'}`);

  /* 6) the videos: the repo's own page (the same simulation as the site's) renders each match frame by frame */
  const videos = [];
  if (RENDER && picks.length) {
    const simHere = execFileSync('node', [path.join(__dirname, 'live-fingerprint.js')]).toString().trim();
    if (simHere !== simLive) throw new Error(`Yayındaki sitenin simülasyonu (${simLive}) repodakinden (${simHere}) farklı: önce siteyi yayınlayın (main), sonra yeniden çalıştırın.`);
    const tmp = path.join(outDir, '.tmp'); fs.mkdirSync(tmp, { recursive: true });
    const page_ = path.join(tmp, 'app.html');
    execFileSync('sh', [path.join(ROOT, 'build.sh'), page_], { stdio: 'ignore' });
    let chromium;
    try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright'))); }
    const browser = await chromium.launch();
    try {
      for (const r of picks) {
        const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
        page.on('pageerror', e => log('Sayfa hatası:', e.message));
        let sink = null;
        await page.exposeFunction('__sink', (kind, b64) => { if (sink) sink(kind, Buffer.from(b64, 'base64')); });
        await page.goto('file://' + page_ + '?studio');
        await page.waitForFunction(() => typeof Offline !== 'undefined' && typeof App !== 'undefined' && App.setup, null, { timeout: 30000 });
        await page.evaluate(() => document.fonts.ready);
        const vPath = path.join(tmp, 'v.h264'), aPath = path.join(tmp, 'a.wav'), full = path.join(tmp, 'full.mp4');
        const vOut = fs.openSync(vPath, 'w'), aOut = fs.openSync(aPath, 'w');
        sink = (kind, buf) => fs.writeSync(kind === 'video' ? vOut : aOut, buf);
        const t2 = Date.now(), k = KRITIK[r.tags.length ? r.tags[0].k : 'goals'];
        const hook = { title: r.tags.length ? (typeof k.title === 'function' ? k.title(r.tags[0].x) : k.title) : `${r.hs + r.as} GOALS!`, color: k.color, sub: `${upper(r.home.name)} vs ${upper(r.away.name)}` };
        let v;
        try { v = await page.evaluate(([st, ch, b, h]) => Offline.renderLive({ state: JSON.parse(st).data, ch, bitrate: b, hook: h }), [r.state, r.ch, bitrate, hook]); }
        finally { sink = null; fs.closeSync(vOut); fs.closeSync(aOut); await page.close(); }
        if (v.home.id !== r.home.id || v.home.score !== r.hs || v.away.score !== r.as) throw new Error(`Video maçı sitedekiyle aynı değil: ${v.home.code} ${v.home.score}–${v.away.score} ${v.away.code}`);
        execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-r', '60', '-f', 'h264', '-i', vPath, '-i', aPath,
          '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', full]);
        const dst = path.join(outDir, r.file);
        if (r.kind === 'reel') {
          /* the encoder's 10 Mbps stream → x264 (CRF 20): the same picture at a size a phone uploads easily (~40 MB instead of ~130 MB) */
          execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', full, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
            '-r', '60', '-g', '120', '-c:a', 'copy', '-movflags', '+faststart', dst]);
        } else cutStory(full, dst, v);
        fs.rmSync(full);
        const secs = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst]).toString().trim();
        log(`✅ ${r.file} · ${secs.toFixed(1)} sn · ${(fs.statSync(dst).size / 1048576).toFixed(1)} MB · ${((Date.now() - t2) / 1000).toFixed(0)} sn'de üretildi`);
        videos.push({ file: r.file, seconds: +secs.toFixed(1) });
      }
    } finally { await browser.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  /* 7) captions and the summary */
  const caps = picks.map(r => `=== ${r.file} (${r.kind === 'reel' ? 'Reels' : 'Story'}) ===\n${caption(r, 'en')}\n\n--- Türkçe ---\n${caption(r, 'tr')}\n`);
  fs.writeFileSync(path.join(outDir, 'captions.txt'), caps.join('\n'));
  const summary = { day, site: SITE, sim: simLive, matches: recs.filter(r => r.inDay).length, picks: picks.map(r => ({
    file: r.file, kind: r.kind, what: label(r), home: r.home.name, away: r.away.name, score: `${r.hs}–${r.as}`, pens: r.pens, golden: r.golden,
    kickoff: new Date(r.start).toISOString(), critical: r.tags.map(t => t.k), points: +r.score.toFixed(1), replay: r.replay })), videos };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  log(`Bitti → ${path.relative(ROOT, outDir)} (${videos.length} video)`);
  console.log('SUMMARY ' + JSON.stringify(summary));

  /* --- helpers ------------------------------------------------------------------------------------------------------------ */
  function replayLink(r) {
    const what = r.cup ? 'c' + r.cup : `${r.div === 'promo' ? 'p' : 'w'}${r.week}m${r.wm}`;
    return `${SITE}?tekrar=1.${simLive}.${r.seed >>> 0}.${r.home.id}.${r.away.id}.${r.theme}.${what}.${Math.round(r.start / 1000)}`;
  }
  function cupName(k) { return k === 'FIN' ? 'Final' : k === '3RD' ? 'Third place' : k.startsWith('SF') ? `Semi-final ${k.slice(-1)}` : k.startsWith('QF') ? `Quarter-final ${k.slice(-1)}` : `Round 1 · ${k.slice(-1)}`; }
  function label(r) { return r.cup ? `${r.div === 'promo' ? 'Promotion playoff' : 'Playoff'} · ${cupName(r.cup)}` : `${r.div === 'promo' ? 'Promotion league' : 'League'} · Season ${r.season} · Week ${r.week}`; }
}
)().catch(e => { console.error('❌', e && e.stack || e); process.exit(1); });

function upper(s) { return /[çğışöüÇĞİŞÖÜ]/.test(s) ? s.toLocaleUpperCase('tr-TR') : s.toUpperCase(); }
const tag = (s) => '#' + String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^A-Za-z0-9]/g, '');

/* the caption: what happened and why it matters, the replay link, hashtags (en: the global post, tr: the same in Turkish) */
function caption(r, lang) {
  const H = r.home.name, A = r.away.name, sc = `${H} ${r.hs}–${r.as} ${A}`, W = r.winner === 0 ? H : r.winner === 1 ? A : null;
  const en = lang === 'en', lines = [];
  const what = r.cup ? (en ? `${r.div === 'promo' ? 'Promotion playoff' : 'Playoff'} ${r.cup === 'FIN' ? 'final' : r.cup}` : `${r.div === 'promo' ? 'Yükselme elemesi' : 'Eleme'} ${r.cup === 'FIN' ? 'finali' : r.cup}`)
    : en ? `${r.div === 'promo' ? 'Promotion league' : 'League'} · Season ${r.season} · Week ${r.week}` : `${r.div === 'promo' ? 'Yükselme ligi' : 'Lig'} · Sezon ${r.season} · ${r.week}. hafta`;
  lines.push(`⚽ ${sc}${r.pens ? (en ? ` (pens ${r.pens[0]}–${r.pens[1]})` : ` (penaltılar ${r.pens[0]}–${r.pens[1]})`) : r.golden ? (en ? ' (golden goal)' : ' (altın gol)') : ''}`, what, '');
  const leaderName = (id) => (id === r.home.id ? H : id === r.away.id ? A : id);
  for (const t of r.tags) {
    const x = t.x;
    const s = {
      title: en ? `🏆 ${r.champion} are the Season ${r.season} champions!` : `🏆 ${r.champion} Sezon ${r.season} şampiyonluğunu ilan etti!`,
      titleBy: en ? `🏆 This result hands ${r.champion} the Season ${r.season} title!` : `🏆 Bu sonuç Sezon ${r.season} şampiyonluğunu ${r.champion} takımına getirdi!`,
      promoFin: en ? `🔺 ${W} win the final and go up to the league!` : `🔺 ${W} finali kazandı ve lige yükseldi!`,
      leader: en ? `👑 ${leaderName(r.after.rank[0])} take over at the top!` : `👑 ${leaderName(r.after.rank[0])} zirveye yerleşti!`,
      promoLdr: en ? `👑 ${leaderName(r.after.rank[0])} lead the promotion league!` : `👑 ${leaderName(r.after.rank[0])} yükselme liginde zirvede!`,
      margin: en ? `💥 A ${x}-goal winning margin.` : `💥 ${x} gol farkla galibiyet.`,
      goals: en ? `🔥 ${x} goals in 90 seconds!` : `🔥 90 saniyede ${x} gol!`,
      comeback: en ? `🔄 ${W} came back from ${x} goals down!` : `🔄 ${W} ${x} gol geriden gelip kazandı!`,
      cbDraw: en ? `🔄 Back from ${x} down to rescue a draw!` : `🔄 ${x} gol geriden gelip beraberliği kurtardı!`,
      late: en ? '⏱️ Decided in the last 10 seconds!' : '⏱️ Son 10 saniyede belirlendi!',
      pens: en ? '🎯 Settled on penalties!' : '🎯 Penaltılarla belirlendi!',
      golden: en ? '✨ Settled by a golden goal!' : '✨ Altın golle belirlendi!',
      top: en ? '⚔️ A top-three showdown.' : '⚔️ İlk üçün kapışması.',
      upset: en ? `😱 ${W} stun a side far above them!` : `😱 ${W} kendisinden çok yukarıdaki rakibini devirdi!`,
    }[t.k];
    if (s) lines.push(s);
  }
  lines.push('', en ? `▶ Watch this match again: ${replayLinkOf(r)}` : `▶ Maçı yeniden izle: ${replayLinkOf(r)}`,
    en ? '⚽ A new match every 3 minutes, 24/7 — link in bio. Comment your team 👇' : '⚽ Her 3 dakikada yeni maç, 7/24 — bağlantı profilde. Takımını yaz 👇', '',
    ['#satisfyinglig', '#football', '#soccer', '#satisfying', '#futbol', '#oddlysatisfying', '#footballshorts', tag(H), tag(A)].join(' '));
  return lines.join('\n');
}
function replayLinkOf(r) { return r.replay || ''; }

/* a story: the hook, the goals that mattered (the equalisers and go-ahead goals first, the last goal always), the final whistle and
   the table — at most ~50 s, cut from the full match video (re-encoded, so the cuts are frame-exact) */
function cutStory(src, dst, v) {
  const goals = v.goals.map((g, i) => {
    const [a, b] = g.score, prev = i ? v.goals[i - 1].score : [0, 0], before = prev[0] - prev[1], after = a - b;
    let imp = 1;
    if (Math.sign(before) !== Math.sign(after)) imp += 3;        // equaliser or a goal that takes the lead
    if (i === v.goals.length - 1) imp += 2;
    if (g.clock >= 75) imp += 2;
    return { t: g.t, imp, i };
  });
  const BUDGET = 34, win = (t) => [Math.max(v.intro + 0.2, t - 2.6), t + 1.5];
  const chosen = [], merged = () => {
    const w = chosen.map(g => win(g.t)).sort((x, y) => x[0] - y[0]), out = [];
    for (const s of w) { const l = out[out.length - 1]; if (l && s[0] <= l[1] + 0.3) l[1] = Math.max(l[1], s[1]); else out.push(s.slice()); }
    return out;
  };
  const len = () => merged().reduce((s, x) => s + x[1] - x[0], 0);
  for (const g of goals.slice().sort((x, y) => y.imp - x.imp || y.t - x.t)) { chosen.push(g); if (len() > BUDGET) chosen.pop(); }
  const segs = [[0, 3.2]].concat(merged()).concat([[Math.max(v.whistle - 0.8, 0), v.seconds]]);
  /* no overlap with the hook or the end */
  const fixed = [];
  for (const s of segs) { const l = fixed[fixed.length - 1]; if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]); else fixed.push(s.slice()); }
  /* each part on its own (accurate seek, a short fade on the sound at the cuts), all with the same settings, then joined without
     re-encoding: memory stays small (one filter graph over the whole file would buffer every frame) */
  const dir = path.join(path.dirname(dst), '.parts-' + path.basename(dst, '.mp4')), list = [];
  fs.mkdirSync(dir, { recursive: true });
  fixed.forEach(([a, b], i) => {
    const f = path.join(dir, `p${i}.mp4`), d = b - a;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', a.toFixed(3), '-i', src, '-t', d.toFixed(3),
      '-af', `afade=t=in:d=0.04,afade=t=out:st=${Math.max(0, d - 0.06).toFixed(3)}:d=0.06`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '60', '-g', '120', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', f]);
    list.push(`file '${f}'`);
  });
  fs.writeFileSync(path.join(dir, 'list.txt'), list.join('\n') + '\n');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', dst]);
  fs.rmSync(dir, { recursive: true, force: true });
}
