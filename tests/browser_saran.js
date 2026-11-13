/* Uji kotak "Saran" pada formulir menu (draf keterangan & deskripsi), DB SEMENTARA.
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules CHROME_PATH=/opt/chromium/chrome-linux64/chrome node tests/browser_saran.js
 */
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const free = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CHROME = process.env.CHROME_PATH || undefined;

(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-saran-'));
  const db = path.join(tmp, 't.sqlite3');
  const proc = spawn('python3', [path.join(__dirname, '..', 'app.py')], {
    env: { ...process.env, KOPI_SAWAH_PORT: String(port), KOPI_SAWAH_DB: db, KOPI_SAWAH_SETUP_CODE: '12345678' },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--mute-audio'] });
  const hasil = [], galat = [];
  const ok = (nama, lulus, extra = '') => hasil.push([lulus ? 'LULUS' : 'GAGAL', nama, extra]);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID' });
    const page = await ctx.newPage();
    page.on('pageerror', e => galat.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/audio|Media/i.test(m.text())) galat.push('console: ' + m.text()); });

    await page.goto(base);
    await page.waitForSelector('#f');
    await page.fill('[name=name]', 'Digi'); await page.fill('[name=pin]', '482916'); await page.fill('[name=pin2]', '482916'); await page.fill('[name=code]', '12345678');
    await page.click('#f button[type=submit]');
    await page.waitForSelector('.top');

    // isi draf saran ke DB sementara (produk sudah dibuat server saat start)
    execFileSync('python3', [path.join(__dirname, '..', 'tools', 'saran-menu.py'), '--db', db], { stdio: 'ignore' });

    await page.evaluate(async () => { await loadProducts(true); await loadMods(true); });
    await page.evaluate(() => productSheet(state.products.find(x => x.name === 'Ayam Bakar')));
    await page.waitForSelector('.saran-box', { timeout: 8000 });

    const kotak = await page.evaluate(() => [...document.querySelectorAll('.saran-box')].map(b => ({
      teks: b.querySelector('.saran-teks').textContent,
      tombol: b.querySelector('button')?.textContent
    })));
    ok('dua kotak saran muncul (keterangan + deskripsi)', kotak.length === 2, JSON.stringify(kotak));
    ok('saran keterangan Lauk = "Tanpa nasi"', /Tanpa nasi/.test(kotak[0]?.teks || ''), kotak[0]?.teks);
    ok('saran deskripsi Lauk tidak menyebut nasi', !/nasi/i.test(kotak[1]?.teks || ''), kotak[1]?.teks);

    // tombol Pakai mengisi kolom deskripsi
    await page.evaluate(() => { [...document.querySelectorAll('.saran-box')][1].querySelector('button').click(); });
    const isi = await page.inputValue('[name=description]');
    ok('tombol Pakai mengisi kolom deskripsi', isi.length > 20 && !/nasi/i.test(isi), isi);

    // kasir tidak melihat kotak saran? (hanya pemilik yang membuka formulir menu)
    const saranAPI = await page.evaluate(async () => (await (await fetch('/api/products/' + state.products.find(x => x.name === 'Ayam Bakar').id + '/saran')).json()).item.ada);
    ok('endpoint saran menjawab untuk menu itu', saranAPI === true, String(saranAPI));

    await page.screenshot({ path: '/root/mockup-kopi-sawah/saran-menu-uji.png' }).catch(() => { });
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
