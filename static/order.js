'use strict';
/* Halaman pesan pelanggan (scan QR meja). Tanpa pustaka luar. Harga selalu dihitung ulang oleh server. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('id-ID');
const rp = n => (n < 0 ? '−Rp' : 'Rp') + nf.format(Math.abs(n));
const signed = n => (n > 0 ? '+' : '−') + rp(Math.abs(n));
const TOKEN = (location.pathname.match(/^\/m\/([A-Za-z0-9_-]+)/) || [])[1] || '';
const KEY = 'ks_' + TOKEN;
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* abaikan */ } },
};
const st = { items: [], settings: {}, table: '', cat: 'Semua', q: '', cart: [], ids: [], orders: [], sheet: null, reqId: null, busy: false, seen: {} };
const prod = id => st.items.find(p => p.id === id);
const imgSrc = k => !k || k === 'none' ? '' : k.startsWith('up-') ? `/media/${k}.jpg` : `/static/images/${k}.jpg`;
const photo = (k, cls) => k && k !== 'none' ? `<img class="${cls}" src="${imgSrc(k)}" alt="" loading="lazy">` : `<div class="${cls} none"><img src="/static/images/logo-badge.png" alt="" style="width:${cls === 'hero' ? 96 : 56}px;height:${cls === 'hero' ? 96 : 56}px;border-radius:50%;opacity:.35"></div>`;

async function api(path, body) {
  let r;
  try { r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new Error('Tidak ada koneksi internet. Coba lagi sebentar lagi.'); }
  let d = {}; try { d = await r.json(); } catch { /* bukan JSON */ }
  if (!r.ok) throw Object.assign(new Error(d.error || `Gagal (${r.status}).`), { status: r.status });
  return d;
}
let toastT;
function toast(m, kind = '') { $('.toast')?.remove(); const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = m; t.setAttribute('role', 'status'); document.body.appendChild(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3000); }

/* ---------- sheet ---------- */
function openSheet(title, body, footer, onMount) {
  closeSheet();
  const s = document.createElement('div'); s.className = 'scrim';
  s.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-h"><h3>${esc(title)}</h3><button class="x" data-x aria-label="Tutup">×</button></div><div class="sheet-b">${body}</div>${footer ? `<div class="sheet-f">${footer}</div>` : ''}</div>`;
  document.body.appendChild(s);
  s.addEventListener('mousedown', e => { if (e.target === s) closeSheet(); });
  $('[data-x]', s).onclick = closeSheet;
  st.sheet = { el: s, kind: title };
  onMount && onMount(s);
  return s;
}
function closeSheet() { if (st.sheet) { st.sheet.el.remove(); st.sheet = null; } }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

/* ---------- keranjang ---------- */
const cartKey = (pid, opts) => pid + '|' + opts.map(o => o.id).sort().join(',');
const unit = l => (prod(l.pid)?.price || 0) + l.opts.reduce((s, o) => s + o.delta, 0);
const subtotal = () => st.cart.reduce((s, l) => s + unit(l) * l.qty, 0);
const count = () => st.cart.reduce((s, l) => s + l.qty, 0);
const saveCart = () => ls.set(KEY + '_cart', JSON.stringify(st.cart));
const saveIds = () => ls.set(KEY + '_orders', JSON.stringify(st.ids.slice(0, 10)));
function add(p, opts, qty) {
  const key = cartKey(p.id, opts), ex = st.cart.find(l => l.key === key);
  if (ex) ex.qty = Math.min(20, ex.qty + qty); else st.cart.push({ key, pid: p.id, opts, qty });
  st.reqId = null; saveCart(); drawBar();
}
const toBp = s => Math.round(parseFloat(String(s ?? '0').replace(',', '.') || '0') * 100);
const pctOf = (x, bp) => Math.floor((x * bp + 5000) / 10000);
function estimate(sub) {
  const s = st.settings, svc = pctOf(sub, toBp(s.service_percent)), tax = pctOf(sub + svc, toBp(s.tax_percent));
  const raw = sub + svc + tax, step = parseInt(s.rounding, 10) || 0;
  let total = raw; if (step) { const r = Math.floor((raw + Math.floor(step / 2)) / step) * step; if (r > 0) total = r; }
  return { sub, svc, tax, round: total - raw, total };
}
const sumHTML = sub => {
  const e = estimate(sub), s = st.settings, row = (a, b, c = '') => `<div class="r ${c}"><span>${a}</span><span>${b}</span></div>`;
  return `<div class="sum">${row('Subtotal', rp(e.sub))}${e.svc ? row(`Biaya layanan ${esc(s.service_percent)}%`, rp(e.svc)) : ''}${e.tax ? row(`Pajak ${esc(s.tax_percent)}%`, rp(e.tax)) : ''}${e.round ? row('Pembulatan', rp(e.round)) : ''}${row('Perkiraan total', rp(e.total), 'total')}</div>`;
};

