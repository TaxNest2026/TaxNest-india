/* fx.js -- background + interaction effects. Pure decoration: never required for the tool to work.
   - floating rupee coins + gold dust on a canvas behind everything (pauses when the tab is hidden)
   - ripple on buttons, counting-up numbers, coin burst celebration
   - "Effects" toggle (saved in this browser); automatically off when the OS asks for reduced motion */
(function () {
  'use strict';
  var KEY = 'taxnest_fx';
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var stored = null; try { stored = localStorage.getItem(KEY); } catch (e) {}
  var enabled = stored === null ? !reduced : stored === 'on';
  var canvas = document.getElementById('fx-bg'), ctx = canvas ? canvas.getContext('2d') : null;
  var W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2), items = [], mx = 0.5, my = 0.5, raf = null, last = 0, bursts = [];

  function resize() { if (!canvas) return; W = innerWidth; H = innerHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function seed() {
    items = []; var coins = Math.max(8, Math.min(22, Math.round(W / 70))), dust = Math.max(20, Math.min(60, Math.round(W / 28)));
    for (var i = 0; i < coins; i++) items.push({ t: 'c', x: rnd(0, W), y: rnd(0, H), r: rnd(11, 26), vy: rnd(-9, -3), vx: rnd(-4, 4), ph: rnd(0, 6.28), sp: rnd(.6, 1.6), z: rnd(.4, 1) });
    for (var j = 0; j < dust; j++) items.push({ t: 'd', x: rnd(0, W), y: rnd(0, H), r: rnd(.8, 2.4), vy: rnd(-12, -3), vx: rnd(-3, 3), ph: rnd(0, 6.28), sp: rnd(.5, 1.5), z: rnd(.3, 1) });
  }
  function coin(x, y, r, ph, a) {
    var sx = Math.abs(Math.cos(ph)); sx = Math.max(sx, .12);
    ctx.save(); ctx.translate(x, y); ctx.scale(sx, 1); ctx.globalAlpha = a;
    var g = ctx.createRadialGradient(-r * .3, -r * .3, r * .1, 0, 0, r); g.addColorStop(0, '#FFE9A6'); g.addColorStop(.55, '#D4A12A'); g.addColorStop(1, '#8F6410');
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.2832); ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = Math.max(1, r * .1); ctx.strokeStyle = 'rgba(255,240,190,.8)'; ctx.stroke();
    if (r > 13 && sx > .45) { ctx.fillStyle = 'rgba(110,70,0,.85)'; ctx.font = 'bold ' + Math.round(r * 1.1) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('\u20B9', 0, 1); }
    ctx.restore();
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame); var dt = Math.min(.05, (ts - last) / 1000 || .016); last = ts;
    ctx.clearRect(0, 0, W, H);
    var px = (mx - .5) * 28, py = (my - .5) * 18;
    items.forEach(function (it) {
      it.x += it.vx * dt * it.z; it.y += it.vy * dt * it.z; it.ph += dt * it.sp * 2.2;
      if (it.y < -40) { it.y = H + 40; it.x = rnd(0, W); } if (it.x < -40) it.x = W + 40; if (it.x > W + 40) it.x = -40;
      var X = it.x + px * it.z, Y = it.y + py * it.z;
      if (it.t === 'c') coin(X, Y, it.r * it.z, it.ph, .3 + .35 * it.z);
      else { ctx.globalAlpha = .25 + .45 * Math.abs(Math.sin(it.ph)); ctx.fillStyle = '#F0CB6A'; ctx.beginPath(); ctx.arc(X, Y, it.r, 0, 6.2832); ctx.fill(); }
    });
    ctx.globalAlpha = 1;
    for (var b = bursts.length - 1; b >= 0; b--) {
      var p = bursts[b]; p.life -= dt; if (p.life <= 0) { bursts.splice(b, 1); continue; }
      p.vy += 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.ph += dt * 9; coin(p.x, p.y, p.r, p.ph, Math.min(1, p.life * 1.4));
    }
  }
  function start() { if (!canvas || raf || !enabled) return; resize(); seed(); last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = null; if (ctx) ctx.clearRect(0, 0, W, H); }
  function setEnabled(on) {
    enabled = on; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {}
    document.body.classList.toggle('fx-off', !on); var b = document.getElementById('fx-toggle'); if (b) b.textContent = on ? '\u2726 Effects on' : '\u2726 Effects off';
    if (on) start(); else stop();
  }
  /* coin shower from the middle-top of the screen */
  function burst(n) {
    if (!enabled || !canvas) return; if (!raf) start();
    for (var i = 0; i < (n || 46); i++) bursts.push({ x: W / 2 + rnd(-80, 80), y: H * .35, vx: rnd(-380, 380), vy: rnd(-620, -180), r: rnd(9, 20), ph: rnd(0, 6), life: rnd(1.4, 2.4) });
  }
  function countUp(el, to, opt) {
    opt = opt || {}; var dec = opt.decimals === undefined ? 0 : opt.decimals, pre = opt.prefix || '', fmt = opt.format || function (v) { return v.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }); };
    if (!enabled || typeof to !== 'number' || !isFinite(to)) { el.textContent = pre + fmt(to); return; }
    var from = el._fxv || 0, t0 = performance.now(), dur = 650; el._fxv = to;
    (function step(now) { var k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = pre + fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); else el.textContent = pre + fmt(to); })(t0);
  }
  document.addEventListener('pointerdown', function (ev) {
    if (!enabled) return; var b = ev.target.closest && ev.target.closest('.btn-p,.btn-s,.abtn,.btn-continue,.btn-choose,.tlight'); if (!b || b.disabled) return;
    var r = b.getBoundingClientRect(), s = Math.max(r.width, r.height), sp = document.createElement('span'); sp.className = 'ripple';
    sp.style.width = sp.style.height = s + 'px'; sp.style.left = (ev.clientX - r.left - s / 2) + 'px'; sp.style.top = (ev.clientY - r.top - s / 2) + 'px'; b.appendChild(sp); setTimeout(function () { sp.remove(); }, 650);
  }, true);
  document.addEventListener('pointermove', function (e) { mx = e.clientX / Math.max(1, innerWidth); my = e.clientY / Math.max(1, innerHeight); }, { passive: true });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else if (enabled) start(); });
  window.addEventListener('resize', function () { if (enabled) { resize(); seed(); } });
  function init() {
    var b = document.getElementById('fx-toggle'); if (b) b.addEventListener('click', function () { setEnabled(!enabled); });
    setEnabled(enabled);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.FX = { burst: burst, countUp: countUp, setEnabled: setEnabled, isOn: function () { return enabled; } };
})();
