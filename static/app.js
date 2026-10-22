'use strict';
/* Kopi Sawah — antarmuka kasir. Tanpa pustaka luar. Semua teks pengguna dalam Bahasa Indonesia. */

/* ============================== util ============================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('id-ID');
const rp = n => n == null ? '—' : (n < 0 ? '−Rp' : 'Rp') + nf.format(Math.abs(n));
const digits = s => String(s ?? '').replace(/\D/g, '');
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* abaikan */ } },
};
const wib = (iso, opt) => { try { return new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', ...opt }); } catch { return iso; } };
const fmtTime = iso => wib(iso, { hour: '2-digit', minute: '2-digit' }).replace('.', ':');
const fmtDateTime = iso => wib(iso, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace('.', ':');
const fmtDate = d => new Date(d + 'T00:00:00+07:00').toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const todayWIB = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const METHOD_NAME = m => (state.methods && state.methods[m]) || m;
const ROLE_NAME = { owner: 'Pemilik', kasir: 'Kasir' };

const ICON = {
  home: '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 12h11L21 7H6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>',
  table: '<path d="M4 9h16M6 9v10M18 9v10M3 9l1.5-4h15L21 9"/>',
};
const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

/* ============================== state ============================== */
const state = {
  me: null, settings: {}, methods: {}, orderTypes: {}, staff: [],
  products: [], images: [], mods: null, shift: null,
  view: '', soldMode: false, sub: 'menu', cat: 'Semua', q: '', compact: ls.get('ks_compact') === '1',
  cart: [], rep: { preset: 'today', from: '', to: '' }, sheets: [], cartSheet: null,
};
const isOwner = () => state.me && state.me.role === 'owner';
const prod = id => state.products.find(p => p.id === id);
const CAT_ORDER = ['Makanan', 'Lauk', 'Paket', 'Sup', 'Sayuran', 'Camilan', 'Kopi', 'Minuman', 'Wedangan', 'Add-on'];   // urutan kartu menu
const catRank = c => { const i = CAT_ORDER.indexOf(c); return i < 0 ? 99 : i; };
const imgSrc = k => !k || k === 'none' ? '' : k.startsWith('up-') ? `/media/${k}.jpg` : `/static/images/${k}.jpg`;
const thumb = k => k && k !== 'none' ? `<img src="${imgSrc(k)}" alt="" loading="lazy">` : '<span class="noimg"></span>';
const signed = n => (n > 0 ? '+' : '−') + rp(Math.abs(n));

/* ============================== jaringan ============================== */
/* ---- data cadangan di perangkat agar kasir tetap jalan saat internet putus ---- */
const SNAP_KEYS = ['/api/auth/status', '/api/products', '/api/modifiers', '/api/shifts/current', '/api/settings'];
const snapKey = p => { const k = p.split('?')[0]; return SNAP_KEYS.includes(k) ? 'ks_snap:' + k : null; };
const snapSave = (p, d) => { const k = snapKey(p); if (k) ls.set(k, JSON.stringify({ at: Date.now(), d })); };
const snapLoad = p => { const k = snapKey(p); if (!k) return null; try { return JSON.parse(ls.get(k) || 'null'); } catch { return null; } };
function setOffline(v) {
  if (state.offline === v) return;
  state.offline = v; drawOfflineBar();
  if (!v) flushQueue();
}
async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    if (method === 'GET') { const snap = snapLoad(path); if (snap) { setOffline(true); return snap.d; } }
    setOffline(true);
    throw Object.assign(new Error('Tidak bisa terhubung ke server. Periksa internet/Wi-Fi lalu coba lagi.'), { network: true });
  }
  setOffline(false);
  const raw = await r.text();
  let d = {};
  try { d = raw ? JSON.parse(raw) : {}; } catch { /* bukan JSON */ }
  if (r.status === 401 && !path.startsWith('/api/auth/')) {
    state.me = null; boot();
    throw new Error('Sesi berakhir. Silakan masuk lagi.');
  }
  if (!r.ok) throw Object.assign(new Error(d.error || `Permintaan gagal (${r.status}).`), { status: r.status });
  if (method === 'GET') snapSave(path, d);
  return d;
}

/* ---- antrean penjualan saat offline (kunci idempoten mencegah dobel saat dikirim ulang) ---- */
const QKEY = 'ks_sale_queue';
const getQueue = () => { try { return JSON.parse(ls.get(QKEY) || '[]'); } catch { return []; } };
const setQueue = q => ls.set(QKEY, JSON.stringify(q));
let flushing = false;
async function flushQueue() {
  if (flushing || !state.me) return; flushing = true;
  try {
    let q = getQueue(), sent = 0;
    for (const item of q) {
      if (item.dead) continue;
      try { await api('/api/sales', { method: 'POST', body: item.body }); setQueue(getQueue().filter(x => x.body.request_id !== item.body.request_id)); sent++; }
      catch (e) {
        if (e.network) break;
        if (e.status === 401) break;
        const cur = getQueue(); const it = cur.find(x => x.body.request_id === item.body.request_id); if (it) { it.error = e.message; it.tries = (it.tries || 0) + 1; } setQueue(cur);
      }
    }
    if (sent) { toast(`${sent} penjualan offline sudah terkirim ✓`, 'ok'); loadProducts(true).catch(() => { }); }
  } finally { flushing = false; drawOfflineBar(); }
}
function drawOfflineBar() {
  const bar = $('#offlineBar'); if (!bar) return;
  const q = getQueue(), failed = q.filter(x => x.error);
  let html = '';
  if (state.offline) html += '<div class="offbar bad"><b>⚠ Offline</b> — internet putus. Penjualan tetap bisa dicatat dan akan dikirim otomatis saat tersambung lagi.</div>';
  if (q.length) html += `<div class="offbar ${failed.length ? 'bad' : 'warn'}"><b>${q.length} penjualan belum terkirim</b>${failed.length ? ` — ${failed.length} ditolak server: ${esc(failed[0].error)}` : ''} <button class="btn sm ghost" data-act="queueNow">Kirim sekarang</button>${failed.length ? ' <button class="btn sm ghost" data-act="queueDrop">Hapus yang ditolak</button>' : ''}</div>`;
  bar.innerHTML = html; bar.classList.toggle('hidden', !html);
}
window.addEventListener('online', () => { flushQueue(); });
window.addEventListener('offline', () => setOffline(true));

let toastTimer;
function toast(msg, kind = '') {
  $('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200);
}

/* ============================== lembar (modal) ============================== */
function openSheet({ title, body, footer = '', wide = false, onMount, onClose }) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-h"><h3>${esc(title)}</h3><button class="x" data-close aria-label="Tutup">×</button></div>
    <div class="sheet-b">${body}</div>${footer ? `<div class="sheet-f">${footer}</div>` : ''}</div>`;
  document.body.appendChild(scrim);
  const sh = {
    el: scrim, q: s => $(s, scrim), qa: s => $$(s, scrim),
    body: () => $('.sheet-b', scrim),
    setBody(html) { $('.sheet-b', scrim).innerHTML = html; },
    setFooter(html) { let f = $('.sheet-f', scrim); if (f) f.innerHTML = html; },
    close() { scrim.remove(); state.sheets = state.sheets.filter(x => x !== sh); onClose && onClose(); },
  };
  $('[data-close]', scrim).onclick = () => sh.close();
  state.sheets.push(sh);
  onMount && onMount(sh);
  const first = $('input:not([type=hidden]),select,textarea', scrim);
  if (first && matchMedia('(pointer:fine)').matches) first.focus();
  return sh;
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.sheets.length) state.sheets[state.sheets.length - 1].close();
});

function confirmSheet({ title, text, ok = 'Ya, lanjutkan', danger = false }) {
  return new Promise(res => {
    let done = false;
    const sh = openSheet({
      title, body: `<p>${text}</p>`,
      footer: `<button class="btn ghost" data-no>Batal</button><button class="btn ${danger ? 'danger' : ''}" data-yes>${esc(ok)}</button>`,
      onMount: s => { s.q('[data-no]').onclick = () => { done = true; s.close(); res(false); }; s.q('[data-yes]').onclick = () => { done = true; s.close(); res(true); }; },
      onClose: () => { if (!done) res(false); },
    });
    return sh;
  });
}

/* Formulir generik: fields = [{name,label,type,value,hint,options,placeholder,maxlength,list}] */
function fieldHTML(f) {
  const id = 'f_' + f.name;
  const lbl = f.label ? `<label class="lbl" for="${id}">${esc(f.label)}</label>` : '';
  const hint = f.hint ? `<div class="hint">${f.hint}</div>` : '';
  let input = '';
  const v = f.value ?? '';
  switch (f.type) {
    case 'money': input = `<input class="field" id="${id}" name="${f.name}" inputmode="numeric" autocomplete="off" data-money placeholder="${esc(f.placeholder || '0')}" value="${v === '' || v == null ? '' : nf.format(v)}">`; break;
    case 'smoney': input = `<input class="field" id="${id}" name="${f.name}" inputmode="text" autocomplete="off" data-smoney placeholder="0" value="${v === '' || v == null ? '' : (v < 0 ? '-' : '') + nf.format(Math.abs(v))}">`; break;
    case 'number': input = `<input class="field" id="${id}" name="${f.name}" inputmode="decimal" autocomplete="off" placeholder="${esc(f.placeholder || '')}" value="${esc(v)}">`; break;
    case 'pin': input = `<input class="field" id="${id}" name="${f.name}" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="${esc(f.placeholder || '')}" value="${esc(v)}">`; break;
    case 'textarea': input = `<textarea class="field" id="${id}" name="${f.name}" maxlength="${f.maxlength || 240}" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`; break;
    case 'select': input = `<select class="field" id="${id}" name="${f.name}">${f.options.map(([val, text]) => `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`; break;
    case 'seg': input = `<div class="seg" data-seg="${f.name}" data-value="${esc(v)}">${f.options.map(([val, text]) => `<button type="button" data-v="${esc(val)}" class="${String(val) === String(v) ? 'on' : ''}">${esc(text)}</button>`).join('')}</div>`; break;
    case 'switch': input = `<button type="button" class="opt multi ${v ? 'on' : ''}" data-switch="${f.name}" data-value="${v ? 1 : 0}"><span class="box"></span><span>${esc(f.text || f.label)}</span></button>`; return `<div class="form-row">${input}${hint}</div>`;
    default: input = `<input class="field" id="${id}" name="${f.name}" autocomplete="off" maxlength="${f.maxlength || 80}" placeholder="${esc(f.placeholder || '')}" value="${esc(v)}" ${f.list ? `list="${f.list.id}"` : ''}>${f.list ? `<datalist id="${f.list.id}">${f.list.items.map(i => `<option value="${esc(i)}">`).join('')}</datalist>` : ''}`;
  }
  return `<div class="form-row">${lbl}${input}${hint}</div>`;
}
function readFields(root, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'seg') out[f.name] = $(`[data-seg="${f.name}"]`, root).dataset.value;
    else if (f.type === 'switch') out[f.name] = $(`[data-switch="${f.name}"]`, root).dataset.value === '1';
    else {
      const el = $(`[name="${f.name}"]`, root);
      out[f.name] = f.type === 'money' ? (digits(el.value) === '' ? null : parseInt(digits(el.value), 10))
        : f.type === 'smoney' ? (digits(el.value) === '' ? 0 : (/^\s*[-−]/.test(el.value) ? -1 : 1) * parseInt(digits(el.value), 10))
        : el.value.trim();
    }
  }
  return out;
}
function wireFields(root) {
  $$('[data-seg]', root).forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    seg.dataset.value = b.dataset.v; $$('button', seg).forEach(x => x.classList.toggle('on', x === b));
    seg.dispatchEvent(new Event('change', { bubbles: true }));
  }));
  $$('[data-switch]', root).forEach(sw => sw.addEventListener('click', () => {
    sw.dataset.value = sw.dataset.value === '1' ? '0' : '1'; sw.classList.toggle('on', sw.dataset.value === '1');
    sw.dispatchEvent(new Event('change', { bubbles: true }));
  }));
}
document.addEventListener('input', e => {
  const el = e.target;
  if (el.matches && el.matches('[data-smoney]')) {
    const neg = /^\s*[-−]/.test(el.value), d = digits(el.value).slice(0, 9);
    el.value = (neg ? '-' : '') + (d ? nf.format(parseInt(d, 10)) : '');
  }
  if (el.matches && el.matches('[data-money]')) {
    const d = digits(el.value).slice(0, 10);
    el.value = d ? nf.format(parseInt(d, 10)) : '';
  }
});

function formSheet({ title, head = '', intro = '', fields, submit = 'Simpan', danger, extra = '', onSubmit, onMount, wide }) {
  const sh = openSheet({
    title, wide,
    body: `${head}${intro ? `<p class="muted" style="margin-top:0">${intro}</p>` : ''}<div id="formErr"></div><form id="theForm" novalidate>${fields.map(fieldHTML).join('')}</form>${extra}`,
    footer: `<button class="btn ghost" data-cancel type="button">Batal</button><button class="btn ${danger ? 'danger' : ''}" data-submit type="button">${esc(submit)}</button>`,
    onMount: s => {
      wireFields(s.el);
      s.q('[data-cancel]').onclick = () => s.close();
      const go = async () => {
        const btn = s.q('[data-submit]'); btn.disabled = true; $('#formErr', s.el).innerHTML = '';
        try { await onSubmit(readFields(s.el, fields), s); }
        catch (err) { $('#formErr', s.el).innerHTML = `<div class="notice bad" style="margin-bottom:12px">${esc(err.message)}</div>`; btn.disabled = false; s.body().scrollTop = 0; }
      };
      s.q('[data-submit]').onclick = go;
      s.q('#theForm').addEventListener('submit', e => { e.preventDefault(); go(); });
      onMount && onMount(s);
    },
  });
  return sh;
}

/* ============================== data ============================== */
async function loadProducts(force) {
  if (force || !state.products.length) {
    const d = await api('/api/products' + (isOwner() ? '?include_inactive=1' : ''));
    state.products = d.items.sort((a, b) => catRank(a.category) - catRank(b.category) || a.category.localeCompare(b.category) || (b.featured || 0) - (a.featured || 0) || a.name.localeCompare(b.name) || a.variant.localeCompare(b.variant));
    state.images = d.images || [];
  }
  return state.products;
}
const activeProducts = () => state.products.filter(p => p.active !== 0);
async function loadMods(force) { if (force || !state.mods) state.mods = await api('/api/modifiers'); return state.mods; }
async function loadShift() { state.shift = (await api('/api/shifts/current')).shift; updateShiftChip(); return state.shift; }
function groupsFor(p) {
  const custom = state.mods?.product_groups?.[p.id];
  const ids = custom !== undefined ? custom : (state.mods?.categories[p.category]) || [];
  return ids.map(id => state.mods.groups.find(g => g.id === id)).filter(g => g && g.options.length);
}
function soldOut(p) { return !p.available || (p.stock_tracked && p.stock_on_hand != null && p.stock_on_hand <= 0); }

/* ============================== keranjang ============================== */
const cartKey = (pid, opts) => pid + '|' + opts.map(o => o.id).sort().join(',');
function saveCart() { ls.set('ks_cart_v2', JSON.stringify(state.cart.map(({ key, pid, opts, qty }) => ({ key, pid, opts, qty })))); }
function restoreCart() {
  try { state.cart = (JSON.parse(ls.get('ks_cart_v2') || '[]')).filter(l => prod(l.pid) && l.qty > 0); } catch { state.cart = []; }
}
function addToCart(p, opts, qty = 1) {
  const key = cartKey(p.id, opts);
  const inCart = state.cart.filter(l => l.pid === p.id).reduce((s, l) => s + l.qty, 0);
  if (p.stock_tracked && p.stock_on_hand != null && inCart + qty > p.stock_on_hand) { toast(`Stok ${p.name} tinggal ${p.stock_on_hand}.`, 'bad'); return false; }
  const ex = state.cart.find(l => l.key === key);
  if (ex) ex.qty += qty; else state.cart.push({ key, pid: p.id, opts, qty });
  saveCart(); drawCart(); return true;
}
function changeQty(key, d) {
  const l = state.cart.find(x => x.key === key); if (!l) return;
  const p = prod(l.pid);
  if (d > 0 && p && p.stock_tracked && p.stock_on_hand != null && state.cart.filter(x => x.pid === l.pid).reduce((s, x) => s + x.qty, 0) + d > p.stock_on_hand) { toast(`Stok ${p.name} tinggal ${p.stock_on_hand}.`, 'bad'); return; }
  l.qty += d;
  if (l.qty <= 0) state.cart = state.cart.filter(x => x !== l);
  saveCart(); drawCart();
}
const optLabel = opts => { const seen = {}; opts.forEach(o => { seen[o.name] = (seen[o.name] || 0) + 1; }); return opts.map(o => seen[o.name] > 1 ? `${o.group} ${o.name}` : o.name).join(' · '); };
const lineUnit = l => { const p = prod(l.pid); return (p?.price || 0) + l.opts.reduce((s, o) => s + o.delta, 0); };
const cartSubtotal = () => state.cart.reduce((s, l) => s + lineUnit(l) * l.qty, 0);
const cartCount = () => state.cart.reduce((s, l) => s + l.qty, 0);

