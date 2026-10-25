/* Uji tombol Aktif/Tutup meja di layar "Meja & QR" — Chromium sungguhan, DB SEMENTARA.
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules CHROME_PATH=/opt/chromium/chrome-linux64/chrome node tests/browser_meja_aktif.js
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
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-meja-'));
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => galat.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) galat.push('console: ' + m.text()); });  // 404 disengaja pada uji meja ditutup

    await page.goto(base);
    await page.waitForSelector('#f');
    await page.fill('[name=name]', 'Digi'); await page.fill('[name=pin]', '482916'); await page.fill('[name=pin2]', '482916'); await page.fill('[name=code]', '12345678');
    await page.click('#f button[type=submit]');
    await page.waitForSelector('.top');

    // siapkan 3 meja (DB sementara masih kosong), lalu buka layar Meja & QR
    const buat = await page.evaluate(async () => (await fetch('/api/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: 'Meja', start: 1, count: 3 }) })).status);
    ok('meja uji dibuat', buat === 200 || buat === 201, 'HTTP ' + buat);
    await page.evaluate(() => ACT.manageTables());
    await page.waitForSelector('[data-act=bukaMeja], [data-act=tutupMeja]');
    const barisMeja1 = page.locator('.item', { hasText: 'Meja 1' }).first();
    ok('tombol status meja tampil di daftar', await barisMeja1.locator('[data-act=tutupMeja]').count() === 1 ||
      await barisMeja1.locator('[data-act=bukaMeja]').count() === 1);
    ok('teks status jelas untuk pemilik', (await barisMeja1.textContent()).includes('Aktif'));

    const statusApi = async (label) => {
      const r = await page.evaluate(async (l) => (await (await fetch('/api/tables')).json()).items.find(x => x.label === l), label);
      return r ? r.active : null;
    };
    ok('Meja 1 aktif di server sebelum diubah', await statusApi('Meja 1') === 1);

    // TUTUP meja 1 (ada konfirmasi)
    await barisMeja1.locator('[data-act=tutupMeja]').click();
    await page.waitForSelector('.sheet');
    ok('konfirmasi tutup meja muncul', (await page.textContent('.sheet')).includes('Tutup Meja 1'));
    await page.click(".sheet [data-yes]");
    await page.waitForSelector('[data-act=bukaMeja]');
    ok('setelah ditutup: status server jadi nonaktif', await statusApi('Meja 1') === 0);
    const barisTutup = page.locator('.item', { hasText: 'Meja 1' }).first();
    ok('label berubah jadi Nonaktif', (await barisTutup.textContent()).includes('Nonaktif'));
    ok('hitungan meja terbuka ikut turun', (await page.textContent('#sub')).includes('Meja terbuka'));

    // pelanggan tidak bisa memesan dari meja yang ditutup
    const tok = await page.evaluate(async () => (await (await fetch('/api/tables')).json()).items.find(x => x.label === 'Meja 1').token);
    const stTutup = await page.evaluate(async (t) => (await fetch('/api/public/menu?t=' + t)).status, tok);
    ok('menu pelanggan menolak meja yang ditutup (404)', stTutup === 404, 'HTTP ' + stTutup);

    // AKTIFKAN lagi
    await page.locator('.item', { hasText: 'Meja 1' }).first().locator('[data-act=bukaMeja]').click();
    await page.waitForSelector('[data-act=tutupMeja]');
    ok('setelah diaktifkan: status server jadi aktif', await statusApi('Meja 1') === 1);
    const stBuka = await page.evaluate(async (t) => (await fetch('/api/public/menu?t=' + t)).status, tok);
    ok('menu pelanggan terbuka lagi (200)', stBuka === 200, 'HTTP ' + stBuka);

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
