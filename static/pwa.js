/* Tombol "Pasang aplikasi" (PWA).
   Muncul hanya bila peramban mengizinkan pemasangan (Chrome/Edge Android & desktop).
   Safari iPhone/iPad tidak punya event beforeinstallprompt, jadi diberi petunjuk manual. */
(function () {
  'use strict';
  var sudahTerpasang = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
  if (sudahTerpasang) return;

  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  var promptEvent = null;
  var tombol = document.createElement('button');
  tombol.type = 'button';
  tombol.id = 'tombolPasang';
  tombol.textContent = ios ? '\uD83D\uDCF2 Pasang di iPhone' : '\u2B07 Pasang aplikasi';
  tombol.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:9999;display:none;'
    + 'padding:11px 15px;border:1px solid #6b5f2c;border-radius:999px;background:#363a10;'
    + 'color:#e9d27a;font:600 14px system-ui,sans-serif;box-shadow:0 6px 20px #0006;cursor:pointer';

  function tampilkan() {
    if (!document.body) return;
    if (!tombol.isConnected) document.body.appendChild(tombol);
    if (ios) tombol.style.display = 'block';
    window.__pwaTombolSiap = true;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    promptEvent = e;
    tampilkan();
    tombol.style.display = 'block';
  });

  tombol.addEventListener('click', function () {
    if (!promptEvent) {
      window.alert('Cara pasang di iPhone/iPad:\n1. Buka dengan Safari\n2. Ketuk tombol Bagikan (kotak dengan panah ke atas)\n3. Pilih "Tambahkan ke Layar Utama"\n4. Beri nama "Kopi Sawah" lalu ketuk Tambah.');
      return;
    }
    promptEvent.prompt();
    var p = promptEvent;
    promptEvent = null;
    try { p.userChoice.finally(function () { tombol.style.display = 'none'; }); }
    catch (err) { tombol.style.display = 'none'; }
  });

  window.addEventListener('appinstalled', function () { tombol.style.display = 'none'; });

  tampilkan();
  document.addEventListener('DOMContentLoaded', tampilkan);
  window.addEventListener('load', tampilkan);
  setTimeout(tampilkan, 1500);          // cadangan terakhir bila skrip dimuat sangat awal
})();