/* hitungan yang sama dengan server (pembulatan setengah-ke-atas, bilangan bulat) */
const toBp = s => Math.round(parseFloat(String(s ?? '0').replace(',', '.') || '0') * 100);
const pctOf = (x, bp) => Math.floor((x * bp + 5000) / 10000);
function calcTotals(subtotal, disc) {
  const st = state.settings, base = subtotal - disc;
  const svc = pctOf(base, toBp(st.service_percent)), tax = pctOf(base + svc, toBp(st.tax_percent));
  const raw = base + svc + tax, step = parseInt(st.rounding, 10) || 0;
  let total = raw;
  if (step) { const r = Math.floor((raw + Math.floor(step / 2)) / step) * step; if (r > 0) total = r; }
  return { subtotal, disc, svc, tax, round: total - raw, total };
}
function sumRows(t) {
  const st = state.settings, row = (l, v, cls = '') => `<div class="r ${cls}"><span>${l}</span><span>${v}</span></div>`;
  return row('Subtotal', rp(t.subtotal)) + (t.disc ? row('Diskon', '−' + rp(t.disc)) : '')
    + (t.svc ? row(`Biaya layanan ${st.service_percent}%`, rp(t.svc)) : '') + (t.tax ? row(`Pajak ${st.tax_percent}%`, rp(t.tax)) : '')
    + (t.round ? row('Pembulatan', rp(t.round)) : '') + row('Total', rp(t.total), 'total');
}

/* ============================== kerangka & navigasi ============================== */
function navItems() {
  return isOwner()
    ? [['home', 'Beranda', 'home'], ['kasir', 'Kasir', 'cart'], ['meja', 'Meja', 'table'], ['pesanan', 'Pesanan', 'list'], ['laporan', 'Laporan', 'chart'], ['kelola', 'Kelola', 'cog'], ['kas', 'Kas', 'cash']]
    : [['kasir', 'Kasir', 'cart'], ['meja', 'Meja', 'table'], ['pesanan', 'Pesanan', 'list'], ['kas', 'Kas', 'cash']];
}
function shell() {
  $('#app').innerHTML = `<header class="top"><img class="badge-logo" src="/static/images/logo-badge.png" alt="Kopi Sawah"><span class="brand">Kopi Sawah</span>
    <div class="who"><span id="shiftChip"></span><button class="btn ghost" data-act="help" aria-label="Bantuan" style="min-width:40px">?</button><span class="nm">${esc(state.me.name)} · ${ROLE_NAME[state.me.role]}</span>${state.tanpaLogin ? '' : '<button class="btn ghost" data-act="logout">Keluar</button>'}</div></header>
    <nav class="tabs" id="tabs" aria-label="Menu utama">${navItems().map(([id, label, ic]) => `<button data-act="go" data-view="${id}">${icon(ic)}<span>${label}</span>${id === 'meja' ? '<span class="nbadge hidden" id="mejaBadge"></span>' : ''}</button>`).join('')}</nav>
    <div id="offlineBar" class="hidden"></div><main id="main"></main>`;
  updateShiftChip(); drawOfflineBar();
}
function updateShiftChip() {
  const c = $('#shiftChip'); if (!c) return;
  c.innerHTML = state.shift ? `<span class="chip ok">Kasir buka · ${fmtTime(state.shift.opened_at)}</span>` : `<span class="chip warn">Kasir tutup</span>`;
}
async function go(view) {
  if (state.view !== view) { state.cartSheet?.close(); state.soldMode = false; }
  state.view = view; ls.set('ks_view', view);
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const main = $('#main'); if (!main) return;
  main.innerHTML = '<div class="empty">Memuat…</div>';
  window.scrollTo(0, 0);
  try { await VIEWS[view](); }
  catch (e) { main.innerHTML = `<div class="card"><div class="notice bad">${esc(e.message)}</div><p><button class="btn" data-act="go" data-view="${view}">Coba lagi</button></p></div>`; }
}
const head = (t, sub = '', right = '') => `<div class="page-head"><div><h2>${t}</h2>${sub ? `<p>${sub}</p>` : ''}</div><div class="row wrap">${right}</div></div>`;

/* ============================== masuk & penyiapan ============================== */
function authFrame(inner) {
  $('#app').innerHTML = `<div class="auth"><img class="auth-logo" src="/static/images/logo-badge.png" alt="Kopi Sawah"><div class="card">${inner}</div></div>`;
}
function setupScreen() {
  authFrame(`<h2>Selamat datang 👋</h2><p class="muted">Buat akun <b>pemilik</b> dulu. PIN ini dipakai untuk masuk dan mengatur toko.</p><div id="err"></div>
    <form id="f" novalidate>${[
      { name: 'name', label: 'Nama Anda', placeholder: 'mis. Digi', maxlength: 40 },
      { name: 'pin', label: 'PIN pemilik (6–8 angka)', type: 'pin', hint: 'Jangan pakai angka berulang atau berurutan (mis. 111111, 123456).' },
      { name: 'pin2', label: 'Ulangi PIN', type: 'pin' },
      { name: 'code', label: 'Kode penyiapan', type: 'pin', hint: 'Kode 8 angka yang muncul di log server saat aplikasi dinyalakan. Perintah: <code>journalctl -u kopi-sawah -n 30</code>' },
    ].map(fieldHTML).join('')}<button class="btn big block" type="submit">Buat akun & masuk</button></form>`);
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const v = readFields($('#f'), [{ name: 'name' }, { name: 'pin' }, { name: 'pin2' }, { name: 'code' }]);
    const err = m => { $('#err').innerHTML = `<div class="notice bad" style="margin-bottom:12px">${esc(m)}</div>`; };
    if (!v.name) return err('Nama wajib diisi.');
    if (v.pin !== v.pin2) return err('PIN dan ulangan PIN tidak sama.');
    try { await api('/api/auth/setup', { method: 'POST', body: { name: v.name, pin: v.pin, setup_code: v.code } }); boot(); }
    catch (x) { err(x.message); }
  };
}
function loginScreen() {
  authFrame(`<h2>Masuk</h2><p class="muted">Ketuk nama Anda.</p><div class="staff">${state.staff.map(s => `<button data-act="pickStaff" data-id="${s.id}" data-name="${esc(s.name)}"><span class="avatar">${esc(s.name.slice(0, 1).toUpperCase())}</span>${esc(s.name)}</button>`).join('')}</div>`);
}
function pinScreen(id, name) {
  let pin = '', busy = false;
  authFrame(`<div class="center"><span class="avatar" style="margin:0 auto 8px">${esc(name.slice(0, 1).toUpperCase())}</span><h2>${esc(name)}</h2><p class="muted">Masukkan PIN</p></div>
    <div id="err"></div><div class="dots" id="dots" aria-live="polite"></div>
    <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-d="${n}">${n}</button>`).join('')}<button class="fn" data-back>Ganti nama</button><button data-d="0">0</button><button class="fn" data-del aria-label="Hapus satu angka">⌫ Hapus</button></div>
    <button class="btn big block" style="margin-top:12px" id="enter" disabled>Masuk</button>`);
  const draw = () => {
    $('#dots').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'f' : ''}"></i>`).join('');
    $('#enter').disabled = pin.length < 4 || busy;
  };
  const submit = async () => {
    if (pin.length < 4 || busy) return; busy = true; draw();
    try { await api('/api/auth/login', { method: 'POST', body: { user_id: id, pin } }); boot(); }
    catch (e) { pin = ''; busy = false; $('#err').innerHTML = `<div class="notice bad" style="margin-bottom:8px">${esc(e.message)}</div>`; draw(); }
  };
  $$('[data-d]').forEach(b => b.onclick = () => { if (pin.length < 8) { pin += b.dataset.d; draw(); } });
  $('[data-del]').onclick = () => { pin = pin.slice(0, -1); draw(); };
  $('[data-back]').onclick = loginScreen;
  $('#enter').onclick = submit;
  document.onkeydown = e => {
    if (!$('#dots')) { document.onkeydown = null; return; }
    if (/^\d$/.test(e.key) && pin.length < 8) { pin += e.key; draw(); }
    else if (e.key === 'Backspace') { pin = pin.slice(0, -1); draw(); }
    else if (e.key === 'Enter') submit();
  };
  draw();
}

/* ============================== BANTUAN ============================== */
const HELP_HTML = `<div class="stack">
<details open><summary><b>Jualan di kasir</b></summary><ol><li>Tab <b>Kas</b> → isi uang awal laci → <b>Buka kasir</b> (sekali tiap shift).</li><li>Tab <b>Kasir</b> → ketuk menu → pilih ukuran/gula dsb. → <b>Tambah</b>.</li><li>Ketuk <b>Bayar</b> → pilih cara bayar. Untuk tunai isi uang diterima; kembalian muncul otomatis.</li><li>Akhir shift: tab <b>Kas</b> → hitung uang di laci → <b>Tutup kasir</b>.</li></ol></details>
<details><summary><b>Pesanan dari QR meja</b></summary><ol><li>Tab <b>Meja</b>: pesanan baru berbunyi. Ketuk <b>Terima</b>.</li><li>Dapur memasak lalu ketuk <b>Siap</b> (atau pakai <b>Papan dapur</b>), kemudian <b>Sudah disajikan</b>.</li><li>Pelanggan selesai makan → <b>Bayar meja</b>. Bisa bayar sebagian dengan menghilangkan centang pesanan.</li><li>Pelanggan pindah tempat duduk? <b>Pindah / gabung meja</b>.</li><li>Ada ikon 🙋/🧾 di atas = pelanggan memanggil pelayan / minta bill. Ketuk <b>Selesai</b> setelah dilayani.</li></ol></details>
<details><summary><b>Internet putus</b></summary><p>Kasir tetap bisa menjual. Muncul pita merah <b>Offline</b>; penjualan disimpan di perangkat dan <b>terkirim otomatis</b> saat internet kembali. Jangan hapus data peramban dan jangan tutup kasir sebelum terkirim. Pesanan dari QR meja memerlukan internet.</p></details>
<details><summary><b>Menu kosong / habis</b></summary><p>Di tab Kasir ketuk <b>Tandai menu habis</b>, lalu ketuk menu yang habis (ketuk lagi untuk tersedia kembali). Pelanggan melihat tulisan “Habis”.</p></details>
<details><summary><b>Foto menu & QR meja (pemilik)</b></summary><p><b>Kelola → Menu & Harga</b> → ketuk menu → <b>Tambah foto</b>, atau tombol <b>📷 Lengkapi foto</b> untuk foto beruntun. <b>Kelola → Meja & QR</b> untuk membuat meja dan mencetak kartu QR.</p></details>
<details><summary><b>Salah input / perlu koreksi?</b></summary><p>Pemilik bisa membatalkan transaksi di tab <b>Pesanan</b> (ketuk nota → Batalkan). Stok dikembalikan otomatis.</p></details></div>`;

/* ============================== BERANDA (pemilik) ============================== */
async function viewHome() {
  const [s] = await Promise.all([api('/api/reports/summary'), loadProducts(true)]);
  const max = Math.max(1, ...s.series.map(x => x.total));
  const alerts = [];
  if (!state.shift) alerts.push(['warn', 'Kasir belum dibuka', 'Buka kasir dan isi uang awal laci sebelum mulai jualan.', ['kas', 'Buka kasir']]);
  s.open_shifts.forEach(sh => alerts.push(['ok', `Kasir terbuka: ${esc(sh.cashier)}`, `Sejak ${fmtTime(sh.opened_at)} · ${sh.sales_count} transaksi · ${rp(sh.sales_total)}`, null]));
  if (s.no_price) alerts.push(['bad', `${s.no_price} menu belum ada harga`, 'Menu tanpa harga tidak bisa dijual.', ['kelola', 'Isi harga', 'menu']]);
  if (s.low_stock.length) alerts.push(['warn', `${s.low_stock.length} menu stoknya menipis`, s.low_stock.slice(0, 4).map(x => `${esc(x.name)} (${x.stock_on_hand})`).join(', '), ['kelola', 'Lihat stok', 'stok']]);
  if (s.no_cost) alerts.push(['gold', `${s.no_cost} menu belum diisi HPP (modal)`, 'Tanpa HPP, laba tidak bisa dihitung. Isi bertahap, mulai dari menu terlaris.', ['kelola', 'Isi HPP', 'menu']]);
  if (s.sold_out) alerts.push(['gray', `${s.sold_out} menu ditandai habis`, 'Tidak bisa dipesan sampai ditandai tersedia lagi.', null]);
  const su = s.setup, steps = [
    [su.users > 1, 'Tambah akun kasir', 'Tiap orang punya PIN sendiri.', ['kelola', 'Tambah kasir', 'tim']],
    [su.named, 'Isi nama toko, alamat & kontak', 'Muncul di struk dan halaman pesan.', ['kelola', 'Atur toko', 'atur']],
    [s.no_price === 0 && s.menus > 0, 'Pastikan semua menu punya harga', 'Menu tanpa harga tidak bisa dijual.', ['kelola', 'Cek harga', 'menu']],
    [su.tables > 0, 'Buat meja & cetak QR', 'Pelanggan scan lalu pesan dari HP.', ['kelola', 'Buat meja', 'meja']],
    [su.no_photo < s.menus * 0.5, 'Lengkapi foto menu (minimal separuh)', `${su.no_photo} menu belum berfoto.`, ['kelola', 'Lengkapi foto', 'menu']],
    [su.qris, 'Unggah gambar QRIS toko (opsional)', 'Pelanggan bisa bayar QRIS dari meja.', ['kelola', 'Unggah QRIS', 'atur']],
    [su.backups > 0, 'Pastikan cadangan otomatis berjalan', 'Cek di Pengaturan setelah jam 03:00.', ['kelola', 'Lihat cadangan', 'atur']],
  ], done = steps.filter(x => x[0]).length;
  const guide = done < steps.length ? `<div class="card" style="margin-top:14px"><div class="row between wrap"><h3 style="margin:0">Panduan mulai <span class="pill gold">${done}/${steps.length}</span></h3><button class="btn ghost sm" data-act="help">Buka bantuan</button></div><div class="list" style="margin-top:6px">${steps.map(([d, t, sub, a]) => `<div class="item"><span class="pill ${d ? 'ok' : ''}" style="min-width:30px;text-align:center">${d ? '✓' : '•'}</span><div class="grow"><div class="t" ${d ? 'style="text-decoration:line-through;opacity:.6"' : ''}>${esc(t)}</div><div class="s">${esc(sub)}</div></div>${d ? '' : `<button class="btn ghost sm" data-act="go" data-view="${a[0]}" data-sub="${a[2]}">${a[1]}</button>`}</div>`).join('')}</div></div>` : '';
  $('#main').innerHTML = head(`Halo, ${esc(state.me.name)}`, fmtDate(s.today), `<button class="btn gold" data-act="go" data-view="kasir">${icon('cart')} Buka Kasir</button>`)
    + `<div class="grid stats">
      <div class="card stat"><div class="label">Penjualan hari ini</div><div class="val">${rp(s.today_total)}</div><div class="sub">${s.today_transactions} transaksi${s.today_transactions ? ' · rata-rata ' + rp(Math.round(s.today_total / s.today_transactions)) : ''}</div></div>
      <div class="card stat"><div class="label">Menu aktif</div><div class="val">${s.menus}</div><div class="sub">${s.tracked} dengan stok terlacak</div></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h3>7 hari terakhir</h3><div class="cols">${s.series.map((x, i) => `<div class="col ${i === 6 ? 'today' : ''}" title="${esc(fmtDate(x.date))}: ${rp(x.total)}"><div class="b" style="height:${Math.round(x.total / max * 100)}%"></div><span>${new Date(x.date + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'short', timeZone: 'UTC' })}</span></div>`).join('')}</div></div>
      <div class="card"><h3>Terlaris hari ini</h3>${s.top_today.length ? `<div class="list">${s.top_today.map(t => `<div class="item"><div class="t grow">${esc(t.name)}</div><span class="pill">${t.qty}×</span><b>${rp(t.revenue)}</b></div>`).join('')}</div>` : '<div class="empty">Belum ada penjualan hari ini.</div>'}</div>
    </div>
    ${guide}<div class="card" style="margin-top:14px"><h3>Perlu perhatian</h3>${alerts.length ? `<div class="list">${alerts.map(([k, t, d, a]) => `<div class="item"><span class="pill ${k}">${k === 'ok' ? 'Info' : k === 'bad' ? 'Penting' : k === 'warn' ? 'Cek' : 'Saran'}</span><div class="grow"><div class="t">${t}</div><div class="s">${d}</div></div>${a ? `<button class="btn ghost sm" data-act="go" data-view="${a[0]}" ${a[2] ? `data-sub="${a[2]}"` : ''}>${a[1]}</button>` : ''}</div>`).join('')}</div>` : '<div class="empty">Semua beres 👍</div>'}</div>`;
}

