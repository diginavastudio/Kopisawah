#!/usr/bin/env python3
"""Kopi Sawah beta app; keep its listener on loopback behind the Hestia proxy."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
CATALOG = DATA / "catalog.json"
DB_PATH = Path(os.environ.get("KOPI_SAWAH_DB", DATA / "kopi-sawah-dev.sqlite3"))
PORT = int(os.environ.get("KOPI_SAWAH_PORT", "8791"))
REQUIRE_ORIGIN = os.environ.get("KOPI_SAWAH_REQUIRE_ORIGIN", "0") == "1"
TZ_NAME = os.environ.get("KOPI_SAWAH_TZ", "Asia/Jakarta").strip() or "Asia/Jakarta"
try:
    TZ = ZoneInfo(TZ_NAME)
except Exception:
    TZ_NAME, TZ = "UTC", timezone.utc
REQUIRE_STOCK = os.environ.get("KOPI_SAWAH_REQUIRE_STOCK", "0") == "1"
WRITE_UNTIL_RAW = os.environ.get("KOPI_SAWAH_WRITE_UNTIL", "").strip()
VALID_IMAGE_KEYS = {p.stem for p in (STATIC / "images").glob("*.jpg")}


def write_window_expired():
    if not WRITE_UNTIL_RAW:
        return True
    try:
        cutoff = datetime.fromisoformat(WRITE_UNTIL_RAW.replace("Z", "+00:00"))
        if cutoff.tzinfo is None:
            return True
        return datetime.now(timezone.utc) >= cutoff.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return True


def now():
    return datetime.now(TZ).isoformat(timespec="seconds")


def business_date(stamp=None):
    if stamp is None:
        return datetime.now(TZ).date().isoformat()
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone(TZ).date().isoformat()
    except (ValueError, OverflowError):
        return str(stamp)[:10]


@contextmanager
def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


VARIAN_SEED = [
    ("suhu", "Suhu", 1, 1, [("Es", 0), ("Panas", 0)]),
    ("gula", "Level Gula", 1, 1, [("Normal", 0), ("Less Sugar", 0), ("No Sugar", 0)]),
    ("es", "Level Es", 1, 1, [("Normal", 0), ("Sedikit", 0), ("Tanpa Es", 0)]),
    ("ukuran", "Ukuran", 1, 1, [("Regular", 0), ("Large", 5000)]),
    ("shot", "Extra Shot", 0, 1, [("Tanpa Extra Shot", 0), ("Extra Shot", 5000)]),
    ("susu", "Jenis Susu", 1, 1, [("Susu UHT", 0), ("Oat Milk", 5000)]),
    ("sambal", "Sambal Tambahan", 0, 2, [("Sambal Bawang", 4000), ("Sambal Terasi", 4000)]),
]
VARIAN_KATEGORI = {
    "Kopi": ["suhu", "gula", "es", "ukuran", "shot", "susu"],
    "Minuman": ["suhu", "gula", "es", "ukuran"],
    "Wedangan": ["suhu", "gula"],
    "Makanan": ["sambal"],
    "Lauk": ["sambal"],
    "Paket": ["sambal"],
    "Camilan": ["sambal"],
}


def seed_modifiers(c):
    if c.execute("SELECT COUNT(*) FROM modifier_groups").fetchone()[0]:
        return
    for order, (gid, gname, lo, hi, options) in enumerate(VARIAN_SEED):
        c.execute("INSERT INTO modifier_groups(id,name,min_select,max_select,sort,active) VALUES(?,?,?,?,?,1)",
                  (gid, gname, lo, hi, order))
        for i, (name, delta) in enumerate(options):
            c.execute("INSERT INTO modifiers(id,group_id,name,price_delta,sort,active) VALUES(?,?,?,?,?,1)",
                      (f"{gid}-{i+1}", gid, name, delta, i))
    for category, groups in VARIAN_KATEGORI.items():
        for i, gid in enumerate(groups):
            c.execute("INSERT OR IGNORE INTO category_modifier_groups(category,group_id,sort) VALUES(?,?,?)",
                      (category, gid, i))


def variant_groups_for(c, category):
    rows = c.execute("""SELECT g.* FROM category_modifier_groups cm
                        JOIN modifier_groups g ON g.id=cm.group_id
                        WHERE cm.category=? AND g.active=1 ORDER BY cm.sort,g.sort""", (category,)).fetchall()
    return [row_dict(r) for r in rows]


def variant_options(c, group_id):
    rows = c.execute("SELECT * FROM modifiers WHERE group_id=? AND active=1 ORDER BY sort,id", (group_id,)).fetchall()
    return [row_dict(r) for r in rows]


def resolve_item_variants(c, product, chosen):
    """Validasi pilihan varian sebuah item; kembalikan (delta, ringkasan, [, baris])."""
    groups = variant_groups_for(c, product["category"])
    allowed = {g["id"]: g for g in groups}
    picked = {}
    for raw in chosen or []:
        oid = str(raw.get("id") if isinstance(raw, dict) else raw)
        row = c.execute("""SELECT m.id,m.group_id,m.name,m.price_delta FROM modifiers m
                           JOIN modifier_groups g ON g.id=m.group_id
                           WHERE m.id=? AND m.active=1 AND g.active=1""", (oid,)).fetchone()
        if not row:
            raise ValueError("Pilihan varian tidak dikenal.")
        if row["group_id"] not in allowed:
            raise ValueError(f"Varian {row['name']} tidak tersedia untuk {product['name']}.")
        picked.setdefault(row["group_id"], []).append(row_dict(row))
    delta = 0
    lines = []
    for gid, g in allowed.items():
        items = picked.get(gid, [])
        if len(items) < g["min_select"]:
            raise ValueError(f"Pilih {g['name']} untuk {product['name']}.")
        if len(items) > g["max_select"]:
            raise ValueError(f"{g['name']} maksimal {g['max_select']} pilihan.")
        for it in items:
            delta += it["price_delta"]
            lines.append({"group_name": g["name"], "modifier_name": it["name"], "price_delta": it["price_delta"]})
    summary = ", ".join(f"{l['modifier_name']}" + (f" (+{l['price_delta']//1000}rb)" if l["price_delta"] else "") for l in lines)
    return delta, summary, lines


def open_session(c):
    row = c.execute("SELECT * FROM cash_sessions WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1").fetchone()
    return row_dict(row) if row else None


def session_row(c, session_id):
    return row_dict(c.execute("SELECT * FROM cash_sessions WHERE id=?", (session_id,)).fetchone())


def session_summary(c, session):
    if not session:
        return None
    rincian = [row_dict(r) for r in c.execute(
        """SELECT payment_method AS metode, COUNT(*) AS jumlah, COALESCE(SUM(total_amount),0) AS total
           FROM sales WHERE session_id=? GROUP BY payment_method ORDER BY total DESC""",
        (session["id"],)).fetchall()]
    tunai = sum(r["total"] for r in rincian
                if "tunai" in r["metode"].lower() or "cash" in r["metode"].lower())
    total = sum(r["total"] for r in rincian)
    return {"session": session, "rincian": rincian, "jumlah_transaksi": sum(r["jumlah"] for r in rincian),
            "total_penjualan": total, "tunai": tunai, "non_tunai": total - tunai,
            "kas_awal": session["opening_cash"], "kas_seharusnya": session["opening_cash"] + tunai}


def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            variant TEXT NOT NULL DEFAULT '',
            price INTEGER NULL CHECK(price IS NULL OR price > 0),
            stock_on_hand INTEGER NULL CHECK(stock_on_hand IS NULL OR stock_on_hand >= 0),
            reorder_level INTEGER NULL CHECK(reorder_level IS NULL OR reorder_level >= 0),
            image_key TEXT NOT NULL DEFAULT 'snack',
            draft INTEGER NOT NULL DEFAULT 1,
            active INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sales (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            total_amount INTEGER NOT NULL CHECK(total_amount >= 0),
            payment_method TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'recorded_manual',
            note TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS sale_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sale_id TEXT NOT NULL REFERENCES sales(id),
            product_id TEXT NOT NULL REFERENCES products(id),
            name_snapshot TEXT NOT NULL,
            variant_snapshot TEXT NOT NULL,
            unit_price INTEGER NOT NULL CHECK(unit_price > 0),
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            line_total INTEGER NOT NULL CHECK(line_total > 0)
        );
        CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL REFERENCES products(id),
            movement_type TEXT NOT NULL,
            quantity_change INTEGER NOT NULL,
            resulting_quantity INTEGER NOT NULL CHECK(resulting_quantity >= 0),
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS modifier_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            min_select INTEGER NOT NULL DEFAULT 0 CHECK(min_select >= 0),
            max_select INTEGER NOT NULL DEFAULT 1 CHECK(max_select >= 1),
            sort INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS modifiers (
            id TEXT PRIMARY KEY,
            group_id TEXT NOT NULL REFERENCES modifier_groups(id),
            name TEXT NOT NULL,
            price_delta INTEGER NOT NULL DEFAULT 0 CHECK(price_delta >= 0),
            sort INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS category_modifier_groups (
            category TEXT NOT NULL,
            group_id TEXT NOT NULL REFERENCES modifier_groups(id),
            sort INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (category, group_id)
        );
        CREATE TABLE IF NOT EXISTS sale_item_modifiers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
            group_name TEXT NOT NULL,
            modifier_name TEXT NOT NULL,
            price_delta INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS cash_sessions (
            id TEXT PRIMARY KEY,
            opened_at TEXT NOT NULL,
            business_date TEXT NOT NULL,
            opening_cash INTEGER NOT NULL DEFAULT 0 CHECK(opening_cash >= 0),
            closed_at TEXT,
            counted_cash INTEGER,
            expected_cash INTEGER,
            difference INTEGER,
            total_sales INTEGER,
            total_transactions INTEGER,
            note TEXT NOT NULL DEFAULT '',
            close_note TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_cash_opened ON cash_sessions(opened_at);
        CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
        CREATE INDEX IF NOT EXISTS idx_movements_product_time ON stock_movements(product_id, created_at);
        """)
        sales_cols = {r["name"] for r in c.execute("PRAGMA table_info(sales)")}
        if "business_date" not in sales_cols:
            c.execute("ALTER TABLE sales ADD COLUMN business_date TEXT NOT NULL DEFAULT ''")
        if "request_id" not in sales_cols:
            c.execute("ALTER TABLE sales ADD COLUMN request_id TEXT")
        if "session_id" not in sales_cols:
            c.execute("ALTER TABLE sales ADD COLUMN session_id TEXT")
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_request ON sales(request_id) WHERE request_id IS NOT NULL")
        item_cols = {r["name"] for r in c.execute("PRAGMA table_info(sale_items)")}
        if "modifiers_summary" not in item_cols:
            c.execute("ALTER TABLE sale_items ADD COLUMN modifiers_summary TEXT NOT NULL DEFAULT ''")
        product_cols = {r["name"] for r in c.execute("PRAGMA table_info(products)")}
        if "stock_tracked" not in product_cols:
            c.execute("ALTER TABLE products ADD COLUMN stock_tracked INTEGER NOT NULL DEFAULT 0")
        for stale in c.execute("SELECT id, created_at FROM sales WHERE business_date=''").fetchall():
            c.execute("UPDATE sales SET business_date=? WHERE id=?", (business_date(stale["created_at"]), stale["id"]))
        seed_modifiers(c)
        count = c.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        if count == 0 and CATALOG.exists():
            rows = json.loads(CATALOG.read_text(encoding="utf-8"))
            for p in rows:
                image_key = p.get("image_key") if p.get("image_key") in VALID_IMAGE_KEYS else "snack"
                c.execute("""INSERT INTO products
                    (id,name,category,variant,price,stock_on_hand,reorder_level,image_key,draft,active,updated_at)
                    VALUES (?,?,?,?,?,NULL,NULL,?,1,1,?)""",
                    (str(p["id"]), p["name"], p.get("category", "Lainnya"), p.get("variant", ""),
                     p.get("price"), image_key, now()))


