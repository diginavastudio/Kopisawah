#!/usr/bin/env python3
"""Kopi Sawah beta app; keep its listener on loopback behind the Hestia proxy."""
from __future__ import annotations

import json
import mimetypes
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
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
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
        CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
        CREATE INDEX IF NOT EXISTS idx_movements_product_time ON stock_movements(product_id, created_at);
        """)
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
                              "sales": c.execute("SELECT COUNT(*) FROM sales").fetchone()[0]}
                return self.send_json(200, {"ok": True, "mode": "local-development", "counts": counts})
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
            if path == "/api/stock":
                with db() as c:
                    rows = [row_dict(r) for r in c.execute("""SELECT id,name,category,variant,stock_on_hand,
                        reorder_level,image_key FROM products WHERE active=1 ORDER BY category,name,variant,id""").fetchall()]
                return self.send_json(200, {"items": rows})
            if path == "/api/sales":
                with db() as c:
                    sales = c.execute("SELECT * FROM sales ORDER BY created_at DESC LIMIT 200").fetchall()
                    result = []
                    for s in sales:
                        d = row_dict(s)
                        d["items"] = [row_dict(r) for r in c.execute("SELECT * FROM sale_items WHERE sale_id=? ORDER BY id", (s["id"],)).fetchall()]
                        result.append(d)
                return self.send_json(200, {"items": result})
            if path == "/api/reports/summary":
                today = datetime.now(timezone.utc).date().isoformat()
                with db() as c:
                    day = c.execute("SELECT COUNT(*) n,COALESCE(SUM(total_amount),0) total FROM sales WHERE substr(created_at,1,10)=?", (today,)).fetchone()
                    low = c.execute("SELECT COUNT(*) FROM products WHERE active=1 AND stock_on_hand IS NOT NULL AND reorder_level IS NOT NULL AND stock_on_hand<=reorder_level").fetchone()[0]
                    unknown = c.execute("SELECT COUNT(*) FROM products WHERE active=1 AND stock_on_hand IS NULL").fetchone()[0]
                    all_sales = c.execute("SELECT COUNT(*) FROM sales").fetchone()[0]
                    all_total = c.execute("SELECT COALESCE(SUM(total_amount),0) FROM sales").fetchone()[0]
                return self.send_json(200, {"today_transactions": day["n"], "today_total": day["total"],
                                           "low_stock": low, "unknown_stock": unknown,
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
                    delta = counted if old is None else counted - old
                    kind = "opening_count" if old is None else "count_adjustment"
                    c.execute("UPDATE products SET stock_on_hand=?,updated_at=? WHERE id=?", (counted, now(), product_id))
                    c.execute("INSERT INTO stock_movements(product_id,movement_type,quantity_change,resulting_quantity,note,created_at) VALUES(?,?,?,?,?,?)",
                              (product_id, kind, delta, counted, note, now()))
                    item = row_dict(c.execute("SELECT id,name,stock_on_hand,reorder_level FROM products WHERE id=?", (product_id,)).fetchone())
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
                quantities = {}
                for entry in items:
                    pid = str(entry.get("product_id", ""))
                    qty = to_int(entry.get("quantity"), "Jumlah", 1)
                    quantities[pid] = quantities.get(pid, 0) + qty
                sale_id = "KS-" + uuid.uuid4().hex[:10].upper()
                with db() as c:
                    c.execute("BEGIN IMMEDIATE")
                    prepared = []
                    total = 0
                    for pid, qty in quantities.items():
                        p = c.execute("SELECT * FROM products WHERE id=? AND active=1", (pid,)).fetchone()
                        if not p:
                            return self.send_json(404, {"error": f"Menu {pid} tidak ditemukan."})
                        if p["price"] is None:
                            return self.send_json(409, {"error": f"Harga {p['name']} belum diisi."})
                        if p["stock_on_hand"] is not None and p["stock_on_hand"] < qty:
                            return self.send_json(409, {"error": f"Stok {p['name']} tidak cukup."})
                        line_total = p["price"] * qty
                        total += line_total
                        prepared.append((p, qty, line_total))
                    stamp = now()
                    c.execute("INSERT INTO sales(id,created_at,total_amount,payment_method,status,note) VALUES(?,?,?,?,?,?)",
                              (sale_id, stamp, total, method, "recorded_manual", note))
                    for p, qty, line_total in prepared:
                        c.execute("INSERT INTO sale_items(sale_id,product_id,name_snapshot,variant_snapshot,unit_price,quantity,line_total) VALUES(?,?,?,?,?,?,?)",
                                  (sale_id, p["id"], p["name"], p["variant"], p["price"], qty, line_total))
                        if p["stock_on_hand"] is not None:
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

    def do_PUT(self):
        if self.reject_cross_origin_write():
            return
        if self.reject_expired_write():
            return
        path = urlparse(self.path).path
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