/* ============================== KASIR ============================== */
function openShiftCard() {
  return `<div class="card" style="max-width:520px;margin:10px auto"><h2>Buka kasir</h2>
    <p class="muted">Sebelum mulai jualan, hitung uang tunai di laci lalu isi di bawah. Ini jadi dasar untuk mencocokkan uang saat tutup kasir.</p><div id="shiftErr"></div>
    <div class="form-row"><label class="lbl" for="openCash">Uang awal di laci (Rp)</label><input class="field big" id="openCash" inputmode="numeric" data-money placeholder="0" autocomplete="off">
    <div class="quick">${[0, 100000, 200000, 300000, 500000].map(n => `<button type="button" data-act="setCash" data-v="${n}">${n ? rp(n) : 'Tanpa uang awal'}</button>`).join('')}</div></div>
    <button class="btn big block" data-act="openShift">Buka kasir</button></div>`;
}
async function viewKasir() {
  await Promise.all([loadProducts(), loadMods(), loadShift()]);
  if (!state.cart.length) restoreCart();
  if (!state.shift) { $('#main').innerHTML = openShiftCard(); return; }
  const cats = ['Semua', ...new Set(activeProducts().map(p => p.category))];
  $('#main').innerHTML = `<div class="pos"><section>
    <div class="pos-tools"><input id="q" class="field" type="search" placeholder="🔍  Cari menu…" value="${esc(state.q)}" autocomplete="off"><button class="btn ghost sm" data-act="soldMode">${state.soldMode ? '✓ Selesai tandai habis' : 'Tandai menu habis'}</button><button class="btn ghost sm" data-act="toggleCompact">${state.compact ? 'Tampilkan foto' : 'Tampilan daftar'}</button></div>
    ${state.soldMode ? '<div class="notice" style="margin-bottom:12px"><b>Mode tandai habis:</b> ketuk menu untuk menandainya habis / tersedia lagi. Pesanan tidak bertambah selama mode ini aktif.</div>' : ''}
    <div class="chips" id="cats">${cats.map(c => `<button data-act="cat" data-c="${esc(c)}" class="${state.cat === c ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
    <div class="menu-grid ${state.compact ? 'compact' : ''}" id="grid"></div></section>
    <aside class="cart side" id="cartSide"></aside></div><div class="mobile-bar" id="mobileBar"></div>`;
  $('#q').oninput = e => { state.q = e.target.value; drawGrid(); };
  drawGrid(); drawCart();
}
function drawGrid() {
  const g = $('#grid'); if (!g) return;
  const q = state.q.trim().toLowerCase();
  const list = activeProducts().filter(p => (state.cat === 'Semua' || p.category === state.cat) && (!q || `${p.name} ${p.category} ${p.variant}`.toLowerCase().includes(q)));
  g.innerHTML = list.length ? list.map(p => {
    const out = soldOut(p), low = !out && p.stock_tracked && p.stock_on_hand != null && p.reorder_level != null && p.stock_on_hand <= p.reorder_level;
    const nov = groupsFor(p).length;
    return `<div class="tile ${out ? 'off' : ''}" role="button" tabindex="0" data-act="tile" data-id="${esc(p.id)}">
      ${thumb(p.image_key)}
      ${out ? '<span class="pill bad tag">Habis</span>' : low ? `<span class="pill warn tag">Sisa ${p.stock_on_hand}</span>` : ''}
      <div class="in"><span class="nm">${esc(p.name)}</span><span class="sub">${esc(p.variant || p.category)}${nov ? ' · ada pilihan' : ''}</span>
      <span class="pr">${p.price == null ? 'Harga belum diisi' : rp(p.price)}</span>
</div></div>`;
  }).join('') : '<div class="empty" style="grid-column:1/-1">Menu tidak ditemukan. Coba kata lain atau pilih kategori “Semua”.</div>';
}
function cartInner(inSheet) {
  const sub = cartSubtotal(), t = calcTotals(sub, 0);
  const lines = state.cart.length ? state.cart.map(l => { const p = prod(l.pid);
    return `<div class="cl"><div class="info"><div class="nm">${esc(p?.name || '?')}</div>${l.opts.length ? `<div class="op">${esc(optLabel(l.opts))}</div>` : ''}<div class="small muted">${rp(lineUnit(l))} × ${l.qty} = <b>${rp(lineUnit(l) * l.qty)}</b></div></div>
    <div class="step"><button data-act="qty" data-key="${esc(l.key)}" data-d="-1" aria-label="Kurangi">−</button><b>${l.qty}</b><button data-act="qty" data-key="${esc(l.key)}" data-d="1" aria-label="Tambah">+</button></div></div>`; }).join('')
    : '<div class="empty">Belum ada pesanan.<br>Ketuk menu untuk menambahkan.</div>';
  return `<h3 style="display:flex;justify-content:space-between;align-items:center">${inSheet ? '' : 'Pesanan '}<span class="small muted">${cartCount()} item</span>${state.cart.length ? '<button class="btn ghost sm" data-act="clearCart">Kosongkan</button>' : ''}</h3>
    <div class="cart-lines">${lines}</div><div class="sumrows">${sumRows(t)}</div>
    <button class="btn gold big block" style="margin-top:12px" data-act="checkout" ${state.cart.length ? '' : 'disabled'}>Bayar · ${rp(t.total)}</button>`;
}
function drawCart() {
  const side = $('#cartSide'); if (side) side.innerHTML = cartInner();
  const mb = $('#mobileBar');
  if (mb) mb.innerHTML = `<div class="grow"><div class="small muted">${cartCount()} item</div><b style="font-size:20px">${rp(calcTotals(cartSubtotal(), 0).total)}</b></div><button class="btn gold big" data-act="openCart" ${state.cart.length ? '' : 'disabled'}>Lihat pesanan</button>`;
  if (state.cartSheet) { if (!state.cart.length) state.cartSheet.close(); else state.cartSheet.setBody(cartInner(true)); }
}
function variantSheet(p, groups) {
  const picked = new Map(); let qty = 1;
  groups.forEach(g => { if (g.min_select > 0 && g.options.length) picked.set(g.id, new Set([g.options[0].id])); });
  const chosen = () => groups.flatMap(g => [...(picked.get(g.id) || [])].map(id => { const o = g.options.find(z => z.id === id); return { id: o.id, name: o.name, delta: o.price_delta, group: g.name }; }));
  const draw = sh => {
    const extra = chosen().reduce((s, o) => s + o.delta, 0);
    sh.setBody(`<p class="muted" style="margin-top:0">Harga dasar ${rp(p.price)}. Pilihan standar sudah terpilih — ubah bila perlu.</p>` + groups.map(g => `<div class="opt-group"><div class="h"><span>${esc(g.name)}</span><span class="small muted">${g.min_select > 0 ? 'Wajib pilih' : 'Boleh dikosongkan'}${g.max_select > 1 ? ` · maks ${g.max_select}` : ''}</span></div>
      ${g.options.map(o => { const on = (picked.get(g.id) || new Set()).has(o.id); return `<button type="button" class="opt ${g.max_select > 1 ? 'multi' : ''} ${on ? 'on' : ''}" data-g="${esc(g.id)}" data-o="${esc(o.id)}"><span class="box"></span><span>${esc(o.name)}</span><span class="pl">${o.price_delta ? signed(o.price_delta) : ''}</span></button>`; }).join('')}</div>`).join(''));
    sh.setFooter(`<div class="step"><button data-q="-1" aria-label="Kurangi">−</button><b>${qty}</b><button data-q="1" aria-label="Tambah">+</button></div><button class="btn gold" data-add>Tambah · ${rp((p.price + extra) * qty)}</button>`);
    sh.qa('.opt').forEach(b => b.onclick = () => {
      const g = groups.find(x => x.id === b.dataset.g), id = b.dataset.o, set = picked.get(g.id) || new Set();
      if (g.max_select > 1) { if (set.has(id)) set.delete(id); else if (set.size < g.max_select) set.add(id); else toast(`${g.name}: maksimal ${g.max_select} pilihan`, 'bad'); }
      else if (set.has(id) && g.min_select === 0) set.clear(); else { set.clear(); set.add(id); }
      picked.set(g.id, set); draw(sh);
    });
    sh.qa('[data-q]').forEach(b => b.onclick = () => { qty = Math.min(99, Math.max(1, qty + parseInt(b.dataset.q, 10))); draw(sh); });
    sh.q('[data-add]').onclick = () => {
      const miss = groups.find(g => (picked.get(g.id)?.size || 0) < g.min_select);
      if (miss) return toast(`Pilih ${miss.name} dulu`, 'bad');
      if (addToCart(p, chosen(), qty)) { sh.close(); toast(`${p.name} ditambahkan`, 'ok'); }
    };
  };
  openSheet({ title: p.name, body: '', footer: ' ', onMount: draw });
}

/* ---- pembayaran ---- */
function checkoutSheet(src) {
  const orderMode = !!(src && src.orders);
  if (!orderMode && !state.cart.length) return;
  state.cartSheet?.close();
  const st = state.settings; let sub = orderMode ? src.sub : cartSubtotal(); let selOrders = orderMode ? [...src.orders] : [];
  const canDisc = isOwner() || parseFloat(st.kasir_max_discount_percent) > 0;
  const co = { type: 'dine_in', table: '', note: '', discOn: false, dtype: 'percent', dval: '', dreason: '', method: '', paid: null, reqId: (crypto.randomUUID ? crypto.randomUUID() : 'ks-' + Date.now() + '-' + Math.random().toString(16).slice(2)), busy: false };
  const sh = openSheet({
    title: 'Pembayaran', wide: true,
    body: `<div id="coErr"></div>
    ${orderMode ? `<div class="form-row"><label class="lbl">${esc(src.label)} — pesanan yang dibayar sekarang</label><div id="coOrders">${src.orders.map(o => `<button type="button" class="opt multi on" data-oid="${esc(o.id)}"><span class="box"></span><span><b>${esc(o.id)}</b> · ${esc(o.items.map(i => `${i.quantity}× ${i.name_snapshot}`).join(', '))}</span><span class="pl">${rp(o.subtotal)}</span></button>`).join('')}</div><div class="hint">Hilangkan centang untuk membayar sebagian saja (split bill per pesanan).</div></div>` : ''}
    <div class="${orderMode ? 'hidden' : ''}"><div class="form-row"><label class="lbl">Jenis pesanan</label><div class="seg" id="coType">${Object.entries(state.orderTypes).map(([k, v]) => `<button type="button" data-v="${k}" class="${k === co.type ? 'on' : ''}">${esc(v)}</button>`).join('')}</div></div>
    <div class="two"><div class="form-row"><label class="lbl" for="coTable">Nomor meja / nama (opsional)</label><input class="field" id="coTable" maxlength="20" autocomplete="off" placeholder="mis. Meja 5 / Bu Sari"></div>
    <div class="form-row"><label class="lbl" for="coNote">Catatan (opsional)</label><input class="field" id="coNote" maxlength="240" autocomplete="off" placeholder="mis. jangan terlalu pedas"></div></div></div>
    ${canDisc ? `<div class="form-row"><button type="button" class="btn ghost sm" id="coDiscBtn">+ Tambah diskon</button><div id="coDisc" class="hidden" style="margin-top:10px"><div class="seg" id="coDType"><button type="button" data-v="percent" class="on">Persen (%)</button><button type="button" data-v="nominal">Rupiah (Rp)</button></div>
      <div class="two" style="margin-top:10px"><input class="field" id="coDVal" inputmode="decimal" placeholder="Nilai diskon" autocomplete="off"><input class="field" id="coDWhy" maxlength="120" placeholder="Alasan (wajib)" autocomplete="off"></div>${isOwner() ? '' : `<div class="hint">Batas diskon kasir: ${esc(st.kasir_max_discount_percent)}% dari subtotal.</div>`}</div></div>` : ''}
    <div class="card flat sumrows" id="coSum" style="margin-bottom:14px"></div>
    <div class="form-row"><label class="lbl">Cara bayar</label><div class="pay-grid" id="coPay">${Object.entries(state.methods).map(([k, v]) => `<button type="button" class="opt" data-m="${k}" style="margin:0;justify-content:center"><span>${esc(v)}</span></button>`).join('')}</div></div>
    <div id="coCash" class="hidden"><label class="lbl" for="coPaid">Uang diterima (Rp)</label><input class="field" id="coPaid" inputmode="numeric" data-money placeholder="0" autocomplete="off"><div class="quick" id="coQuick"></div><div id="coChange"></div></div>`,
    footer: `<button class="btn ghost" data-cancel>Kembali</button><button class="btn gold" id="coPayBtn" disabled>Bayar</button>`,
  });
  const err = m => { $('#coErr', sh.el).innerHTML = m ? `<div class="notice bad" style="margin-bottom:12px">${esc(m)}</div>` : ''; };
  const discAmount = () => {
    if (!co.discOn || co.dval === '') return { amt: 0 };
    let amt;
    if (co.dtype === 'percent') { const bp = toBp(co.dval); if (!(bp > 0 && bp <= 10000)) return { error: 'Diskon persen harus antara 0 dan 100.' }; amt = pctOf(sub, bp); }
    else { amt = parseInt(digits(co.dval) || '0', 10); }
    if (amt > sub) return { error: 'Diskon tidak boleh melebihi subtotal.' };
    if (amt > 0 && !co.dreason.trim()) return { error: 'Isi alasan diskon.' };
    if (amt > 0 && !isOwner() && amt * 100 > sub * parseFloat(st.kasir_max_discount_percent)) return { error: `Diskon kasir maksimal ${st.kasir_max_discount_percent}% dari subtotal.` };
    return { amt };
  };
  const update = () => {
    const d = discAmount(), t = calcTotals(sub, d.amt || 0);
    $('#coSum', sh.el).innerHTML = sumRows(t) + (d.error ? `<div class="hint" style="color:var(--bad)">${esc(d.error)}</div>` : '');
    const cash = co.method === 'tunai';
    $('#coCash', sh.el).classList.toggle('hidden', !cash);
    let ok = !!co.method && !d.error && (!orderMode || selOrders.length > 0);
    if (cash) {
      const paid = co.paid || 0, quick = [t.total, ...[5000, 10000, 20000, 50000, 100000].map(u => Math.ceil(t.total / u) * u)].filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
      $('#coQuick', sh.el).innerHTML = quick.map((v, i) => `<button type="button" data-q="${v}">${i === 0 ? 'Uang pas' : rp(v)}</button>`).join('');
      $$('#coQuick button', sh.el).forEach(b => b.onclick = () => { co.paid = parseInt(b.dataset.q, 10); $('#coPaid', sh.el).value = nf.format(co.paid); update(); });
      $('#coChange', sh.el).innerHTML = co.paid == null ? '' : paid >= t.total ? `<div class="change"><span>Kembalian</span><span>${rp(paid - t.total)}</span></div>` : `<div class="change bad"><span>Kurang</span><span>${rp(t.total - paid)}</span></div>`;
      ok = ok && paid >= t.total;
    }
    const btn = $('#coPayBtn', sh.el); btn.disabled = !ok || co.busy; btn.textContent = `Bayar · ${rp(t.total)}`;
    return t;
  };
  wireFields(sh.el);
  $('#coOrders', sh.el)?.addEventListener('click', e => {
    const b = e.target.closest('[data-oid]'); if (!b) return;
    b.classList.toggle('on'); selOrders = src.orders.filter(o => $(`[data-oid="${CSS.escape(o.id)}"]`, sh.el).classList.contains('on'));
    sub = selOrders.reduce((a, o) => a + o.subtotal, 0); update();
  });
  $('#coType', sh.el).addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (!b) return; co.type = b.dataset.v; $$('#coType button', sh.el).forEach(x => x.classList.toggle('on', x === b)); });
  $('#coTable', sh.el).oninput = e => co.table = e.target.value; $('#coNote', sh.el).oninput = e => co.note = e.target.value;
  $('#coDiscBtn', sh.el)?.addEventListener('click', () => { co.discOn = !co.discOn; $('#coDisc', sh.el).classList.toggle('hidden', !co.discOn); $('#coDiscBtn', sh.el).textContent = co.discOn ? '− Hapus diskon' : '+ Tambah diskon'; update(); });
  $('#coDType', sh.el)?.addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (!b) return; co.dtype = b.dataset.v; $$('#coDType button', sh.el).forEach(x => x.classList.toggle('on', x === b)); $('#coDVal', sh.el).value = ''; co.dval = ''; update(); });
  $('#coDVal', sh.el)?.addEventListener('input', e => { co.dval = e.target.value; update(); });
  $('#coDWhy', sh.el)?.addEventListener('input', e => { co.dreason = e.target.value; update(); });
  $('#coPay', sh.el).addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; co.method = b.dataset.m; $$('#coPay .opt', sh.el).forEach(x => x.classList.toggle('on', x === b)); if (co.method === 'tunai') setTimeout(() => $('#coPaid', sh.el).focus(), 30); update(); });
  $('#coPaid', sh.el).addEventListener('input', e => { co.paid = digits(e.target.value) === '' ? null : parseInt(digits(e.target.value), 10); update(); });
  $('[data-cancel]', sh.el).onclick = () => sh.close();
  $('#coPayBtn', sh.el).onclick = async () => {
    if (co.busy) return; co.busy = true; err(''); update();
    const d = discAmount();
    const body = orderMode
      ? { order_ids: selOrders.map(o => o.id), payment_method: co.method, note: co.note, request_id: co.reqId }
      : { items: state.cart.map(l => ({ product_id: l.pid, quantity: l.qty, modifiers: l.opts.map(o => ({ id: o.id })) })), payment_method: co.method, order_type: co.type, table_no: co.table, note: co.note, request_id: co.reqId };
    if (co.method === 'tunai') body.amount_paid = co.paid;
    if (d.amt) body.discount = { type: co.dtype, value: co.dtype === 'percent' ? parseFloat(co.dval.replace(',', '.')) : d.amt, reason: co.dreason.trim() };
    try {
      const r = await api('/api/sales', { method: 'POST', body });
      if (!orderMode) { state.cart = []; saveCart(); }
      sh.close();
      if (r.duplicate) toast('Pesanan ini sudah tersimpan sebelumnya — tidak dicatat dua kali.', 'ok');
      loadProducts(true).then(() => { if (state.view === 'kasir') { drawGrid(); drawCart(); } });
      if (state.view === 'kasir') drawCart();
      receiptSheet(r.item, true);
      if (orderMode) { pollOrders(); if (state.view === 'meja') viewMeja(); }
    } catch (e) {
      if (e.network && !orderMode) {          // internet putus: simpan di perangkat, kirim otomatis nanti
        const t = calcTotals(sub, d.amt || 0), paid = body.amount_paid ?? t.total;
        const prov = { id: 'OFFLINE-' + body.request_id.slice(-4).toUpperCase(), created_at: new Date().toISOString(), cashier: state.me.name, order_type: body.order_type, table_no: body.table_no, status: 'paid', offline: true,
          items: state.cart.map(l => { const unit = lineUnit(l); return { name_snapshot: prod(l.pid)?.name || '?', quantity: l.qty, unit_price: unit, line_total: unit * l.qty, modifiers_summary: optLabel(l.opts) }; }),
          subtotal: t.subtotal, discount_amount: t.disc, service_amount: t.svc, tax_amount: t.tax, rounding_amount: t.round, total_amount: t.total, payment_method: body.payment_method, amount_paid: paid, change_amount: paid - t.total };
        setQueue([...getQueue().filter(x => x.body.request_id !== body.request_id), { body, prov, at: Date.now() }]);
        state.cart = []; saveCart(); sh.close(); drawOfflineBar(); if (state.view === 'kasir') drawCart();
        receiptSheet(prov, true);
        return;
      }
      co.busy = false; err(e.message); update();
    }
  };
  update();
}

/* ---- struk & tiket ---- */
function receiptHTML(s) {
  const st = state.settings, line = (l, v, cls = '') => `<div class="l ${cls}"><span>${l}</span><span>${v}</span></div>`;
  return `<div class="receipt"><h4>${esc(st.outlet_name)}</h4><div class="c">${esc(st.outlet_address)}</div><hr>
    <div>No: ${esc(s.id)}</div><div>${esc(fmtDateTime(s.created_at))}</div><div>Kasir: ${esc(s.cashier || '-')}</div>
    <div>${esc(state.orderTypes[s.order_type] || '')}${s.table_no ? ' · ' + esc(s.table_no) : ''}</div><hr>
    ${s.items.map(i => `<div>${esc(i.name_snapshot)}</div>${i.modifiers_summary ? `<div style="padding-left:8px">${esc(i.modifiers_summary)}</div>` : ''}${line(`${i.quantity} × ${nf.format(i.unit_price)}`, nf.format(i.line_total))}`).join('')}<hr>
    ${line('Subtotal', nf.format(s.subtotal))}${s.discount_amount ? line('Diskon', '-' + nf.format(s.discount_amount)) : ''}${s.service_amount ? line('Layanan', nf.format(s.service_amount)) : ''}${s.tax_amount ? line('Pajak', nf.format(s.tax_amount)) : ''}${s.rounding_amount ? line('Pembulatan', nf.format(s.rounding_amount)) : ''}
    ${line('TOTAL', 'Rp' + nf.format(s.total_amount), 'b')}${line(esc(METHOD_NAME(s.payment_method)), nf.format(s.amount_paid))}${s.payment_method === 'tunai' ? line('Kembali', nf.format(s.change_amount)) : ''}
    ${s.status === 'void' ? '<hr><div class="c b">** DIBATALKAN **</div>' : ''}<hr><div class="c">${esc(st.receipt_footer)}</div>${st.outlet_contact ? `<div class="c">${esc(st.outlet_contact)}</div>` : ''}</div>`;
}
function ticketHTML(s) {
  return `<div class="receipt"><h4 style="font-size:22px">${esc(s.id.split('-').pop())}</h4><div class="c b">${esc(state.orderTypes[s.order_type] || '')}${s.table_no ? ' · ' + esc(s.table_no) : ''}</div><div class="c">${esc(fmtTime(s.created_at))}</div><hr>
    ${s.items.map(i => `<div class="b" style="font-size:16px">${i.quantity}× ${esc(i.name_snapshot)}</div>${i.modifiers_summary ? `<div style="padding-left:10px;font-size:13px">${esc(i.modifiers_summary.replace(/ \(\+\d+rb\)/g, ''))}</div>` : ''}`).join('<div style="height:6px"></div>')}
    ${s.note ? `<hr><div class="b">Catatan: ${esc(s.note)}</div>` : ''}</div>`;
}
function printHTML(html) {
  const pa = $('#printArea'); pa.className = 'print-area' + (state.settings.receipt_width === '80' ? ' w80' : ''); pa.innerHTML = html;
  setTimeout(() => window.print(), 50);
}
function receiptSheet(sale, fresh) {
  openSheet({
    title: sale.offline ? 'Tersimpan di perangkat' : fresh ? 'Pembayaran berhasil ✓' : `Nota ${sale.id}`,
    body: `${sale.offline ? '<div class="notice bad" style="margin-bottom:12px"><b>Belum terkirim ke server.</b> Penjualan ini tersimpan di perangkat dan dikirim otomatis saat internet kembali. Nomor nota resmi muncul setelah terkirim. Jangan hapus data peramban sebelum terkirim.</div>' : ''}${fresh ? `<div class="notice ok" style="margin-bottom:12px"><b style="font-size:20px">${rp(sale.total_amount)}</b> · ${esc(METHOD_NAME(sale.payment_method))}${sale.payment_method === 'tunai' ? `<div style="font-size:22px;font-weight:800;margin-top:4px">Kembalian ${rp(sale.change_amount)}</div>` : ''}</div>` : ''}
    <div class="receipt-preview ${state.settings.receipt_width === '80' ? 'w80' : ''}">${receiptHTML(sale)}</div>
    <p class="hint center">Cetak lewat printer yang terhubung ke perangkat ini (kertas ${esc(state.settings.receipt_width)} mm).</p>`,
    footer: `<button class="btn ghost" data-ticket>Tiket dapur</button><button class="btn ghost" data-print>Cetak struk</button>${fresh ? '<button class="btn gold" data-done>Pesanan baru</button>' : '<button class="btn" data-done>Tutup</button>'}`,
    onMount: s => { s.q('[data-print]').onclick = () => printHTML(receiptHTML(sale)); s.q('[data-ticket]').onclick = () => printHTML(ticketHTML(sale)); s.q('[data-done]').onclick = () => s.close(); },
  });
}

/* ============================== PESANAN ============================== */
async function viewPesanan() {
  const date = state.pesananDate || todayWIB();
  const d = await api('/api/sales?date=' + encodeURIComponent(isOwner() ? date : todayWIB()));
  const ok = d.items.filter(s => s.status !== 'void');
  const queued = getQueue();
  $('#main').innerHTML = (queued.length ? `<div class="card" style="margin-bottom:14px;border-color:#e2b3a8"><h3>Belum terkirim (${queued.length})</h3><div class="list">${queued.map(q => `<div class="item"><div><div class="t">${esc(q.prov.id)} · ${fmtTime(q.prov.created_at)}</div><div class="s">${esc(q.prov.items.map(i => `${i.quantity}× ${i.name_snapshot}`).join(', '))}</div>${q.error ? `<div class="s" style="color:var(--bad)">Ditolak: ${esc(q.error)}</div>` : '<div class="s">Menunggu internet…</div>'}</div><div class="end"><div class="t">${rp(q.prov.total_amount)}</div></div></div>`).join('')}</div></div>` : '') + head(isOwner() ? 'Pesanan' : 'Pesanan saya hari ini', isOwner() ? fmtDate(date) : 'Hanya pesanan yang Anda catat hari ini.',
    isOwner() ? `<div class="row wrap"><button class="btn ghost sm" data-act="dayShift" data-d="-1">‹ Sebelumnya</button><input type="date" class="field" id="dayPick" value="${date}" max="${todayWIB()}" style="width:auto;flex:1 1 140px;min-width:0"><button class="btn ghost sm" data-act="dayShift" data-d="1">Berikutnya ›</button></div>` : '')
    + `<div class="grid stats" style="margin-bottom:14px"><div class="card stat"><div class="label">Transaksi</div><div class="val">${ok.length}</div></div><div class="card stat"><div class="label">Total</div><div class="val">${rp(ok.reduce((s, x) => s + x.total_amount, 0))}</div></div></div>`
    + `<div class="card"><div class="list">${d.items.length ? d.items.map(s => `<button class="item" data-act="sale" data-id="${esc(s.id)}"><div><div class="t">${fmtTime(s.created_at)} · ${esc(s.id)}</div><div class="s">${esc(s.items.map(i => `${i.quantity}× ${i.name_snapshot}`).join(', '))}</div><div class="s">${esc(METHOD_NAME(s.payment_method))}${s.cashier ? ' · ' + esc(s.cashier) : ''}${s.table_no ? ' · ' + esc(s.table_no) : ''}</div></div><div class="end"><div class="t">${rp(s.total_amount)}</div>${s.status === 'void' ? '<span class="pill bad">Batal</span>' : ''}</div></button>`).join('') : '<div class="empty">Belum ada pesanan pada tanggal ini.</div>'}</div></div>`;
  $('#dayPick')?.addEventListener('change', e => { if (e.target.value) { state.pesananDate = e.target.value; go('pesanan'); } });
}
async function saleSheet(id) {
  const { item: s } = await api('/api/sales/' + encodeURIComponent(id));
  const sh = openSheet({
    title: `Nota ${s.id}`, wide: true,
    body: `${s.status === 'void' ? `<div class="notice bad" style="margin-bottom:12px"><b>Dibatalkan</b> oleh ${esc(s.voided_by)} — ${esc(s.void_reason)}</div>` : ''}<div class="receipt-preview ${state.settings.receipt_width === '80' ? 'w80' : ''}">${receiptHTML(s)}</div>`,
    footer: `<button class="btn ghost" data-ticket>Tiket dapur</button><button class="btn ghost" data-print>Cetak struk</button>${isOwner() && s.status !== 'void' ? '<button class="btn danger" data-void>Batalkan</button>' : ''}`,
    onMount: x => {
      x.q('[data-print]').onclick = () => printHTML(receiptHTML(s)); x.q('[data-ticket]').onclick = () => printHTML(ticketHTML(s));
      x.q('[data-void]')?.addEventListener('click', () => { x.close(); formSheet({ title: `Batalkan ${s.id}?`, intro: `Transaksi senilai <b>${rp(s.total_amount)}</b> akan dibatalkan, dikeluarkan dari laporan, dan stok dikembalikan (jika terlacak). Ini tidak bisa diurungkan.`, fields: [{ name: 'reason', label: 'Alasan pembatalan', maxlength: 160 }], submit: 'Ya, batalkan transaksi', danger: true, onSubmit: async (v, f) => { await api(`/api/sales/${encodeURIComponent(s.id)}/void`, { method: 'POST', body: { reason: v.reason } }); f.close(); toast('Transaksi dibatalkan', 'ok'); loadProducts(true); go('pesanan'); } }); });
    },
  });
}

/* ============================== KAS (shift) ============================== */
function shiftReportHTML(sh) {
  const m = sh.by_method || [];
  return `<table><tbody>
    <tr><td>Dibuka</td><td class="num">${esc(fmtDateTime(sh.opened_at))}</td></tr>
    <tr><td>Kasir</td><td class="num">${esc(sh.cashier)}</td></tr>
    <tr><td>Uang awal laci</td><td class="num">${rp(sh.opening_cash)}</td></tr>
    <tr><td>Penjualan tunai</td><td class="num">${rp(sh.cash_sales)}</td></tr>
    <tr><td><b>Seharusnya ada di laci</b></td><td class="num"><b>${rp(sh.expected_cash)}</b></td></tr></tbody></table>
    <h3 style="margin:16px 0 6px">Penjualan per cara bayar</h3>
    ${m.length ? `<table><tbody>${m.map(x => `<tr><td>${esc(METHOD_NAME(x.payment_method))} <span class="muted small">(${x.n}×)</span></td><td class="num">${rp(x.total)}</td></tr>`).join('')}<tr><td><b>Total penjualan</b></td><td class="num"><b>${rp(sh.sales_total)}</b></td></tr></tbody></table>` : '<div class="muted">Belum ada penjualan.</div>'}
    ${sh.void_count ? `<p class="small muted">Dibatalkan: ${sh.void_count} transaksi (${rp(sh.void_total)}), tidak dihitung.</p>` : ''}`;
}
async function viewKas() {
  const sh = await loadShift();
  let hist = '';
  if (isOwner()) {
    const h = await api('/api/shifts');
    hist = `<div class="card" style="margin-top:14px"><h3>Riwayat kas</h3><div class="tablewrap"><table><thead><tr><th>Kasir</th><th>Buka</th><th>Tutup</th><th class="num">Seharusnya</th><th class="num">Dihitung</th><th class="num">Selisih</th></tr></thead><tbody>${h.items.map(x => `<tr><td>${esc(x.cashier)}</td><td>${esc(fmtDateTime(x.opened_at))}</td><td>${x.closed_at ? esc(fmtDateTime(x.closed_at)) : '<span class="pill ok">Terbuka</span>'}</td><td class="num">${rp(x.expected_cash)}</td><td class="num">${x.closed_at ? rp(x.counted_cash) : '—'}</td><td class="num">${x.closed_at ? `<span class="pill ${x.difference === 0 ? 'ok' : 'bad'}">${x.difference === 0 ? 'Pas' : rp(x.difference)}</span>` : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Belum ada.</td></tr>'}</tbody></table></div></div>`;
  }
  if (!sh) { $('#main').innerHTML = head('Kas', 'Buka kasir untuk mulai jualan.') + openShiftCard() + hist; return; }
  $('#main').innerHTML = head('Kas & tutup kasir', 'Ringkasan sementara untuk shift Anda yang sedang berjalan.')
    + `<div class="grid g2"><div class="card"><h3>Laporan sementara</h3>${shiftReportHTML(sh)}</div>
    <div class="card"><h3>Tutup kasir</h3><p class="muted">Hitung semua uang tunai di laci, lalu isi jumlahnya. Aplikasi menunjukkan apakah uang cocok.</p><div id="shiftErr"></div>
    <div class="form-row"><label class="lbl" for="countCash">Uang tunai di laci sekarang (Rp)</label><input class="field" id="countCash" inputmode="numeric" data-money placeholder="0" autocomplete="off"></div>
    <div id="diffBox"></div><div class="form-row" style="margin-top:12px"><label class="lbl" for="closeNote">Catatan (opsional)</label><input class="field" id="closeNote" maxlength="240" placeholder="mis. kurang seribu, kembalian"></div>
    <button class="btn big block" data-act="closeShift">Tutup kasir</button></div></div>${hist}`;
  $('#countCash').addEventListener('input', e => {
    const v = digits(e.target.value); if (v === '') { $('#diffBox').innerHTML = ''; return; }
    const diff = parseInt(v, 10) - sh.expected_cash;
    $('#diffBox').innerHTML = `<div class="change ${diff === 0 ? '' : 'bad'}"><span>${diff === 0 ? 'Uang pas ✓' : diff > 0 ? 'Lebih' : 'Kurang'}</span><span>${diff === 0 ? '' : rp(Math.abs(diff))}</span></div>`;
  });
}
function zReportSheet(sh) {
  const html = `<div class="receipt"><h4>LAPORAN TUTUP KASIR</h4><div class="c">${esc(state.settings.outlet_name)}</div><hr><div>Kasir: ${esc(sh.cashier)}</div><div>Buka : ${esc(fmtDateTime(sh.opened_at))}</div><div>Tutup: ${esc(fmtDateTime(sh.closed_at))}</div><hr>
    <div class="l"><span>Uang awal</span><span>${nf.format(sh.opening_cash)}</span></div><div class="l"><span>Penjualan tunai</span><span>${nf.format(sh.cash_sales)}</span></div><div class="l b"><span>Seharusnya</span><span>${nf.format(sh.expected_cash)}</span></div><div class="l"><span>Dihitung</span><span>${nf.format(sh.counted_cash)}</span></div><div class="l b"><span>Selisih</span><span>${sh.difference > 0 ? '+' : ''}${nf.format(sh.difference)}</span></div><hr>
    ${sh.by_method.map(x => `<div class="l"><span>${esc(METHOD_NAME(x.payment_method))} (${x.n})</span><span>${nf.format(x.total)}</span></div>`).join('')}<div class="l b"><span>Total jual</span><span>${nf.format(sh.sales_total)}</span></div>${sh.note ? `<hr><div>Catatan: ${esc(sh.note)}</div>` : ''}</div>`;
  openSheet({ title: 'Kasir ditutup', body: `<div class="notice ${sh.difference === 0 ? 'ok' : 'bad'}" style="margin-bottom:12px"><b>${sh.difference === 0 ? 'Uang laci cocok ✓' : (sh.difference > 0 ? 'Uang lebih ' : 'Uang kurang ') + rp(Math.abs(sh.difference))}</b></div><div class="receipt-preview ${state.settings.receipt_width === '80' ? 'w80' : ''}">${html}</div>`,
    footer: '<button class="btn ghost" data-print>Cetak</button><button class="btn" data-done>Selesai</button>', onMount: s => { s.q('[data-print]').onclick = () => printHTML(html); s.q('[data-done]').onclick = () => s.close(); } });
}

/* ============================== LAPORAN (pemilik) ============================== */
function repRange() {
  const t = todayWIB(), r = state.rep;
  if (r.preset === 'today') return [t, t];
  if (r.preset === 'yesterday') return [addDays(t, -1), addDays(t, -1)];
  if (r.preset === '7d') return [addDays(t, -6), t];
  if (r.preset === 'month') return [t.slice(0, 8) + '01', t];
  return [r.from || t, r.to || t];
}
const barRows = (items, label, val, cls = '') => { const max = Math.max(1, ...items.map(val)); return `<div class="bars">${items.map(i => `<div class="bar"><span>${label(i)}</span><div class="track"><div class="fill ${cls}" style="width:${Math.round(val(i) / max * 100)}%"></div></div><b>${rp(val(i))}</b></div>`).join('')}</div>`; };
async function viewLaporan() {
  const [from, to] = repRange(), r = await api(`/api/reports/range?from=${from}&to=${to}`);
  const presets = [['today', 'Hari ini'], ['yesterday', 'Kemarin'], ['7d', '7 hari'], ['month', 'Bulan ini'], ['custom', 'Pilih tanggal']];
  const cov = r.cost_coverage;
  $('#main').innerHTML = head('Laporan', from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`,
    `<a class="btn ghost sm" href="/api/reports/export.csv?from=${from}&to=${to}&type=sales" download>⬇ Unduh transaksi (CSV)</a><a class="btn ghost sm" href="/api/reports/export.csv?from=${from}&to=${to}&type=items" download>⬇ Unduh rincian menu (CSV)</a>`)
    + `<div class="chips" style="margin-bottom:14px">${presets.map(([k, l]) => `<button data-act="preset" data-p="${k}" class="${state.rep.preset === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${state.rep.preset === 'custom' ? `<div class="card flat row wrap" style="margin-bottom:14px"><input type="date" class="field" id="rFrom" value="${from}" style="width:auto"> <span>sampai</span> <input type="date" class="field" id="rTo" value="${to}" style="width:auto"><button class="btn sm" data-act="applyRange">Tampilkan</button></div>` : ''}
    <div class="grid stats">
      <div class="card stat"><div class="label">Penjualan bersih</div><div class="val">${rp(r.net_sales)}</div><div class="sub">setelah diskon, sebelum pajak & layanan</div></div>
      <div class="card stat"><div class="label">Transaksi</div><div class="val">${r.transactions}</div><div class="sub">rata-rata ${rp(r.average)} per nota</div></div>
      <div class="card stat"><div class="label">Uang masuk (total)</div><div class="val">${rp(r.total)}</div><div class="sub">termasuk pajak & layanan</div></div>
      <div class="card stat"><div class="label">Laba kotor (perkiraan)</div><div class="val">${!cov ? '—' : rp(r.gross_profit_known)}</div><div class="sub">${cov == null ? 'belum ada penjualan' : cov === 0 ? 'isi HPP menu agar laba terhitung' : `dari penjualan yang HPP-nya terisi (${cov}%), sebelum diskon`}</div></div>
    </div>
    ${cov != null && cov < 100 ? `<div class="notice" style="margin-top:14px">${cov === 0 ? 'Laba belum bisa dihitung: belum ada menu terjual yang diisi HPP (modal).' : `Laba belum akurat: hanya <b>${cov}%</b> penjualan yang menunya sudah diisi HPP (modal).`} Lengkapi di <b>Kelola → Menu & Harga</b>.</div>` : ''}
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h3>Rincian</h3><table><tbody><tr><td>Subtotal</td><td class="num">${rp(r.subtotal)}</td></tr><tr><td>Diskon</td><td class="num">${r.discount ? '−' + rp(r.discount) : rp(0)}</td></tr><tr><td>Biaya layanan</td><td class="num">${rp(r.service)}</td></tr><tr><td>Pajak</td><td class="num">${rp(r.tax)}</td></tr><tr><td>Pembulatan</td><td class="num">${rp(r.rounding)}</td></tr><tr><td><b>Total</b></td><td class="num"><b>${rp(r.total)}</b></td></tr><tr><td class="muted">Dibatalkan (tidak dihitung)</td><td class="num muted">${r.void_count}× · ${rp(r.void_total)}</td></tr></tbody></table></div>
      <div class="card"><h3>Per cara bayar</h3>${r.by_method.length ? barRows(r.by_method, m => `${esc(METHOD_NAME(m.method))} <span class="muted">(${m.n})</span>`, m => m.total) : '<div class="empty">Belum ada data.</div>'}
      ${r.by_type.length ? `<h3 style="margin:18px 0 8px">Jenis pesanan</h3>${barRows(r.by_type, t => esc(state.orderTypes[t.order_type] || t.order_type), t => t.total, 'gold')}` : ''}</div>
      <div class="card"><h3>Jam ramai</h3>${r.by_hour.length ? barRows(r.by_hour, h => `${h.hour}:00 <span class="muted">(${h.n})</span>`, h => h.total, 'gold') : '<div class="empty">Belum ada data.</div>'}</div>
      ${r.by_day.length > 1 ? `<div class="card"><h3>Per hari</h3>${barRows(r.by_day, d => new Date(d.date + 'T00:00:00Z').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }), d => d.total)}</div>` : ''}
    </div>
    <div class="card" style="margin-top:14px"><h3>Menu terlaris</h3><div class="tablewrap"><table><thead><tr><th>Menu</th><th class="num">Terjual</th><th class="num">Penjualan</th><th class="num">Margin</th></tr></thead><tbody>${r.top.map(t => { const m = t.revenue_with_cost ? Math.round((t.revenue_with_cost - t.cost) * 100 / t.revenue_with_cost) : null; return `<tr><td>${esc(t.name)}</td><td class="num">${t.qty}</td><td class="num">${rp(t.revenue)}</td><td class="num">${m == null ? '<span class="muted">HPP kosong</span>' : m + '%'}</td></tr>`; }).join('') || '<tr><td colspan="4" class="empty">Belum ada penjualan.</td></tr>'}</tbody></table></div></div>`;
}

/* ============================== KELOLA (pemilik) ============================== */
const SUBS = [['menu', 'Menu & Harga'], ['stok', 'Stok'], ['varian', 'Pilihan Tambahan'], ['meja', 'Meja & QR'], ['tim', 'Tim'], ['atur', 'Pengaturan']];
async function viewKelola() {
  $('#main').innerHTML = head('Kelola', 'Atur menu, stok, tim, dan pengaturan toko.') + `<div class="chips" style="margin-bottom:14px">${SUBS.map(([k, l]) => `<button data-act="sub" data-s="${k}" class="${state.sub === k ? 'on' : ''}">${l}</button>`).join('')}</div><div id="sub"></div>`;
  await SUBVIEWS[state.sub]();
}
const SUBVIEWS = {};
const margin = p => p.price && p.cost != null ? Math.round((p.price - p.cost) * 100 / p.price) : null;

SUBVIEWS.menu = async () => {
  await loadProducts(true);
  const cats = ['Semua', ...new Set(state.products.map(p => p.category))];
  const q = (state.mq || '').toLowerCase(), f = state.mf || 'Semua';
  const list = state.products.filter(p => (f === 'Semua' || p.category === f || (f === '__todo' && (p.price == null || p.cost == null || !p.active)) || (f === '__nophoto' && p.image_key === 'none')) && (!q || `${p.name} ${p.category}`.toLowerCase().includes(q)));
  $('#sub').innerHTML = `<div class="pos-tools"><input id="mq" class="field" type="search" placeholder="🔍  Cari menu…" value="${esc(state.mq || '')}"><button class="btn ghost" data-act="quickPhoto">📷 Lengkapi foto</button><button class="btn" data-act="addProduct">+ Tambah menu</button></div>
    <div class="chips" style="margin-bottom:12px">${cats.map(c => `<button data-act="mfilter" data-c="${esc(c)}" class="${f === c ? 'on' : ''}">${esc(c)}</button>`).join('')}<button data-act="mfilter" data-c="__nophoto" class="${f === '__nophoto' ? 'on' : ''}">📷 Tanpa foto (${state.products.filter(p => p.active && p.image_key === 'none').length})</button><button data-act="mfilter" data-c="__todo" class="${f === '__todo' ? 'on' : ''}">⚠ Perlu dilengkapi (${state.products.filter(p => p.price == null || p.cost == null || !p.active).length})</button></div>
    <div class="card"><p class="hint" style="margin:0 0 6px">Ketuk menu untuk mengubah harga, HPP (modal), foto, atau menyembunyikannya. Banyak menu memakai foto contoh — ganti bila ada foto yang lebih cocok.</p><div class="list">${list.map(p => { const m = margin(p); return `<button class="item" data-act="editProduct" data-id="${esc(p.id)}" ${p.active ? '' : 'style="opacity:.55"'}>${thumb(p.image_key)}<div><div class="t">${esc(p.name)}</div><div class="s">${esc(p.category)}${p.variant ? ' · ' + esc(p.variant) : ''}</div></div><div class="end"><div class="t">${p.price == null ? '<span class="pill bad">Harga kosong</span>' : rp(p.price)}</div><div class="s">${p.cost == null ? '<span class="pill gold">HPP kosong</span>' : `Modal ${rp(p.cost)} · margin ${m}%`}${p.active ? '' : ' <span class="pill">Disembunyikan</span>'}</div></div></button>`; }).join('') || '<div class="empty">Tidak ada menu.</div>'}</div></div>`;
  $('#mq').oninput = e => { state.mq = e.target.value; clearTimeout(state._mt); state._mt = setTimeout(() => SUBVIEWS.menu(), 250); };
  $('#mq').focus(); const v = $('#mq').value; $('#mq').setSelectionRange(v.length, v.length);
};
function productForm(p) {
  const cats = [...new Set(state.products.map(x => x.category))];
  const builtin = state.images.map(i => [i, i === 'none' ? 'Tanpa foto' : i.replace(/-/g, ' ')]);
  if (p && p.image_key.startsWith('up-')) builtin.unshift([p.image_key, 'Foto unggahan']);
  return [
    { name: 'name', label: 'Nama menu', value: p?.name, maxlength: 80 },
    { name: 'category', label: 'Kategori', value: p?.category || 'Makanan', maxlength: 40, list: { id: 'catlist', items: cats }, hint: 'Pilihan tambahan (gula, es, dll.) mengikuti kategori, kecuali diatur khusus di bawah.' },
    { name: 'variant', label: 'Keterangan singkat (opsional)', value: p?.variant, hint: 'Teks pendek di bawah nama, mis. “Es” atau “Panas”.' },
    { name: 'description', label: 'Deskripsi (opsional)', type: 'textarea', value: p?.description, maxlength: 300, hint: 'Tampil di halaman pesan pelanggan.' },
    { name: 'price', label: 'Harga jual (Rp)', type: 'money', value: p?.price },
    { name: 'cost', label: 'HPP / modal per porsi (Rp)', type: 'money', placeholder: 'Belum diisi', value: p?.cost, hint: 'Biaya bahan untuk 1 porsi. Diisi agar laba bisa dihitung; boleh dikosongkan dulu.' },
    { name: 'featured', type: 'switch', text: '⭐ Menu favorit (tampil paling atas)', value: !!p?.featured },
    { name: 'image_key', label: 'Foto', type: 'select', value: p?.image_key || 'none', options: builtin },
  ];
}
/* kecilkan foto dari kamera/galeri: potong 4:3, maks 800px, JPEG */
async function toJpeg(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let sw = bmp.width, sh = bmp.height;
  if (sw / sh > 4 / 3) sw = Math.round(sh * 4 / 3); else sh = Math.round(sw * 3 / 4);
  const sx = Math.round((bmp.width - sw) / 2), sy = Math.round((bmp.height - sh) / 2), w = Math.min(800, sw), h = Math.round(w * 3 / 4);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  return cv.toDataURL('image/jpeg', 0.82);
}
async function uploadPhoto(pid, dataUrl) { return api(`/api/products/${encodeURIComponent(pid)}/photo`, { method: 'POST', body: { image: dataUrl } }); }
function productSheet(p) {
  const fields = productForm(p);
  const groups = state.mods.groups, catIds = (state.mods.categories[p?.category] || []);
  let custom = p ? state.mods.product_groups?.[p.id] : undefined, pending = null;
  const effective = () => custom !== undefined ? custom : catIds;
  const photoHTML = `<div class="photo-block"><div class="prevbox" id="imgPrev">${thumb(p?.image_key || 'none')}</div><div class="stack" style="flex:1"><label class="btn" for="photoFile">📷 ${p && p.image_key !== 'none' ? 'Ganti foto' : 'Tambah foto'}</label><input type="file" id="photoFile" accept="image/*" class="hidden"><button type="button" class="btn ghost sm" id="photoClear">Pakai logo (tanpa foto)</button><div class="hint">Bisa dari kamera atau galeri. Foto dipotong 4:3 dan dikecilkan otomatis.</div></div></div>`;
  const modHTML = p ? `<div class="form-row"><label class="lbl">Pilihan tambahan untuk menu ini</label><div class="seg" id="modMode"><button type="button" data-v="category" class="${custom === undefined ? 'on' : ''}">Ikuti kategori</button><button type="button" data-v="custom" class="${custom !== undefined ? 'on' : ''}">Atur khusus</button></div><div class="chips" id="modChips" style="margin-top:10px"></div><div class="hint" id="modHint"></div></div>` : '<div class="hint" style="margin-bottom:14px">Pilihan tambahan (ukuran, gula, dll.) bisa diatur setelah menu disimpan.</div>';
  const sh = formSheet({
    title: p ? 'Ubah menu' : 'Tambah menu', head: photoHTML, fields: fields.concat(p ? [{ name: 'available', type: 'switch', text: 'Tersedia untuk dijual', value: !!p.available }] : []),
    extra: `${modHTML}${p ? `<hr style="border:0;border-top:1px solid var(--line2);margin:14px 0"><button class="btn ${p.active ? 'danger' : 'ghost'} block" data-hide>${p.active ? 'Sembunyikan menu ini' : 'Tampilkan menu ini lagi'}</button><p class="hint">Menu yang disembunyikan tidak muncul di kasir dan halaman pesan, tetapi riwayat penjualannya tetap aman.</p>` : ''}`,
    onMount: s => {
      const draw = () => {
        if (!p) return;
        const names = effective().map(id => groups.find(g => g.id === id)?.name).filter(Boolean);
        $('#modChips', s.el).innerHTML = custom !== undefined ? groups.map(g => `<button type="button" data-g="${esc(g.id)}" class="${custom.includes(g.id) ? 'on' : ''}">${esc(g.name)}</button>`).join('') : '';
        $('#modHint', s.el).textContent = custom !== undefined ? 'Ketuk untuk memasang/melepas. Berlaku langsung.' : (names.length ? 'Mengikuti kategori: ' + names.join(', ') + '.' : 'Kategori ini belum punya pilihan tambahan.');
      };
      const saveMods = async mode => { try { await api(`/api/products/${encodeURIComponent(p.id)}/modifiers`, { method: 'PUT', body: { mode, group_ids: mode === 'custom' ? custom : [] } }); state.mods = await api('/api/modifiers'); } catch (e) { toast(e.message, 'bad'); } };
      s.q('[name=image_key]').addEventListener('change', e => { pending = null; $('#imgPrev', s.el).innerHTML = thumb(e.target.value); });
      $('#photoFile', s.el).addEventListener('change', async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const data = await toJpeg(f);
          if (!p) { pending = data; $('#imgPrev', s.el).innerHTML = `<img src="${data}" alt="">`; toast('Foto dipilih. Akan tersimpan bersama menu.', 'ok'); return; }
          const r = await uploadPhoto(p.id, data);
          p.image_key = r.image_key; $('#imgPrev', s.el).innerHTML = thumb(r.image_key);
          const sel = s.q('[name=image_key]'); if (![...sel.options].some(o => o.value === r.image_key)) sel.insertAdjacentHTML('afterbegin', `<option value="${r.image_key}">Foto unggahan</option>`); sel.value = r.image_key;
          const row = state.products.find(x => x.id === p.id); if (row) row.image_key = r.image_key;
          toast('Foto tersimpan', 'ok');
        } catch (err) { toast(err.message || 'Foto tidak bisa diproses.', 'bad'); }
      });
      $('#photoClear', s.el).onclick = () => { pending = null; s.q('[name=image_key]').value = 'none'; $('#imgPrev', s.el).innerHTML = thumb('none'); };
      $('#modMode', s.el)?.addEventListener('click', async e => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        if (b.dataset.v === 'custom' && custom === undefined) custom = [...catIds];
        if (b.dataset.v === 'category') custom = undefined;
        $$('#modMode button', s.el).forEach(x => x.classList.toggle('on', x === b));
        draw(); await saveMods(b.dataset.v);
      });
      $('#modChips', s.el)?.addEventListener('click', async e => {
        const b = e.target.closest('button[data-g]'); if (!b) return;
        custom = custom.includes(b.dataset.g) ? custom.filter(x => x !== b.dataset.g) : [...custom, b.dataset.g];
        draw(); await saveMods('custom');
      });
      s.q('[data-hide]')?.addEventListener('click', async () => { try { await api('/api/products/' + encodeURIComponent(p.id), { method: 'PUT', body: { active: !p.active } }); s.close(); toast(p.active ? 'Menu disembunyikan' : 'Menu ditampilkan lagi', 'ok'); state.products = []; SUBVIEWS.menu(); } catch (e) { toast(e.message, 'bad'); } });
      draw();
    },
    onSubmit: async (v, s) => {
      if (!v.name) throw new Error('Nama menu wajib diisi.');
      if (v.price == null || v.price < 1) throw new Error('Isi harga jual (minimal Rp1).');
      const body = { name: v.name, category: v.category || 'Lainnya', variant: v.variant, description: v.description, price: v.price, cost: v.cost, image_key: v.image_key, featured: v.featured };
      if (p) { body.available = v.available; await api('/api/products/' + encodeURIComponent(p.id), { method: 'PUT', body }); }
      else {
        const r = await api('/api/products', { method: 'POST', body });
        if (pending) { try { await uploadPhoto(r.item.id, pending); } catch (e) { toast('Menu tersimpan, tetapi foto gagal: ' + e.message, 'bad'); } }
      }
      s.close(); toast('Menu disimpan', 'ok'); state.products = []; SUBVIEWS.menu();
    },
  });
  return sh;
}
/* lengkapi foto menu satu per satu: daftar menu tanpa foto, tiap baris ada tombol kamera */
function quickPhotoSheet() {
  const draw = s => {
    const q = ($('#qpq', s.el)?.value || '').toLowerCase();
    const list = state.products.filter(p => p.active && p.image_key === 'none' && (!q || p.name.toLowerCase().includes(q)));
    $('#qpList', s.el).innerHTML = list.map(p => `<div class="item"><div><div class="t">${esc(p.name)}</div><div class="s">${esc(p.category)}</div></div><div class="end"><label class="btn sm" for="qp_${esc(p.id)}">📷 Foto</label><input type="file" accept="image/*" class="hidden" id="qp_${esc(p.id)}" data-pid="${esc(p.id)}"></div></div>`).join('') || '<div class="empty">Semua menu sudah berfoto 🎉</div>';
    $('#qpCount', s.el).textContent = `${state.products.filter(p => p.active && p.image_key === 'none').length} menu belum berfoto`;
  };
  openSheet({
    title: 'Lengkapi foto menu', wide: true,
    body: `<p class="muted" style="margin-top:0">Ketuk <b>📷 Foto</b> di samping menu, ambil foto dengan kamera (atau pilih dari galeri). Foto tersimpan otomatis dan menu itu hilang dari daftar ini.</p><div class="small" id="qpCount" style="font-weight:700;margin-bottom:8px"></div><input class="field" id="qpq" type="search" placeholder="🔍  Cari menu…" autocomplete="off" style="margin-bottom:8px"><div class="list" id="qpList"></div>`,
    footer: '<button class="btn" data-done>Selesai</button>',
    onMount: s => {
      draw(s);
      $('#qpq', s.el).oninput = () => draw(s);
      s.q('[data-done]').onclick = () => { s.close(); SUBVIEWS.menu(); };
      $('#qpList', s.el).addEventListener('change', async e => {
        const inp = e.target.closest('input[type=file]'); if (!inp || !inp.files[0]) return;
        try { const data = await toJpeg(inp.files[0]); const r = await uploadPhoto(inp.dataset.pid, data); const row = state.products.find(x => x.id === inp.dataset.pid); if (row) row.image_key = r.image_key; toast('Foto tersimpan', 'ok'); draw(s); }
        catch (err) { toast(err.message || 'Foto tidak bisa diproses.', 'bad'); }
      });
    },
  });
}

