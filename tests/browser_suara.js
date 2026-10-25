/* Uji pengumuman suara (klip rekaman) di Chromium sungguhan, DB SEMENTARA.
 * Yang diuji: semua klip ada (HTTP 200), urutan klip per jenis pengumuman, nomor meja,
 * batas antrean, pengumuman ganda tidak diulang, dan sakelar suara dihormati.
 * Pemutaran audio diganti tiruan: Chromium tanpa perangkat suara bisa macet kalau memutar
 * audio sungguhan. Berkasnya tetap diambil sungguhan lewat fetch pada uji pertama.
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules CHROME_PATH=/opt/chromium/chrome-linux64/chrome node tests/browser_suara.js
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const free = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CHROME = process.env.CHROME_PATH || undefined;
const KLIP = ['kepala_pesan', 'ekor_panggil', 'ekor_bill', 'tes'].concat(Array.from({ length: 50 }, (_, i) => 'meja_' + (i + 1)));

(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-suara-'));
  const proc = spawn('python3', [path.join(__dirname, '..', 'app.py')], {
    env: { ...process.env, KOPI_SAWAH_PORT: String(port), KOPI_SAWAH_DB: path.join(tmp, 't.sqlite3'), KOPI_SAWAH_SETUP_CODE: '12345678' },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const hasil = [], galat = [];
  const ok = (nama, lulus, extra = '') => hasil.push([lulus ? 'LULUS' : 'GAGAL', nama, extra]);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'id-ID' });
    // Tiruan Web Audio: pemutaran dibuat selesai seketika, tanpa perangkat suara.
    await ctx.addInitScript(() => {
      window.AudioContext = class {
        constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
        resume() { return Promise.resolve(); }
        decodeAudioData(buf, ok) { const b = { duration: 0.05 }; if (ok) setTimeout(() => ok(b), 0); return Promise.resolve(b); }
        createBufferSource() { return { buffer: null, connect() { }, onended: null, start() { setTimeout(() => { if (this.onended) this.onended(); }, 8); }, stop() { } }; }
        createGain() { return { gain: { value: 1 }, connect() { } }; }
        createOscillator() { return { frequency: { value: 0 }, connect() { }, start() { }, stop() { } }; }
      };
      window.webkitAudioContext = window.AudioContext;
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => galat.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/audio|Media/i.test(m.text())) galat.push('console: ' + m.text()); });
    const tunggu = ms => new Promise(r => setTimeout(r, ms));
    let diminta = [];                                     // klip yang benar-benar diminta ke server
    page.on('request', r => { const u = r.url(); if (u.includes('/static/audio/')) diminta.push(u.split('/static/audio/')[1]); });
    const mulaiCatat = () => { diminta = []; };
    const diputar = async () => { const d = diminta.slice(); diminta = []; return d.filter(x => x && x.endsWith('.mp3')); };
    const bersih = async () => { mulaiCatat(); await page.evaluate(() => { if (typeof voiceAntre !== 'undefined') { voiceAntre.length = 0; voiceJalan = false; } }); };

    await page.goto(base);
    await page.waitForSelector('#f');
    await page.fill('[name=name]', 'Digi'); await page.fill('[name=pin]', '482916'); await page.fill('[name=pin2]', '482916'); await page.fill('[name=code]', '12345678');
    await page.click('#f button[type=submit]');
    await page.waitForSelector('.top');
    await page.click('h2');                       // sentuhan pertama: AudioContext dibuat

    // 1. semua berkas klip ada dan bisa diambil (HTTP 200)
    const status = await page.evaluate(async (klip) => {
      const hasil = {};
      for (const n of klip) { try { const r = await fetch('/static/audio/' + n + '.mp3'); hasil[n] = r.status; } catch { hasil[n] = 0; } }
      return hasil;
    }, KLIP);
    const kurang = Object.entries(status).filter(([, s]) => s !== 200);
    ok(`semua ${KLIP.length} klip suara tersedia (HTTP 200)`, kurang.length === 0, kurang.length ? JSON.stringify(kurang) : '');

    // 2. pesanan baru meja 7 -> "Ada pesanan baru dari" + "Meja tujuh"
    await bersih();
    await page.evaluate(() => antreSuara('pesan', 'Meja 7'));
    await tunggu(700);
    const urutPesan = await diputar();
    ok('pesan Meja 7: kepala_pesan lalu meja_7', urutPesan.join(',') === 'kepala_pesan.mp3,meja_7.mp3', urutPesan.join(','));

    // 3. panggil pelayan meja 3 -> "Meja tiga" + "memanggil pelayan"
    await bersih();
    await page.evaluate(() => antreSuara('panggil', 'Meja 3'));
    await tunggu(700);
    const urutPanggil = await diputar();
    ok('panggil Meja 3: meja_3 lalu ekor_panggil', urutPanggil.join(',') === 'meja_3.mp3,ekor_panggil.mp3', urutPanggil.join(','));

    // 4. minta bill meja 10 -> "Meja sepuluh" + "minta tagihan"
    await bersih();
    await page.evaluate(() => antreSuara('bill', 'Meja 10'));
    await tunggu(700);
    const urutBill = await diputar();
    ok('bill Meja 10: meja_10 lalu ekor_bill', urutBill.join(',') === 'meja_10.mp3,ekor_bill.mp3', urutBill.join(','));

    // 5. meja di luar daftar klip (51) -> cukup bel, tanpa klip
    await bersih();
    await page.evaluate(() => antreSuara('pesan', 'Meja 51'));
    await tunggu(600);
    const urutLuar = await diputar();
    ok('Meja 51 (di luar 1..50) tidak memutar klip apa pun', urutLuar.length === 0, urutLuar.join(','));

    // 6. pengumuman sama tidak diulang (dobel)
    await bersih();
    await page.evaluate(() => { antreSuara('bill', 'Meja 5'); antreSuara('bill', 'Meja 5'); });
    await tunggu(700);
    const urutDobel = await diputar();
    ok('pengumuman sama tidak diulang', urutDobel.filter(x => x === 'meja_5.mp3').length === 1, urutDobel.join(','));

    // 7. antrean dibatasi 3
    await bersih();
    const panjang = await page.evaluate(() => {
      ['Meja 1', 'Meja 2', 'Meja 4', 'Meja 6', 'Meja 8'].forEach(l => antreSuara('pesan', l));
      return voiceAntre.length;
    });
    ok('antrean paling banyak 3 pengumuman', panjang <= 3, 'antrean=' + panjang);
    await tunggu(2000);                            // biarkan sisa antrean selesai diputar
    await bersih();

    // 8. sakelar suara mati: tidak ada klip yang diputar
    await page.evaluate(() => localStorage.setItem('ks_sound', '0'));
    await bersih();
    await page.evaluate(() => antreSuara('pesan', 'Meja 2'));
    await tunggu(600);
    const urutMati = await diputar();
    ok('suara mati: tidak memutar klip', urutMati.length === 0, urutMati.join(','));
    await page.evaluate(() => localStorage.setItem('ks_sound', '1'));

    ok('tidak ada galat JavaScript', galat.length === 0, galat.slice(0, 3).join(' | '));
  } catch (e) {
    hasil.push(['GAGAL', 'uji berjalan tanpa gangguan', e.message]);
  } finally {
    await browser.close(); proc.kill();
  }
  for (const [status, nama, extra] of hasil) console.log(`${status}  ${nama}${extra ? '  [' + extra + ']' : ''}`);
  const gagal = hasil.filter(h => h[0] === 'GAGAL').length;
  console.log(`\n${hasil.length - gagal}/${hasil.length} lulus`);
  process.exit(gagal ? 1 : 0);
})();
