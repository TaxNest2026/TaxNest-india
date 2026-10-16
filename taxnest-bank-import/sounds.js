/* sounds.js -- short synthesized sound cues (Web Audio, no audio files). Muted by default if the OS asks for reduced motion
   is NOT assumed; the user can turn sounds off with the speaker button and that choice is remembered in this browser.
   Cues:  extracted -> quick bright blips     assign -> "zoop" pitch sweep     push -> sonic whoosh     done -> happy chime */
(function () {
  'use strict';
  var KEY = 'taxnest_sound', ctx = null, on = true;
  try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) {}
  function ac() {
    if (!ctx) { var C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, t0, dur, type, vol, slideTo) {
    var a = ac(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain(), t = a.currentTime + t0;
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.12, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t0, dur, vol, fromHz, toHz) {
    var a = ac(); if (!a) return;
    var len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), t = a.currentTime + t0;
    s.buffer = buf; f.type = 'bandpass'; f.frequency.setValueAtTime(fromHz, t); f.frequency.exponentialRampToValueAtTime(toHz, t + dur);
    g.gain.setValueAtTime(vol, t); s.connect(f); f.connect(g); g.connect(a.destination); s.start(t);
  }
  var cues = {
    extracted: function () { [0, 0.07, 0.14, 0.23].forEach(function (t, i) { tone(660 + i * 180, t, 0.09, 'triangle', 0.13); }); },
    assign:    function () { tone(260, 0, 0.22, 'sine', 0.18, 980); tone(980, 0.2, 0.07, 'sine', 0.08); },
    push:      function () { noise(0, 0.5, 0.35, 400, 6000); tone(180, 0, 0.5, 'sawtooth', 0.04, 1600); },
    done:      function () { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, i * 0.09, 0.45, 'triangle', 0.14); }); tone(1568, 0.42, 0.6, 'sine', 0.07); },
    error:     function () { tone(220, 0, 0.25, 'square', 0.06, 160); }
  };
  var Sounds = {
    play: function (name) { if (on && cues[name]) { try { cues[name](); } catch (e) {} } },
    isOn: function () { return on; },
    set: function (v) { on = !!v; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {} if (on) ac(); },
    toggleButton: function (el) {
      var paint = function () { el.textContent = on ? '\u{1F50A} Sound on' : '\u{1F507} Sound off'; el.setAttribute('aria-pressed', String(on)); };
      el.addEventListener('click', function () { Sounds.set(!on); paint(); Sounds.play('assign'); }); paint(); return el;
    }
  };
  window.TaxNestSound = Sounds;
})();