SUBVIEWS.stok = async () => {
  await loadProducts(true);
  const f = state.sf || 'Semua', q = (state.sq || '').toLowerCase();
  const low = p => p.stock_tracked && p.stock_on_hand != null && p.reorder_level != null && p.stock_on_hand <= p.reorder_level;
  const list = activeProducts().filter(p => (f === 'Semua' || (f === 'tracked' && p.stock_tracked) || (f === 'untracked' && !p.stock_tracked) || (f === 'low' && low(p))) && (!q || p.name.toLowerCase().includes(q)));
  $('#sub').innerHTML = `<div class="notice" style="margin-bottom:12px">Stok dihitung <b>per porsi/gelas/piring</b> yang terjual. Menu yang stoknya sudah dihitung akan berkurang otomatis dan tidak bisa dijual melebihi stok. Menu yang belum dilacak tetap bisa dijual tanpa batas.</div>
    <div class="pos-tools"><input id="sq" class="field" type="search" placeholder="🔍  Cari menu…" value="${esc(state.sq || '')}"></div>
    <div class="chips" style="margin-bottom:12px">${[['Semua', 'Semua'], ['tracked', 'Terlacak'], ['untracked', 'Belum dilacak'], ['low', 'Menipis']].map(([k, l]) => `<button data-act="sfilter" data-c="${k}" class="${f === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="card"><div class="list">${list.map(p => `<button class="item" data-act="editStock" data-id="${esc(p.id)}">${thumb(p.image_key)}<div><div class="t">${esc(p.name)}</div><div class="s">${esc(p.category)}</div></div><div class="end">${p.stock_tracked ? `<span class="pill ${low(p) ? 'warn' : 'ok'}">Stok ${p.stock_on_hand ?? '?'}${low(p) ? ' · menipis' : ''}</span>` : '<span class="pill">Belum dilacak</span>'}</div></button>`).join('') || '<div class="empty">Tidak ada menu.</div>'}</div></div>`;
  $('#sq').oninput = e => { state.sq = e.target.value; clearTimeout(state._st); state._st = setTimeout(() => SUBVIEWS.stok(), 250); };
  $('#sq').focus(); const v = $('#sq').value; $('#sq').setSelectionRange(v.length, v.length);
};
function stockSheet(p) {
  formSheet({
    title: `Stok · ${p.name}`, intro: p.stock_tracked ? `Stok tercatat sekarang: <b>${p.stock_on_hand}</b>. Isi hasil hitung fisik terbaru.` : 'Belum dilacak. Isi hasil hitung fisik untuk mulai melacak stok menu ini.',
    fields: [{ name: 'count', label: 'Jumlah fisik sekarang', type: 'number', value: p.stock_on_hand ?? '', placeholder: '0' }, { name: 'reorder', label: 'Ingatkan bila stok tinggal (opsional)', type: 'number', value: p.reorder_level ?? '' }, { name: 'note', label: 'Catatan (opsional)', value: '', maxlength: 240 }],
    submit: 'Simpan stok', extra: p.stock_tracked ? '<hr style="border:0;border-top:1px solid var(--line2);margin:14px 0"><button class="btn ghost block" data-untrack>Berhenti melacak stok menu ini</button>' : '',
    onMount: s => s.q('[data-untrack]')?.addEventListener('click', async () => { try { await api('/api/products/' + encodeURIComponent(p.id), { method: 'PUT', body: { stock_tracked: false } }); s.close(); toast('Stok tidak lagi dilacak', 'ok'); SUBVIEWS.stok(); } catch (e) { toast(e.message, 'bad'); } }),
    onSubmit: async (v, s) => {
      if (!/^\d+$/.test(v.count)) throw new Error('Isi jumlah fisik dengan angka bulat (0 atau lebih).');
      if (v.reorder && !/^\d+$/.test(v.reorder)) throw new Error('Batas menipis harus angka bulat.');
      await api('/api/stock/count', { method: 'POST', body: { product_id: p.id, counted_quantity: parseInt(v.count, 10), note: v.note || 'hitung dari layar' } });
      await api('/api/products/' + encodeURIComponent(p.id), { method: 'PUT', body: { reorder_level: v.reorder === '' ? null : parseInt(v.reorder, 10) } });
      s.close(); toast('Stok disimpan', 'ok'); SUBVIEWS.stok();
    },
  });
}