/* ---------- tampilan utama ---------- */
function shell() {
  $('#app').innerHTML = `<header class="top"><img src="/static/images/logo-badge.png" alt="Kopi Sawah"><div class="t"><b>${esc(st.settings.outlet_name || 'Kopi Sawah')}</b><span class="sub">Anda duduk di <b style="display:inline">${esc(st.table)}</b></span></div><button class="btn" data-act="status" aria-label="Lihat status pesanan">Pesanan saya<span class="badge hidden" id="badge">0</span></button></header>
    <div class="tools"><input class="search" id="q" type="search" placeholder="🔍  Cari menu…" autocomplete="off" aria-label="Cari menu"><div class="cats" id="cats"></div></div>
    <main id="list"></main><div class="foot">${esc(st.settings.outlet_address || '')}<br>${esc(st.settings.outlet_contact || '')}<br>Pembayaran dilakukan di kasir.</div><div class="bar" id="bar"></div>`;
  $('#q').oninput = e => { st.q = e.target.value; drawList(); };
  drawCats(); drawList(); drawBar(); drawBadge();
}
function drawCats() {
  const cats = ['Semua', ...new Set(st.items.map(i => i.category))];
  $('#cats').innerHTML = cats.map(c => `<button data-act="cat" data-c="${esc(c)}" class="${st.cat === c ? 'on' : ''}">${esc(c)}</button>`).join('');
}
function drawList() {
  const q = st.q.trim().toLowerCase();
  const list = st.items.filter(i => (st.cat === 'Semua' || i.category === st.cat) && (!q || `${i.name} ${i.category} ${i.description}`.toLowerCase().includes(q)));
  let html = '', last = '';
  for (const i of list) {
    if (st.cat === 'Semua' && i.category !== last) { html += `<h2 class="cat">${esc(i.category)}</h2>`; last = i.category; }
    html += `<button class="item ${i.sold_out ? 'off' : ''}" data-act="item" data-id="${esc(i.id)}">${photo(i.image_key, 'ph')}
      <div class="in"><span class="nm">${i.featured ? '⭐ ' : ''}${esc(i.name)}${i.variant ? ` <span class="muted small">(${esc(i.variant)})</span>` : ''}</span>
      ${i.description ? `<span class="ds">${esc(i.description)}</span>` : ''}
      <span class="pr"><span>${rp(i.price)}</span>${i.sold_out ? '<span class="pill bad">Habis</span>' : '<span class="add" aria-hidden="true" style="display:grid;place-items:center">+</span>'}</span></div></button>`;
  }
  $('#list').innerHTML = html || '<div class="empty">Menu tidak ditemukan. Coba kata lain.</div>';
}
function drawBar() {
  const b = $('#bar'); if (!b) return;
  b.innerHTML = `<div class="grow"><div class="small muted">${count()} item</div><b>${rp(subtotal())}</b></div><button class="btn gold big" data-act="cart" ${count() ? '' : 'disabled'}>Lihat pesanan</button>`;
}
function drawBadge() {
  const live = st.orders.filter(o => ['pending', 'accepted', 'ready'].includes(o.status)).length;
  const b = $('#badge'); if (!b) return; b.textContent = live; b.classList.toggle('hidden', !live);
}

