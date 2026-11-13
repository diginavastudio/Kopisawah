/* Uji layar reservasi: halaman pelanggan + persetujuan kasir. DB SEMENTARA.
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules CHROME_PATH=/opt/chromium/chrome-linux64/chrome node tests/browser_reservasi.js
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const free = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CHROME = process.env.CHROME_PATH || undefined;

(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-resv-'));
  const proc = spawn('python3', [path.join(__dirname, '..', 'app.py')], {
    env: { ...process.env, KOPI_SAWAH_PORT: String(port), KOPI_SAWAH_DB: path.join(tmp, 't.sqlite3'), KOPI_SAWAH_SETUP_CODE: '12345678' },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--mute-audio'] });
  const hasil = [], galat = [];
  const ok = (nama, lulus, extra = '') => hasil.push([lulus ? 'LULUS' : 'GAGAL', nama, extra]);
  try {
    // pemilik dibuat dulu
    const own = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID' });
    const op = await own.newPage();
    op.on('pageerror', e => galat.push('owner pageerror: ' + e.message));
    await op.goto(base);
    await op.waitForSelector('#f');
    await op.fill('[name=name]', 'Digi'); await op.fill('[name=pin]', '482916'); await op.fill('[name=pin2]', '482916'); await op.fill('[name=code]', '12345678');
    await op.click('#f button[type=submit]');
    await op.waitForSelector('.top');
    await op.evaluate(() => api('/api/settings', { method: 'PUT', body: { reservasi_batas_jam: '23:59', reservasi_wa: '08123456789' } }));

    // halaman pelanggan
    const cust = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'id-ID' });
    const page = await cust.newPage();
    page.on('pageerror', e => galat.push('pelanggan pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') galat.push('pelanggan console: ' + m.text()); });

    await page.goto(base + '/r');
    await page.waitForURL(/\/reservasi/);
    ok('tautan pendek /r membuka halaman reservasi', /\/reservasi$/.test(new URL(page.url()).pathname), page.url());
    await page.waitForSelector('#nm');
    const tgl = await page.inputValue('#tgl');
    const jam = await page.$eval('#jam', s => s.options[2].value);
    await page.fill('#orang', '3');
    await page.fill('#nm', 'Bu Uji');
    await page.fill('#hp', '081234567890');
    const teks1 = await page.textContent('#app');
    ok('langkah 1 tanpa catatan rombongan & DP', !/Rombongan besar/.test(teks1) && !/DP dikonfirmasi/.test(teks1));
    await page.click('#next');                       // langkah 1 -> 2
    await page.waitForSelector('#menu .add');
    await page.fill('#q', 'Air Es');
    await page.click('#menu .add');
    await page.waitForSelector('.sheet [data-add]');
    await page.click('.sheet [data-add]');
    await page.waitForFunction(() => /1 porsi/.test(document.querySelector('#bar')?.innerText || ''));
    await page.click('#next2');                      // langkah 2 -> 3
    await page.waitForSelector('#kirim');
    const ringkas = await page.textContent('#app');
    ok('halaman ke-3 menampilkan ringkasan reservasi', /Periksa reservasi/.test(ringkas) && /Air Es/.test(ringkas));
    ok('langkah 3 tanpa catatan DP & tawaran jam', !/DP dikonfirmasi/.test(ringkas) && !/Kasir akan mengonfirmasi/.test(ringkas));
    await page.click('#kirim');
    await page.waitForURL(/[?&]t=/, { timeout: 15000 });
    const kode = await page.textContent('.big-code');
    ok('reservasi terkirim dan dapat kode', /^RSV-\d{6}-\d{3}$/.test(kode.trim()), kode.trim());
    const status1 = await page.textContent('.pill');
    ok('status awal menunggu konfirmasi', /Menunggu konfirmasi/.test(status1), status1);

    // kasir menyetujui
    await op.click('#tabs button[data-view=reservasi]');
    await op.waitForSelector('[data-rid]');
    const kartu = await op.textContent('#main');
    ok('kasir melihat reservasi masuk', /Bu Uji/.test(kartu) && /3 orang/.test(kartu), kartu.slice(0, 120));
    await op.click('[data-rid][data-act=ok]');
    await op.waitForFunction(() => /Disetujui/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 10000 });
    ok('kasir bisa menyetujui reservasi', true);

    // pelanggan melihat status baru
    await page.reload();
    await page.waitForSelector('.pill');
    const status2 = await page.textContent('.pill');
    ok('pelanggan melihat status disetujui', /Disetujui/.test(status2), status2);
    const teksStatus = await page.textContent('#app');
    ok('halaman status memuat info pembayaran', /Pembayaran bisa di kasir/.test(teksStatus), teksStatus.slice(0, 90));

    const wa = await page.$eval('a[href*="wa.me"]', a => a.getAttribute('href')).catch(() => null);
    ok('tombol WhatsApp kasir tampil dengan nomor yang benar', !!wa && /wa\.me\/628123456789/.test(wa), wa || 'tidak ada');

    // buka tautan lagi tanpa kode -> reservasi tersimpan yang tampil, bukan form kosong
    await page.goto(base + '/reservasi');
    await page.waitForSelector('.big-code', { timeout: 8000 }).catch(() => { });
    const kodeLagi = await page.textContent('.big-code').catch(() => '');
    ok('buka tautan lagi menampilkan reservasi tersimpan', kodeLagi.trim() === kode.trim(), kodeLagi.trim());
    await page.screenshot({ path: '/root/mockup-kopi-sawah/reservasi-uji.png' }).catch(() => { });
  } catch (e) {
    galat.push('exception: ' + e.message);
  } finally {
    await browser.close(); proc.kill();
    for (const [st, nama, extra] of hasil) console.log(`${st} — ${nama}${extra ? ' :: ' + extra : ''}`);
    if (galat.length) { console.log('GALAT JS:'); galat.forEach(g => console.log(' - ' + g)); }
    const gagal = hasil.filter(h => h[0] !== 'LULUS').length;
    console.log(`\n${hasil.length - gagal}/${hasil.length} lulus, ${galat.length} galat JS`);
    process.exit(gagal || galat.length ? 1 : 0);
  }
})();
