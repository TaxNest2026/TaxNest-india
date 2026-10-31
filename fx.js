  /* animated round favicon, from the supplied video frames */
  function favicon() {
    var link = document.querySelector('link[rel~="icon"]'); if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.type = 'image/png';
    var frames = []; for (var i = 1; i <= 24; i++) frames.push('taxnest-bank-import//assets/fav/f' + (i < 10 ? '0' : '') + i + '.png');
    var k = 0; if (reduced) { link.href = 'taxnest-bank-import/assets/favicon.png'; return; }
    setInterval(function () { if (document.hidden) return; link.href = frames[k]; k = (k + 1) % frames.length; }, 140);
  }
  function init() { start(); favicon(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.FX = { burst: burst, countUp: countUp, isOn: function () { return true; } };
})();
