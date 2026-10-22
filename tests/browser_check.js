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

    // 5b. QR meja: pemilik membuat meja → pelanggan memesan lewat HP → kasir memproses & menerima bayar
    await page.click('#tabs [data-view=kelola]'); await page.click('[data-act=sub][data-s=meja]'); await page.waitForSelector('[data-act=addTables]');
    await page.click('[data-act=addTables]'); await page.waitForSelector('#theForm'); await page.fill('[name=count]', '3'); await page.click('[data-submit]');
    await page.waitForSelector('[data-act=tableQR]'); await shot('21-meja-qr');
    ok('3 meja dibuat', (await page.$$('[data-act=tableQR]')).length === 3);
    await page.click('[data-act=tableQR] >> nth=0'); await page.waitForSelector('.sheet svg'); await shot('22-qr-meja');
    const tok = await page.evaluate(() => state.tables[0].token);
    const qrUrl = `${base}/m/${tok}`;
    if (process.env.QR_DECODER) {
      await page.locator('.sheet svg').first().screenshot({ path: path.join(shots, 'qr-meja1.png') });
      const out = require('node:child_process').execFileSync(process.env.QR_DECODER.split(' ')[0], [...process.env.QR_DECODER.split(' ').slice(1), path.join(shots, 'qr-meja1.png')]).toString().trim();
      ok('QR terbaca pemindai dan mengarah ke halaman pesan meja', out === qrUrl, out);
    } else results.push(['LEWAT', 'QR dipindai (set QR_DECODER untuk mengaktifkan)', '']);
    await page.click('[data-close]');

    const cust = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'id-ID' });
    const cp = await cust.newPage();
    cp.on('pageerror', e => errors.push('pelanggan pageerror: ' + e.message));
    cp.on('console', m => { if (m.type() === 'error' && !/40[0-9]|42[0-9]/.test(m.text())) errors.push('pelanggan console: ' + m.text()); });
    await cp.goto(`${base}/m/${tok}`); await cp.waitForSelector('.item');
    ok('halaman pelanggan memuat menu & nama meja', (await cp.textContent('header.top')).includes('Meja 1') && (await cp.$$('.item')).length > 100);
    await cp.screenshot({ path: path.join(shots, '30-pelanggan-menu.png') });
    await cp.fill('#q', 'Bakmi Goreng'); await cp.click('.item >> nth=0');
    await cp.waitForSelector('.sheet [data-add]'); await cp.click('.sheet [data-add]');
    await cp.fill('#q', 'Udang Krispy'); await cp.click('.item >> nth=0'); await cp.waitForSelector('.opt');
    ok('tombol tambah nonaktif sebelum pilihan wajib dipilih', await cp.isDisabled('.sheet [data-add]'));
    await cp.screenshot({ path: path.join(shots, '31-pelanggan-pilihan.png') });
    await cp.click('.opt:has-text("Tanpa nasi")'); await cp.click('.sheet [data-add]');
    await cp.click('[data-act=cart]'); await cp.waitForSelector('.sheet .cl >> nth=1');
    await cp.fill('#nm', 'Bu Sari'); await cp.fill('#nt', 'jangan pedas');
    await cp.screenshot({ path: path.join(shots, '32-pelanggan-keranjang.png') });
    await cp.click('[data-send]'); await cp.waitForSelector('.ord');
    ok('pesanan terkirim, status menunggu konfirmasi', (await cp.textContent('.sheet')).includes('Menunggu konfirmasi'));
    await cp.screenshot({ path: path.join(shots, '33-pelanggan-status.png') });

    await page.click('#tabs [data-view=meja]'); await page.waitForSelector('[data-act=orderStatus]', { timeout: 15000 });
    ok('kasir melihat pesanan masuk (menunggu konfirmasi)', (await page.textContent('#main')).includes('Meja 1') && (await page.textContent('#main')).includes('Bu Sari'));
    await shot('34-kasir-meja');
    await page.click('[data-act=orderStatus][data-s=accepted]'); await page.waitForSelector('[data-act=orderStatus][data-s=ready]');
    await page.click('[data-act=orderStatus][data-s=ready]'); await page.waitForSelector('[data-act=orderStatus][data-s=served]');
    await cp.waitForSelector('.sheet .pill.ok:has-text("siap")', { timeout: 15000 }).catch(() => { });
    await cp.click('[data-act=call][data-k=waiter]'); await cp.waitForSelector('[data-act=call][data-k=waiter][disabled]');
    await page.waitForSelector('.notice:has-text("memanggil pelayan")', { timeout: 15000 });
    ok('panggilan pelayan dari meja muncul di kasir', true);
    await page.click('[data-act=orderStatus][data-s=served]');
    await page.click('[data-act=payTable]'); await page.waitForSelector('#coPay');
    ok('bayar meja memuat pesanan QR', (await page.textContent('.sheet')).includes('PM'));
    await page.click('#coPay [data-m=qris]'); await shot('35-bayar-meja'); await page.click('#coPayBtn'); await page.waitForSelector('.receipt');
    ok('struk bayar meja memuat nomor meja & hitungan benar', (await page.textContent('.receipt')).includes('Meja 1') && (await page.textContent('.receipt')).includes('Tanpa nasi'));
    await shot('36-struk-meja'); await page.click('[data-done]');
    await cp.reload(); await cp.waitForSelector('.item'); await cp.click('[data-act=status]'); await cp.waitForSelector('.ord');
    ok('pelanggan melihat pesanan Selesai', (await cp.textContent('.sheet')).includes('Selesai'));
    await cp.screenshot({ path: path.join(shots, '37-pelanggan-selesai.png') });
    const cov = await cp.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('halaman pelanggan tanpa geser horizontal', cov <= 1, `selisih ${cov}px`);
    await cp.goto(`${base}/m/kodesalah123`); await cp.waitForSelector('.err');
    ok('QR salah → pesan ramah', (await cp.textContent('.err')).includes('tidak dikenali'));
    await cp.screenshot({ path: path.join(shots, '38-qr-salah.png') });

    // 5c. unggah foto, pilihan khusus menu, cetak QR
    await page.click('#tabs [data-view=kelola]'); await page.click('[data-act=sub][data-s=menu]'); await page.waitForSelector('[data-act=editProduct]');
    await page.fill('#mq', 'Nasi Goreng Original'); await page.waitForTimeout(500);
    await page.click('[data-act=editProduct] >> nth=0'); await page.waitForSelector('#photoFile', { state: 'attached' });
    await page.setInputFiles('#photoFile', path.join(__dirname, '..', 'static', 'images', 'bakmi-goreng.jpg'));
    await page.waitForSelector('#imgPrev img', { timeout: 15000 });
    const up = await page.evaluate(() => state.products.find(p => p.name === 'Nasi Goreng Original').image_key);
    ok('foto unggahan tersimpan (up-…)', /^up-[0-9a-f]{12}$/.test(up), up);
    const prevOk = await page.evaluate(() => { const i = document.querySelector('#imgPrev img'); return i && i.complete && i.naturalWidth > 0; });
    ok('foto unggahan tampil dari /media', prevOk);
    await page.click('#modMode [data-v=custom]'); await page.waitForSelector('#modChips button');
    await page.click('#modChips button[data-g=gula]');
    await shot('23-ubah-menu-foto-opsi');
    await page.click('[data-cancel]');
    await page.click('#tabs [data-view=kelola]'); await page.click('[data-act=sub][data-s=meja]'); await page.waitForSelector('[data-act=printAllQR]');
    await page.evaluate(() => { window.print = () => { }; });
    await page.click('[data-act=printAllQR]'); await page.waitForTimeout(300);
    await page.emulateMedia({ media: 'print' });
    const nCards = await page.evaluate(() => document.querySelectorAll('#printArea .qrcard').length);
    ok('cetak semua QR: 3 kartu meja tersusun', nCards === 3, String(nCards));
    await page.screenshot({ path: path.join(shots, '24-cetak-qr.png'), fullPage: false });
    await page.emulateMedia({ media: 'screen' });

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
