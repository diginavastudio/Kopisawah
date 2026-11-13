/* Uji tiket dapur: item dikelompokkan per stasiun (MAKANAN / MINUMAN / CAMILAN) dengan batas jelas.
 * DB SEMENTARA. Jalankan:
 * NODE_PATH=/opt/node-tools/node_modules CHROME_PATH=/opt/chromium/chrome-linux64/chrome node tests/browser_tiket_dapur.js
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
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-tiket-'));
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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID' });
    const page = await ctx.newPage();
    page.on('pageerror', e => galat.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/audio|Media/i.test(m.text())) galat.push('console: ' + m.text()); });

    await page.goto(base);
    await page.waitForSelector('#f');
    await page.fill('[name=name]', 'Digi'); await page.fill('[name=pin]', '482916'); await page.fill('[name=pin2]', '482916'); await page.fill('[name=code]', '12345678');
    await page.click('#f button[type=submit]');
    await page.waitForSelector('.top');
    await page.click('#tabs button[data-view=kasir]');
    await page.waitForSelector('#openCash');
    await page.fill('#openCash', '100000');
    await page.click('[data-act=openShift]');
    await page.waitForSelector('#grid .tile');

    // satu nota berisi tiga stasiun (Air Es = Add-on yang masuk MINUMAN)
    const hasilNota = await page.evaluate(async () => {
      await loadProducts(true);
      const p = Object.fromEntries(state.products.map(x => [x.name, x]));
      const items = [
        { product_id: p['Nasi Goreng Original'].id, quantity: 1, modifiers: [] },
        { product_id: p['Air Es'].id, quantity: 2, modifiers: [] },
        { product_id: p['Bakwan'].id, quantity: 1, modifiers: [] },
      ];
      const r = await api('/api/sales', { method: 'POST', body: { items, payment_method: 'qris', order_type: 'dine_in', table_no: 'Meja 3' } });
      const s = r.item;
      const html = ticketHTML(s);
      const box = document.createElement('div');
      box.id = 'uji-tiket'; box.className = 'receipt-preview';
      box.innerHTML = html;
      document.body.appendChild(box);
      const stations = [...box.querySelectorAll('.station')].map(x => x.textContent.trim());
      const blocks = [...box.querySelectorAll('.station')].map(st => {
        let txt = ''; let el = st.nextElementSibling;
        while (el && !el.classList.contains('station')) { txt += ' ' + el.textContent; el = el.nextElementSibling; }
        return [st.textContent.trim(), txt.trim()];
      });
      return { stations, blocks, id: s.id };
    });
    ok('tiga batas stasiun tampil berurutan', JSON.stringify(hasilNota.stations) === JSON.stringify(['MAKANAN', 'MINUMAN', 'CAMILAN']), JSON.stringify(hasilNota.stations));
    const blok = Object.fromEntries(hasilNota.blocks);
    ok('Nasi Goreng masuk MAKANAN', /Nasi Goreng/.test(blok.MAKANAN || ''), blok.MAKANAN);
    ok('Air Es (Add-on) masuk MINUMAN', /Air Es/.test(blok.MINUMAN || ''), blok.MINUMAN);
    ok('Bakwan masuk CAMILAN', /Bakwan/.test(blok.CAMILAN || ''), blok.CAMILAN);
    ok('item tidak dobel di stasiun lain', !/Nasi Goreng/.test(blok.MINUMAN || '') && !/Bakwan/.test(blok.MAKANAN || ''));

    // nota hanya minuman -> hanya satu batas stasiun
    const hanyaMinum = await page.evaluate(async () => {
      const p = Object.fromEntries(state.products.map(x => [x.name, x]));
      const r = await api('/api/sales', { method: 'POST', body: { items: [{ product_id: p['Air Es'].id, quantity: 1, modifiers: [] }], payment_method: 'qris' } });
      const box = document.createElement('div'); box.innerHTML = ticketHTML(r.item);
      return [...box.querySelectorAll('.station')].map(x => x.textContent.trim());
    });
    ok('stasiun kosong tidak dicetak', JSON.stringify(hanyaMinum) === JSON.stringify(['MINUMAN']), JSON.stringify(hanyaMinum));

    await page.evaluate(() => { document.querySelector('#uji-tiket').scrollIntoView({ block: 'center' }); });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: '/root/mockup-kopi-sawah/tiket-dapur-uji.png' }).catch(() => { });
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
