/* fx.js -- background effects.
   - Gold coins printed with the TaxNest logo, and gold dust, drift behind the page.
   - The cursor is a MAGNET: particles within reach are pulled in, shrink, and vanish into it. Always on (no switch).
   - The favicon is the rounded TaxNest mark, animated with the supplied frames.
   - Also: count-up numbers, coin shower on success. Pure decoration: nothing depends on it. */
(function () {
  'use strict';
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canvas = document.getElementById('fx-bg'), ctx = canvas ? canvas.getContext('2d') : null;
  var W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2), items = [], bursts = [], raf = null, last = 0;
  var px = -9999, py = -9999, running = false, logo = new Image(), logoOk = false;
  logo.onload = function () { logoOk = true; }; logo.src = 'assets/taxnest-logo-192.png';
  var REACH = 230, ABSORB = 22;

  function resize() { if (!canvas) return; W = innerWidth; H = innerHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function spawn(it, fromEdge) {
    it.x = fromEdge ? (Math.random() < .5 ? -30 : W + 30) : rnd(0, W); it.y = fromEdge ? rnd(0, H) : rnd(0, H);
    it.vx = rnd(-14, 14); it.vy = rnd(-10, 10); it.ph = rnd(0, 6.28); it.spin = rnd(.8, 2.2); it.s = 1; it.dead = 0;
    return it;
  }
  function seed() {
    items = [];
    var coins = reduced ? 8 : Math.max(18, Math.min(40, Math.round(W / 45))), dust = reduced ? 30 : Math.max(90, Math.min(220, Math.round(W / 7)));
    for (var i = 0; i < coins; i++) items.push(spawn({ t: 'c', r: rnd(14, 26), z: rnd(.5, 1) }, false));
    for (var j = 0; j < dust; j++) items.push(spawn({ t: 'd', r: rnd(.9, 2.2), z: rnd(.3, 1) }, false));
  }
  function drawCoin(x, y, r, ph, alpha) {
    var sx = Math.max(Math.abs(Math.cos(ph)), .14);
    ctx.save(); ctx.translate(x, y); ctx.scale(sx, 1); ctx.globalAlpha = alpha;
    var g = ctx.createRadialGradient(-r * .35, -r * .35, r * .15, 0, 0, r);
    g.addColorStop(0, '#FFF0B8'); g.addColorStop(.55, '#D4A12A'); g.addColorStop(1, '#8F6410');
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.2832); ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = Math.max(1, r * .09); ctx.strokeStyle = 'rgba(255,240,190,.9)'; ctx.stroke();
    if (r > 7 && sx > .4) {                                     // golden rupee sign (₹) on the face
      ctx.font = '700 ' + Math.round(r * 1.25) + 'px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,236,160,.9)'; ctx.fillText('\u20B9', 0, r * .06 + 1);   // highlight
      ctx.fillStyle = '#7A5410'; ctx.fillText('\u20B9', 0, r * .06);                    // engraved gold
    }
    ctx.restore();
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame); var dt = Math.min(.05, (ts - last) / 1000 || .016); last = ts;
    ctx.clearRect(0, 0, W, H);
    items.forEach(function (it) {
      if (it.dead) { it.s -= dt * 5; if (it.s <= 0) spawn(it, true); else { it.x = it.bx; it.y = it.by; } return; }
      var dx = px - it.x, dy = py - it.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < REACH && d > 0.001) {                                           // magnetic pull: stronger the closer it is
        var k = Math.pow(1 - d / REACH, 2) * (it.t === 'c' ? 1400 : 2200) * it.z;
        it.vx += dx / d * k * dt; it.vy += dy / d * k * dt;
        var v = Math.sqrt(it.vx * it.vx + it.vy * it.vy), cap = it.t === 'c' ? 420 : 520;
        if (v > cap) { it.vx *= cap / v; it.vy *= cap / v; }
        if (d < ABSORB) { it.dead = 1; it.bx = px; it.by = py; it.s = 1; }   // absorbed into the cursor
      } else { it.vx *= (1 - .6 * dt); it.vy *= (1 - .6 * dt); it.vx += rnd(-4, 4) * dt; it.vy += rnd(-4, 4) * dt; }
      it.x += it.vx * dt * it.z; it.y += it.vy * dt * it.z; it.ph += dt * it.spin;
      if (it.x < -60 || it.x > W + 60 || it.y < -60 || it.y > H + 60) spawn(it, true);
      if (it.dead) return;
      if (it.t === 'c') drawCoin(it.x, it.y, it.r * it.z, it.ph, .32 + .4 * it.z);
      else { ctx.globalAlpha = .35 + .5 * Math.abs(Math.sin(it.ph)); ctx.fillStyle = '#F0CB6A'; ctx.beginPath(); ctx.arc(it.x, it.y, it.r, 0, 6.2832); ctx.fill(); }
    });
    ctx.globalAlpha = 1;
    for (var b = bursts.length - 1; b >= 0; b--) {
      var p = bursts[b]; p.life -= dt; if (p.life <= 0) { bursts.splice(b, 1); continue; }
      p.vy += 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.ph += dt * 9; drawCoin(p.x, p.y, p.r, p.ph, Math.min(1, p.life * 1.4));
    }
  }
  function start() { if (!canvas || raf) return; resize(); seed(); last = performance.now(); raf = requestAnimationFrame(frame); }
  function burst(n) { if (!canvas) return; if (!raf) start(); for (var i = 0; i < (n || 46); i++) bursts.push({ x: W / 2 + rnd(-80, 80), y: H * .35, vx: rnd(-380, 380), vy: rnd(-620, -180), r: rnd(9, 20), ph: rnd(0, 6), life: rnd(1.4, 2.4) }); }
  function countUp(el, to, opt) {
    opt = opt || {}; var dec = opt.decimals === undefined ? 0 : opt.decimals, pre = opt.prefix || '', fmt = opt.format || function (v) { return v.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }); };
    if (typeof to !== 'number' || !isFinite(to) || reduced) { el.textContent = pre + fmt(to); el._fxv = to; return; }
    var from = el._fxv || 0, t0 = performance.now(), dur = 650; el._fxv = to;
    (function step(now) { var k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = pre + fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); else el.textContent = pre + fmt(to); })(t0);
  }
  /* magnet: track the pointer everywhere, including over buttons and inputs */
  window.addEventListener('pointermove', function (e) { px = e.clientX; py = e.clientY; }, { passive: true });
  window.addEventListener('pointerleave', function () { px = -9999; py = -9999; });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = null; } else start(); });
  window.addEventListener('resize', function () { if (raf) { resize(); seed(); } });

  /* animated round favicon, from the supplied video frames */
  function favicon() {
    var link = document.querySelector('link[rel~="icon"]'); if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.type = 'image/png';
    var frames = []; for (var i = 1; i <= 24; i++) frames.push('assets/fav/f' + (i < 10 ? '0' : '') + i + '.png');
    var k = 0; if (reduced) { link.href = 'assets/favicon.png'; return; }
    setInterval(function () { if (document.hidden) return; link.href = frames[k]; k = (k + 1) % frames.length; }, 140);
  }
  function init() { start(); favicon(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.FX = { burst: burst, countUp: countUp, isOn: function () { return true; } };
})();