/* ---------- detail menu & pilihan ---------- */
function itemSheet(p) {
  const picked = new Map(); let qty = 1;
  const chosen = () => p.groups.flatMap(g => [...(picked.get(g.id) || [])].map(id => { const o = g.options.find(z => z.id === id); return { id: o.id, name: o.name, delta: o.price_delta, group: g.name }; }));
  const lacking = () => p.groups.find(g => (picked.get(g.id)?.size || 0) < g.min_select);
  const draw = s => {
    const extra = chosen().reduce((a, o) => a + o.delta, 0), miss = lacking();
    $('.sheet-b', s).innerHTML = `${photo(p.image_key, 'hero')}${p.description ? `<p class="muted" style="margin:0 0 6px">${esc(p.description)}</p>` : ''}<b style="font-size:18px">${rp(p.price)}</b>` +
      p.groups.map(g => `<div class="group"><div class="h"><span>${esc(g.name)}</span><span class="small ${g.min_select > 0 && !(picked.get(g.id)?.size) ? 'pill gold' : 'muted'}">${g.min_select > 0 ? 'Wajib pilih' : 'Boleh dilewati'}${g.max_select > 1 ? ` · maks ${g.max_select}` : ''}</span></div>
        ${g.options.map(o => { const on = (picked.get(g.id) || new Set()).has(o.id); return `<button class="opt ${g.max_select > 1 ? 'multi' : ''} ${on ? 'on' : ''}" data-g="${esc(g.id)}" data-o="${esc(o.id)}"><span class="box"></span><span>${esc(o.name)}</span><span class="pl">${o.price_delta ? signed(o.price_delta) : ''}</span></button>`; }).join('')}</div>`).join('');
    $('.sheet-f', s).innerHTML = `<div class="step"><button data-q="-1" aria-label="Kurangi">−</button><b>${qty}</b><button data-q="1" aria-label="Tambah">+</button></div><button class="btn gold" data-add ${miss ? 'disabled' : ''}>${miss ? `Pilih ${esc(miss.name)} dulu` : `Tambah · ${rp((p.price + extra) * qty)}`}</button>`;
    $$('.opt', s).forEach(b => b.onclick = () => {
      const g = p.groups.find(x => x.id === b.dataset.g), id = b.dataset.o, set = picked.get(g.id) || new Set();
      if (g.max_select > 1) { if (set.has(id)) set.delete(id); else if (set.size < g.max_select) set.add(id); else toast(`${g.name}: maksimal ${g.max_select} pilihan`, 'bad'); }
      else if (set.has(id) && g.min_select === 0) set.clear(); else { set.clear(); set.add(id); }
      picked.set(g.id, set); draw(s);
    });
    $$('[data-q]', s).forEach(b => b.onclick = () => { qty = Math.min(20, Math.max(1, qty + parseInt(b.dataset.q, 10))); draw(s); });
    $('[data-add]', s).onclick = () => { add(p, chosen(), qty); closeSheet(); toast(`${p.name} ditambahkan`, 'ok'); };
  };
  openSheet(p.name, '', ' ', draw);
}

