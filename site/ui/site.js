/* mcp-pin site motion. No dependencies. Everything degrades to a readable page without it. */
(() => {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const pad = (n) => String(n).padStart(3, '0');

  /* ------------------------------------------------------------ nav */
  const nav = $('.nav');
  const onNav = () => nav && nav.classList.toggle('solid', scrollY > 24 || nav.classList.contains('open'));
  addEventListener('scroll', onNav, { passive: true }); onNav();
  const menu = $('.menu');
  if (menu) menu.addEventListener('click', () => { nav.classList.toggle('open'); menu.setAttribute('aria-expanded', nav.classList.contains('open')); onNav(); });

  /* ------------------------------------------------------------ reveal */
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -12% 0px' });
  $$('[data-reveal]').forEach((el) => io.observe(el));

  /* ------------------------------------------------------------ frame sequences (canvas, scrubbed) */
  class Seq {
    constructor(canvas) {
      this.c = canvas; this.ctx = canvas.getContext('2d');
      this.base = canvas.dataset.seq; this.n = +canvas.dataset.frames; this.fit = canvas.dataset.fit || 'cover';
      this.imgs = []; this.want = 0; this.shown = -1; this.started = false;
      new IntersectionObserver((es) => { if (es[0].isIntersecting) this.load(); }, { rootMargin: '160% 0px' }).observe(canvas.closest('section') || canvas);
      addEventListener('resize', () => { this.shown = -1; this.draw(); });
    }
    load() {
      if (this.started) return; this.started = true;
      // coarse to fine (both ends, then every 32nd, 16th, ... frame), so a fast scroll
      // always lands near a frame that is already loaded
      const order = [0, this.n - 1];
      for (let step = 32; step >= 1; step >>= 1) for (let i = step; i < this.n - 1; i += step) if (!order.includes(i)) order.push(i);
      for (const i of order) {
        const im = new Image(); im.decoding = 'async'; im.src = `${this.base}/${pad(i)}.webp`;
        im.onload = () => { if (this.shown !== this.want) this.draw(); };
        this.imgs[i] = im;
      }
    }
    set(p) { this.want = Math.round(clamp(p) * (this.n - 1)); if (this.want !== this.shown) this.draw(); }
    ready(i) { const im = this.imgs[i]; return im && im.complete && im.naturalWidth ? im : null; }
    draw() {
      // the wanted frame, or the nearest one loaded so far; `shown` records which one it really was
      let at = this.want, im = this.ready(at);
      for (let d = 1; !im && d < this.n; d++) {
        if ((im = this.ready(this.want - d))) at = this.want - d;
        else if ((im = this.ready(this.want + d))) at = this.want + d;
      }
      if (!im) return;
      const c = this.c, r = Math.min(2, devicePixelRatio || 1);
      const w = Math.round(c.clientWidth * r), h = Math.round(c.clientHeight * r);
      if (!w || !h) return;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const s = this.fit === 'contain' ? Math.min(w / im.naturalWidth, h / im.naturalHeight) : Math.max(w / im.naturalWidth, h / im.naturalHeight);
      const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
      this.ctx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);
      this.shown = at;
    }
  }
  const seqs = new Map();
  $$('canvas[data-seq]').forEach((c) => seqs.set(c, new Seq(c)));

  /* ------------------------------------------------------------ scenes: progress through a tall section */
  const scenes = $$('[data-scene]').map((el) => ({ el, kind: el.dataset.scene, p: -1 }));
  function progress(el) {
    const r = el.getBoundingClientRect();
    const span = r.height - innerHeight;
    return span > 0 ? clamp(-r.top / span) : clamp((innerHeight - r.top) / (innerHeight + r.height));
  }
  const handlers = {
    manifesto(s, p) {
      const words = s.words || (s.words = $$('.w', s.el));
      const lit = Math.floor(clamp((p - 0.08) / 0.72) * words.length);
      words.forEach((w, i) => w.classList.toggle('on', i < lit));
    },
    rewrite(s, p) {
      const seq = seqs.get($('canvas', s.el)); if (seq) seq.set(clamp(p * 1.1));
      const steps = $$('.step', s.el);
      const at = p < 0.33 ? 0 : p < 0.68 ? 1 : 2;
      steps.forEach((el, i) => el.classList.toggle('on', i === at));
      const hud = $('.hud', s.el);
      if (hud) {
        const changed = p > 0.52;
        hud.classList.toggle('changed', changed);
        $('.hash', hud).textContent = changed ? hud.dataset.after : hud.dataset.before;
        $('.state', hud).textContent = changed ? 'changed, nobody told you' : 'approved 12 March';
      }
    },
    seal(s, p) {
      // stop on the glowing crack, before the film's last frames go to black
      const seq = seqs.get($('canvas', s.el)); if (seq) seq.set(Math.min(0.86, p * 1.2));
      const lines = $$('.bigline .h2', s.el);
      if (lines[0]) lines[0].classList.toggle('on', p > 0.08);        // stays, and the answer lands beneath it
      if (lines[1]) lines[1].classList.toggle('on', p >= 0.6);
    },
    scrub(s, p) { const seq = seqs.get($('canvas', s.el)); if (seq) seq.set(p); },
  };
  function tick() {
    for (const s of scenes) {
      const r = s.el.getBoundingClientRect();
      if (r.bottom < -innerHeight || r.top > innerHeight * 2) continue;
      const p = reduce && s.kind !== 'manifesto' ? 1 : progress(s.el);
      if (Math.abs(p - s.p) < 0.0005) continue;
      s.p = p; s.el.style.setProperty('--p', p.toFixed(4));
      const h = handlers[s.kind]; if (h) h(s, p);
    }
    steps();
  }
  let ticking = false;
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; tick(); }); } };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);

  /* ------------------------------------------------------------ steps: sticky frame, three sequences */
  const stepWrap = $('[data-steps]');
  function steps() {
    if (!stepWrap) return;
    const arts = $$('article', stepWrap);
    const cans = $$('.frame canvas', stepWrap);
    const mid = innerHeight * 0.5;
    let active = 0, best = Infinity;
    arts.forEach((a, i) => { const r = a.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - mid); if (d < best) { best = d; active = i; } });
    arts.forEach((a, i) => a.classList.toggle('on', i === active));
    cans.forEach((c, i) => c.classList.toggle('on', i === active));
    const r = arts[active].getBoundingClientRect();
    const p = reduce ? 1 : clamp((mid - r.top) / r.height * 1.15);
    const seq = seqs.get(cans[active]); if (seq) seq.set(p);
    const count = $('.count', stepWrap); if (count) count.textContent = `0${active + 1} / 0${arts.length}`;
  }

  /* ------------------------------------------------------------ Pin: watches the cursor, blinks, takes a state */
  $$('[data-pin]').forEach((stage) => {
    const base = stage.dataset.pin;
    const imgs = [];
    for (let i = 1; i <= 32; i++) {
      const im = new Image(); im.alt = ''; im.decoding = 'async'; im.draggable = false;
      im.src = `${base}/p${String(i).padStart(2, '0')}.webp`;
      stage.appendChild(im); imgs.push(im);
    }
    const pose = (row, col, shut) => (shut ? 16 : 1) + row * 5 + col;   // rows: up, level, down; cols: left..right
    let row = 1, col = 2, shut = false, state = stage.dataset.state || 'watching', cur = null;
    const show = () => {
      const n = state === 'changed' ? 31 : state === 'approved' ? (shut ? 23 : 32) : pose(row, col, shut);
      const im = imgs[n - 1];
      if (im !== cur) { im.classList.add('on'); if (cur) { const old = cur; setTimeout(() => old.classList.remove('on'), 90); } cur = im; }
    };
    show();
    let tx = 0, ty = 0;
    const look = (x, y) => {
      const r = stage.getBoundingClientRect();
      const dx = (x - (r.left + r.width / 2)) / Math.max(innerWidth * 0.45, 1);
      const dy = (y - (r.top + r.height * 0.36)) / Math.max(innerHeight * 0.45, 1);
      tx = dx; ty = dy;
      const c = clamp(Math.round(2 + dx * 2.4), 0, 4), rw = dy < -0.22 ? 0 : dy > 0.28 ? 2 : 1;
      if (c !== col || rw !== row) { col = c; row = rw; if (state === 'watching') show(); }
    };
    if (!reduce) {
      addEventListener('pointermove', (e) => look(e.clientX, e.clientY), { passive: true });
      const blink = () => { if (state !== 'changed') { shut = true; show(); setTimeout(() => { shut = false; show(); }, 130); } setTimeout(blink, 2600 + Math.random() * 3200); };
      setTimeout(blink, 1800);
    }
    const say = stage.parentElement && $('.pin-say', stage.parentElement);
    const chips = stage.parentElement ? $$('.chip', stage.parentElement) : [];
    chips.forEach((ch) => ch.addEventListener('click', () => {
      state = ch.dataset.s; stage.dataset.state = state;
      chips.forEach((c) => c.setAttribute('aria-pressed', c === ch));
      if (say) say.textContent = ch.dataset.say;
      show();
    }));
  });

  /* ------------------------------------------------------------ hero film */
  const vid = $('.hero video');
  const vbtn = $('.vidctl');
  if (vid) {
    const setBtn = () => { if (vbtn) { vbtn.textContent = vid.paused ? 'Play film loop' : 'Pause'; vbtn.setAttribute('aria-pressed', !vid.paused); } };
    if (reduce) { vid.removeAttribute('autoplay'); vid.pause(); }
    else { const pr = vid.play(); if (pr && pr.catch) pr.catch(() => {}); }
    new IntersectionObserver((es) => { if (reduce || vid.dataset.user === 'paused') return; es[0].isIntersecting ? vid.play().catch(() => {}) : vid.pause(); }).observe(vid);
    if (vbtn) vbtn.addEventListener('click', () => { if (vid.paused) { vid.dataset.user = ''; vid.play(); } else { vid.dataset.user = 'paused'; vid.pause(); } setBtn(); });
    vid.addEventListener('play', setBtn); vid.addEventListener('pause', setBtn); setBtn();
  }

  /* ------------------------------------------------------------ numbers count up once */
  const cio = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return; cio.unobserve(e.target);
    const el = e.target, to = +el.dataset.count, t0 = performance.now(), dur = reduce ? 0 : 1600;
    const fmt = (v) => Math.round(v).toLocaleString('en-US');
    const step = (t) => { const k = dur ? clamp((t - t0) / dur) : 1; el.textContent = fmt(to * (1 - Math.pow(1 - k, 4))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), { threshold: 0.6 });
  $$('[data-count]').forEach((el) => cio.observe(el));

  /* ------------------------------------------------------------ copy */
  $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const t = document.getElementById(b.dataset.copy);
    try { await navigator.clipboard.writeText(t.textContent.trim()); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1600); } catch { b.textContent = 'Select it'; }
  }));

  /* ------------------------------------------------------------ card light follows the pointer */
  $$('.card').forEach((c) => c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', `${e.clientX - r.left}px`); c.style.setProperty('--my', `${e.clientY - r.top}px`);
  }));

  /* ------------------------------------------------------------ the log: filter */
  const q = $('#q');
  if (q) {
    const rows = $$('.row[data-name]');
    const count = $('#qcount');
    q.addEventListener('input', () => {
      const v = q.value.trim().toLowerCase(); let n = 0;
      rows.forEach((r) => { const hit = !v || r.dataset.name.includes(v); r.style.display = hit ? '' : 'none'; if (hit) n++; });
      if (count) count.textContent = v ? `${n} of ${rows.length}` : `${rows.length} servers`;
    });
  }

  tick();
})();