SUBVIEWS.varian = async () => {
  const [m] = await Promise.all([loadMods(true), loadProducts(true)]);
  const cats = [...new Set(activeProducts().map(p => p.category))].sort();
  $('#sub').innerHTML = `<div class="notice" style="margin-bottom:12px">“Pilihan tambahan” muncul saat kasir mengetuk menu — mis. ukuran, level gula, extra shot. Atur isinya di sini, lalu <b>pasang ke kategori</b> yang memakainya.</div>
    <div class="grid g2"><div class="stack">${m.groups.map(g => `<div class="card"><div class="row between wrap"><div><h3 style="margin:0">${esc(g.name)}</h3><div class="small muted">${g.min_select > 0 ? 'Wajib pilih' : 'Boleh dikosongkan'}${g.max_select > 1 ? ` · maks ${g.max_select} pilihan` : ''}</div></div><div class="row"><button class="btn ghost sm" data-act="editGroup" data-id="${esc(g.id)}">Ubah</button><button class="btn ghost sm" data-act="addOption" data-id="${esc(g.id)}">+ Pilihan</button></div></div>
      <div class="list" style="margin-top:6px">${g.options.map(o => `<button class="item" data-act="editOption" data-id="${esc(o.id)}" data-g="${esc(g.id)}"><div class="t grow">${esc(o.name)}</div><div class="s">${o.price_delta ? signed(o.price_delta) : 'gratis'}</div></button>`).join('') || '<div class="empty">Belum ada pilihan.</div>'}</div></div>`).join('')}
      <button class="btn ghost" data-act="addGroup">+ Kelompok pilihan baru</button></div>
    <div class="card"><h3>Pasang ke kategori</h3><p class="hint" style="margin-top:0">Ketuk untuk memasang/melepas. Berlaku langsung.</p>${cats.map(k => `<div style="margin-bottom:14px"><div class="t" style="font-weight:700;margin-bottom:6px">${esc(k)}</div><div class="chips">${m.groups.map(g => { const on = (m.categories[k] || []).includes(g.id); return `<button data-act="toggleCat" data-k="${esc(k)}" data-g="${esc(g.id)}" class="${on ? 'on' : ''}">${esc(g.name)}</button>`; }).join('')}</div></div>`).join('')}</div></div>`;
};