def row_dict(row):
    return dict(row) if row is not None else None


def to_int(value, label, minimum=0, allow_none=False):
    if value is None and allow_none:
        return None
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label} harus berupa bilangan bulat minimal {minimum}.")
    return value


class Handler(BaseHTTPRequestHandler):
    server_version = "KopiSawahLocal/0.1"

    def log_message(self, fmt, *args):
        # Keep local testing logs concise; do not log request bodies.
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("Isi permintaan terlalu besar.")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            raise ValueError("Format data tidak valid.") from exc
        if not isinstance(value, dict):
            raise ValueError("Isi permintaan harus berupa objek data.")
        return value

    def reject_cross_origin_write(self):
        if not REQUIRE_ORIGIN:
            return False
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "").strip().lower()
        scheme = self.headers.get("X-Forwarded-Proto", "http").split(",", 1)[0].strip().lower()
        parsed = urlparse(origin or "")
        if (not origin or not host or parsed.scheme.lower() != scheme
                or parsed.netloc.lower() != host or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            self.send_json(403, {"error": "Asal permintaan tidak diizinkan."})
            return True
        return False

    def reject_expired_write(self):
        if not write_window_expired():
            return False
        self.send_json(403, {"error": "Masa simpan data uji sudah berakhir. Data tetap dapat dibaca."})
        return True

    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        try:
            if path == "/api/health":
                with db() as c:
                    counts = {"products": c.execute("SELECT COUNT(*) FROM products").fetchone()[0],
                              "sales": c.execute("SELECT COUNT(*) FROM sales").fetchone()[0],
                              "untracked_stock": c.execute(
                                  "SELECT COUNT(*) FROM products WHERE active=1 AND stock_tracked=0").fetchone()[0]}
                return self.send_json(200, {"ok": True, "mode": "local-development", "counts": counts,
                                            "timezone": TZ_NAME, "business_date": business_date(),
                                            "require_stock": REQUIRE_STOCK})
            if path == "/api/products":
                qs = parse_qs(url.query)
                q = (qs.get("q", [""])[0] or "").strip()
                category = (qs.get("category", [""])[0] or "").strip()
                sql = "SELECT * FROM products WHERE active=1"
                args = []
                if q:
                    sql += " AND (name LIKE ? OR category LIKE ? OR variant LIKE ?)"
                    args.extend([f"%{q}%"] * 3)
                if category and category != "Semua":
                    sql += " AND category=?"
                    args.append(category)
                sql += " ORDER BY category,name,variant,id"
                with db() as c:
                    rows = [row_dict(r) for r in c.execute(sql, args).fetchall()]
                return self.send_json(200, {"items": rows})
            if path == "/api/modifiers":
                with db() as c:
                    groups = [row_dict(r) for r in c.execute(
                        "SELECT * FROM modifier_groups WHERE active=1 ORDER BY sort,name").fetchall()]
                    for g in groups:
                        g["options"] = variant_options(c, g["id"])
                    assignments = {}
                    for r in c.execute("SELECT category,group_id FROM category_modifier_groups ORDER BY sort,rowid"):
                        assignments.setdefault(r["category"], []).append(r["group_id"])
                    cats = [r[0] for r in c.execute(
                        "SELECT DISTINCT category FROM products WHERE active=1 ORDER BY category")]
                return self.send_json(200, {"groups": groups, "categories": assignments, "product_categories": cats})
            if path == "/api/cash/current":
                with db() as c:
                    sesi = open_session(c)
                    ringkas = session_summary(c, sesi)
                    hari = c.execute("SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) t FROM sales WHERE business_date=?",
                                     (business_date(),)).fetchone()
                    luar = c.execute("""SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) t FROM sales
                                        WHERE business_date=? AND (session_id IS NULL OR session_id<>?)""",
                                     (business_date(), sesi["id"] if sesi else "")).fetchone()
                return self.send_json(200, {"open": bool(sesi), "ringkas": ringkas,
                                            "hari_ini": {"jumlah": hari["n"], "total": hari["t"]},
                                            "di_luar_sesi": {"jumlah": luar["n"], "total": luar["t"]}})
            if path == "/api/cash/sessions":
                with db() as c:
                    rows = [row_dict(r) for r in c.execute(
                        "SELECT * FROM cash_sessions ORDER BY opened_at DESC LIMIT 40").fetchall()]
                return self.send_json(200, {"items": rows})
            if path == "/api/stock":
                with db() as c:
                    rows = [row_dict(r) for r in c.execute("""SELECT id,name,category,variant,stock_on_hand,
                        reorder_level,image_key,stock_tracked FROM products WHERE active=1 ORDER BY category,name,variant,id""").fetchall()]
                return self.send_json(200, {"items": rows})
            if path == "/api/sales":
                with db() as c:
                    sales = c.execute("SELECT * FROM sales ORDER BY created_at DESC LIMIT 200").fetchall()
                    result = []
                    for s in sales:
                        d = row_dict(s)
                        d["items"] = [row_dict(r) for r in c.execute("SELECT * FROM sale_items WHERE sale_id=? ORDER BY id", (s["id"],)).fetchall()]
                        for it in d["items"]:
                            it["modifiers"] = [row_dict(m) for m in c.execute(
                                "SELECT group_name,modifier_name,price_delta FROM sale_item_modifiers WHERE sale_item_id=? ORDER BY id",
                                (it["id"],)).fetchall()]
                        result.append(d)
                return self.send_json(200, {"items": result})
            if path.startswith("/api/cash/sessions/"):
                sid = unquote(path.rsplit("/", 1)[-1])
                with db() as c:
                    sesi = session_row(c, sid)
                    if not sesi:
                        return self.send_json(404, {"error": "Sesi kasir tidak ditemukan."})
                    ringkas = session_summary(c, sesi)
                return self.send_json(200, ringkas)
            if path.startswith("/api/sales/"):
                sid = unquote(path.rsplit("/", 1)[-1])
                with db() as c:
                    row = c.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone()
                    if not row:
                        return self.send_json(404, {"error": "Transaksi tidak ditemukan."})
                    data = row_dict(row)
                    data["items"] = [row_dict(r) for r in c.execute(
                        "SELECT * FROM sale_items WHERE sale_id=? ORDER BY id", (sid,)).fetchall()]
                    for it in data["items"]:
                        it["modifiers"] = [row_dict(m) for m in c.execute(
                            "SELECT group_name,modifier_name,price_delta FROM sale_item_modifiers WHERE sale_item_id=? ORDER BY id",
                            (it["id"],)).fetchall()]
                return self.send_json(200, {"item": data})
            if path == "/api/reports/summary":
                today = business_date()
                with db() as c:
                    day = c.execute("SELECT COUNT(*) n,COALESCE(SUM(total_amount),0) total FROM sales WHERE COALESCE(NULLIF(business_date,''),substr(created_at,1,10))=?", (today,)).fetchone()
                    low = c.execute("SELECT COUNT(*) FROM products WHERE active=1 AND stock_tracked=1 AND stock_on_hand IS NOT NULL AND reorder_level IS NOT NULL AND stock_on_hand<=reorder_level").fetchone()[0]
                    unknown = c.execute("SELECT COUNT(*) FROM products WHERE active=1 AND stock_tracked=0").fetchone()[0]
                    tracked = c.execute("SELECT COUNT(*) FROM products WHERE active=1 AND stock_tracked=1").fetchone()[0]
                    all_sales = c.execute("SELECT COUNT(*) FROM sales").fetchone()[0]
                    all_total = c.execute("SELECT COALESCE(SUM(total_amount),0) FROM sales").fetchone()[0]
                return self.send_json(200, {"today": today, "timezone": TZ_NAME, "require_stock": REQUIRE_STOCK,
                                           "today_transactions": day["n"], "today_total": day["total"],
                                           "low_stock": low, "unknown_stock": unknown, "tracked_stock": tracked,
                                           "all_transactions": all_sales, "all_total": all_total})
            if path == "/" or path == "/index.html":
                return self.serve_file(STATIC / "index.html")
            if path.startswith("/static/"):
                candidate = (STATIC / path.removeprefix("/static/")).resolve()
                if STATIC.resolve() not in candidate.parents or not candidate.is_file():
                    return self.send_json(404, {"error": "Berkas tidak ditemukan."})
                return self.serve_file(candidate)
            return self.send_json(404, {"error": "Rute tidak ditemukan."})
        except Exception as exc:
            return self.send_json(500, {"error": str(exc)})

    def serve_file(self, path):
        if not path.is_file():
            return self.send_json(404, {"error": "Berkas tidak ditemukan."})
        data = path.read_bytes()
        mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime + ("; charset=utf-8" if mime.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.reject_cross_origin_write():
            return
        if self.reject_expired_write():
            return
        path = urlparse(self.path).path
        try:
            data = self.body_json()
            if path == "/api/cash/open":
                kas = to_int(data.get("opening_cash", 0), "Kas awal", 0)
                catatan = str(data.get("note", "")).strip()[:160]
                with db() as c:
                    if open_session(c):
                        return self.send_json(409, {"error": "Kasir masih terbuka. Tutup dulu sesi yang berjalan."})
                    sid = "CS-" + uuid.uuid4().hex[:8].upper()
                    c.execute("INSERT INTO cash_sessions(id,opened_at,business_date,opening_cash,note) VALUES(?,?,?,?,?)",
                              (sid, now(), business_date(), kas, catatan))
                    row = session_row(c, sid)
                return self.send_json(201, {"session": row})
            if path == "/api/cash/close":
                hitung = to_int(data.get("counted_cash", 0), "Kas dihitung", 0)
                catatan = str(data.get("note", "")).strip()[:160]
                with db() as c:
                    c.execute("BEGIN IMMEDIATE")
                    sesi = open_session(c)
                    if not sesi:
                        return self.send_json(409, {"error": "Tidak ada kasir yang terbuka."})
                    ringkas = session_summary(c, sesi)
                    selisih = hitung - ringkas["kas_seharusnya"]
                    c.execute("""UPDATE cash_sessions SET closed_at=?,counted_cash=?,expected_cash=?,difference=?,
                                 total_sales=?,total_transactions=?,close_note=? WHERE id=?""",
                              (now(), hitung, ringkas["kas_seharusnya"], selisih, ringkas["total_penjualan"],
                               ringkas["jumlah_transaksi"], catatan, sesi["id"]))
                    ringkas["session"] = session_row(c, sesi["id"])
                return self.send_json(200, ringkas)
            if path == "/api/modifiers/groups":
                name = str(data.get("name", "")).strip()[:60]
                if not name:
                    return self.send_json(400, {"error": "Nama kelompok varian tidak boleh kosong."})
                lo = to_int(data.get("min_select", 0), "Wajib pilih minimal", 0)
                hi = to_int(data.get("max_select", 1), "Maksimal pilih", 1)
                if lo > hi:
                    return self.send_json(400, {"error": "Minimal pilih tidak boleh lebih besar dari maksimal."})
                gid = "g-" + uuid.uuid4().hex[:8]
                with db() as c:
                    order = c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM modifier_groups").fetchone()[0]
                    c.execute("INSERT INTO modifier_groups(id,name,min_select,max_select,sort,active) VALUES(?,?,?,?,?,1)",
                              (gid, name, lo, hi, order))
                    g = row_dict(c.execute("SELECT * FROM modifier_groups WHERE id=?", (gid,)).fetchone())
                    g["options"] = []
                return self.send_json(201, {"item": g})
            if path == "/api/modifiers/options":
                gid = str(data.get("group_id", "")).strip()
                name = str(data.get("name", "")).strip()[:60]
                delta = to_int(data.get("price_delta", 0), "Tambahan harga", 0)
                if not name:
                    return self.send_json(400, {"error": "Nama pilihan tidak boleh kosong."})
                with db() as c:
                    if not c.execute("SELECT 1 FROM modifier_groups WHERE id=? AND active=1", (gid,)).fetchone():
                        return self.send_json(404, {"error": "Kelompok varian tidak ditemukan."})
                    order = c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM modifiers WHERE group_id=?", (gid,)).fetchone()[0]
                    oid = "o-" + uuid.uuid4().hex[:8]
                    c.execute("INSERT INTO modifiers(id,group_id,name,price_delta,sort,active) VALUES(?,?,?,?,?,1)",
                              (oid, gid, name, delta, order))
                    item = row_dict(c.execute("SELECT * FROM modifiers WHERE id=?", (oid,)).fetchone())
                return self.send_json(201, {"item": item})
            if path == "/api/products":
                name = str(data.get("name", "")).strip()
                category = str(data.get("category", "Lainnya")).strip()
                if not name or not category:
                    return self.send_json(400, {"error": "Nama dan kategori wajib diisi."})
                price = to_int(data.get("price"), "Harga", 1, allow_none=True)
                pid = "new-" + uuid.uuid4().hex[:12]
                image_key = data.get("image_key") if data.get("image_key") in VALID_IMAGE_KEYS else "snack"
                with db() as c:
                    c.execute("INSERT INTO products(id,name,category,variant,price,image_key,draft,active,updated_at) VALUES(?,?,?,?,?,?,1,1,?)",
                              (pid, name, category, str(data.get("variant", "")).strip(), price, image_key, now()))
                    item = row_dict(c.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone())
                return self.send_json(201, {"item": item})
            if path == "/api/stock/count":
                product_id = str(data.get("product_id", ""))
                counted = to_int(data.get("counted_quantity"), "Stok dihitung", 0)
                note = str(data.get("note", "")).strip()[:240]
                with db() as c:
                    c.execute("BEGIN IMMEDIATE")
                    p = c.execute("SELECT * FROM products WHERE id=? AND active=1", (product_id,)).fetchone()
                    if not p:
                        return self.send_json(404, {"error": "Menu tidak ditemukan."})
                    old = p["stock_on_hand"]
                    tracked = 1 if data.get("stock_tracked", True) else 0
                    delta = counted if old is None else counted - old
                    kind = "opening_count" if old is None else "count_adjustment"
                    c.execute("UPDATE products SET stock_on_hand=?,stock_tracked=?,updated_at=? WHERE id=?", (counted, tracked, now(), product_id))
                    c.execute("INSERT INTO stock_movements(product_id,movement_type,quantity_change,resulting_quantity,note,created_at) VALUES(?,?,?,?,?,?)",
                              (product_id, kind, delta, counted, note, now()))
                    item = row_dict(c.execute("SELECT id,name,stock_on_hand,reorder_level,stock_tracked FROM products WHERE id=?", (product_id,)).fetchone())
                return self.send_json(201, {"item": item, "quantity_change": delta})
            if path == "/api/sales":
                items = data.get("items")
                method = str(data.get("payment_method", "")).strip()[:80]
                note = str(data.get("note", "")).strip()[:240]
                discount = to_int(data.get("discount_amount", 0), "Diskon", 0)
                if discount != 0:
                    return self.send_json(409, {"error": "Diskon belum diaktifkan; aturan usaha masih draf."})
                if not isinstance(items, list) or not items:
                    return self.send_json(400, {"error": "Keranjang kosong."})
                if not method:
                    return self.send_json(400, {"error": "Isi metode pembayaran yang dicatat."})
                raw_request = data.get("request_id")
                request_id = str(raw_request).strip() if raw_request else ""
                if request_id and not re.fullmatch(r"[A-Za-z0-9._:-]{6,64}", request_id):
                    return self.send_json(400, {"error": "Kunci permintaan transaksi tidak valid."})
                if request_id:
                    with db() as c:
                        dup = c.execute("SELECT * FROM sales WHERE request_id=?", (request_id,)).fetchone()
                        if dup:
                            replay = row_dict(dup)
                            replay["items"] = [row_dict(r) for r in c.execute(
                                "SELECT * FROM sale_items WHERE sale_id=? ORDER BY id", (dup["id"],)).fetchall()]
                            return self.send_json(200, {"item": replay, "duplicate": True})
                lines = {}
                for entry in items:
                    pid = str(entry.get("product_id", ""))
                    qty = to_int(entry.get("quantity"), "Jumlah", 1)
                    chosen = entry.get("modifiers") or []
                    if not isinstance(chosen, list):
                        raise ValueError("Format varian tidak valid.")
                    ids = tuple(sorted(str(m.get("id") if isinstance(m, dict) else m) for m in chosen))
                    lines[(pid, ids)] = lines.get((pid, ids), 0) + qty
                sale_id = "KS-" + uuid.uuid4().hex[:10].upper()
                with db() as c:
                    c.execute("BEGIN IMMEDIATE")
                    prepared = []
                    total = 0
                    for (pid, opt_ids), qty in lines.items():
                        p = c.execute("SELECT * FROM products WHERE id=? AND active=1", (pid,)).fetchone()
                        if not p:
                            return self.send_json(404, {"error": f"Menu {pid} tidak ditemukan."})
                        if p["price"] is None:
                            return self.send_json(409, {"error": f"Harga {p['name']} belum diisi."})
                        tracked = 1 if p["stock_tracked"] else 0
                        if tracked and p["stock_on_hand"] is None:
                            return self.send_json(409, {"error": f"Stok {p['name']} terlacak tetapi angkanya kosong; hitung stok fisik dulu."})
                        if tracked and p["stock_on_hand"] < qty:
                            return self.send_json(409, {"error": f"Stok {p['name']} tidak cukup."})
                        if not tracked and REQUIRE_STOCK:
                            return self.send_json(409, {"error": f"Stok {p['name']} belum dilacak; hitung stok fisik dulu atau matikan mode wajib stok."})
                        delta, summary, var_lines = resolve_item_variants(c, p, [{"id": o} for o in opt_ids])
                        unit = p["price"] + delta
                        line_total = unit * qty
                        total += line_total
                        prepared.append((p, qty, unit, line_total, summary, var_lines))
                    stamp = now()
                    sesi = open_session(c)
                    if sesi:
                        sesi_id = sesi["id"]
                    else:
                        sesi_id = "CS-" + uuid.uuid4().hex[:8].upper()
                        c.execute("INSERT INTO cash_sessions(id,opened_at,business_date,opening_cash,note) VALUES(?,?,?,?,?)",
                                  (sesi_id, stamp, business_date(stamp), 0, "dibuka otomatis saat transaksi pertama"))
                    c.execute("INSERT INTO sales(id,created_at,total_amount,payment_method,status,note,business_date,request_id,session_id) VALUES(?,?,?,?,?,?,?,?,?)",
                              (sale_id, stamp, total, method, "recorded_manual", note, business_date(stamp), request_id or None, sesi_id))
                    for p, qty, unit, line_total, summary, var_lines in prepared:
                        cur = c.execute("INSERT INTO sale_items(sale_id,product_id,name_snapshot,variant_snapshot,unit_price,quantity,line_total,modifiers_summary) VALUES(?,?,?,?,?,?,?,?)",
                                        (sale_id, p["id"], p["name"], p["variant"], unit, qty, line_total, summary))
                        for var_line in var_lines:
                            c.execute("INSERT INTO sale_item_modifiers(sale_item_id,group_name,modifier_name,price_delta) VALUES(?,?,?,?)",
                                      (cur.lastrowid, var_line["group_name"], var_line["modifier_name"], var_line["price_delta"]))
                        if p["stock_tracked"]:
                            resulting = p["stock_on_hand"] - qty
                            c.execute("UPDATE products SET stock_on_hand=?,updated_at=? WHERE id=?", (resulting, stamp, p["id"]))
                            c.execute("INSERT INTO stock_movements(product_id,movement_type,quantity_change,resulting_quantity,note,created_at) VALUES(?,?,?,?,?,?)",
                                      (p["id"], "sale", -qty, resulting, sale_id, stamp))
                    sale = row_dict(c.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone())
                return self.send_json(201, {"item": sale})
            return self.send_json(404, {"error": "Rute tidak ditemukan."})
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})
        except sqlite3.IntegrityError as exc:
            return self.send_json(409, {"error": "Data tidak dapat disimpan: " + str(exc)})
        except Exception as exc:
            return self.send_json(500, {"error": str(exc)})

    def do_DELETE(self):
        if self.reject_cross_origin_write():
            return
        if self.reject_expired_write():
            return
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/modifiers/option/"):
                oid = unquote(path.rsplit("/", 1)[-1])
                with db() as c:
                    cur = c.execute("UPDATE modifiers SET active=0 WHERE id=?", (oid,))
                return self.send_json(200, {"deleted": cur.rowcount, "mode": "nonaktif"})
            if path.startswith("/api/modifiers/group/"):
                gid = unquote(path.rsplit("/", 1)[-1])
                with db() as c:
                    cur = c.execute("UPDATE modifier_groups SET active=0 WHERE id=?", (gid,))
                    c.execute("UPDATE modifiers SET active=0 WHERE group_id=?", (gid,))
                    c.execute("DELETE FROM category_modifier_groups WHERE group_id=?", (gid,))
                return self.send_json(200, {"deleted": cur.rowcount, "mode": "nonaktif"})
            return self.send_json(404, {"error": "Rute tidak ditemukan."})
        except Exception as exc:
            return self.send_json(500, {"error": str(exc)})

    def do_PUT(self):
        if self.reject_cross_origin_write():
            return
        if self.reject_expired_write():
            return
        path = urlparse(self.path).path
        if path.startswith("/api/modifiers/option/"):
            oid = unquote(path.rsplit("/", 1)[-1])
            try:
                data = self.body_json()
                fields = {}
                if "name" in data:
                    fields["name"] = str(data["name"]).strip()[:60]
                    if not fields["name"]:
                        return self.send_json(400, {"error": "Nama pilihan tidak boleh kosong."})
                if "price_delta" in data:
                    fields["price_delta"] = to_int(data["price_delta"], "Tambahan harga", 0)
                if "active" in data:
                    fields["active"] = 1 if data["active"] else 0
                if not fields:
                    return self.send_json(400, {"error": "Tidak ada perubahan."})
                with db() as c:
                    assigns = ",".join(f"{k}=?" for k in fields)
                    cur = c.execute(f"UPDATE modifiers SET {assigns} WHERE id=?", (*fields.values(), oid))
                    if cur.rowcount != 1:
                        return self.send_json(404, {"error": "Pilihan tidak ditemukan."})
                    item = row_dict(c.execute("SELECT * FROM modifiers WHERE id=?", (oid,)).fetchone())
                return self.send_json(200, {"item": item})
            except ValueError as exc:
                return self.send_json(400, {"error": str(exc)})
        if path.startswith("/api/modifiers/group/"):
            gid = unquote(path.rsplit("/", 1)[-1])
            try:
                data = self.body_json()
                fields = {}
                if "name" in data:
                    fields["name"] = str(data["name"]).strip()[:60]
                    if not fields["name"]:
                        return self.send_json(400, {"error": "Nama kelompok varian tidak boleh kosong."})
                for key, label in (("min_select", "Wajib pilih minimal"), ("max_select", "Maksimal pilih")):
                    if key in data:
                        fields[key] = to_int(data[key], label, 0 if key == "min_select" else 1)
                if "active" in data:
                    fields["active"] = 1 if data["active"] else 0
                if not fields:
                    return self.send_json(400, {"error": "Tidak ada perubahan."})
                with db() as c:
                    assigns = ",".join(f"{k}=?" for k in fields)
                    cur = c.execute(f"UPDATE modifier_groups SET {assigns} WHERE id=?", (*fields.values(), gid))
                    if cur.rowcount != 1:
                        return self.send_json(404, {"error": "Kelompok varian tidak ditemukan."})
                    item = row_dict(c.execute("SELECT * FROM modifier_groups WHERE id=?", (gid,)).fetchone())
                return self.send_json(200, {"item": item})
            except ValueError as exc:
                return self.send_json(400, {"error": str(exc)})
        if path.startswith("/api/modifiers/category/"):
            category = unquote(path.rsplit("/", 1)[-1])
            try:
                data = self.body_json()
                group_ids = [str(g) for g in (data.get("group_ids") or [])]
                with db() as c:
                    known = {r[0] for r in c.execute("SELECT id FROM modifier_groups WHERE active=1")}
                    unknown = [g for g in group_ids if g not in known]
                    if unknown:
                        return self.send_json(400, {"error": "Kelompok varian tidak dikenal: " + ", ".join(unknown)})
                    c.execute("DELETE FROM category_modifier_groups WHERE category=?", (category,))
                    for i, gid in enumerate(group_ids):
                        c.execute("INSERT INTO category_modifier_groups(category,group_id,sort) VALUES(?,?,?)", (category, gid, i))
                return self.send_json(200, {"category": category, "group_ids": group_ids})
            except ValueError as exc:
                return self.send_json(400, {"error": str(exc)})
        if not path.startswith("/api/products/"):
            return self.send_json(404, {"error": "Rute tidak ditemukan."})
        product_id = unquote(path.rsplit("/", 1)[-1])
        try:
            data = self.body_json()
            fields = {}
            if "price" in data:
                fields["price"] = to_int(data["price"], "Harga", 1, allow_none=True)
            if "reorder_level" in data:
                fields["reorder_level"] = to_int(data["reorder_level"], "Ambang stok", 0, allow_none=True)
            if "stock_tracked" in data:
                fields["stock_tracked"] = 1 if data["stock_tracked"] else 0
            for key in ("name", "category", "variant"):
                if key in data:
                    fields[key] = str(data[key]).strip()
            if not fields:
                return self.send_json(400, {"error": "Tidak ada perubahan."})
            if "name" in fields and not fields["name"]:
                return self.send_json(400, {"error": "Nama menu tidak boleh kosong."})
            if "category" in fields and not fields["category"]:
                return self.send_json(400, {"error": "Kategori tidak boleh kosong."})
            fields["updated_at"] = now()
            assignments = ",".join(f"{key}=?" for key in fields)
            with db() as c:
                cur = c.execute(f"UPDATE products SET {assignments} WHERE id=?", (*fields.values(), product_id))
                if cur.rowcount != 1:
                    return self.send_json(404, {"error": "Menu tidak ditemukan."})
                item = row_dict(c.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone())
            return self.send_json(200, {"item": item})
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            return self.send_json(500, {"error": str(exc)})


def main():
    init_db()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Kopi Sawah local development: http://127.0.0.1:{PORT}")
    print(f"Database lokal: {DB_PATH}")
    print("JANGAN buka port ini ke internet; belum ada autentikasi/TLS.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