/* ---------- keranjang & kirim ---------- */
function cartSheet() {
  if (!count()) return;
  const draw = s => {
    $('.sheet-b', s).innerHTML = `<div id="err"></div>` + st.cart.map(l => `<div class="cl"><div class="info"><b>${esc(prod(l.pid)?.name || '?')}</b>${l.opts.length ? `<div class="op">${esc(optLabel(l.opts))}</div>` : ''}<div class="small muted">${rp(unit(l))} × ${l.qty} = <b>${rp(unit(l) * l.qty)}</b></div></div><div class="step"><button data-k="${esc(l.key)}" data-d="-1" aria-label="Kurangi">−</button><b>${l.qty}</b><button data-k="${esc(l.key)}" data-d="1" aria-label="Tambah">+</button></div></div>`).join('')
      + `<label class="lbl" for="nm">Nama Anda (opsional)</label><input class="field" id="nm" maxlength="30" autocomplete="off" placeholder="mis. Bu Sari" value="${esc(ls.get(KEY + '_name') || '')}">
      <label class="lbl" for="nt">Catatan untuk dapur (opsional)</label><textarea class="field" id="nt" maxlength="200" placeholder="mis. jangan terlalu pedas"></textarea>
      <div style="margin-top:12px">${sumHTML(subtotal())}</div>
      <div class="notice">Pesanan dikirim ke kasir untuk dikonfirmasi. <b>Pembayaran dilakukan di kasir.</b> Total akhir dihitung kasir.</div>`;
    $('.sheet-f', s).innerHTML = `<button class="btn ghost" data-x2>Tambah menu</button><button class="btn gold" data-send>Kirim pesanan</button>`;
    $$('[data-k]', s).forEach(b => b.onclick = () => { const nm = $('#nm', s).value, nt = $('#nt', s).value; const l = st.cart.find(x => x.key === b.dataset.k); l.qty += parseInt(b.dataset.d, 10); if (l.qty <= 0) st.cart = st.cart.filter(x => x !== l); if (l.qty > 20) l.qty = 20; st.reqId = null; saveCart(); drawBar(); if (!count()) return closeSheet(); draw(s); $('#nm', s).value = nm; $('#nt', s).value = nt; });
    $('[data-x2]', s).onclick = closeSheet;
    $('[data-send]', s).onclick = () => send(s);
  };
  openSheet('Pesanan Anda', '', ' ', draw);
}
const optLabel = opts => { const seen = {}; opts.forEach(o => { seen[o.name] = (seen[o.name] || 0) + 1; }); return opts.map(o => seen[o.name] > 1 ? `${o.group} ${o.name}` : o.name).join(' · '); };
async function send(s) {
  if (st.busy) return; st.busy = true;
  const btn = $('[data-send]', s); btn.disabled = true; btn.textContent = 'Mengirim…'; $('#err', s).innerHTML = '';
  if (!st.reqId) st.reqId = crypto.randomUUID ? crypto.randomUUID() : 'c-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const name = $('#nm', s).value.trim(); ls.set(KEY + '_name', name);
  try {
    const r = await api('/api/public/orders', { t: TOKEN, customer_name: name, note: $('#nt', s).value.trim(), request_id: st.reqId,
      items: st.cart.map(l => ({ product_id: l.pid, quantity: l.qty, modifiers: l.opts.map(o => ({ id: o.id })) })) });
    st.ids = [r.order.id, ...st.ids.filter(x => x !== r.order.id)]; saveIds();
    st.cart = []; st.reqId = null; saveCart(); drawBar();
    st.orders = [r.order, ...st.orders.filter(o => o.id !== r.order.id)]; drawBadge();
    closeSheet(); statusSheet(true);
  } catch (e) {
    st.busy = false; btn.disabled = false; btn.textContent = 'Kirim pesanan';
    $('#err', s).innerHTML = `<div class="notice bad">${esc(e.message)}</div>`;
    if (e.status === 409 || e.status === 404) st.reqId = null;
    return;
  }
  st.busy = false;
}