SUBVIEWS.tim = async () => {
  const d = await api('/api/users');
  $('#sub').innerHTML = `<div class="row between wrap" style="margin-bottom:12px"><p class="muted" style="margin:0">Setiap orang punya PIN sendiri supaya tercatat siapa yang melayani. <b>Kasir</b> hanya bisa jualan; <b>Pemilik</b> bisa semuanya.</p><button class="btn" data-act="addUser">+ Tambah anggota</button></div>
    <div class="card"><div class="list">${d.items.map(u => `<button class="item" data-act="editUser" data-id="${u.id}" ${u.active ? '' : 'style="opacity:.55"'}><span class="avatar">${esc(u.name.slice(0, 1).toUpperCase())}</span><div><div class="t">${esc(u.name)}</div><div class="s">${ROLE_NAME[u.role]}${u.id === state.me.id ? ' · Anda' : ''}</div></div><div class="end">${u.active ? '<span class="pill ok">Aktif</span>' : '<span class="pill">Nonaktif</span>'}</div></button>`).join('')}</div></div>`;
  state.users = d.items;
};

const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
/* foto utuh (tanpa dipotong), latar putih — untuk gambar QRIS */
async function toJpegFull(file, max = 1000) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const sc = Math.min(1, max / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
  return cv.toDataURL('image/jpeg', 0.92);
}
SUBVIEWS.atur = async () => {
  const [{ settings: st }, bk] = await Promise.all([api('/api/settings'), api('/api/admin/backups')]); state.settings = st;
  $('#sub').innerHTML = `<div class="grid g2">
    <div class="card"><h3>Info toko & struk</h3><div id="e1"></div>${[{ name: 'outlet_name', label: 'Nama toko', value: st.outlet_name }, { name: 'outlet_address', label: 'Alamat singkat', value: st.outlet_address }, { name: 'receipt_footer', label: 'Pesan di bawah struk', value: st.receipt_footer }, { name: 'outlet_contact', label: 'Kontak (struk & halaman pesan)', value: st.outlet_contact, maxlength: 120 }, { name: 'public_base_url', label: 'Alamat situs untuk QR meja (opsional)', value: st.public_base_url, maxlength: 120, placeholder: 'https://kopisawah.diginavastudio.com', hint: 'Kosongkan bila Anda membuka aplikasi lewat alamat publik toko. Isi hanya bila alamat yang tercetak di QR harus berbeda.' }, { name: 'receipt_width', label: 'Lebar kertas struk', type: 'seg', value: st.receipt_width, options: [['58', '58 mm'], ['80', '80 mm']] }].map(fieldHTML).join('')}<button class="btn" data-act="saveSet" data-grp="info">Simpan</button></div>
    <div class="card"><h3>Pajak, layanan & pembulatan</h3><div class="notice" style="margin-bottom:12px">Bawaan: <b>semua 0%</b> (tidak ada pajak/layanan). Besaran pajak restoran (PB1) ditetapkan pemerintah daerah — <b>tarif dan kewajibannya belum saya verifikasi</b>; pastikan dulu ke konsultan pajak / Bapenda setempat sebelum mengaktifkan.</div><div id="e2"></div>
    ${[{ name: 'service_percent', label: 'Biaya layanan (%)', type: 'number', value: st.service_percent, hint: 'Dihitung dari harga setelah diskon.' }, { name: 'tax_percent', label: 'Pajak (%)', type: 'number', value: st.tax_percent, hint: 'Dihitung dari harga setelah diskon + biaya layanan. Harga di menu dianggap belum termasuk pajak.' }, { name: 'rounding', label: 'Pembulatan total', type: 'select', value: st.rounding, options: [['0', 'Tidak dibulatkan'], ['100', 'Ke Rp100 terdekat'], ['500', 'Ke Rp500 terdekat'], ['1000', 'Ke Rp1.000 terdekat']] }].map(fieldHTML).join('')}<button class="btn" data-act="saveSet" data-grp="tax">Simpan</button></div>
    <div class="card"><h3>Diskon oleh kasir</h3><div id="e3"></div>${fieldHTML({ name: 'kasir_max_discount_percent', label: 'Batas diskon kasir (%)', type: 'number', value: st.kasir_max_discount_percent, hint: '0 = kasir tidak boleh memberi diskon (hanya pemilik). Diskon selalu wajib disertai alasan.' })}<button class="btn" data-act="saveSet" data-grp="disc">Simpan</button></div>
    <div class="card"><h3>QRIS toko (untuk pelanggan di meja)</h3>${st.qris_image ? `<div class="center"><img src="${imgSrc(st.qris_image)}" alt="QRIS toko" style="max-width:220px;width:100%;border:1px solid var(--line);border-radius:12px"></div>` : '<p class="muted" style="margin-top:0">Belum ada. Unggah gambar QRIS toko Anda (dari aplikasi bank/e-wallet).</p>'}<div class="stack" style="margin-top:10px"><label class="btn ghost" for="qrisFile">📷 ${st.qris_image ? 'Ganti gambar QRIS' : 'Unggah gambar QRIS'}</label><input type="file" id="qrisFile" accept="image/*" class="hidden">${st.qris_image ? '<button class="btn danger sm" data-act="qrisDelete">Hapus gambar QRIS</button>' : ''}</div><p class="hint">Setelah pesanan diterima, pelanggan melihat tombol <b>Bayar dengan QRIS</b> di HP-nya. <b>Kasir tetap harus memeriksa uang masuk</b> sebelum mencatat bayar — halaman ini tidak memverifikasi pembayaran.</p></div>
    <div class="card"><h3>Cadangan otomatis</h3><p class="muted" style="margin-top:0">Setiap hari setelah jam ${bk.hour}:00, sistem menyimpan cadangan (database + foto). Disimpan ${bk.keep} terakhir <b>di server yang sama</b>, jadi tetap unduh dan simpan salinan di tempat lain.</p><div class="list">${bk.items.map(b => `<div class="item"><div><div class="t">${esc(b.name)}</div><div class="s">${esc(fmtDateTime(b.at))} · ${fmtSize(b.size)}</div></div><div class="end"><a class="btn sm ghost" href="/api/admin/backups/${encodeURIComponent(b.name)}" download>⬇</a></div></div>`).join('') || '<div class="empty">Belum ada cadangan otomatis.</div>'}</div><button class="btn ghost" style="margin-top:10px" data-act="backupNow">Cadangkan sekarang</button></div>
    <div class="card"><h3>Keamanan & data</h3><div class="stack"><button class="btn ghost" data-act="changePin">Ganti PIN saya</button><a class="btn ghost" href="/api/admin/backup" download>⬇ Unduh cadangan data (.zip)</a><button class="btn ghost" data-act="audit">Riwayat aktivitas</button></div><p class="hint">Unduh cadangan rutin (mis. tiap minggu) dan simpan di tempat aman di luar server. Berkas cadangan berisi seluruh data toko — jangan dibagikan.</p></div></div>`;
  wireFields($('#sub'));
};
const SET_GROUPS = { info: ['outlet_name', 'outlet_address', 'receipt_footer', 'outlet_contact', 'public_base_url', 'receipt_width'], tax: ['service_percent', 'tax_percent', 'rounding'], disc: ['kasir_max_discount_percent'] };

