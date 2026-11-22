/* =====================================================================
   OFFLINE RENDER  (headless video production — driven by tools/daily.js)
   Plays the next match frame by frame at exactly 60 fps, independent of real time:
   every canvas frame goes to a WebCodecs H.264 encoder and the synthesized sounds are
   rendered with an OfflineAudioContext. Encoded data is handed to the Node runner through
   window.__sink(kind, base64) ('video' = H.264 Annex B stream, 'audio' = 16-bit WAV).
   The match itself runs through the normal App lifecycle, so the league table, history,
   week/group progress and caption are updated exactly as in the browser.
   ===================================================================== */
const Offline = {
  active: false, FPS: 60,
  begin() { this.active = true; App.running = false; },

  /* one main-loop frame, identical to frame() in 05_app.js but with a fixed real-time step */
  stepFrame(st, rdt) {
    const g = App.game;
    let dtW = 0;
    if (g && !g.over && App.introOn()) {
      App.introT += rdt;
    } else if (g && !g.over) {
      const ts = g.timeScale();
      st.acc += rdt * ts;
      let n = 0;
      while (st.acc >= DT && n < 200) { g.step(DT); st.acc -= DT; n++; if (g.over) break; }
      if (n >= 200) st.acc = 0;
      dtW = rdt * ts;
      App.matchRealT += rdt;
      if (g.over && !App.end) App.onOver();
    } else if (App.end) dtW = rdt;
    FX.update(dtW, rdt);
    if (App.end) App.endT += rdt;
  },

  /* exact number of video frames for a match: replays the same loop on a copy of the game (deterministic) */
  countFrames(opts, rdt) {
    const g = new Game(opts);
    let acc = 0, n = 0;
    while (!g.over && n < 60 * 60 * 30) {
      acc += rdt * g.timeScale();
      let k = 0;
      while (acc >= DT && k < 200) { g.step(DT); acc -= DT; k++; if (g.over) break; }
      if (k >= 200) acc = 0;
      n++;
    }
    return n + Math.ceil((CONFIG.INTRO_DURATION + CONFIG.END_DURATION + 0.3) / rdt) + 1;
  },

  async blobB64(blob) {
    const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
    return url.slice(url.indexOf(',') + 1);
  },

  async pickCodec(w, h, bitrate) {
    for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.42e033']) {
      const cfg = /** @type {VideoEncoderConfig} */ ({ codec, width: w, height: h, bitrate, framerate: this.FPS, avc: { format: 'annexb' }, latencyMode: 'quality' });
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch (e) { /* try next */ }
    }
    throw new Error('Bu tarayıcıda H.264 VideoEncoder yok.');
  },

  wav(buf, frames) {
    const ch = buf.numberOfChannels, rate = buf.sampleRate, n = Math.min(frames, buf.length);
    const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, rate, true);
    out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7FFF, true); o += 2; }
    return new Blob([out.buffer], { type: 'audio/wav' });
  },

  /* --- a finished match of the LIVE league as a video (tools/instagram.js) ----------------------------------------------------
     state: the live league as it stood before the match's slot (Live.lastClean's data), ch: 'main' | 'promo'. The match is set up
     exactly as the site played it (same seed, clubs, theme, intro and animated end table), so it is the very match the site showed.
     hook: { title, sub, color } — a banner over the first seconds (why this match matters). Returns the goals' times in the video
     (s) so a short cut of the same file (a story) can be made, and the final whistle's time. */
  HOOK_T: 2.9,
  drawHook(ctx, hook, t) {
    const T = this.HOOK_T, a = t < 0.25 ? t / 0.25 : t > T - 0.4 ? Math.max(0, (T - t) / 0.4) : 1;
    if (a <= 0) return;
    const pop = t < 0.35 ? 0.82 + 0.18 * Math.sin((t / 0.35) * Math.PI / 2) : 1, W = Renderer.canvas.width, y = 610;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(6,9,15,0.86)'; ctx.fillRect(0, y - 175, W, 350);
    ctx.fillStyle = hook.color || '#FFD54F'; ctx.fillRect(0, y - 175, W, 10); ctx.fillRect(0, y + 165, W, 10);
    ctx.translate(W / 2, y - 20); ctx.scale(pop, pop);
    let fs = 150; ctx.font = `${fs}px ${FONT_BIG}`;
    while (ctx.measureText(hook.title).width > W - 90 && fs > 60) { fs -= 4; ctx.font = `${fs}px ${FONT_BIG}`; }
    outlinedText(ctx, hook.title, 0, 0, `${fs}px ${FONT_BIG}`, hook.color || '#FFD54F', '#000000', 10);
    if (hook.sub) {
      let ss = 46; ctx.font = `700 ${ss}px ${FONT_UI}`;
      while (ctx.measureText(hook.sub).width > W - 110 && ss > 24) { ss -= 2; ctx.font = `700 ${ss}px ${FONT_UI}`; }
      outlinedText(ctx, hook.sub, 0, fs * 0.5 + 44, `700 ${ss}px ${FONT_UI}`, '#ffffff', '#000000', 6);
    }
    ctx.restore();
  },
  async renderLive({ state, ch = 'main', bitrate = 10e6, hook = null }) {
    this.begin();
    const fps = this.FPS, rdt = 1 / fps, c = Renderer.canvas, ctx = Renderer.ctx;
    Live.on = true;                                              // live seeds (the league's), not the studio's random ones
    Live.adopt(state);
    const m = Live.computeNext(), M = m.ms.find(x => x.ch === ch);
    if (!M) throw new Error(`no ${ch} match in this slot`);
    if (!App.load(M.s)) throw new Error(M.s.err || 'match could not be set up');
    const s = App.setup, total = this.countFrames(s.opts, rdt);
    AudioSys.initOffline(total / fps + 2);
    App.running = true; App.paused = false;
    let i = 0, whistle = 0;
    const goals = [], g = App.game, fx = g.onEvent;
    g.onEvent = (type, d) => {
      if (fx) fx(type, d);
      if (type === 'goal') goals.push({ t: i / fps, clock: g.clock, side: d.benefit, score: d.score.slice(), golden: !!d.golden });
      else if (type === 'win' && !whistle) whistle = i / fps;
    };
    const cfg = await this.pickCodec(c.width, c.height, bitrate);
    const pend = []; let pendBytes = 0, encErr = null;
    const enc = new VideoEncoder({
      output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); pend.push(b); pendBytes += b.length; },
      error: (e) => { encErr = e; },
    });
    enc.configure(cfg);
    const flush = async () => {
      if (!pend.length) return;
      const blob = new Blob(pend); pend.length = 0; pendBytes = 0;
      await window.__sink('video', await this.blobB64(blob));
    };
    const st = { acc: 0 };
    for (;;) {
      AudioSys.clock = i / fps;
      this.stepFrame(st, rdt);
      Renderer.draw(App.game, App);
      if (hook && i / fps < this.HOOK_T) this.drawHook(ctx, hook, i / fps);
      const vf = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      i++;
      if (encErr) throw encErr;
      while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 0));
      if (pendBytes > 4e6) await flush();
      if (App.end && App.endT >= CONFIG.END_DURATION + 0.3) break;
      if (i > total + fps * 5) throw new Error('video ran longer than expected');
    }
    await enc.flush(); enc.close();
    if (encErr) throw encErr;
    await flush();
    AudioSys.clock = null;
    const buf = await AudioSys.ctx.startRendering();
    await window.__sink('audio', await this.blobB64(this.wav(buf, Math.round(i / fps * buf.sampleRate))));
    AudioSys.ctx = null; AudioSys.offline = false;
    App.running = false;
    const [H, A] = g.teams;
    return { frames: i, seconds: i / fps, intro: CONFIG.INTRO_DURATION, whistle, goals, codec: cfg.codec,
      home: { id: H.id, name: H.name, code: H.code, score: H.score }, away: { id: A.id, name: A.name, code: A.code, score: A.score },
      pens: g.pens ? [H.pen, A.pen] : null, title: App.title };
  },

  /* plays + encodes the next match of the current league settings */
  async renderMatch({ bitrate = 10e6 } = {}) {
    if (!this.active) this.begin();
    const fps = this.FPS, rdt = 1 / fps, c = Renderer.canvas;
    if (!App.prepare()) throw new Error(App.setup && App.setup.err || 'Maç hazırlanamadı.');
    const s = App.setup;
    const total = this.countFrames(s.opts, rdt);
    AudioSys.initOffline(total / fps + 2);
    App.running = true; App.paused = false;

    const cfg = await this.pickCodec(c.width, c.height, bitrate);
    const pend = []; let pendBytes = 0, encErr = null;
    const enc = new VideoEncoder({
      output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); pend.push(b); pendBytes += b.length; },
      error: (e) => { encErr = e; },
    });
    enc.configure(cfg);
    const flush = async () => {
      if (!pend.length) return;
      const blob = new Blob(pend); pend.length = 0; pendBytes = 0;
      await window.__sink('video', await this.blobB64(blob));
    };

    const st = { acc: 0 };
    let i = 0;
    for (;;) {
      AudioSys.clock = i / fps;
      this.stepFrame(st, rdt);
      Renderer.draw(App.game, App);
      const vf = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      i++;
      if (encErr) throw encErr;
      while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 0));
      if (pendBytes > 4e6) await flush();
      if (App.end && App.endT >= CONFIG.END_DURATION + 0.3) break;
      if (i > total + fps * 5) throw new Error('Video beklenenden uzun sürdü.');
    }
    await enc.flush(); enc.close();
    if (encErr) throw encErr;
    await flush();

    AudioSys.clock = null;
    const buf = await AudioSys.ctx.startRendering();
    await window.__sink('audio', await this.blobB64(this.wav(buf, Math.round(i / fps * buf.sampleRate))));
    AudioSys.ctx = null; AudioSys.offline = false;
    App.running = false;

    const E = App.end, d = League.data;
    return {
      title: App.title, mode: s.mode, week: s.week, weekMatch: s.weekMatch, seed: s.seed, theme: s.theme,
      frames: i, seconds: i / fps, codec: cfg.codec,
      winner: E.winner.name, subtitle: E.subtitle,
      standings: E.standings.map(x => ({ place: x.place, name: x.name, code: x.code, gf: x.gf, pts: x.pts })),
      caption: $('caption').value,
      base: s.cup ? `s${d.season || 1}_playoff_${String(CUP_SHAPE.findIndex(m => m.k === s.cup) + 1).padStart(2, '0')}_${s.cup}` : `s${d.season || 1}_week${String(s.week).padStart(2, '0')}_match${s.weekMatch}`,
    };
  }
};