/* ---------- status pesanan ---------- */
const STEP = { pending: 1, accepted: 2, ready: 3, served: 4, paid: 4 };
const NOTE = { pending: ['gold', 'Menunggu konfirmasi kasir'], accepted: ['ok', 'Sedang diproses dapur'], ready: ['ok', 'Pesanan siap — segera diantar'], served: ['ok', 'Sudah disajikan. Selamat menikmati!'], paid: ['ok', 'Selesai — terima kasih 🙏'], rejected: ['bad', 'Maaf, pesanan tidak dapat diproses'], cancelled: ['bad', 'Pesanan dibatalkan'] };
function orderCard(o) {
  const [k, t] = NOTE[o.status] || ['', o.status], n = STEP[o.status] || 0, done = ['paid', 'rejected', 'cancelled'].includes(o.status);
  return `<div class="ord"><div class="hd"><b>${esc(o.id)}</b><span class="pill ${k}">${esc(t)}</span></div>
    ${n ? `<div class="steps" aria-hidden="true">${[1, 2, 3, 4].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>` : ''}
    ${o.reason && ['rejected', 'cancelled'].includes(o.status) ? `<div class="notice bad">${esc(o.reason)}</div>` : ''}
    <ul>${o.items.map(i => `<li>${i.quantity}× ${esc(i.name_snapshot)}${i.modifiers_summary ? `<div class="small muted">${esc(i.modifiers_summary)}</div>` : ''}</li>`).join('')}</ul>
    <div class="row small">Subtotal <b>${rp(o.subtotal)}</b>${o.customer_name ? ` · atas nama ${esc(o.customer_name)}` : ''}</div>
    ${o.status === 'pending' ? `<button class="btn danger sm" style="margin-top:8px" data-act="cancel" data-id="${esc(o.id)}">Batalkan pesanan</button>` : ''}
    ${done ? `<button class="btn ghost sm" style="margin-top:8px" data-act="hide" data-id="${esc(o.id)}">Sembunyikan</button>` : ''}</div>`;
}
async function refresh() {
  if (!st.ids.length) { st.orders = []; drawBadge(); return; }
  try {
    const r = await api(`/api/public/orders?t=${encodeURIComponent(TOKEN)}&ids=${encodeURIComponent(st.ids.join(','))}`);
    for (const o of r.orders) { const prev = st.seen[o.id]; if (prev && prev !== o.status && !st.sheet) toast(`${o.id}: ${(NOTE[o.status] || [0, o.status])[1]}`, o.status === 'rejected' ? 'bad' : 'ok'); st.seen[o.id] = o.status; }
    st.orders = r.orders.sort((a, b) => a.created_at < b.created_at ? 1 : -1); st.calls = r.calls || [];
    drawBadge(); if (st.sheet && st.sheet.kind === 'Pesanan saya') fillStatus(st.sheet.el);
  } catch { /* abaikan; coba lagi pada putaran berikutnya */ }
}
function fillStatus(s) {
  const pend = (k) => (st.calls || []).some(c => c.kind === k);
  $('.sheet-b', s).innerHTML = (st.orders.length ? st.orders.map(orderCard).join('') : '<div class="empty">Belum ada pesanan.<br>Pilih menu lalu kirim pesanan Anda.</div>')
    + (st.settings.qris_image && st.orders.some(x => ['accepted', 'ready', 'served'].includes(x.status)) ? `<button class="btn gold block" style="margin-bottom:10px" data-act="qris">💳 Bayar dengan QRIS</button>` : '')
    + `<div class="notice">Pembayaran dilakukan di kasir. Butuh bantuan?</div>
    <div class="row" style="display:flex;gap:8px"><button class="btn ghost" style="flex:1" data-act="call" data-k="waiter" ${pend('waiter') ? 'disabled' : ''}>${pend('waiter') ? '✓ Pelayan dipanggil' : '🙋 Panggil pelayan'}</button><button class="btn ghost" style="flex:1" data-act="call" data-k="bill" ${pend('bill') ? 'disabled' : ''}>${pend('bill') ? '✓ Bill diminta' : '🧾 Minta bill'}</button></div>`;
}
function statusSheet(fresh) {
  const s = openSheet('Pesanan saya', '', '<button class="btn ghost" data-x2>Pesan lagi</button>', s0 => { $('[data-x2]', s0).onclick = closeSheet; });
  fillStatus(s);
  if (fresh) $('.sheet-b', s).insertAdjacentHTML('afterbegin', '<div class="notice ok"><b>Pesanan terkirim ✓</b><br>Kasir akan mengonfirmasi sebentar lagi. Halaman ini akan menampilkan statusnya.</div>');
  refresh();
}

function qrisSheet() {
  const due = st.orders.filter(x => ['accepted', 'ready', 'served'].includes(x.status)).reduce((a, x) => a + x.subtotal, 0);
  openSheet('Bayar dengan QRIS', `<div class="center"><img src="${imgSrc(st.settings.qris_image)}" alt="QRIS toko" style="width:min(300px,100%);border:1px solid var(--line);border-radius:12px;background:#fff"></div>
    <div style="margin-top:12px">${sumHTML(due)}</div>
    <div class="notice"><b>Cara bayar:</b> scan QRIS di atas dengan aplikasi bank/e-wallet, masukkan jumlah sesuai total, lalu <b>tunjukkan bukti pembayaran ke kasir</b>. Pesanan dianggap lunas setelah kasir memeriksa.</div>`, '<button class="btn" data-x2>Tutup</button>', s0 => { $('[data-x2]', s0).onclick = closeSheet; });
}

/* ---------- aksi ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  const a = el.dataset.act;
  if (a === 'cat') { st.cat = el.dataset.c; drawCats(); drawList(); window.scrollTo(0, 0); }
  else if (a === 'item') { const p = prod(el.dataset.id); if (p.sold_out) return toast(`${p.name} sedang habis`, 'bad'); if (p.groups.length) itemSheet(p); else { add(p, [], 1); toast(`${p.name} ditambahkan`, 'ok'); } }
  else if (a === 'cart') cartSheet();
  else if (a === 'qris') qrisSheet();
  else if (a === 'status') statusSheet(false);
  else if (a === 'hide') { st.ids = st.ids.filter(x => x !== el.dataset.id); saveIds(); st.orders = st.orders.filter(o => o.id !== el.dataset.id); drawBadge(); fillStatus(st.sheet.el); }
  else if (a === 'cancel') { try { await api(`/api/public/orders/${encodeURIComponent(el.dataset.id)}/cancel`, { t: TOKEN }); toast('Pesanan dibatalkan', 'ok'); await refresh(); } catch (err) { toast(err.message, 'bad'); refresh(); } }
  else if (a === 'call') { try { await api('/api/public/call', { t: TOKEN, kind: el.dataset.k }); toast(el.dataset.k === 'bill' ? 'Bill diminta. Kasir segera datang.' : 'Pelayan dipanggil. Mohon tunggu sebentar.', 'ok'); await refresh(); } catch (err) { toast(err.message, 'bad'); } }
});

/* ---------- mulai ---------- */
(async function boot() {
  try {
    const m = await api('/api/public/menu?t=' + encodeURIComponent(TOKEN));
    Object.assign(st, { items: m.items, settings: m.settings, table: m.table.label });
    document.title = `${m.table.label} · ${m.settings.outlet_name || 'Kopi Sawah'}`;
    try { st.cart = (JSON.parse(ls.get(KEY + '_cart') || '[]')).filter(l => prod(l.pid) && l.qty > 0); } catch { st.cart = []; }
    try { st.ids = JSON.parse(ls.get(KEY + '_orders') || '[]').filter(x => typeof x === 'string'); } catch { st.ids = []; }
    shell(); refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  } catch (e) {
    $('#app').innerHTML = `<div class="err"><div><img src="/static/images/logo-badge.png" alt=""><h2>${e.status === 404 ? 'QR ini tidak dikenali' : 'Menu belum bisa dibuka'}</h2><p class="muted">${esc(e.status === 404 ? 'Kode meja tidak berlaku. Silakan minta bantuan pelayan untuk memesan.' : e.message)}</p><button class="btn" data-reload>Coba lagi</button></div></div>`;
    $('[data-reload]').onclick = () => location.reload();
  }
})();