/* ============================== MEJA: pesanan dari QR ============================== */
const ORDER_PILL = { pending: ['gold', 'Menunggu konfirmasi'], accepted: ['ok', 'Diproses'], ready: ['ok', 'Siap diantar'], served: ['', 'Sudah disajikan'] };
let actx = null;
document.addEventListener('click', () => { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* tanpa suara */ } } else if (actx.state === 'suspended') actx.resume(); }, { capture: true });
function beep() {
  if (ls.get('ks_sound') === '0' || !actx) return;
  [0, 0.22].forEach(t => { try { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = t ? 1175 : 880; g.gain.value = 0.18; o.connect(g); g.connect(actx.destination); o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.16); } catch { /* abaikan */ } });
}
function ticketOf(o) { return { id: o.id, order_type: 'dine_in', table_no: o.table_label + (o.customer_name ? ' · ' + o.customer_name : ''), created_at: o.created_at, items: o.items, note: o.note }; }
const mejaMode = () => ls.get('ks_mejamode') === 'dapur' ? 'dapur' : 'meja';
const minsAgo = iso => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
function orderCard(o, kds) {
  const [k, t] = ORDER_PILL[o.status] || ['', o.status];
  const big = kds ? 'font-size:20px;line-height:1.35' : '';
  const mins = minsAgo(o.updated_at || o.created_at), age = mins >= 20 ? 'bad' : mins >= 10 ? 'warn' : 'ok';
  return `<div class="card flat" style="margin-top:10px"><div class="row between wrap"><div>${kds ? `<b style="font-size:22px">${esc(o.table_label)}</b> ` : ''}<b>${esc(o.id)}</b> <span class="small muted">· ${fmtTime(o.created_at)}${o.customer_name ? ' · ' + esc(o.customer_name) : ''}</span></div>${kds ? `<span class="pill ${age}">${mins} mnt</span>` : `<span class="pill ${k}">${esc(t)}</span>`}</div>
    <ul style="margin:8px 0 4px;padding-left:20px;${big}">${o.items.map(i => `<li><b>${i.quantity}×</b> ${esc(i.name_snapshot)}${i.modifiers_summary ? `<div class="small muted">${esc(i.modifiers_summary)}</div>` : ''}</li>`).join('')}</ul>
    ${o.note ? `<div class="notice" style="padding:8px 12px;margin:6px 0">📝 ${esc(o.note)}</div>` : ''}
    <div class="row wrap" style="margin-top:8px">${kds ? '<span class="grow"></span>' : `<b class="grow">${rp(o.subtotal)}</b>`}
    ${o.status === 'pending' ? `<button class="btn sm" data-act="orderStatus" data-id="${esc(o.id)}" data-s="accepted">✓ Terima</button><button class="btn danger sm" data-act="orderReason" data-id="${esc(o.id)}" data-s="rejected">Tolak</button>` : ''}
    ${o.status === 'accepted' ? `<button class="btn ${kds ? 'big' : 'sm'}" data-act="orderStatus" data-id="${esc(o.id)}" data-s="ready">Siap</button>` : ''}
    ${o.status === 'ready' && kds ? `<button class="btn big" data-act="orderStatus" data-id="${esc(o.id)}" data-s="served">Sudah disajikan</button>` : ''}
    ${!kds && (o.status === 'accepted' || o.status === 'ready') ? `<button class="btn sm ghost" data-act="orderStatus" data-id="${esc(o.id)}" data-s="served">Sudah disajikan</button>` : ''}
    <button class="btn sm ghost" data-act="ticketOrder" data-id="${esc(o.id)}">Tiket dapur</button>
    ${!kds && o.status !== 'pending' ? `<button class="btn sm danger" data-act="orderReason" data-id="${esc(o.id)}" data-s="cancelled">Batalkan</button>` : ''}</div></div>`;
}
async function viewMeja() {
  const [d, tb] = await Promise.all([api('/api/orders'), api('/api/tables')]);
  state.mejaData = d; state.tablesAll = tb.items;
  const mode = mejaMode(), sound = ls.get('ks_sound') !== '0';
  const byTable = {};
  d.orders.forEach(o => (byTable[o.table_label] ||= []).push(o));
  const calls = d.calls.map(c => `<div class="notice" style="display:flex;gap:10px;align-items:center;margin-bottom:10px"><span style="font-size:22px">${c.kind === 'bill' ? '🧾' : '🙋'}</span><div class="grow"><b>${esc(c.table_label)}</b> ${c.kind === 'bill' ? 'meminta bill' : 'memanggil pelayan'} · ${fmtTime(c.created_at)}</div><button class="btn sm" data-act="callDone" data-id="${c.id}">Selesai</button></div>`).join('');
  const right = `<div class="seg" style="min-width:230px"><button data-act="mejaMode" data-m="meja" class="${mode === 'meja' ? 'on' : ''}">Per meja</button><button data-act="mejaMode" data-m="dapur" class="${mode === 'dapur' ? 'on' : ''}">Papan dapur</button></div><button class="btn ghost sm" data-act="soundToggle">${sound ? '🔔 Suara aktif' : '🔕 Suara mati'}</button>${isOwner() ? '<button class="btn ghost sm" data-act="manageTables">⚙ Atur meja & QR</button>' : ''}`;
  const strip = tb.items.filter(x => x.active).map(x => { const l = byTable[x.label] || [], pend = l.some(o => o.status === 'pending'); return `<span class="tchip ${l.length ? (pend ? 'wait' : 'busy') : ''}" title="${l.length ? l.length + ' pesanan' : 'kosong'}">${esc(x.label)}${l.length ? ` <b>${l.length}</b>` : ''}</span>`; }).join('');
  let body;
  if (mode === 'dapur') {
    const prep = d.orders.filter(o => o.status === 'accepted'), ready = d.orders.filter(o => o.status === 'ready'), pend = d.orders.filter(o => o.status === 'pending');
    body = (pend.length ? `<div class="notice" style="margin-bottom:12px"><b>${pend.length} pesanan menunggu diterima kasir.</b> <button class="btn sm" data-act="mejaMode" data-m="meja">Lihat & terima</button></div>` : '')
      + `<div class="grid g2"><div><h3>Sedang diproses (${prep.length})</h3>${prep.map(o => orderCard(o, true)).join('') || '<div class="empty card flat">Tidak ada yang sedang diproses.</div>'}</div><div><h3>Siap diantar (${ready.length})</h3>${ready.map(o => orderCard(o, true)).join('') || '<div class="empty card flat">Belum ada yang siap.</div>'}</div></div>`;
  } else {
    const tables = Object.entries(byTable);
    body = (state.shift ? '' : '<div class="notice" style="margin-bottom:12px">Kasir belum dibuka — buka kasir dulu (tab Kas) supaya pembayaran meja bisa dicatat.</div>') + calls
      + (tables.length ? tables.map(([label, list]) => {
        const payable = list.filter(o => o.status !== 'pending'), waiting = list.length - payable.length, due = payable.reduce((a, o) => a + o.subtotal, 0);
        return `<div class="card" style="margin-bottom:14px"><div class="row between wrap" style="margin-bottom:8px"><div><h3 style="margin:0">${esc(label)}</h3><div class="small muted">${list.length} pesanan${waiting ? ` · <b>${waiting} menunggu konfirmasi</b>` : ''}</div></div>
          <div class="row wrap"><button class="btn ghost sm" data-act="moveTable" data-t="${esc(label)}">⇄ Pindah / gabung meja</button><button class="btn gold" data-act="payTable" data-t="${esc(label)}" ${payable.length ? '' : 'disabled'}>Bayar meja · ${rp(due)}</button></div></div>
          ${list.map(o => orderCard(o, false)).join('')}</div>`;
      }).join('') : `<div class="card"><div class="empty">Belum ada pesanan dari meja.<br><span class="small">Pesanan baru akan muncul di sini otomatis dan berbunyi.${isOwner() ? ' Pasang QR di meja lewat <b>⚙ Atur meja & QR</b>.' : ''}</span></div></div>`);
  }
  $('#main').innerHTML = head(mode === 'dapur' ? 'Papan Dapur' : 'Pesanan Meja', mode === 'dapur' ? 'Pesanan yang sudah diterima. Ketuk <b>Siap</b> bila sudah selesai dimasak.' : 'Pesanan dari QR di meja. Terima dulu, lalu bayar di kasir saat pelanggan selesai.', right)
    + (strip ? `<div class="tstrip" aria-label="Status meja">${strip}</div>` : '') + body;
}
let sumPrev = null;
async function pollOrders() {
  if (!state.me) return;
  try {
    const s = await api('/api/orders/summary'), n = s.pending + s.calls;
    const b = $('#mejaBadge'); if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
    document.title = n ? `(${n}) Kopi Sawah — Kasir` : 'Kopi Sawah — Kasir';
    if (sumPrev) {
      const newOrder = s.latest_pending && s.latest_pending > (sumPrev.latest_pending || '');
      const newCall = s.latest_call && s.latest_call > (sumPrev.latest_call || 0);
      if (newOrder || newCall) { beep(); toast(newOrder ? 'Pesanan baru dari meja!' : 'Meja memanggil Anda', 'ok'); }
      const changed = ['pending', 'calls', 'active', 'latest_pending', 'latest_call'].some(k => s[k] !== sumPrev[k]);
      if (changed && state.view === 'meja' && !state.sheets.length) viewMeja().catch(() => { });
    }
    sumPrev = s;
  } catch { /* abaikan; coba lagi */ }
}

