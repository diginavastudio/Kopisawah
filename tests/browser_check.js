/* Uji alur layar di Chromium sungguhan terhadap server lokal + DB SEMENTARA (data tiruan).
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules node tests/browser_check.js [folder-screenshot]
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'ks-shots-'));
fs.mkdirSync(shots, { recursive: true });
const free = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const CHROME = process.env.CHROME_PATH || undefined;

(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-db-'));
  const proc = spawn('python3', [path.join(__dirname, '..', 'app.py')], { env: { ...process.env, KOPI_SAWAH_PORT: String(port), KOPI_SAWAH_DB: path.join(tmp, 't.sqlite3'), KOPI_SAWAH_SETUP_CODE: '12345678' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const errors = [], results = [];
  const ok = (name, cond, extra = '') => { results.push([cond ? 'LULUS' : 'GAGAL', name, extra]); };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'id-ID' });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    const shot = n => page.screenshot({ path: path.join(shots, n + '.png') });
    const typePin = async pin => { for (const d of pin) await page.click(`.pad [data-d="${d}"]`); };

    // 1. penyiapan pemilik
    await page.goto(base); await page.waitForSelector('#f');
    await shot('01-setup');
    await page.fill('[name=name]', 'Digi'); await page.fill('[name=pin]', '482916'); await page.fill('[name=pin2]', '482916'); await page.fill('[name=code]', '12345678');
    await page.click('#f button[type=submit]');
    await page.waitForSelector('.top');
    ok('setup pemilik lalu masuk Beranda', (await page.textContent('h2')).includes('Halo, Digi'));
    await shot('02-beranda-awal');

    // 2. buka kasir via halaman Kasir
    await page.click('#tabs [data-view=kasir]'); await page.waitForSelector('#openCash');
    await shot('03-buka-kasir');
    await page.click('[data-act=setCash][data-v="100000"]'); await page.click('[data-act=openShift]');
    await page.waitForSelector('.tile');
    ok('kasir terbuka, menu tampil', (await page.$$('.tile')).length > 50);
    await shot('04-kasir');

    // 3. jual Kopi dengan varian
    await page.fill('#q', 'Cappucino'); await page.click('.tile >> nth=0');
    await page.waitForSelector('.opt');
    await shot('05-varian');
    await page.click('.opt:has-text("Large")'); await page.click('[data-add]');
    await page.click('#q', { clickCount: 3 }); await page.fill('#q', 'Nasi Goreng Original'); await page.click('.tile >> nth=0');
    await page.waitForSelector('[data-add]'); await page.click('[data-add]'); await page.waitForSelector('.sheet', { state: 'detached' });
    await page.waitForSelector('#cartSide .cl >> nth=1');
    ok('keranjang berisi 2 baris', (await page.$$('#cartSide .cl')).length === 2);
    await shot('06-keranjang');
    await page.click('#cartSide [data-act=checkout]'); await page.waitForSelector('#coPay');
    ok('tombol bayar nonaktif sebelum pilih cara bayar', await page.isDisabled('#coPayBtn'));
    await page.click('#coPay [data-m=tunai]'); await page.fill('#coPaid', '100000');
    await shot('07-bayar');
    ok('kembalian tampil', (await page.textContent('#coChange')).includes('Kembalian'));
    await page.click('#coPayBtn'); await page.waitForSelector('.receipt');
    ok('struk tampil setelah bayar', (await page.textContent('.sheet')).includes('KS'));
    await shot('08-struk');
    await page.click('[data-done]');
    ok('keranjang kosong setelah bayar', (await page.$$('#cartSide .cl')).length === 0);

    // 4. pengaturan pajak & tampil di keranjang
    await page.click('#tabs [data-view=kelola]'); await page.click('[data-act=sub][data-s=atur]'); await page.waitForSelector('[data-grp=tax]');
    await shot('09-pengaturan');
    await page.fill('[name=tax_percent]', '10'); await page.click('[data-grp=tax]'); await page.waitForSelector('.toast');
    await page.click('#tabs [data-view=kasir]'); await page.waitForSelector('.tile');
    await page.fill('#q', 'Nasi Goreng Original'); await page.click('.tile >> nth=0');
    await page.waitForSelector('[data-add]'); await page.click('[data-add]'); await page.waitForSelector('#cartSide .cl');
    ok('pajak 10% tampil di ringkasan', (await page.textContent('#cartSide .sumrows')).includes('Pajak 10%'));

    // 5. menu & harga, stok, laporan, pesanan, kas
    await page.click('#tabs [data-view=kelola]'); await page.click('[data-act=sub][data-s=menu]'); await page.waitForSelector('[data-act=editProduct]');
    await shot('10-menu-harga');
    await page.click('[data-act=editProduct] >> nth=0'); await page.waitForSelector('#theForm'); await shot('10b-ubah-menu'); await page.click('[data-cancel]');
    await page.click('[data-act=sub][data-s=stok]'); await page.waitForSelector('[data-act=editStock]'); await shot('11-stok');
    await page.click('[data-act=editStock] >> nth=0'); await page.waitForSelector('#theForm'); await shot('11b-hitung-stok'); await page.click('[data-cancel]');
    await page.click('[data-act=sub][data-s=varian]'); await page.waitForSelector('[data-act=editGroup]'); await shot('12-varian');
    await page.click('[data-act=sub][data-s=tim]'); await page.waitForSelector('[data-act=editUser]'); await shot('13-tim');
    await page.click('#tabs [data-view=laporan]'); await page.waitForSelector('.stats'); await shot('14-laporan');
    ok('laporan menampilkan 1 transaksi', (await page.textContent('.stats')).includes('1'));
    await page.click('#tabs [data-view=pesanan]'); await page.waitForSelector('[data-act=sale]'); await shot('15-pesanan');
    await page.click('[data-act=sale]'); await page.waitForSelector('[data-void]'); await shot('16-nota'); await page.click('[data-close]');
    await page.click('#tabs [data-view=kas]'); await page.waitForSelector('#countCash'); await page.fill('#countCash', '100000'); await shot('17-kas');
    ok('selisih kas terdeteksi', (await page.textContent('#diffBox')).includes('Kurang'));
    await page.click('#tabs [data-view=home]'); await page.waitForSelector('.stats'); await shot('18-beranda');

    // 6. tampilan HP
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'id-ID' });
    const mp = await mob.newPage();
    mp.on('pageerror', e => errors.push('mobile pageerror: ' + e.message));
    await mp.goto(base); await mp.waitForSelector('.staff');
    await mp.screenshot({ path: path.join(shots, '19-hp-login.png') });
    await mp.click('.staff button'); await mp.waitForSelector('.pad');
    await mp.screenshot({ path: path.join(shots, '19b-hp-pin.png') });
    for (const d of '482916') await mp.click(`.pad [data-d="${d}"]`);
    await mp.click('#enter'); await mp.waitForSelector('.top');
    await mp.screenshot({ path: path.join(shots, '20-hp-beranda.png') });
    await mp.click('#tabs [data-view=kasir]'); await mp.waitForSelector('.tile');
    await mp.fill('#q', 'Es Teh'); await mp.click('.tile >> nth=0'); await mp.waitForSelector('.opt');
    await mp.screenshot({ path: path.join(shots, '21-hp-varian.png') });
    await mp.click('[data-add]'); await mp.waitForSelector('.mobile-bar [data-act=openCart]:not([disabled])');
    await mp.screenshot({ path: path.join(shots, '22-hp-kasir.png') });
    await mp.click('[data-act=openCart]'); await mp.waitForSelector('.sheet .cl');
    await mp.screenshot({ path: path.join(shots, '23-hp-keranjang.png') });
    await mp.click('[data-close]');
    const m = await mp.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, logoLeft: document.querySelector('.top img').getBoundingClientRect().left, mainRight: document.querySelector('main').getBoundingClientRect().right, vw: innerWidth, vv: window.visualViewport.scale }));
    ok('tanpa geser horizontal di HP', m.over <= 1 && m.logoLeft >= 0 && m.mainRight <= m.vw + 1 && m.vv === 1, JSON.stringify(m));
  } catch (e) {
    results.push(['GAGAL', 'skrip berhenti: ' + e.message.split('\n')[0], '']);
  } finally {
    await browser.close(); proc.kill('SIGTERM');
  }
  results.forEach(r => console.log(r.join(' | ')));
  console.log('Galat konsol/halaman:', errors.length ? errors : 'tidak ada');
  console.log('Screenshot:', shots);
  process.exitCode = results.some(r => r[0] === 'GAGAL') || errors.length ? 1 : 0;
})();
