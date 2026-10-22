/* Audit "pas layar": buka tiap layar penting di banyak ukuran, lalu ukur apakah ada yang meluber ke samping,
 * terpotong di bawah, atau tombol utama tak terjangkau. Data TIRUAN di DB sementara.
 * Jalankan: NODE_PATH=/opt/node-tools/node_modules node tests/viewport_audit.js [folder-screenshot] [--shots]
 */
const { chromium, request } = require('playwright');
const { spawn } = require('node:child_process');
const net = require('node:net'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const shots = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : fs.mkdtempSync(path.join(os.tmpdir(), 'ks-audit-'));
const SAVE_ALL = process.argv.includes('--shots');
fs.mkdirSync(shots, { recursive: true });
const free = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const SIZES = (process.env.ONLY ? (all => all.filter(x => x[0].includes(process.env.ONLY)))  : (all => all))([
  ['hp-kecil 320x568', 320, 568], ['hp 360x640', 360, 640], ['hp 390x844', 390, 844], ['hp-besar 412x915', 412, 915],
  ['tablet-tegak 768x1024', 768, 1024], ['tablet-datar 1024x768', 1024, 768], ['tablet-android 1280x800', 1280, 800],
  ['laptop 1366x768', 1366, 768], ['laptop-zoom125 1093x614', 1093, 614], ['laptop-zoom150 911x512', 911, 512], ['pendek 1366x600', 1366, 600], ['desktop 1920x1080', 1920, 1080],
]);

(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-db-'));
  const proc = spawn('python3', [path.join(__dirname, '..', 'app.py')], { env: { ...process.env, KOPI_SAWAH_PORT: String(port), KOPI_SAWAH_DB: path.join(tmp, 't.sqlite3'), KOPI_SAWAH_SETUP_CODE: '12345678' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch();
  const problems = []; let checks = 0;
  try {
    // ---- data tiruan lewat API
    const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
    await api.post('/api/auth/setup', { data: { name: 'Digi', pin: '482916', setup_code: '12345678' } });
    await api.put('/api/settings', { data: { tax_percent: '10', service_percent: '5', rounding: '100', kasir_max_discount_percent: '10' } });
    await api.post('/api/shifts/open', { data: { opening_cash: 100000 } });
    await api.post('/api/tables', { data: { count: 14 } });
    const tables = (await (await api.get('/api/tables')).json()).items;
    const newOrder = async (t, ip) => {   // satu pesanan baru (menunggu) per putaran supaya data uji tidak menumpuk
      await fetch(`${base}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Real-IP': ip }, body: JSON.stringify({ t, customer_name: 'Bu Sari dengan nama panjang sekali', note: 'tolong jangan terlalu pedas dan tambahkan sambal terpisah ya', items: [{ product_id: '4', quantity: 2 }, { product_id: '7', quantity: 1 }, { product_id: '9', quantity: 1, modifiers: [{ id: 'nasi-2' }] }] }) });
      await fetch(`${base}/api/public/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Real-IP': ip }, body: JSON.stringify({ t, kind: 'bill' }) });
    };
    const state = await api.storageState();
    const cartInit = JSON.stringify([
      { key: '4|', pid: '4', opts: [], qty: 2 }, { key: '7|', pid: '7', opts: [], qty: 1 },
      { key: '17|a', pid: '17', opts: [{ id: 'suhu-1', name: 'Es', delta: 0, group: 'Suhu' }, { id: 'gula-1', name: 'Normal', delta: 0, group: 'Level Gula' }, { id: 'ukuran-2', name: 'Large', delta: 5000, group: 'Ukuran' }, { id: 'susu-2', name: 'Oat Milk', delta: 5000, group: 'Jenis Susu' }], qty: 3 },
      { key: '9|b', pid: '9', opts: [], qty: 1 }, { key: '10|', pid: '10', opts: [], qty: 1 }, { key: '12|', pid: '12', opts: [], qty: 2 }]);

    async function measure(page, label, size, opts = {}) {
      checks++;
      const [, tw, th] = size.match(/(\d+)x(\d+)/).map(Number);
      const m = await page.evaluate(([tw, th]) => {
        const vw = tw, vh = th, bad = [];    // ukur terhadap lebar perangkat sebenarnya (viewport peramban HP bisa membesar diam-diam)
        const scrollable = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { const o = getComputedStyle(e); if (/(auto|scroll)/.test(o.overflowX) && e.scrollWidth > e.clientWidth) return true; } return false; };
        for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
          if (el.closest('#printArea')) continue;
          if ((r.right > vw + 1 || r.left < -1) && !scrollable(el.parentElement || el)) bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''} [${Math.round(r.left)}..${Math.round(r.right)}]`);
        }
        const sheet = document.querySelector('.sheet'), foot = document.querySelector('.sheet-f'), bar = document.querySelector('.mobile-bar, .bar');
        const out = { over: document.documentElement.scrollWidth - vw, bad: [...new Set(bad)].slice(0, 6), vh };
        if (sheet) { const r = sheet.getBoundingClientRect(); out.sheetBottom = Math.round(r.bottom); out.sheetTop = Math.round(r.top); }
        if (foot) { const r = foot.getBoundingClientRect(); out.footBottom = Math.round(r.bottom); }
        const pay = document.querySelector('#cartSide [data-act=checkout]'); if (pay && getComputedStyle(document.querySelector('#cartSide')).display !== 'none') out.payBottom = Math.round(pay.getBoundingClientRect().bottom);
        out.inflated = innerWidth - tw;
        return out;
      }, [tw, th]);
      const issues = [];
      if (m.inflated > 1) issues.push(`halaman melebar: peramban HP memperbesar viewport ${m.inflated}px`);
      if (m.over > 1) issues.push(`geser horizontal ${m.over}px`);
      if (m.bad.length) issues.push('meluber: ' + m.bad.join('; '));
      if (m.sheetBottom != null && m.sheetBottom > m.vh + 1) issues.push(`lembar terpotong di bawah (bawah=${m.sheetBottom} > tinggi=${m.vh})`);
      if (m.sheetTop != null && m.sheetTop < -1) issues.push(`lembar terpotong di atas (${m.sheetTop})`);
      if (m.footBottom != null && m.footBottom > m.vh + 1) issues.push(`tombol lembar tak terlihat (${m.footBottom} > ${m.vh})`);
      if (m.payBottom != null && m.payBottom > m.vh + 1) issues.push(`tombol Bayar di panel keranjang tak terlihat (${m.payBottom} > ${m.vh})`);
      if (issues.length) { problems.push({ size, label, issues }); await page.screenshot({ path: path.join(shots, `X-${size.split(' ')[1]}-${label.replace(/[^a-z0-9]+/gi, '_')}.png`) }); }
      else if (SAVE_ALL) await page.screenshot({ path: path.join(shots, `ok-${size.split(' ')[1]}-${label.replace(/[^a-z0-9]+/gi, '_')}.png`) });
    }

    let idx = 0;
    for (const [size, w, h] of SIZES) try {
      idx++; const tok = tables[idx].token; await newOrder(tok, `10.1.0.${idx}`);
      const mobile = w < 800;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, storageState: state, locale: 'id-ID', extraHTTPHeaders: { 'X-Real-IP': `10.2.0.${idx}` } });
      await ctx.addInitScript(([cart]) => { try { localStorage.setItem('ks_cart_v2', cart); if (!localStorage.getItem('ks_view')) localStorage.setItem('ks_view', 'kasir'); } catch { } }, [cartInit]);
      const page = await ctx.newPage();
      const go = async (view, sel) => { await page.evaluate(v => { localStorage.setItem('ks_view', v); }, view); await page.goto(base); await page.waitForSelector(sel || '#main', { timeout: 15000 }); await page.waitForTimeout(400); };
      const view = async (name, sel, extra) => { await go(name, sel); if (extra) await extra(); await measure(page, name + (extra ? '+' : ''), size); };
      // staff
      await page.goto(base); await page.waitForSelector('.top');
      await view('kasir', '.tile');
      await go('kasir', '.tile');
      await page.click('.tile >> nth=0'); await page.waitForSelector('.sheet [data-add], .sheet .btn');
      await page.waitForTimeout(250); await measure(page, 'kasir-sheet-varian', size); await page.keyboard.press('Escape');
      if (mobile || w < 1000) { await page.click('[data-act=openCart]'); await page.waitForSelector('.sheet .cl'); await page.waitForTimeout(250); await measure(page, 'keranjang-sheet', size); await page.click('.sheet [data-act=checkout]'); }
      else await page.click('#cartSide [data-act=checkout]');
      await page.waitForSelector('#coPay'); await page.waitForTimeout(250);
      await page.click('#coPay [data-m=tunai]'); await page.fill('#coPaid', '200000');
      await measure(page, 'bayar-sheet', size); await page.keyboard.press('Escape');
      await view('meja', '[data-act=payTable], .empty');
      await go('meja', '[data-act=payTable]');
      await page.click('[data-act=moveTable]'); await page.waitForSelector('#theForm'); await page.waitForTimeout(250); await measure(page, 'pindah-meja-sheet', size); await page.keyboard.press('Escape');
      await page.click('[data-act=help]'); await page.waitForSelector('details'); await page.waitForTimeout(250); await measure(page, 'bantuan-sheet', size); await page.keyboard.press('Escape');
      await page.click('[data-act=orderStatus][data-s=accepted]'); await page.waitForTimeout(500);
      await page.click('[data-act=mejaMode][data-m=dapur]'); await page.waitForSelector('.btn.big:has-text("Siap")'); await page.waitForTimeout(250); await measure(page, 'papan-dapur', size);
      await page.click('[data-act=mejaMode][data-m=meja]'); await page.waitForSelector('[data-act=payTable]'); await page.waitForTimeout(500); await page.click('[data-act=payTable]'); await page.waitForSelector('#coPay'); await page.waitForTimeout(250); await measure(page, 'bayar-meja-sheet', size); await page.keyboard.press('Escape');
      for (const v of ['home', 'pesanan', 'laporan', 'kas']) await view(v, '#main .page-head, #main h2');
      await go('kelola', '[data-act=sub]');
      for (const sub of ['menu', 'stok', 'varian', 'meja', 'tim', 'atur']) { await page.click(`[data-act=sub][data-s=${sub}]`); await page.waitForTimeout(450); await measure(page, 'kelola-' + sub, size); }
      await page.click('[data-act=sub][data-s=menu]'); await page.waitForSelector('[data-act=editProduct]');
      await page.click('[data-act=quickPhoto]'); await page.waitForSelector('#qpList'); await page.waitForTimeout(250); await measure(page, 'lengkapi-foto-sheet', size); await page.keyboard.press('Escape');
      await page.click('[data-act=addProduct]'); await page.waitForSelector('#photoFile', { state: 'attached' }); await page.waitForTimeout(250); await measure(page, 'tambah-menu-sheet', size); await page.keyboard.press('Escape');
      await page.click('[data-act=editProduct] >> nth=3'); await page.waitForSelector('#theForm'); await page.waitForTimeout(300); await measure(page, 'ubah-menu-sheet', size); await page.keyboard.press('Escape');
      await page.click('[data-act=sub][data-s=meja]'); await page.waitForSelector('[data-act=tableQR]'); await page.click('[data-act=tableQR] >> nth=0'); await page.waitForSelector('.sheet svg'); await page.waitForTimeout(250); await measure(page, 'qr-sheet', size); await page.keyboard.press('Escape');
      // pelanggan
      const cp = await ctx.newPage();
      await cp.goto(`${base}/m/${tok}`); await cp.waitForSelector('.item'); await cp.waitForTimeout(300); await measure(cp, 'pelanggan-menu', size);
      await cp.fill('#q', 'Udang Krispy'); await cp.click('.item >> nth=0'); await cp.waitForSelector('.opt'); await cp.waitForTimeout(300); await measure(cp, 'pelanggan-pilihan', size);
      await cp.click('.opt:has-text("Tanpa nasi")'); await cp.click('.sheet [data-add]'); await cp.fill('#q', 'Bakmi Goreng'); await cp.click('.item >> nth=0'); await cp.waitForTimeout(200); await cp.keyboard.press('Escape');
      await cp.click('[data-act=cart]'); await cp.waitForSelector('.sheet .cl'); await cp.waitForTimeout(300); await measure(cp, 'pelanggan-keranjang', size);
      await cp.click('[data-send]'); await cp.waitForSelector('.ord'); await cp.waitForTimeout(500); await measure(cp, 'pelanggan-status', size);
      await ctx.close();
      // layar masuk (tanpa sesi)
      const c2 = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, locale: 'id-ID' });
      const p2 = await c2.newPage(); await p2.goto(base); await p2.waitForSelector('.staff'); await measure(p2, 'masuk', size);
      await p2.click('.staff button'); await p2.waitForSelector('.pad'); await measure(p2, 'masuk-pin', size); await c2.close();
    } catch (e) { problems.push({ size, label: 'skrip', issues: [e.message.split('\n').filter(l => l.trim()).slice(0, 6).join(' | ')] }); }
  } catch (e) { problems.push({ size: '-', label: 'skrip', issues: [e.stack.split('\n').slice(0, 3).join(' | ')] }); }
  finally { await browser.close(); proc.kill('SIGTERM'); }
  console.log(`Pemeriksaan: ${checks} layar × ukuran. Masalah: ${problems.length}`);
  for (const p of problems) console.log(` - [${p.size}] ${p.label}: ${p.issues.join(' | ')}`);
  console.log('Screenshot masalah:', shots);
  process.exitCode = problems.length ? 1 : 0;
})();