/* ============================== KELOLA: Meja & QR ============================== */
const publicBase = () => (state.settings.public_base_url || location.origin).replace(/\/+$/, '');
const tableURL = t => `${publicBase()}/m/${t.token}`;
const qrSVG = url => { const q = qrcode(0, 'M'); q.addData(url); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
const qrCard = t => `<div class="qrcard"><img src="/static/images/logo-badge.png" alt=""><h3>Pesan dari meja</h3><div class="qrbox">${qrSVG(tableURL(t))}</div><div class="tn">${esc(t.label)}</div><p>Scan QR dengan kamera HP,<br>pilih menu, lalu kirim pesanan.<br><b>Bayar di kasir.</b></p><small>${esc(state.settings.outlet_contact || '')}</small></div>`;
function printQR(list) {
  const pa = $('#printArea'); pa.className = 'print-area qr'; pa.innerHTML = `<div class="qrgrid">${list.map(qrCard).join('')}</div>`;
  setTimeout(() => window.print(), 80);
}
SUBVIEWS.meja = async () => {
  const [t, st] = await Promise.all([api('/api/tables'), api('/api/settings')]);
  state.settings = st.settings; state.tables = t.items;
  $('#sub').innerHTML = `<div class="notice" style="margin-bottom:12px">Tiap meja punya QR sendiri. Pelanggan scan → pilih menu → pesanan masuk ke tab <b>Meja</b> di kasir (berbunyi). Pelanggan <b>membayar di kasir</b>. Cetak QR, lalu tempel/laminasi di meja.<br>Alamat yang dipakai di QR: <b>${esc(publicBase())}</b>${state.settings.public_base_url ? '' : ' (alamat yang sedang Anda buka). Bila perlu mengganti, isi di Pengaturan.'}</div>
    <div class="row wrap" style="margin-bottom:12px"><button class="btn" data-act="addTables">+ Tambah banyak meja</button><button class="btn ghost" data-act="addTable">+ Satu meja (nama bebas)</button><span class="grow"></span><button class="btn ghost" data-act="printAllQR" ${t.items.some(x => x.active) ? '' : 'disabled'}>🖨 Cetak semua QR</button></div>
    <div class="card"><div class="list">${t.items.map(x => `<button class="item" data-act="tableQR" data-id="${x.id}" ${x.active ? '' : 'style="opacity:.55"'}><span class="avatar" style="border-radius:12px">${icon('table')}</span><div><div class="t">${esc(x.label)}</div><div class="s">${x.active ? 'Aktif' : 'Nonaktif'}</div></div><div class="end"><span class="pill gold">Lihat QR</span></div></button>`).join('') || '<div class="empty">Belum ada meja. Ketuk “Tambah banyak meja”.</div>'}</div></div>`;
};
function tableQRSheet(t) {
  const url = tableURL(t);
  openSheet({
    title: t.label, wide: false,
    body: `<div class="center"><div style="width:260px;max-width:100%;margin:0 auto;border:1px solid var(--line);border-radius:12px;padding:8px;background:#fff">${qrSVG(url)}</div><p class="small muted" style="word-break:break-all;margin:10px 0 0">${esc(url)}</p><p class="hint">Coba scan dengan HP Anda untuk memastikan halaman pesan terbuka.</p></div>`,
    footer: `<button class="btn ghost" data-more>Ubah / ganti kode</button><button class="btn" data-pr>Cetak kartu meja</button>`,
    onMount: s => {
      s.q('[data-pr]').onclick = () => printQR([t]);
      s.q('[data-more]').onclick = () => { s.close(); formSheet({ title: `Ubah ${t.label}`, fields: [{ name: 'label', label: 'Nama meja', value: t.label, maxlength: 30 }, { name: 'active', type: 'switch', text: 'Meja aktif (QR bisa dipakai memesan)', value: !!t.active }],
        extra: '<hr style="border:0;border-top:1px solid var(--line2);margin:14px 0"><button class="btn danger block" data-rot>Ganti kode QR</button><p class="hint">Bila foto QR meja ini tersebar atau disalahgunakan: kode lama langsung tidak berlaku, lalu cetak ulang kartunya.</p>',
        onMount: f => f.q('[data-rot]').onclick = async () => { if (!await confirmSheet({ title: 'Ganti kode QR?', text: `QR lama ${esc(t.label)} langsung tidak berlaku. Anda perlu mencetak dan memasang QR yang baru.`, ok: 'Ya, ganti kode', danger: true })) return; await api(`/api/tables/${t.id}/rotate`, { method: 'POST' }); f.close(); toast('Kode QR diganti. Cetak ulang kartunya.', 'ok'); SUBVIEWS.meja(); },
        onSubmit: async (v, f) => { if (!v.label) throw new Error('Nama meja wajib diisi.'); await api(`/api/tables/${t.id}`, { method: 'PUT', body: v }); f.close(); toast('Disimpan', 'ok'); SUBVIEWS.meja(); } }); };
    },
  });
}

/* ============================== aksi (klik) ============================== */
const VIEWS = { home: viewHome, kasir: viewKasir, meja: viewMeja, pesanan: viewPesanan, laporan: viewLaporan, kelola: viewKelola, kas: viewKas };
const ACT = {
  reload: () => location.reload(),
  help: () => openSheet({ title: 'Bantuan singkat', wide: true, body: HELP_HTML, footer: '<button class="btn" data-done>Mengerti</button>', onMount: s => { s.q('[data-done]').onclick = () => s.close(); } }),
  queueNow: () => { setQueue(getQueue().map(x => { delete x.error; return x; })); flushQueue(); },
  queueDrop: () => { setQueue(getQueue().filter(x => !x.error)); drawOfflineBar(); },
  go: el => { if (el.dataset.sub) state.sub = el.dataset.sub; go(el.dataset.view); },
  logout: async () => { Object.keys(localStorage).filter(k => k.startsWith('ks_snap:')).forEach(k => localStorage.removeItem(k)); clearInterval(state._poll); document.title = 'Kopi Sawah — Kasir'; try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* abaikan */ } state.me = null; state.products = []; state.mods = null; state.shift = null; boot(); },
  pickStaff: el => pinScreen(parseInt(el.dataset.id, 10), el.dataset.name),
  setCash: el => { $('#openCash').value = el.dataset.v === '0' ? '' : nf.format(parseInt(el.dataset.v, 10)); $('#openCash').focus(); },
  openShift: async el => {
    el.disabled = true;
    try { await api('/api/shifts/open', { method: 'POST', body: { opening_cash: parseInt(digits($('#openCash').value) || '0', 10) } }); await loadShift(); toast('Kasir dibuka. Selamat berjualan!', 'ok'); go(state.view); }
    catch (e) { $('#shiftErr').innerHTML = `<div class="notice bad" style="margin-bottom:12px">${esc(e.message)}</div>`; el.disabled = false; }
  },
  closeShift: async el => {
    const v = digits($('#countCash').value);
    if (v === '') return $('#shiftErr').innerHTML = '<div class="notice bad" style="margin-bottom:12px">Isi jumlah uang tunai di laci dulu (isi 0 bila kosong).</div>';
    if (!await confirmSheet({ title: 'Tutup kasir?', text: 'Setelah ditutup, Anda tidak bisa mencatat penjualan sampai membuka kasir lagi.', ok: 'Ya, tutup kasir' })) return;
    el.disabled = true;
    try { const r = await api('/api/shifts/close', { method: 'POST', body: { counted_cash: parseInt(v, 10), note: $('#closeNote').value.trim() } }); state.shift = null; updateShiftChip(); zReportSheet(r.shift); go('kas'); }
    catch (e) { $('#shiftErr').innerHTML = `<div class="notice bad" style="margin-bottom:12px">${esc(e.message)}</div>`; el.disabled = false; }
  },
  cat: el => { state.cat = el.dataset.c; $$('#cats button').forEach(b => b.classList.toggle('on', b === el)); drawGrid(); },
  toggleCompact: el => { state.compact = !state.compact; ls.set('ks_compact', state.compact ? '1' : '0'); go('kasir'); },
  soldMode: () => { state.soldMode = !state.soldMode; go('kasir'); },
  tile: el => {
    const p = prod(el.dataset.id); if (!p) return;
    if (state.soldMode) return ACT.toggleAvail(el);
    if (p.price == null) return toast('Harga menu ini belum diisi. Minta pemilik mengisinya di Kelola → Menu & Harga.', 'bad');
    if (soldOut(p)) return toast(`${p.name} sedang habis.`, 'bad');
    const gs = groupsFor(p);
    if (gs.length) variantSheet(p, gs); else if (addToCart(p, [])) toast(`${p.name} ditambahkan`, 'ok');
  },
  toggleAvail: async el => {
    const p = prod(el.dataset.id);
    try { await api(`/api/products/${encodeURIComponent(p.id)}/availability`, { method: 'POST', body: { available: !p.available } }); p.available = p.available ? 0 : 1; drawGrid(); toast(p.available ? `${p.name} tersedia lagi` : `${p.name} ditandai habis`, 'ok'); }
    catch (e) { toast(e.message, 'bad'); }
  },
  qty: el => changeQty(el.dataset.key, parseInt(el.dataset.d, 10)),
  clearCart: async () => { if (await confirmSheet({ title: 'Kosongkan pesanan?', text: 'Semua item di pesanan ini akan dihapus.', ok: 'Ya, kosongkan', danger: true })) { state.cart = []; saveCart(); drawCart(); } },
  openCart: () => { if (state.cart.length) state.cartSheet = openSheet({ title: 'Pesanan', body: cartInner(true), onClose: () => { state.cartSheet = null; } }); },
  checkout: checkoutSheet,
  sale: el => saleSheet(el.dataset.id).catch(e => toast(e.message, 'bad')),
  dayShift: el => { const t = todayWIB(), n = addDays(state.pesananDate || t, parseInt(el.dataset.d, 10)); state.pesananDate = n > t ? t : n; go('pesanan'); },
  preset: el => { state.rep.preset = el.dataset.p; go('laporan'); },
  applyRange: () => { state.rep.from = $('#rFrom').value; state.rep.to = $('#rTo').value; go('laporan'); },
  sub: el => { state.sub = el.dataset.s; $$('[data-act=sub]').forEach(b => b.classList.toggle('on', b === el)); SUBVIEWS[state.sub](); },
  mfilter: el => { state.mf = el.dataset.c; SUBVIEWS.menu(); },
  sfilter: el => { state.sf = el.dataset.c; SUBVIEWS.stok(); },
  addProduct: () => loadMods().then(() => productSheet(null)),
  editProduct: el => loadMods().then(() => productSheet(prod(el.dataset.id))),
  mejaMode: el => { ls.set('ks_mejamode', el.dataset.m); viewMeja(); },
  manageTables: () => { state.sub = 'meja'; go('kelola'); },
  moveTable: el => {
    const label = el.dataset.t, list = state.mejaData.orders.filter(o => o.table_label === label);
    const others = state.tablesAll.filter(t => t.active && t.label !== label);
    if (!others.length) return toast('Belum ada meja lain. Tambah meja di Kelola → Meja & QR.', 'bad');
    formSheet({ title: `Pindah / gabung ${label}`, intro: `Semua pesanan ${esc(label)} (${list.length}) dipindahkan ke meja tujuan. Bila meja tujuan sudah punya pesanan, semuanya digabung jadi satu bill.`, fields: [{ name: 'to', label: 'Pindah ke', type: 'select', options: others.map(t => [t.id, t.label]) }], submit: 'Pindahkan',
      onSubmit: async (v, f) => { await api('/api/orders/move', { method: 'POST', body: { order_ids: list.map(o => o.id), to_table_id: parseInt(v.to, 10) } }); f.close(); toast('Pesanan dipindahkan', 'ok'); viewMeja(); } });
  },
  qrisDelete: async () => { if (!await confirmSheet({ title: 'Hapus gambar QRIS?', text: 'Pelanggan tidak akan melihat tombol bayar QRIS lagi.', ok: 'Ya, hapus', danger: true })) return; try { await api('/api/settings/qris', { method: 'DELETE' }); toast('Gambar QRIS dihapus', 'ok'); SUBVIEWS.atur(); } catch (e) { toast(e.message, 'bad'); } },
  backupNow: async el => { el.disabled = true; try { await api('/api/admin/backups/run', { method: 'POST' }); toast('Cadangan dibuat', 'ok'); SUBVIEWS.atur(); } catch (e) { toast(e.message, 'bad'); el.disabled = false; } },
  quickPhoto: () => loadProducts(true).then(() => quickPhotoSheet()),
  soundToggle: () => { ls.set('ks_sound', ls.get('ks_sound') === '0' ? '1' : '0'); if (ls.get('ks_sound') !== '0') beep(); viewMeja(); },
  orderStatus: async el => { try { await api(`/api/orders/${encodeURIComponent(el.dataset.id)}/status`, { method: 'POST', body: { status: el.dataset.s } }); if (el.dataset.s === 'accepted') { const o = state.mejaData.orders.find(x => x.id === el.dataset.id); toast('Pesanan diterima. Cetak tiket dapur bila perlu.', 'ok'); } viewMeja(); pollOrders(); } catch (e) { toast(e.message, 'bad'); viewMeja(); } },
  orderReason: el => formSheet({ title: el.dataset.s === 'rejected' ? 'Tolak pesanan' : 'Batalkan pesanan', intro: 'Alasan akan terlihat oleh pelanggan di halaman pesannya.', fields: [{ name: 'reason', label: 'Alasan', maxlength: 160, placeholder: 'mis. menu habis / dapur tutup' }], submit: el.dataset.s === 'rejected' ? 'Tolak pesanan' : 'Batalkan pesanan', danger: true, onSubmit: async (v, f) => { if (!v.reason) throw new Error('Isi alasannya dulu.'); await api(`/api/orders/${encodeURIComponent(el.dataset.id)}/status`, { method: 'POST', body: { status: el.dataset.s, reason: v.reason } }); f.close(); viewMeja(); pollOrders(); } }),
  ticketOrder: el => { const o = state.mejaData.orders.find(x => x.id === el.dataset.id); if (o) printHTML(ticketHTML(ticketOf(o))); },
  callDone: async el => { try { await api(`/api/calls/${el.dataset.id}/done`, { method: 'POST' }); viewMeja(); pollOrders(); } catch (e) { toast(e.message, 'bad'); } },
  payTable: async el => {
    const list = state.mejaData.orders.filter(o => o.table_label === el.dataset.t && o.status !== 'pending');
    if (!state.shift) { toast('Buka kasir dulu (tab Kas).', 'bad'); return; }
    if (!list.length) return;
    checkoutSheet({ orders: list, sub: list.reduce((a, o) => a + o.subtotal, 0), label: el.dataset.t });
  },
  tableQR: el => tableQRSheet(state.tables.find(x => x.id === parseInt(el.dataset.id, 10))),
  printAllQR: () => printQR(state.tables.filter(x => x.active)),
  addTables: () => formSheet({ title: 'Tambah banyak meja', fields: [{ name: 'prefix', label: 'Awalan nama', value: 'Meja', maxlength: 20 }, { name: 'start', label: 'Mulai dari nomor', type: 'number', value: '1' }, { name: 'count', label: 'Jumlah meja', type: 'number', value: '10', hint: 'Contoh: awalan “Meja”, mulai 1, jumlah 10 → Meja 1 … Meja 10. Nama yang sudah ada dilewati.' }], submit: 'Buat meja', onSubmit: async (v, f) => { if (!/^\d+$/.test(v.count) || !/^\d+$/.test(v.start)) throw new Error('Isi nomor dan jumlah dengan angka.'); await api('/api/tables', { method: 'POST', body: { prefix: v.prefix, start: parseInt(v.start, 10), count: parseInt(v.count, 10) } }); f.close(); toast('Meja dibuat. Sekarang cetak QR-nya.', 'ok'); SUBVIEWS.meja(); } }),
  addTable: () => formSheet({ title: 'Tambah satu meja', fields: [{ name: 'label', label: 'Nama meja', maxlength: 30, placeholder: 'mis. Gazebo 1 / Teras' }], submit: 'Buat meja', onSubmit: async (v, f) => { if (!v.label) throw new Error('Nama meja wajib diisi.'); await api('/api/tables', { method: 'POST', body: { label: v.label } }); f.close(); toast('Meja dibuat.', 'ok'); SUBVIEWS.meja(); } }),
  editStock: el => stockSheet(prod(el.dataset.id)),
  addGroup: () => formSheet({ title: 'Kelompok pilihan baru', fields: [{ name: 'name', label: 'Nama kelompok', placeholder: 'mis. Topping', maxlength: 60 }, { name: 'required', type: 'switch', text: 'Wajib dipilih (kasir harus memilih salah satu)', value: false }, { name: 'max', label: 'Maksimal pilihan', type: 'select', value: '1', options: [['1', '1 pilihan'], ['2', '2 pilihan'], ['3', '3 pilihan'], ['5', '5 pilihan']] }], submit: 'Buat kelompok', onSubmit: async (v, s) => { if (!v.name) throw new Error('Nama kelompok wajib diisi.'); await api('/api/modifiers/groups', { method: 'POST', body: { name: v.name, min_select: v.required ? 1 : 0, max_select: parseInt(v.max, 10) } }); s.close(); state.mods = null; toast('Kelompok dibuat. Tambahkan pilihannya.', 'ok'); SUBVIEWS.varian(); } }),
  editGroup: el => { const g = state.mods.groups.find(x => x.id === el.dataset.id); formSheet({ title: `Ubah ${g.name}`, fields: [{ name: 'name', label: 'Nama kelompok', value: g.name, maxlength: 60 }, { name: 'required', type: 'switch', text: 'Wajib dipilih', value: g.min_select > 0 }, { name: 'max', label: 'Maksimal pilihan', type: 'select', value: String(g.max_select), options: [['1', '1 pilihan'], ['2', '2 pilihan'], ['3', '3 pilihan'], ['5', '5 pilihan']] }], extra: '<hr style="border:0;border-top:1px solid var(--line2);margin:14px 0"><button class="btn danger block" data-del>Hapus kelompok ini</button>', onMount: s => s.q('[data-del]').onclick = async () => { if (!await confirmSheet({ title: `Hapus ${g.name}?`, text: 'Kelompok ini tidak akan muncul lagi di kasir. Riwayat penjualan tetap aman.', ok: 'Ya, hapus', danger: true })) return; await api('/api/modifiers/group/' + encodeURIComponent(g.id), { method: 'DELETE' }); s.close(); state.mods = null; SUBVIEWS.varian(); }, onSubmit: async (v, s) => { if (!v.name) throw new Error('Nama kelompok wajib diisi.'); await api('/api/modifiers/group/' + encodeURIComponent(g.id), { method: 'PUT', body: { name: v.name, min_select: v.required ? 1 : 0, max_select: parseInt(v.max, 10) } }); s.close(); state.mods = null; toast('Disimpan', 'ok'); SUBVIEWS.varian(); } }); },
  addOption: el => formSheet({ title: 'Pilihan baru', fields: [{ name: 'name', label: 'Nama pilihan', maxlength: 60 }, { name: 'delta', label: 'Tambahan harga (Rp)', type: 'smoney', value: 0, hint: 'Kosongkan / 0 bila gratis. Isi dengan minus (mis. -4000) untuk potongan, seperti “tanpa nasi”.' }], onSubmit: async (v, s) => { if (!v.name) throw new Error('Nama pilihan wajib diisi.'); await api('/api/modifiers/options', { method: 'POST', body: { group_id: el.dataset.id, name: v.name, price_delta: v.delta || 0 } }); s.close(); state.mods = null; toast('Pilihan ditambahkan', 'ok'); SUBVIEWS.varian(); } }),
  editOption: el => { const o = state.mods.groups.find(g => g.id === el.dataset.g).options.find(x => x.id === el.dataset.id); formSheet({ title: `Ubah ${o.name}`, fields: [{ name: 'name', label: 'Nama pilihan', value: o.name, maxlength: 60 }, { name: 'delta', label: 'Tambahan harga (Rp)', type: 'smoney', value: o.price_delta, hint: 'Boleh minus (mis. -4000) untuk potongan.' }], extra: '<hr style="border:0;border-top:1px solid var(--line2);margin:14px 0"><button class="btn danger block" data-del>Hapus pilihan ini</button>', onMount: s => s.q('[data-del]').onclick = async () => { await api('/api/modifiers/option/' + encodeURIComponent(o.id), { method: 'DELETE' }); s.close(); state.mods = null; toast('Pilihan dihapus', 'ok'); SUBVIEWS.varian(); }, onSubmit: async (v, s) => { if (!v.name) throw new Error('Nama pilihan wajib diisi.'); await api('/api/modifiers/option/' + encodeURIComponent(o.id), { method: 'PUT', body: { name: v.name, price_delta: v.delta || 0 } }); s.close(); state.mods = null; toast('Disimpan', 'ok'); SUBVIEWS.varian(); } }); },
  toggleCat: async el => {
    const k = el.dataset.k, g = el.dataset.g, cur = new Set(state.mods.categories[k] || []);
    cur.has(g) ? cur.delete(g) : cur.add(g);
    try { await api('/api/modifiers/category/' + encodeURIComponent(k), { method: 'PUT', body: { group_ids: [...cur] } }); state.mods.categories[k] = [...cur]; el.classList.toggle('on', cur.has(g)); }
    catch (e) { toast(e.message, 'bad'); }
  },
  addUser: () => formSheet({ title: 'Tambah anggota tim', fields: [{ name: 'name', label: 'Nama', maxlength: 40 }, { name: 'role', label: 'Peran', type: 'seg', value: 'kasir', options: [['kasir', 'Kasir'], ['owner', 'Pemilik']] }, { name: 'pin', label: 'PIN (kasir 4–8 angka, pemilik 6–8 angka)', type: 'pin' }], onSubmit: async (v, s) => { if (!v.name) throw new Error('Nama wajib diisi.'); await api('/api/users', { method: 'POST', body: v }); s.close(); toast('Anggota ditambahkan', 'ok'); SUBVIEWS.tim(); } }),
  editUser: el => { const u = state.users.find(x => x.id === parseInt(el.dataset.id, 10)); formSheet({ title: `Ubah ${u.name}`, fields: [{ name: 'name', label: 'Nama', value: u.name, maxlength: 40 }, { name: 'role', label: 'Peran', type: 'seg', value: u.role, options: [['kasir', 'Kasir'], ['owner', 'Pemilik']] }, { name: 'pin', label: 'PIN baru (kosongkan bila tidak diganti)', type: 'pin' }, { name: 'active', type: 'switch', text: 'Akun aktif (bisa masuk)', value: !!u.active }], onSubmit: async (v, s) => { const body = { name: v.name, role: v.role, active: v.active }; if (v.pin) body.pin = v.pin; await api('/api/users/' + u.id, { method: 'PUT', body }); s.close(); toast('Disimpan', 'ok'); SUBVIEWS.tim(); } }); },
  saveSet: async el => {
    const grp = el.dataset.grp, keys = SET_GROUPS[grp], root = el.closest('.card'), body = {};
    keys.forEach(k => { const seg = $(`[data-seg="${k}"]`, root); body[k] = seg ? seg.dataset.value : $(`[name="${k}"]`, root).value.trim(); });
    const box = $('#' + { info: 'e1', tax: 'e2', disc: 'e3' }[grp]);
    try { const r = await api('/api/settings', { method: 'PUT', body }); state.settings = r.settings; box.innerHTML = ''; toast('Pengaturan disimpan', 'ok'); }
    catch (e) { box.innerHTML = `<div class="notice bad" style="margin-bottom:12px">${esc(e.message)}</div>`; }
  },
  changePin: () => formSheet({ title: 'Ganti PIN saya', fields: [{ name: 'old', label: 'PIN lama', type: 'pin' }, { name: 'n1', label: 'PIN baru', type: 'pin' }, { name: 'n2', label: 'Ulangi PIN baru', type: 'pin' }], onSubmit: async (v, s) => { if (v.n1 !== v.n2) throw new Error('PIN baru dan ulangannya tidak sama.'); await api('/api/auth/pin', { method: 'POST', body: { old_pin: v.old, new_pin: v.n1 } }); s.close(); toast('PIN diganti', 'ok'); } }),
  audit: async () => { try { const d = await api('/api/audit'); openSheet({ title: 'Riwayat aktivitas', wide: true, body: `<div class="tablewrap"><table><thead><tr><th>Waktu</th><th>Siapa</th><th>Apa</th></tr></thead><tbody>${d.items.map(a => `<tr><td class="nowrap small">${esc(fmtDateTime(a.at))}</td><td>${esc(a.user_name)}</td><td><b>${esc(a.action.replace(/_/g, ' '))}</b><div class="small muted">${esc(a.detail)}</div></td></tr>`).join('')}</tbody></table></div>` }); } catch (e) { toast(e.message, 'bad'); } },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act]; if (fn) { e.preventDefault(); Promise.resolve(fn(el, e)).catch(err => toast(err.message, 'bad')); }
});
document.addEventListener('change', async e => {
  if (e.target.id !== 'qrisFile' || !e.target.files[0]) return;
  try { const data = await toJpegFull(e.target.files[0]); await api('/api/settings/qris', { method: 'POST', body: { image: data } }); toast('Gambar QRIS tersimpan', 'ok'); SUBVIEWS.atur(); }
  catch (err) { toast(err.message || 'Gambar tidak bisa diproses.', 'bad'); }
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.tile[data-act]')) { e.preventDefault(); e.target.click(); }
});

/* ============================== mulai ============================== */
async function boot() {
  try {
    const s = await api('/api/auth/status');
    if (s.setup_required) return setupScreen();
    if (!s.user) { state.staff = s.staff || []; return loginScreen(); }
    Object.assign(state, { me: s.user, settings: s.settings, methods: s.payment_methods, orderTypes: s.order_types });
    state.tanpaLogin = !!s.tanpa_login;
    state.products = []; state.mods = null;
    await loadShift();
    shell();
    const saved = ls.get('ks_view');
    const ok = navItems().map(n => n[0]);
    await go(ok.includes(saved) ? saved : (isOwner() ? 'home' : 'kasir'));
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
    flushQueue();
    sumPrev = null; pollOrders(); clearInterval(state._poll); state._poll = setInterval(pollOrders, 6000); clearInterval(state._tick); state._tick = setInterval(() => { if (state.view === 'meja' && mejaMode() === 'dapur' && !state.sheets.length) viewMeja().catch(() => { }); }, 30000);
  } catch (e) {
    $('#app').innerHTML = `<div class="auth"><div class="card"><h2>Tidak bisa memuat</h2><div class="notice bad" style="margin:12px 0">${esc(e.message)}</div><button class="btn big block" data-act="reload">Coba lagi</button></div></div>`;
  }
}
boot();
