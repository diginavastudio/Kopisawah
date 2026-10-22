/* Uji layar fitur Ronde 5 di Chromium sungguhan (DB sementara, data TIRUAN):
 * mode offline kasir, papan dapur, pindah meja, bayar sebagian, QRIS toko, unggah foto saat tambah menu, "Lengkapi foto".
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules node tests/browser_ronde5.js [folder-screenshot]
 */
const { chromium, request } = require('playwright');
const { spawn } = require('node:child_process');
const net = require('node:net'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'ks-r5-'));
fs.mkdirSync(shots, { recursive: true });
const free = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const IMG = path.join(__dirname, '..', 'static', 'images', 'bakmi-goreng.jpg');

(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-db-'));
  const proc = spawn('python3', [path.join(__dirname, '..', 'app.py')], { env: { ...process.env, KOPI_SAWAH_PORT: String(port), KOPI_SAWAH_DB: path.join(tmp, 't.sqlite3'), KOPI_SAWAH_SETUP_CODE: '12345678' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch();
  const results = [], errors = [];
  const ok = (name, cond, extra = '') => results.push([cond ? 'LULUS' : 'GAGAL', name, extra]);
  const post = (p, body, ip = '10.5.0.1') => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Real-IP': ip }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
    await api.post('/api/auth/setup', { data: { name: 'Digi', pin: '482916', setup_code: '12345678' } });
    await api.post('/api/shifts/open', { data: { opening_cash: 100000 } });
    await api.post('/api/tables', { data: { count: 4 } });
    const tables = (await (await api.get('/api/tables')).json()).items;
    const state = await api.storageState();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: state, locale: 'id-ID', serviceWorkers: 'allow' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|offline/i.test(m.text())) errors.push('console: ' + m.text()); });
    const shot = n => page.screenshot({ path: path.join(shots, n + '.png') });
    await page.goto(base); await page.waitForSelector('.top');

    // ---- 1. unggah foto saat TAMBAH menu
    await page.click('#tabs [data-view=kelola]'); await page.click('[data-act=sub][data-s=menu]'); await page.waitForSelector('[data-act=addProduct]');
    await page.click('[data-act=addProduct]'); await page.waitForSelector('#photoFile', { state: 'attached' });
    await shot('50-tambah-menu-foto');
    await page.setInputFiles('#photoFile', IMG); await page.waitForSelector('#imgPrev img');
    await page.fill('[name=name]', 'Menu Uji Foto'); await page.fill('[name=price]', '12000');
    await page.click('[data-submit]'); await page.waitForSelector('.toast:has-text("Menu disimpan")');
    await page.waitForTimeout(600);
    const key = await api.get('/api/products').then(r => r.json()).then(j => j.items.find(p => p.name === 'Menu Uji Foto').image_key);
    ok('menu baru langsung tersimpan beserta fotonya', /^up-[0-9a-f]{12}$/.test(key), key);

    // ---- 2. Lengkapi foto
    await page.click('[data-act=quickPhoto]'); await page.waitForSelector('#qpList input[type=file]', { state: 'attached' });
    const before = parseInt((await page.textContent('#qpCount')).match(/\d+/)[0], 10);
    await shot('51-lengkapi-foto');
    await page.setInputFiles('#qpList input[type=file] >> nth=0', IMG); await page.waitForSelector('.toast:has-text("Foto tersimpan")');
    await page.waitForTimeout(400);
    const after = parseInt((await page.textContent('#qpCount')).match(/\d+/)[0], 10);
    ok('Lengkapi foto: jumlah menu tanpa foto berkurang 1', after === before - 1, `${before}→${after}`);
    await page.click('[data-done]');

    // ---- 3. QRIS toko + tampil di halaman pelanggan
    await page.click('#tabs [data-view=kelola]'); await page.click('[data-act=sub][data-s=atur]'); await page.waitForSelector('#qrisFile', { state: 'attached' });
    await shot('52-pengaturan-qris-cadangan');
    ok('pengaturan memuat kartu cadangan otomatis', (await page.textContent('#sub')).includes('Cadangan otomatis'));
    await page.setInputFiles('#qrisFile', IMG); await page.waitForSelector('[data-act=qrisDelete]');
    ok('gambar QRIS toko tersimpan', true);
    await page.click('[data-act=backupNow]'); await page.waitForSelector('.item:has-text("auto-")');
    ok('Cadangkan sekarang menambah berkas cadangan', true);

    const cust = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'id-ID', extraHTTPHeaders: { 'X-Real-IP': '10.5.0.9' } });
    const cp = await cust.newPage(); cp.on('pageerror', e => errors.push('pelanggan: ' + e.message));
    await cp.goto(`${base}/m/${tables[1].token}`); await cp.waitForSelector('.item');
    await cp.fill('#q', 'Bakmi Goreng'); await cp.click('.item >> nth=0'); await cp.waitForSelector('[data-add]'); await cp.click('[data-add]');
    await cp.click('[data-act=cart]'); await cp.waitForSelector('[data-send]'); await cp.click('[data-send]'); await cp.waitForSelector('.ord');
    ok('QRIS belum tampil sebelum pesanan diterima', (await cp.$$('[data-act=qris]')).length === 0);

    // ---- 4. papan dapur
    await page.click('#tabs [data-view=meja]'); await page.waitForSelector('[data-act=orderStatus][data-s=accepted]', { timeout: 15000 });
    await page.click('[data-act=orderStatus][data-s=accepted]'); await page.waitForSelector('[data-act=orderStatus][data-s=ready]');
    await page.click('[data-act=mejaMode][data-m=dapur]'); await page.waitForSelector('.btn.big:has-text("Siap")');
    await shot('53-papan-dapur');
    ok('papan dapur menampilkan pesanan diterima', (await page.textContent('#main')).includes('Sedang diproses (1)'));
    await page.click('.btn.big:has-text("Siap")'); await page.waitForSelector('.btn.big:has-text("Sudah disajikan")');
    ok('pesanan pindah ke kolom Siap diantar', (await page.textContent('#main')).includes('Siap diantar (1)'));
    await page.click('[data-act=mejaMode][data-m=meja]'); await page.waitForSelector('[data-act=payTable]');
    await cp.click('[data-act=status]').catch(() => { });
    await cp.waitForSelector('[data-act=qris]', { timeout: 15000 }).catch(() => { });
    ok('QRIS tampil di HP pelanggan setelah diterima', (await cp.$$('[data-act=qris]')).length === 1);
    if ((await cp.$$('[data-act=qris]')).length) { await cp.click('[data-act=qris]'); await cp.waitForSelector('.sheet img'); await cp.screenshot({ path: path.join(shots, '54-pelanggan-qris.png') }); }

    // ---- 5. pindah meja + bayar sebagian (split per pesanan)
    const t3 = tables[2].token;
    const mk = async (name, ip) => (await post('/api/public/orders', { t: t3, items: [{ product_id: name, quantity: 1 }] }, ip)).order.id;
    const oA = await mk('4', '10.5.0.3'), oB = await mk('5', '10.5.0.3');
    await page.reload(); await page.waitForSelector('.top'); await page.click('#tabs [data-view=meja]'); await page.waitForSelector('[data-act=orderStatus][data-s=accepted]');
    for (let i = 0; i < 2; i++) { await page.click('[data-act=orderStatus][data-s=accepted] >> nth=0'); await page.waitForTimeout(700); }
    await shot('55-meja-dua-pesanan');
    await page.click('[data-act=moveTable][data-t="Meja 3"]'); await page.waitForSelector('#theForm');
    const opts = await page.$$eval('[name=to] option', o => o.map(x => x.textContent));
    ok('pindah meja menampilkan meja tujuan lain', opts.length >= 3 && !opts.includes('Meja 3'), opts.join(','));
    await page.selectOption('[name=to]', { label: 'Meja 4' }); await page.click('[data-submit]'); await page.waitForSelector('[data-act=payTable][data-t="Meja 4"]');
    ok('pesanan berpindah ke Meja 4', true);
    await page.click('[data-act=payTable][data-t="Meja 4"]'); await page.waitForSelector('#coOrders .opt');
    ok('daftar pesanan bisa dipilih untuk bayar sebagian', (await page.$$('#coOrders .opt')).length === 2);
    await page.click('#coOrders .opt >> nth=1'); await page.click('#coPay [data-m=qris]'); await shot('56-bayar-sebagian');
    await page.click('#coPayBtn'); await page.waitForSelector('.receipt'); await page.click('[data-done]');
    await page.waitForSelector('[data-act=payTable][data-t="Meja 4"]');
    ok('setelah bayar sebagian, satu pesanan tetap di meja', (await page.$$('[data-act=orderStatus][data-s=ready]')).length >= 1);

    // ---- 6. MODE OFFLINE
    await page.click('#tabs [data-view=kasir]'); await page.waitForSelector('.tile');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload(); await page.waitForSelector('.tile');          // supaya halaman dikendalikan service worker
    const swOk = await page.evaluate(() => !!navigator.serviceWorker.controller);
    ok('service worker aktif mengendalikan halaman', swOk);
    await ctx.setOffline(true);
    await page.reload(); await page.waitForSelector('.tile', { timeout: 20000 });
    ok('aplikasi tetap terbuka saat offline (dari cache)', true);
    await page.fill('#q', 'Bakmi Goreng'); await page.click('.tile >> nth=0');
    await page.waitForSelector('[data-add]').catch(() => { }); if (await page.$('.sheet [data-add]')) await page.click('.sheet [data-add]');
    await page.waitForSelector('#cartSide .cl'); await page.click('#cartSide [data-act=checkout]'); await page.waitForSelector('#coPay');
    await page.click('#coPay [data-m=tunai]'); await page.fill('#coPaid', '50000'); await shot('57-offline-bayar');
    await page.click('#coPayBtn'); await page.waitForSelector('.receipt');
    const recText = await page.textContent('.sheet');
    ok('struk offline memberi tahu "belum terkirim"', recText.includes('Belum terkirim ke server') && recText.includes('OFFLINE-'));
    await shot('58-offline-struk'); await page.click('[data-done]');
    const qLen = await page.evaluate(() => JSON.parse(localStorage.getItem('ks_sale_queue') || '[]').length);
    ok('penjualan masuk antrean di perangkat', qLen === 1, String(qLen));
    ok('bar offline tampil', (await page.textContent('#offlineBar')).includes('belum terkirim'));
    await shot('59-offline-bar');
    const before2 = (await (await api.get('/api/sales')).json()).items.length;
    await ctx.setOffline(false);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ks_sale_queue') || '[]').length === 0, null, { timeout: 30000 });
    const after2 = (await (await api.get('/api/sales')).json()).items.length;
    ok('setelah internet kembali, penjualan terkirim otomatis & tercatat tepat 1x', after2 === before2 + 1, `${before2}→${after2}`);
    ok('bar offline hilang', !(await page.textContent('#offlineBar')).includes('belum terkirim'));
  } catch (e) { results.push(['GAGAL', 'skrip berhenti: ' + e.message.split('\n')[0], '']); }
  finally { await browser.close(); proc.kill('SIGTERM'); }
  results.forEach(r => console.log(r.join(' | ')));
  console.log('Galat konsol/halaman:', errors.length ? errors : 'tidak ada');
  console.log('Screenshot:', shots);
  process.exitCode = results.some(r => r[0] === 'GAGAL') || errors.length ? 1 : 0;
})();
