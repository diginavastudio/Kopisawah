#!/usr/bin/env python3
"""Kopi Sawah — kasir & katalog. Satu proses Python tanpa dependensi, data di SQLite.

Dengarkan hanya di 127.0.0.1 dan teruskan lewat nginx (HTTPS).
"""
from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
import traceback
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
CATALOG = DATA / "catalog.json"
DB_PATH = Path(os.environ.get("KOPI_SAWAH_DB", DATA / "kopi-sawah-dev.sqlite3"))
PORT = int(os.environ.get("KOPI_SAWAH_PORT", "8791"))
REQUIRE_ORIGIN = os.environ.get("KOPI_SAWAH_REQUIRE_ORIGIN", "0") == "1"
REQUIRE_STOCK = os.environ.get("KOPI_SAWAH_REQUIRE_STOCK", "0") == "1"
TZ_NAME = os.environ.get("KOPI_SAWAH_TZ", "Asia/Jakarta").strip() or "Asia/Jakarta"
# Mode tanpa login: setiap permintaan dianggap dilakukan pemilik (sesuai permintaan pemilik,
# login/PIN ditunda sampai desain web dinyatakan selesai).
TANPA_LOGIN = os.environ.get("KOPI_SAWAH_TANPA_LOGIN", "0") == "1"
try:
    TZ = ZoneInfo(TZ_NAME)
except Exception:
    TZ_NAME, TZ = "UTC", timezone.utc
VALID_IMAGE_KEYS = {p.stem for p in (STATIC / "images").glob("*.jpg")}

SESSION_HOURS = 12
PIN_ITERATIONS = 200_000
MAX_FAILS_USER, MAX_FAILS_IP, LOCK_SECONDS = 5, 20, 300
SCHEMA_VERSION = 3

PAYMENT_METHODS = {"tunai": "Tunai", "qris": "QRIS", "debit": "Kartu Debit/Kredit",
                   "ewallet": "E-Wallet", "transfer": "Transfer Bank"}
ORDER_TYPES = {"dine_in": "Makan di sini", "take_away": "Bawa pulang"}
ROLES = ("owner", "kasir")
SETTING_DEFAULTS = {
    "outlet_name": "Kopi Sawah", "outlet_address": "Klaten",
    "receipt_footer": "Terima kasih, sampai jumpa lagi!", "receipt_width": "58",
    "tax_percent": "0", "service_percent": "0", "rounding": "0",
    "kasir_max_discount_percent": "0",
}


# --------------------------------------------------------------------------- util
class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


class Resp:
    def __init__(self, status=200, payload=None, body=None, content_type=None, headers=None):
        self.status, self.payload, self.body = status, payload, body
        self.content_type, self.headers = content_type, headers or []


def now():
    return datetime.now(TZ).isoformat(timespec="seconds")


def business_date(stamp=None):
    if stamp is None:
        return datetime.now(TZ).date().isoformat()
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone(TZ).date().isoformat()
    except (ValueError, OverflowError):
        return str(stamp)[:10]


def parse_date(value, label):
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except ValueError:
        raise ApiError(400, f"Tanggal {label} tidak valid (format AAAA-BB-HH).")


@contextmanager
def db(write=False):
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    try:
        if write:
            conn.execute("BEGIN IMMEDIATE")
        yield conn
        if write:
            conn.execute("COMMIT")
    except BaseException:
        if write and conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def row_dict(row):
    return dict(row) if row is not None else None


def rows(c, sql, args=()):
    return [dict(r) for r in c.execute(sql, args).fetchall()]


def to_int(value, label, minimum=0, maximum=None, allow_none=False):
    if value is None and allow_none:
        return None
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        hi = f" dan maksimal {maximum}" if maximum is not None else ""
        raise ApiError(400, f"{label} harus berupa bilangan bulat minimal {minimum}{hi}.")
    return value


def money_round(x):
    return int(Decimal(x).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def to_percent(value, label, maximum=100):
    try:
        d = Decimal(str(value).strip().replace(",", "."))
    except (InvalidOperation, ValueError):
        raise ApiError(400, f"{label} harus berupa angka.")
    if not d.is_finite() or d < 0 or d > maximum or d != d.quantize(Decimal("0.01")):
        raise ApiError(400, f"{label} harus antara 0 dan {maximum} (maksimal 2 angka desimal).")
    return d


def csv_safe(value):
    s = "" if value is None else str(value)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


# --------------------------------------------------------------------------- varian seed
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
    "Makanan": ["sambal"], "Lauk": ["sambal"], "Paket": ["sambal"], "Camilan": ["sambal"],
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
    return rows(c, """SELECT g.* FROM category_modifier_groups cm
                      JOIN modifier_groups g ON g.id=cm.group_id
                      WHERE cm.category=? AND g.active=1 ORDER BY cm.sort,g.sort""", (category,))


def variant_options(c, group_id):
    return rows(c, "SELECT * FROM modifiers WHERE group_id=? AND active=1 ORDER BY sort,id", (group_id,))


def resolve_item_variants(c, product, option_ids):
    """Validasi pilihan varian satu item; kembalikan (tambahan_harga, ringkasan, baris)."""
    allowed = {g["id"]: g for g in variant_groups_for(c, product["category"])}
    picked = {}
    for oid in option_ids:
        row = c.execute("""SELECT m.id,m.group_id,m.name,m.price_delta FROM modifiers m
                           JOIN modifier_groups g ON g.id=m.group_id
                           WHERE m.id=? AND m.active=1 AND g.active=1""", (oid,)).fetchone()
        if not row:
            raise ApiError(400, "Pilihan varian tidak dikenal.")
        if row["group_id"] not in allowed:
            raise ApiError(400, f"Varian {row['name']} tidak tersedia untuk {product['name']}.")
        picked.setdefault(row["group_id"], []).append(row_dict(row))
    delta, lines = 0, []
    for gid, g in allowed.items():
        chosen = picked.get(gid, [])
        if len(chosen) < g["min_select"]:
            raise ApiError(400, f"Pilih {g['name']} untuk {product['name']}.")
        if len(chosen) > g["max_select"]:
            raise ApiError(400, f"{g['name']} maksimal {g['max_select']} pilihan.")
        for it in chosen:
            delta += it["price_delta"]
            lines.append({"group_name": g["name"], "modifier_name": it["name"], "price_delta": it["price_delta"]})
    seen = {}
    for l in lines:
        seen[l["modifier_name"]] = seen.get(l["modifier_name"], 0) + 1

    def label(l):  # nama sama di dua kelompok (mis. "Normal") diberi nama kelompok agar tidak ambigu
        name = f"{l['group_name']} {l['modifier_name']}" if seen[l["modifier_name"]] > 1 else l["modifier_name"]
        return name + (f" (+{l['price_delta']//1000}rb)" if l["price_delta"] else "")
    summary = ", ".join(label(l) for l in lines)
    return delta, summary, lines


# --------------------------------------------------------------------------- skema
def ensure_column(c, table, column, ddl):
    if column not in {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}:
        c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def init_db():
    with db() as c:
        c.execute("PRAGMA journal_mode = WAL")
        c.executescript("""
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
            variant TEXT NOT NULL DEFAULT '',
            price INTEGER NULL CHECK(price IS NULL OR price > 0),
            stock_on_hand INTEGER NULL CHECK(stock_on_hand IS NULL OR stock_on_hand >= 0),
            reorder_level INTEGER NULL CHECK(reorder_level IS NULL OR reorder_level >= 0),
            image_key TEXT NOT NULL DEFAULT 'snack',
            draft INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sales (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
            total_amount INTEGER NOT NULL CHECK(total_amount >= 0),
            payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'paid',
            note TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS sale_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sale_id TEXT NOT NULL REFERENCES sales(id),
            product_id TEXT NOT NULL REFERENCES products(id),
            name_snapshot TEXT NOT NULL, variant_snapshot TEXT NOT NULL,
            unit_price INTEGER NOT NULL CHECK(unit_price > 0),
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            line_total INTEGER NOT NULL CHECK(line_total > 0));
        CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL REFERENCES products(id),
            movement_type TEXT NOT NULL, quantity_change INTEGER NOT NULL,
            resulting_quantity INTEGER NOT NULL CHECK(resulting_quantity >= 0),
            note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS modifier_groups (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
            min_select INTEGER NOT NULL DEFAULT 0 CHECK(min_select >= 0),
            max_select INTEGER NOT NULL DEFAULT 1 CHECK(max_select >= 1),
            sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS modifiers (
            id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES modifier_groups(id),
            name TEXT NOT NULL, price_delta INTEGER NOT NULL DEFAULT 0 CHECK(price_delta >= 0),
            sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS category_modifier_groups (
            category TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES modifier_groups(id),
            sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (category, group_id));
        CREATE TABLE IF NOT EXISTS sale_item_modifiers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
            group_name TEXT NOT NULL, modifier_name TEXT NOT NULL,
            price_delta INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            role TEXT NOT NULL CHECK(role IN ('owner','kasir')),
            pin_salt BLOB NOT NULL, pin_hash BLOB NOT NULL,
            active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            opened_at TEXT NOT NULL, opening_cash INTEGER NOT NULL CHECK(opening_cash >= 0),
            closed_at TEXT, counted_cash INTEGER, expected_cash INTEGER, difference INTEGER,
            note TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_name TEXT NOT NULL,
            action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
        CREATE INDEX IF NOT EXISTS idx_movements_product_time ON stock_movements(product_id, created_at);
        """)
        ensure_column(c, "sales", "business_date", "TEXT NOT NULL DEFAULT ''")
        ensure_column(c, "sales", "request_id", "TEXT")
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_request ON sales(request_id) WHERE request_id IS NOT NULL")
        ensure_column(c, "sale_items", "modifiers_summary", "TEXT NOT NULL DEFAULT ''")
        ensure_column(c, "products", "stock_tracked", "INTEGER NOT NULL DEFAULT 0")
        # tambahan skema v3
        ensure_column(c, "products", "cost", "INTEGER NULL CHECK(cost IS NULL OR cost >= 0)")
        ensure_column(c, "products", "available", "INTEGER NOT NULL DEFAULT 1")
        ensure_column(c, "sale_items", "cost_snapshot", "INTEGER NULL")
        for col, ddl in (("subtotal", "INTEGER NOT NULL DEFAULT 0"), ("discount_amount", "INTEGER NOT NULL DEFAULT 0"),
                         ("discount_reason", "TEXT NOT NULL DEFAULT ''"), ("service_amount", "INTEGER NOT NULL DEFAULT 0"),
                         ("tax_amount", "INTEGER NOT NULL DEFAULT 0"), ("rounding_amount", "INTEGER NOT NULL DEFAULT 0"),
                         ("amount_paid", "INTEGER NOT NULL DEFAULT 0"), ("change_amount", "INTEGER NOT NULL DEFAULT 0"),
                         ("order_type", "TEXT NOT NULL DEFAULT 'dine_in'"), ("table_no", "TEXT NOT NULL DEFAULT ''"),
                         ("user_id", "INTEGER NULL"), ("shift_id", "INTEGER NULL"),
                         ("void_reason", "TEXT NOT NULL DEFAULT ''"), ("voided_by", "TEXT NOT NULL DEFAULT ''"),
                         ("voided_at", "TEXT NULL")):
            ensure_column(c, "sales", col, ddl)
        version = int((c.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone() or [0])[0])
        if version < SCHEMA_VERSION:
            c.execute("UPDATE sales SET status='paid' WHERE status='recorded_manual'")
            c.execute("UPDATE sales SET subtotal=total_amount, amount_paid=total_amount WHERE subtotal=0 AND total_amount>0")
            for stale in c.execute("SELECT id, created_at FROM sales WHERE business_date=''").fetchall():
                c.execute("UPDATE sales SET business_date=? WHERE id=?", (business_date(stale["created_at"]), stale["id"]))
            c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
        seed_modifiers(c)
        if c.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 0 and CATALOG.exists():
            for p in json.loads(CATALOG.read_text(encoding="utf-8")):
                image_key = p.get("image_key") if p.get("image_key") in VALID_IMAGE_KEYS else "snack"
                c.execute("""INSERT INTO products
                    (id,name,category,variant,price,stock_on_hand,reorder_level,image_key,draft,active,updated_at)
                    VALUES (?,?,?,?,?,NULL,NULL,?,1,1,?)""",
                          (str(p["id"]), p["name"], p.get("category", "Lainnya"), p.get("variant", ""),
                           p.get("price"), image_key, now()))


# --------------------------------------------------------------------------- pengaturan & audit
def get_settings(c):
    out = dict(SETTING_DEFAULTS)
    out.update({r["key"]: r["value"] for r in c.execute("SELECT key,value FROM settings")
                if r["key"] in SETTING_DEFAULTS})
    return out


def audit(c, user, action, detail=""):
    c.execute("INSERT INTO audit_log(at,user_name,action,detail) VALUES(?,?,?,?)",
              (now(), user["name"] if user else "sistem", action, str(detail)[:500]))


# --------------------------------------------------------------------------- autentikasi
def hash_pin(pin, salt):
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, PIN_ITERATIONS)


def validate_pin(pin, role):
    need = 6 if role == "owner" else 4
    if not isinstance(pin, str) or not re.fullmatch(r"\d{%d,8}" % need, pin):
        raise ApiError(400, f"PIN harus berupa angka {need}–8 digit.")
    if len(set(pin)) == 1 or pin in ("123456", "1234", "12345678", "654321"):
        raise ApiError(400, "PIN terlalu mudah ditebak. Hindari angka berulang atau berurutan.")


_throttle = {}
_throttle_lock = threading.Lock()


def throttle_check(key):
    with _throttle_lock:
        _, until = _throttle.get(key, (0, 0))
        if until > time.time():
            wait = int(until - time.time()) + 1
            raise ApiError(429, f"Terlalu banyak percobaan. Coba lagi dalam {max(1, wait // 60)} menit.")


def throttle_fail(key, limit):
    with _throttle_lock:
        count, until = _throttle.get(key, (0, 0))
        count = 1 if until and until <= time.time() else count + 1
        _throttle[key] = (count, time.time() + LOCK_SECONDS if count >= limit else 0)


def throttle_reset(key):
    with _throttle_lock:
        _throttle.pop(key, None)


def new_session(c, user_id):
    token = secrets.token_urlsafe(32)
    c.execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
    c.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
              (hashlib.sha256(token.encode()).hexdigest(), user_id, now(),
               (datetime.now(TZ) + timedelta(hours=SESSION_HOURS)).isoformat(timespec="seconds")))
    return token


def user_for_token(c, token):
    if not token:
        return None
    row = c.execute("""SELECT u.id,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id
                       WHERE s.token_hash=? AND s.expires_at>? AND u.active=1""",
                    (hashlib.sha256(token.encode()).hexdigest(), now())).fetchone()
    return row_dict(row)


SETUP_CODE = os.environ.get("KOPI_SAWAH_SETUP_CODE", "").strip() or "".join(secrets.choice("0123456789") for _ in range(8))
NAMA_TANPA_LOGIN = "Kasir (tanpa login)"
PENGGUNA_TANPA_LOGIN = None


def pastikan_pengguna_tanpa_login():
    """Siapkan satu akun pemilik otomatis agar mode tanpa login tetap punya user_id
    (dipakai shift, audit, dan transaksi) tanpa perlu PIN."""
    global PENGGUNA_TANPA_LOGIN
    salt = b"tanpa-login"
    with db(write=True) as c:
        row = c.execute("SELECT id,role,active FROM users WHERE name=?", (NAMA_TANPA_LOGIN,)).fetchone()
        if row is None:
            cur = c.execute("INSERT INTO users(name,role,pin_salt,pin_hash,active,created_at) VALUES(?,?,?,?,1,?)",
                            (NAMA_TANPA_LOGIN, "owner", salt, hash_pin("000000", salt), now()))
            uid = cur.lastrowid
        else:
            uid = row["id"]
            if row["role"] != "owner" or not row["active"]:
                c.execute("UPDATE users SET role='owner',active=1 WHERE id=?", (uid,))
    PENGGUNA_TANPA_LOGIN = {"id": uid, "name": NAMA_TANPA_LOGIN, "role": "owner", "active": 1}
    return PENGGUNA_TANPA_LOGIN


def cookie_header(token, secure, max_age):
    flags = f"ks_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
    return ("Set-Cookie", flags + ("; Secure" if secure else ""))


# --------------------------------------------------------------------------- routing
class Req:
    def __init__(self, handler, method, path, query):
        self.h, self.method, self.path, self.query = handler, method, path, query
        self.match, self.user, self._data = None, None, None

    @property
    def data(self):
        if self._data is None:
            self._data = self.h.body_json()
        return self._data

    @property
    def ip(self):
        return self.h.headers.get("X-Real-IP") or self.h.client_address[0]

    @property
    def secure(self):
        return self.h.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower() == "https"

    def arg(self, name, default=""):
        return (self.query.get(name, [default])[0] or default).strip()


ROUTES = []


def route(method, pattern, role="user"):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, role, fn))
        return fn
    return deco


def is_owner(req):
    return req.user["role"] == "owner"


# --------------------------------------------------------------------------- rute: publik & akun
@route("GET", r"/api/health", "public")
def r_health(req):
    return {"ok": True, "timezone": TZ_NAME, "business_date": business_date()}


@route("GET", r"/api/auth/status", "public")
def r_auth_status(req):
    with db() as c:
        total = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        out = {"setup_required": total == 0, "user": req.user,
               "payment_methods": PAYMENT_METHODS, "order_types": ORDER_TYPES}
        if req.user:
            out["settings"] = get_settings(c)
        elif total:
            out["staff"] = rows(c, "SELECT id,name FROM users WHERE active=1 ORDER BY role='owner' DESC,name")
    return out


@route("POST", r"/api/auth/setup", "public")
def r_auth_setup(req):
    throttle_check("setup:" + req.ip)
    d = req.data
    code = str(d.get("setup_code", "")).strip()
    if not hmac.compare_digest(code, SETUP_CODE):
        throttle_fail("setup:" + req.ip, MAX_FAILS_IP)
        raise ApiError(403, "Kode penyiapan salah. Lihat kode di log server (lihat README).")
    name = str(d.get("name", "")).strip()[:40]
    if not name:
        raise ApiError(400, "Nama pemilik wajib diisi.")
    pin = d.get("pin")
    validate_pin(pin, "owner")
    salt = secrets.token_bytes(16)
    with db(write=True) as c:
        if c.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            raise ApiError(409, "Akun pemilik sudah dibuat.")
        cur = c.execute("INSERT INTO users(name,role,pin_salt,pin_hash,active,created_at) VALUES(?,?,?,?,1,?)",
                        (name, "owner", salt, hash_pin(pin, salt), now()))
        token = new_session(c, cur.lastrowid)
        audit(c, {"name": name}, "setup", "akun pemilik dibuat")
    throttle_reset("setup:" + req.ip)
    return Resp(201, {"ok": True}, headers=[cookie_header(token, req.secure, SESSION_HOURS * 3600)])


@route("POST", r"/api/auth/login", "public")
def r_auth_login(req):
    d = req.data
    uid, pin = d.get("user_id"), d.get("pin")
    if type(uid) is not int or not isinstance(pin, str) or not pin:
        raise ApiError(400, "Pilih nama dan masukkan PIN.")
    throttle_check(f"ip:{req.ip}")
    throttle_check(f"user:{uid}")
    with db(write=True) as c:
        u = c.execute("SELECT * FROM users WHERE id=? AND active=1", (uid,)).fetchone()
        ok = bool(u) and hmac.compare_digest(hash_pin(pin, u["pin_salt"]), u["pin_hash"])
        if not ok:
            throttle_fail(f"user:{uid}", MAX_FAILS_USER)
            throttle_fail(f"ip:{req.ip}", MAX_FAILS_IP)
            if u:
                audit(c, u, "login_gagal", f"ip {req.ip}")
            raise ApiError(401, "PIN salah.")
        token = new_session(c, u["id"])
        audit(c, u, "login", f"ip {req.ip}")
    throttle_reset(f"user:{uid}")
    return Resp(200, {"user": {"id": u["id"], "name": u["name"], "role": u["role"]}},
                headers=[cookie_header(token, req.secure, SESSION_HOURS * 3600)])


@route("POST", r"/api/auth/logout", "public")
def r_auth_logout(req):
    token = req.h.session_token()
    if token:
        with db(write=True) as c:
            c.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
    return Resp(200, {"ok": True}, headers=[cookie_header("", req.secure, 0)])


@route("POST", r"/api/auth/pin")
def r_change_pin(req):
    d = req.data
    old, new = d.get("old_pin"), d.get("new_pin")
    throttle_check(f"user:{req.user['id']}")
    validate_pin(new, req.user["role"])
    with db(write=True) as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (req.user["id"],)).fetchone()
        if not isinstance(old, str) or not hmac.compare_digest(hash_pin(old, u["pin_salt"]), u["pin_hash"]):
            throttle_fail(f"user:{u['id']}", MAX_FAILS_USER)
            raise ApiError(403, "PIN lama salah.")
        salt = secrets.token_bytes(16)
        c.execute("UPDATE users SET pin_salt=?,pin_hash=? WHERE id=?", (salt, hash_pin(new, salt), u["id"]))
        audit(c, req.user, "ganti_pin")
    return {"ok": True}


# --------------------------------------------------------------------------- rute: tim (pemilik)
@route("GET", r"/api/users", "owner")
def r_users(req):
    with db() as c:
        return {"items": rows(c, "SELECT id,name,role,active,created_at FROM users ORDER BY active DESC,role='owner' DESC,name")}


@route("POST", r"/api/users", "owner")
def r_user_add(req):
    d = req.data
    name = str(d.get("name", "")).strip()[:40]
    role = d.get("role", "kasir")
    if not name:
        raise ApiError(400, "Nama wajib diisi.")
    if role not in ROLES:
        raise ApiError(400, "Peran tidak dikenal.")
    validate_pin(d.get("pin"), role)
    salt = secrets.token_bytes(16)
    with db(write=True) as c:
        try:
            cur = c.execute("INSERT INTO users(name,role,pin_salt,pin_hash,active,created_at) VALUES(?,?,?,?,1,?)",
                            (name, role, salt, hash_pin(d["pin"], salt), now()))
        except sqlite3.IntegrityError:
            raise ApiError(409, "Nama itu sudah dipakai.")
        audit(c, req.user, "tambah_pengguna", f"{name} ({role})")
        return Resp(201, {"item": row_dict(c.execute("SELECT id,name,role,active FROM users WHERE id=?", (cur.lastrowid,)).fetchone())})


@route("PUT", r"/api/users/(\d+)", "owner")
def r_user_edit(req):
    uid, d = int(req.match.group(1)), req.data
    with db(write=True) as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            raise ApiError(404, "Pengguna tidak ditemukan.")
        sets, args = [], []
        if "name" in d:
            name = str(d["name"]).strip()[:40]
            if not name:
                raise ApiError(400, "Nama wajib diisi.")
            sets.append("name=?"); args.append(name)
        role = d.get("role", u["role"])
        if role not in ROLES:
            raise ApiError(400, "Peran tidak dikenal.")
        active = (1 if d["active"] else 0) if "active" in d else u["active"]
        if u["role"] == "owner" and u["active"] and (role != "owner" or not active):
            others = c.execute("SELECT COUNT(*) FROM users WHERE role='owner' AND active=1 AND id!=?", (uid,)).fetchone()[0]
            if not others:
                raise ApiError(409, "Harus ada minimal satu pemilik aktif.")
        sets += ["role=?", "active=?"]; args += [role, active]
        if d.get("pin"):
            validate_pin(d["pin"], role)
            salt = secrets.token_bytes(16)
            sets += ["pin_salt=?", "pin_hash=?"]; args += [salt, hash_pin(d["pin"], salt)]
        try:
            c.execute(f"UPDATE users SET {','.join(sets)} WHERE id=?", (*args, uid))
        except sqlite3.IntegrityError:
            raise ApiError(409, "Nama itu sudah dipakai.")
        if not active or d.get("pin"):
            c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        audit(c, req.user, "ubah_pengguna", f"{u['name']}: " + ", ".join(k for k in ("name", "role", "active", "pin") if k in d))
        return {"item": row_dict(c.execute("SELECT id,name,role,active FROM users WHERE id=?", (uid,)).fetchone())}


# --------------------------------------------------------------------------- rute: pengaturan
@route("GET", r"/api/settings")
def r_settings(req):
    with db() as c:
        return {"settings": get_settings(c)}


@route("PUT", r"/api/settings", "owner")
def r_settings_put(req):
    d, clean = req.data, {}
    for key in SETTING_DEFAULTS:
        if key not in d:
            continue
        v = d[key]
        if key in ("tax_percent", "service_percent", "kasir_max_discount_percent"):
            v = str(to_percent(v, "Persentase"))
        elif key == "rounding":
            v = str(v)
            if v not in ("0", "100", "500", "1000"):
                raise ApiError(400, "Pembulatan harus 0, 100, 500, atau 1000.")
        elif key == "receipt_width":
            v = str(v)
            if v not in ("58", "80"):
                raise ApiError(400, "Lebar struk harus 58 atau 80 mm.")
        else:
            v = str(v).strip()[:120]
        clean[key] = v
    if not clean:
        raise ApiError(400, "Tidak ada perubahan.")
    with db(write=True) as c:
        for k, v in clean.items():
            c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
        audit(c, req.user, "ubah_pengaturan", json.dumps(clean, ensure_ascii=False))
        return {"settings": get_settings(c)}


# --------------------------------------------------------------------------- rute: menu
def product_public(p, owner):
    if not owner:
        p.pop("cost", None)
    return p


@route("GET", r"/api/products")
def r_products(req):
    q, category = req.arg("q"), req.arg("category")
    hidden = is_owner(req) and req.arg("include_inactive") == "1"
    sql, args = "SELECT * FROM products WHERE " + ("1=1" if hidden else "active=1"), []
    if q:
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        sql += " AND (name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR variant LIKE ? ESCAPE '\\')"
        args += [like] * 3
    if category and category != "Semua":
        sql += " AND category=?"; args.append(category)
    with db() as c:
        items = rows(c, sql + " ORDER BY category,name,variant,id", args)
    owner = is_owner(req)
    return {"items": [product_public(p, owner) for p in items], "images": sorted(VALID_IMAGE_KEYS) if owner else []}


def clean_product_fields(d, partial):
    fields = {}
    if "price" in d or not partial:
        fields["price"] = to_int(d.get("price"), "Harga", 1, 100_000_000, allow_none=True)
    if "cost" in d:
        fields["cost"] = to_int(d["cost"], "HPP (modal)", 0, 100_000_000, allow_none=True)
    if "reorder_level" in d:
        fields["reorder_level"] = to_int(d["reorder_level"], "Batas stok menipis", 0, 1_000_000, allow_none=True)
    if "stock_tracked" in d:
        fields["stock_tracked"] = 1 if d["stock_tracked"] else 0
    if "available" in d:
        fields["available"] = 1 if d["available"] else 0
    if "active" in d:
        fields["active"] = 1 if d["active"] else 0
    if "image_key" in d:
        fields["image_key"] = d["image_key"] if d["image_key"] in VALID_IMAGE_KEYS else "snack"
    for key, limit in (("name", 80), ("category", 40), ("variant", 80)):
        if key in d:
            fields[key] = str(d[key]).strip()[:limit]
    if "name" in fields and not fields["name"]:
        raise ApiError(400, "Nama menu tidak boleh kosong.")
    if "category" in fields and not fields["category"]:
        raise ApiError(400, "Kategori tidak boleh kosong.")
    return fields


@route("POST", r"/api/products", "owner")
def r_product_add(req):
    d = req.data
    d.setdefault("category", "Lainnya")
    if not str(d.get("name", "")).strip():
        raise ApiError(400, "Nama dan kategori wajib diisi.")
    f = clean_product_fields(d, partial=False)
    pid = "new-" + uuid.uuid4().hex[:12]
    with db(write=True) as c:
        c.execute("""INSERT INTO products(id,name,category,variant,price,cost,image_key,draft,active,updated_at)
                     VALUES(?,?,?,?,?,?,?,0,1,?)""",
                  (pid, f["name"], f["category"], f.get("variant", ""), f["price"], f.get("cost"),
                   f.get("image_key", "snack"), now()))
        audit(c, req.user, "tambah_menu", f"{f['name']} harga {f['price']}")
        return Resp(201, {"item": row_dict(c.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone())})


@route("PUT", r"/api/products/([^/]+)", "owner")
def r_product_edit(req):
    pid = unquote(req.match.group(1))
    f = clean_product_fields(req.data, partial=True)
    if not f:
        raise ApiError(400, "Tidak ada perubahan.")
    f["updated_at"] = now()
    with db(write=True) as c:
        old = c.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
        if not old:
            raise ApiError(404, "Menu tidak ditemukan.")
        c.execute(f"UPDATE products SET {','.join(k + '=?' for k in f)} WHERE id=?", (*f.values(), pid))
        changes = [f"{k}: {old[k]}→{v}" for k, v in f.items() if k != "updated_at" and old[k] != v]
        if changes:
            audit(c, req.user, "ubah_menu", f"{old['name']} | " + "; ".join(changes))
        return {"item": row_dict(c.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone())}


@route("POST", r"/api/products/([^/]+)/availability")
def r_product_availability(req):
    pid = unquote(req.match.group(1))
    avail = 1 if req.data.get("available") else 0
    with db(write=True) as c:
        cur = c.execute("UPDATE products SET available=?,updated_at=? WHERE id=? AND active=1", (avail, now(), pid))
        if cur.rowcount != 1:
            raise ApiError(404, "Menu tidak ditemukan.")
        p = c.execute("SELECT name FROM products WHERE id=?", (pid,)).fetchone()
        audit(c, req.user, "menu_tersedia" if avail else "menu_habis", p["name"])
    return {"id": pid, "available": avail}


# --------------------------------------------------------------------------- rute: varian
@route("GET", r"/api/modifiers")
def r_modifiers(req):
    with db() as c:
        groups = rows(c, "SELECT * FROM modifier_groups WHERE active=1 ORDER BY sort,name")
        for g in groups:
            g["options"] = variant_options(c, g["id"])
        assignments = {}
        for r in c.execute("SELECT category,group_id FROM category_modifier_groups ORDER BY sort,rowid"):
            assignments.setdefault(r["category"], []).append(r["group_id"])
        cats = [r[0] for r in c.execute("SELECT DISTINCT category FROM products WHERE active=1 ORDER BY category")]
    return {"groups": groups, "categories": assignments, "product_categories": cats}


@route("POST", r"/api/modifiers/groups", "owner")
def r_group_add(req):
    d = req.data
    name = str(d.get("name", "")).strip()[:60]
    if not name:
        raise ApiError(400, "Nama kelompok varian tidak boleh kosong.")
    lo = to_int(d.get("min_select", 0), "Wajib pilih minimal", 0, 20)
    hi = to_int(d.get("max_select", 1), "Maksimal pilih", 1, 20)
    if lo > hi:
        raise ApiError(400, "Minimal pilih tidak boleh lebih besar dari maksimal.")
    gid = "g-" + uuid.uuid4().hex[:8]
    with db(write=True) as c:
        order = c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM modifier_groups").fetchone()[0]
        try:
            c.execute("INSERT INTO modifier_groups(id,name,min_select,max_select,sort,active) VALUES(?,?,?,?,?,1)",
                      (gid, name, lo, hi, order))
        except sqlite3.IntegrityError:
            raise ApiError(409, "Nama kelompok itu sudah ada.")
        g = row_dict(c.execute("SELECT * FROM modifier_groups WHERE id=?", (gid,)).fetchone())
        g["options"] = []
        audit(c, req.user, "tambah_kelompok_varian", name)
    return Resp(201, {"item": g})


@route("POST", r"/api/modifiers/options", "owner")
def r_option_add(req):
    d = req.data
    gid = str(d.get("group_id", "")).strip()
    name = str(d.get("name", "")).strip()[:60]
    delta = to_int(d.get("price_delta", 0), "Tambahan harga", 0, 10_000_000)
    if not name:
        raise ApiError(400, "Nama pilihan tidak boleh kosong.")
    with db(write=True) as c:
        if not c.execute("SELECT 1 FROM modifier_groups WHERE id=? AND active=1", (gid,)).fetchone():
            raise ApiError(404, "Kelompok varian tidak ditemukan.")
        order = c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM modifiers WHERE group_id=?", (gid,)).fetchone()[0]
        oid = "o-" + uuid.uuid4().hex[:8]
        c.execute("INSERT INTO modifiers(id,group_id,name,price_delta,sort,active) VALUES(?,?,?,?,?,1)",
                  (oid, gid, name, delta, order))
        audit(c, req.user, "tambah_pilihan_varian", f"{name} +{delta}")
        return Resp(201, {"item": row_dict(c.execute("SELECT * FROM modifiers WHERE id=?", (oid,)).fetchone())})


@route("PUT", r"/api/modifiers/option/([^/]+)", "owner")
def r_option_edit(req):
    oid, d, fields = unquote(req.match.group(1)), req.data, {}
    if "name" in d:
        fields["name"] = str(d["name"]).strip()[:60]
        if not fields["name"]:
            raise ApiError(400, "Nama pilihan tidak boleh kosong.")
    if "price_delta" in d:
        fields["price_delta"] = to_int(d["price_delta"], "Tambahan harga", 0, 10_000_000)
    if "active" in d:
        fields["active"] = 1 if d["active"] else 0
    if not fields:
        raise ApiError(400, "Tidak ada perubahan.")
    with db(write=True) as c:
        cur = c.execute(f"UPDATE modifiers SET {','.join(k + '=?' for k in fields)} WHERE id=?", (*fields.values(), oid))
        if cur.rowcount != 1:
            raise ApiError(404, "Pilihan tidak ditemukan.")
        audit(c, req.user, "ubah_pilihan_varian", f"{oid}: {fields}")
        return {"item": row_dict(c.execute("SELECT * FROM modifiers WHERE id=?", (oid,)).fetchone())}


@route("PUT", r"/api/modifiers/group/([^/]+)", "owner")
def r_group_edit(req):
    gid, d, fields = unquote(req.match.group(1)), req.data, {}
    if "name" in d:
        fields["name"] = str(d["name"]).strip()[:60]
        if not fields["name"]:
            raise ApiError(400, "Nama kelompok varian tidak boleh kosong.")
    if "min_select" in d:
        fields["min_select"] = to_int(d["min_select"], "Wajib pilih minimal", 0, 20)
    if "max_select" in d:
        fields["max_select"] = to_int(d["max_select"], "Maksimal pilih", 1, 20)
    if "active" in d:
        fields["active"] = 1 if d["active"] else 0
    if not fields:
        raise ApiError(400, "Tidak ada perubahan.")
    with db(write=True) as c:
        g = c.execute("SELECT * FROM modifier_groups WHERE id=?", (gid,)).fetchone()
        if not g:
            raise ApiError(404, "Kelompok varian tidak ditemukan.")
        if fields.get("min_select", g["min_select"]) > fields.get("max_select", g["max_select"]):
            raise ApiError(400, "Minimal pilih tidak boleh lebih besar dari maksimal.")
        try:
            c.execute(f"UPDATE modifier_groups SET {','.join(k + '=?' for k in fields)} WHERE id=?", (*fields.values(), gid))
        except sqlite3.IntegrityError:
            raise ApiError(409, "Nama kelompok itu sudah ada.")
        audit(c, req.user, "ubah_kelompok_varian", f"{g['name']}: {fields}")
        return {"item": row_dict(c.execute("SELECT * FROM modifier_groups WHERE id=?", (gid,)).fetchone())}


@route("PUT", r"/api/modifiers/category/(.+)", "owner")
def r_category_groups(req):
    category = unquote(req.match.group(1))
    group_ids = [str(g) for g in (req.data.get("group_ids") or [])]
    with db(write=True) as c:
        known = {r[0] for r in c.execute("SELECT id FROM modifier_groups WHERE active=1")}
        unknown = [g for g in group_ids if g not in known]
        if unknown:
            raise ApiError(400, "Kelompok varian tidak dikenal: " + ", ".join(unknown))
        c.execute("DELETE FROM category_modifier_groups WHERE category=?", (category,))
        for i, gid in enumerate(dict.fromkeys(group_ids)):
            c.execute("INSERT INTO category_modifier_groups(category,group_id,sort) VALUES(?,?,?)", (category, gid, i))
        audit(c, req.user, "pasang_varian_kategori", f"{category}: {group_ids}")
    return {"category": category, "group_ids": group_ids}


@route("DELETE", r"/api/modifiers/option/([^/]+)", "owner")
def r_option_del(req):
    oid = unquote(req.match.group(1))
    with db(write=True) as c:
        cur = c.execute("UPDATE modifiers SET active=0 WHERE id=?", (oid,))
        audit(c, req.user, "nonaktif_pilihan_varian", oid)
    return {"deleted": cur.rowcount, "mode": "nonaktif"}


@route("DELETE", r"/api/modifiers/group/([^/]+)", "owner")
def r_group_del(req):
    gid = unquote(req.match.group(1))
    with db(write=True) as c:
        cur = c.execute("UPDATE modifier_groups SET active=0 WHERE id=?", (gid,))
        c.execute("UPDATE modifiers SET active=0 WHERE group_id=?", (gid,))
        c.execute("DELETE FROM category_modifier_groups WHERE group_id=?", (gid,))
        audit(c, req.user, "nonaktif_kelompok_varian", gid)
    return {"deleted": cur.rowcount, "mode": "nonaktif"}


# --------------------------------------------------------------------------- rute: stok
@route("GET", r"/api/stock", "owner")
def r_stock(req):
    with db() as c:
        return {"items": rows(c, """SELECT id,name,category,variant,stock_on_hand,reorder_level,image_key,stock_tracked
                                    FROM products WHERE active=1 ORDER BY category,name,variant,id""")}


@route("POST", r"/api/stock/count", "owner")
def r_stock_count(req):
    d = req.data
    product_id = str(d.get("product_id", ""))
    counted = to_int(d.get("counted_quantity"), "Stok dihitung", 0, 1_000_000)
    note = str(d.get("note", "")).strip()[:240]
    with db(write=True) as c:
        p = c.execute("SELECT * FROM products WHERE id=? AND active=1", (product_id,)).fetchone()
        if not p:
            raise ApiError(404, "Menu tidak ditemukan.")
        old = p["stock_on_hand"]
        delta = counted if old is None else counted - old
        kind = "opening_count" if old is None else "count_adjustment"
        c.execute("UPDATE products SET stock_on_hand=?,stock_tracked=1,updated_at=? WHERE id=?", (counted, now(), product_id))
        c.execute("INSERT INTO stock_movements(product_id,movement_type,quantity_change,resulting_quantity,note,created_at) VALUES(?,?,?,?,?,?)",
                  (product_id, kind, delta, counted, note, now()))
        audit(c, req.user, "hitung_stok", f"{p['name']}: {old}→{counted}")
        item = row_dict(c.execute("SELECT id,name,stock_on_hand,reorder_level,stock_tracked FROM products WHERE id=?", (product_id,)).fetchone())
    return Resp(201, {"item": item, "quantity_change": delta})


# --------------------------------------------------------------------------- hitung nota
def compute_discount(disc, subtotal, user, settings):
    """Kembalikan (jumlah_diskon, alasan). Kasir dibatasi pengaturan pemilik."""
    if not disc:
        return 0, ""
    if not isinstance(disc, dict):
        raise ApiError(400, "Format diskon tidak valid.")
    kind = disc.get("type")
    if kind == "percent":
        pct = to_percent(disc.get("value"), "Diskon (%)")
        amount = money_round(Decimal(subtotal) * pct / 100)
    elif kind == "nominal":
        amount = to_int(disc.get("value"), "Diskon (Rp)", 0)
    else:
        raise ApiError(400, "Jenis diskon tidak dikenal.")
    if amount == 0:
        return 0, ""
    if amount > subtotal:
        raise ApiError(400, "Diskon tidak boleh melebihi subtotal.")
    reason = str(disc.get("reason", "")).strip()[:120]
    if not reason:
        raise ApiError(400, "Isi alasan diskon.")
    if user["role"] != "owner":
        limit = Decimal(settings["kasir_max_discount_percent"])
        if limit <= 0:
            raise ApiError(403, "Diskon hanya bisa diberikan pemilik.")
        if Decimal(amount) * 100 > Decimal(subtotal) * limit:
            raise ApiError(403, f"Diskon kasir maksimal {limit.normalize():f}% dari subtotal.")
    return amount, reason


def compute_totals(subtotal, discount, settings):
    """Urutan: subtotal − diskon → + service → + pajak (dari dasar+service) → pembulatan."""
    base = subtotal - discount
    service = money_round(Decimal(base) * Decimal(settings["service_percent"]) / 100)
    tax = money_round(Decimal(base + service) * Decimal(settings["tax_percent"]) / 100)
    raw = base + service + tax
    step = int(settings["rounding"])
    total = raw
    if step:
        rounded = ((raw + step // 2) // step) * step
        total = rounded if rounded > 0 else raw
    return service, tax, total - raw, total


def open_shift_of(c, user_id):
    return c.execute("SELECT * FROM shifts WHERE user_id=? AND closed_at IS NULL", (user_id,)).fetchone()


def sale_detail(c, sale_id):
    s = c.execute("""SELECT s.*, u.name AS cashier FROM sales s LEFT JOIN users u ON u.id=s.user_id
                     WHERE s.id=?""", (sale_id,)).fetchone()
    if not s:
        return None
    d = row_dict(s)
    d["items"] = rows(c, "SELECT * FROM sale_items WHERE sale_id=? ORDER BY id", (sale_id,))
    return d


@route("POST", r"/api/sales")
def r_sale_add(req):
    d, user = req.data, req.user
    items = d.get("items")
    if not isinstance(items, list) or not items:
        raise ApiError(400, "Pesanan masih kosong.")
    if len(items) > 100:
        raise ApiError(400, "Terlalu banyak baris pesanan.")
    method = str(d.get("payment_method", "")).strip()
    if method not in PAYMENT_METHODS:
        raise ApiError(400, "Pilih cara bayar.")
    order_type = d.get("order_type", "dine_in")
    if order_type not in ORDER_TYPES:
        raise ApiError(400, "Jenis pesanan tidak dikenal.")
    table_no = str(d.get("table_no", "")).strip()[:20]
    note = str(d.get("note", "")).strip()[:240]
    raw_request = d.get("request_id")
    request_id = str(raw_request).strip() if raw_request else ""
    if request_id and not re.fullmatch(r"[A-Za-z0-9._:-]{6,64}", request_id):
        raise ApiError(400, "Kunci permintaan transaksi tidak valid.")
    lines = {}
    for entry in items:
        if not isinstance(entry, dict):
            raise ApiError(400, "Format pesanan tidak valid.")
        pid = str(entry.get("product_id", ""))
        qty = to_int(entry.get("quantity"), "Jumlah", 1, 999)
        chosen = entry.get("modifiers") or []
        if not isinstance(chosen, list):
            raise ApiError(400, "Format varian tidak valid.")
        ids = tuple(sorted(str(m.get("id") if isinstance(m, dict) else m) for m in chosen))
        lines[(pid, ids)] = lines.get((pid, ids), 0) + qty

    with db(write=True) as c:
        if request_id:
            dup = c.execute("SELECT id FROM sales WHERE request_id=?", (request_id,)).fetchone()
            if dup:
                return {"item": sale_detail(c, dup["id"]), "duplicate": True}
        shift = open_shift_of(c, user["id"])
        if not shift:
            raise ApiError(409, "Kasir belum dibuka. Buka kasir dulu dan isi uang awal laci.")
        settings = get_settings(c)
        prepared, need, products = [], {}, {}
        for (pid, opt_ids), qty in lines.items():
            p = products.get(pid) or c.execute("SELECT * FROM products WHERE id=? AND active=1", (pid,)).fetchone()
            if not p:
                raise ApiError(404, f"Menu {pid} tidak ditemukan.")
            products[pid] = p
            if p["price"] is None:
                raise ApiError(409, f"Harga {p['name']} belum diisi.")
            if not p["available"]:
                raise ApiError(409, f"{p['name']} sedang habis.")
            if not p["stock_tracked"] and REQUIRE_STOCK:
                raise ApiError(409, f"Stok {p['name']} belum dilacak; hitung stok fisik dulu.")
            delta, summary, var_lines = resolve_item_variants(c, p, opt_ids)
            need[pid] = need.get(pid, 0) + qty
            prepared.append((p, qty, p["price"] + delta, summary, var_lines))
        for pid, qty in need.items():
            p = products[pid]
            if p["stock_tracked"]:
                if p["stock_on_hand"] is None:
                    raise ApiError(409, f"Stok {p['name']} terlacak tetapi angkanya kosong; hitung stok fisik dulu.")
                if p["stock_on_hand"] < qty:
                    raise ApiError(409, f"Stok {p['name']} tidak cukup (sisa {p['stock_on_hand']}).")
        subtotal = sum(unit * qty for _, qty, unit, _, _ in prepared)
        discount, reason = compute_discount(d.get("discount"), subtotal, user, settings)
        service, tax, rounding, total = compute_totals(subtotal, discount, settings)
        if method == "tunai":
            paid = to_int(d.get("amount_paid"), "Uang diterima", 0)
            if paid < total:
                raise ApiError(400, "Uang yang diterima kurang dari total.")
        else:
            paid = total
        stamp, today = now(), business_date()
        seq = c.execute("SELECT COUNT(*) FROM sales WHERE business_date=?", (today,)).fetchone()[0] + 1
        sale_id = f"KS{today[2:4]}{today[5:7]}{today[8:10]}-{seq:03d}"
        while c.execute("SELECT 1 FROM sales WHERE id=?", (sale_id,)).fetchone():
            seq += 1
            sale_id = f"KS{today[2:4]}{today[5:7]}{today[8:10]}-{seq:03d}"
        c.execute("""INSERT INTO sales(id,created_at,total_amount,payment_method,status,note,business_date,request_id,
                       subtotal,discount_amount,discount_reason,service_amount,tax_amount,rounding_amount,
                       amount_paid,change_amount,order_type,table_no,user_id,shift_id)
                     VALUES(?,?,?,?,'paid',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (sale_id, stamp, total, method, note, today, request_id or None, subtotal, discount, reason,
                   service, tax, rounding, paid, paid - total, order_type, table_no, user["id"], shift["id"]))
        for p, qty, unit, summary, var_lines in prepared:
            cur = c.execute("""INSERT INTO sale_items(sale_id,product_id,name_snapshot,variant_snapshot,unit_price,
                                 quantity,line_total,modifiers_summary,cost_snapshot) VALUES(?,?,?,?,?,?,?,?,?)""",
                            (sale_id, p["id"], p["name"], p["variant"], unit, qty, unit * qty, summary, p["cost"]))
            for vl in var_lines:
                c.execute("INSERT INTO sale_item_modifiers(sale_item_id,group_name,modifier_name,price_delta) VALUES(?,?,?,?)",
                          (cur.lastrowid, vl["group_name"], vl["modifier_name"], vl["price_delta"]))
        for pid, qty in need.items():
            p = products[pid]
            if p["stock_tracked"]:
                left = p["stock_on_hand"] - qty
                c.execute("UPDATE products SET stock_on_hand=?,updated_at=? WHERE id=?", (left, stamp, pid))
                c.execute("INSERT INTO stock_movements(product_id,movement_type,quantity_change,resulting_quantity,note,created_at) VALUES(?,?,?,?,?,?)",
                          (pid, "sale", -qty, left, sale_id, stamp))
        return Resp(201, {"item": sale_detail(c, sale_id)})


@route("GET", r"/api/sales")
def r_sales(req):
    day = req.arg("date") or business_date()
    raw_limit = req.arg("limit", "100")
    limit = min(max(int(raw_limit), 1), 500) if raw_limit.isdigit() else 100
    if day != "all":
        parse_date(day, "transaksi")
    owner = is_owner(req)
    sql = """SELECT s.*, u.name AS cashier FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE 1=1"""
    args = []
    if not owner:
        day = business_date()
    if day != "all":
        sql += " AND s.business_date=?"; args.append(day)
    if not owner:
        sql += " AND s.user_id=?"; args.append(req.user["id"])
    sql += " ORDER BY s.created_at DESC LIMIT ?"; args.append(limit)
    with db() as c:
        sales = rows(c, sql, args)
        if sales:
            marks = ",".join("?" * len(sales))
            by_sale = {}
            for it in rows(c, f"SELECT * FROM sale_items WHERE sale_id IN ({marks}) ORDER BY id", [s["id"] for s in sales]):
                by_sale.setdefault(it["sale_id"], []).append(it)
            for s in sales:
                s["items"] = by_sale.get(s["id"], [])
    return {"items": sales, "date": day}


@route("GET", r"/api/sales/([A-Za-z0-9-]+)")
def r_sale_get(req):
    with db() as c:
        s = sale_detail(c, req.match.group(1))
    if not s or (not is_owner(req) and s["user_id"] != req.user["id"]):
        raise ApiError(404, "Transaksi tidak ditemukan.")
    return {"item": s}


@route("POST", r"/api/sales/([A-Za-z0-9-]+)/void", "owner")
def r_sale_void(req):
    sale_id = req.match.group(1)
    reason = str(req.data.get("reason", "")).strip()[:160]
    if not reason:
        raise ApiError(400, "Isi alasan pembatalan.")
    with db(write=True) as c:
        s = c.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
        if not s:
            raise ApiError(404, "Transaksi tidak ditemukan.")
        if s["status"] == "void":
            raise ApiError(409, "Transaksi ini sudah dibatalkan.")
        stamp = now()
        for mv in rows(c, "SELECT * FROM stock_movements WHERE note=? AND movement_type='sale'", (sale_id,)):
            p = c.execute("SELECT stock_on_hand FROM products WHERE id=?", (mv["product_id"],)).fetchone()
            back = (p["stock_on_hand"] or 0) - mv["quantity_change"]
            c.execute("UPDATE products SET stock_on_hand=?,updated_at=? WHERE id=?", (back, stamp, mv["product_id"]))
            c.execute("INSERT INTO stock_movements(product_id,movement_type,quantity_change,resulting_quantity,note,created_at) VALUES(?,?,?,?,?,?)",
                      (mv["product_id"], "void", -mv["quantity_change"], back, sale_id, stamp))
        c.execute("UPDATE sales SET status='void',void_reason=?,voided_by=?,voided_at=? WHERE id=?",
                  (reason, req.user["name"], stamp, sale_id))
        audit(c, req.user, "batal_transaksi", f"{sale_id} Rp{s['total_amount']} — {reason}")
        return {"item": sale_detail(c, sale_id)}


# --------------------------------------------------------------------------- rute: kas / shift
def shift_report(c, shift):
    s = row_dict(shift)
    sales = rows(c, """SELECT payment_method, COUNT(*) n, SUM(total_amount) total, SUM(discount_amount) discount,
                       SUM(tax_amount) tax, SUM(service_amount) service FROM sales
                       WHERE shift_id=? AND status!='void' GROUP BY payment_method""", (s["id"],))
    cash = sum(r["total"] for r in sales if r["payment_method"] == "tunai")
    voids = c.execute("SELECT COUNT(*), COALESCE(SUM(total_amount),0) FROM sales WHERE shift_id=? AND status='void'", (s["id"],)).fetchone()
    s["by_method"] = sales
    s["sales_count"] = sum(r["n"] for r in sales)
    s["sales_total"] = sum(r["total"] for r in sales)
    s["cash_sales"] = cash
    s["void_count"], s["void_total"] = voids[0], voids[1]
    s["expected_cash"] = s["opening_cash"] + cash if s["closed_at"] is None else s["expected_cash"]
    cashier = c.execute("SELECT name FROM users WHERE id=?", (s["user_id"],)).fetchone()
    s["cashier"] = cashier["name"] if cashier else ""
    return s


@route("GET", r"/api/shifts/current")
def r_shift_current(req):
    with db() as c:
        sh = open_shift_of(c, req.user["id"])
        return {"shift": shift_report(c, sh) if sh else None}


@route("POST", r"/api/shifts/open")
def r_shift_open(req):
    cash = to_int(req.data.get("opening_cash"), "Uang awal laci", 0, 100_000_000)
    with db(write=True) as c:
        if open_shift_of(c, req.user["id"]):
            raise ApiError(409, "Kasir sudah dibuka.")
        cur = c.execute("INSERT INTO shifts(user_id,opened_at,opening_cash) VALUES(?,?,?)", (req.user["id"], now(), cash))
        audit(c, req.user, "buka_kasir", f"uang awal Rp{cash}")
        return Resp(201, {"shift": shift_report(c, c.execute("SELECT * FROM shifts WHERE id=?", (cur.lastrowid,)).fetchone())})


@route("POST", r"/api/shifts/close")
def r_shift_close(req):
    counted = to_int(req.data.get("counted_cash"), "Uang di laci", 0, 1_000_000_000)
    note = str(req.data.get("note", "")).strip()[:240]
    with db(write=True) as c:
        sh = open_shift_of(c, req.user["id"])
        if not sh:
            raise ApiError(409, "Tidak ada kasir yang sedang terbuka.")
        rep = shift_report(c, sh)
        diff = counted - rep["expected_cash"]
        c.execute("UPDATE shifts SET closed_at=?,counted_cash=?,expected_cash=?,difference=?,note=? WHERE id=?",
                  (now(), counted, rep["expected_cash"], diff, note, sh["id"]))
        audit(c, req.user, "tutup_kasir", f"seharusnya Rp{rep['expected_cash']}, dihitung Rp{counted}, selisih {diff}")
        return {"shift": shift_report(c, c.execute("SELECT * FROM shifts WHERE id=?", (sh["id"],)).fetchone())}


@route("GET", r"/api/shifts", "owner")
def r_shifts(req):
    with db() as c:
        return {"items": [shift_report(c, r) for r in c.execute("SELECT * FROM shifts ORDER BY id DESC LIMIT 30").fetchall()]}


# --------------------------------------------------------------------------- rute: laporan
def range_args(req):
    today = datetime.now(TZ).date()
    start = parse_date(req.arg("from") or today.isoformat(), "mulai")
    end = parse_date(req.arg("to") or start.isoformat(), "akhir")
    if end < start:
        raise ApiError(400, "Tanggal akhir sebelum tanggal mulai.")
    if (end - start).days > 366:
        raise ApiError(400, "Rentang laporan maksimal 1 tahun.")
    return start.isoformat(), end.isoformat()


@route("GET", r"/api/reports/summary", "owner")
def r_summary(req):
    today = business_date()
    week = (datetime.now(TZ).date() - timedelta(days=6)).isoformat()
    with db() as c:
        day = c.execute("SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) total FROM sales WHERE business_date=? AND status!='void'", (today,)).fetchone()
        daily = {r["d"]: r for r in c.execute("SELECT business_date d, COUNT(*) n, SUM(total_amount) total FROM sales WHERE business_date>=? AND status!='void' GROUP BY business_date", (week,))}
        series = []
        for i in range(7):
            d = (datetime.now(TZ).date() - timedelta(days=6 - i)).isoformat()
            series.append({"date": d, "n": daily[d]["n"] if d in daily else 0, "total": daily[d]["total"] if d in daily else 0})
        low = rows(c, """SELECT id,name,stock_on_hand,reorder_level FROM products WHERE active=1 AND stock_tracked=1
                         AND stock_on_hand IS NOT NULL AND reorder_level IS NOT NULL AND stock_on_hand<=reorder_level
                         ORDER BY stock_on_hand LIMIT 20""")
        top = rows(c, """SELECT si.name_snapshot name, SUM(si.quantity) qty, SUM(si.line_total) revenue FROM sale_items si
                         JOIN sales s ON s.id=si.sale_id WHERE s.business_date=? AND s.status!='void'
                         GROUP BY si.product_id ORDER BY qty DESC LIMIT 5""", (today,))
        stats = c.execute("""SELECT SUM(active=1) menus, SUM(active=1 AND stock_tracked=0) untracked,
                             SUM(active=1 AND stock_tracked=1) tracked, SUM(active=1 AND cost IS NULL) no_cost,
                             SUM(active=1 AND price IS NULL) no_price, SUM(active=1 AND available=0) sold_out
                             FROM products""").fetchone()
        open_shifts = [shift_report(c, r) for r in c.execute("SELECT * FROM shifts WHERE closed_at IS NULL").fetchall()]
    return {"today": today, "timezone": TZ_NAME, "today_transactions": day["n"], "today_total": day["total"],
            "series": series, "low_stock": low, "top_today": top, "open_shifts": open_shifts,
            "menus": stats["menus"] or 0, "untracked": stats["untracked"] or 0, "tracked": stats["tracked"] or 0,
            "no_cost": stats["no_cost"] or 0, "no_price": stats["no_price"] or 0, "sold_out": stats["sold_out"] or 0}


@route("GET", r"/api/reports/range", "owner")
def r_range(req):
    start, end = range_args(req)
    cond, args = "s.business_date BETWEEN ? AND ?", (start, end)
    with db() as c:
        t = c.execute(f"""SELECT COUNT(*) n, COALESCE(SUM(subtotal),0) subtotal, COALESCE(SUM(discount_amount),0) discount,
                          COALESCE(SUM(service_amount),0) service, COALESCE(SUM(tax_amount),0) tax,
                          COALESCE(SUM(rounding_amount),0) rounding, COALESCE(SUM(total_amount),0) total
                          FROM sales s WHERE {cond} AND status!='void'""", args).fetchone()
        v = c.execute(f"SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) total FROM sales s WHERE {cond} AND status='void'", args).fetchone()
        by_method = rows(c, f"SELECT payment_method method, COUNT(*) n, SUM(total_amount) total FROM sales s WHERE {cond} AND status!='void' GROUP BY payment_method ORDER BY total DESC", args)
        by_hour = rows(c, f"SELECT substr(created_at,12,2) hour, COUNT(*) n, SUM(total_amount) total FROM sales s WHERE {cond} AND status!='void' GROUP BY hour ORDER BY hour", args)
        by_day = rows(c, f"SELECT business_date date, COUNT(*) n, SUM(total_amount) total FROM sales s WHERE {cond} AND status!='void' GROUP BY business_date ORDER BY business_date", args)
        by_type = rows(c, f"SELECT order_type, COUNT(*) n, SUM(total_amount) total FROM sales s WHERE {cond} AND status!='void' GROUP BY order_type", args)
        top = rows(c, f"""SELECT si.product_id id, si.name_snapshot name, SUM(si.quantity) qty, SUM(si.line_total) revenue,
                          SUM(CASE WHEN si.cost_snapshot IS NOT NULL THEN si.line_total END) revenue_with_cost,
                          SUM(CASE WHEN si.cost_snapshot IS NOT NULL THEN si.cost_snapshot*si.quantity END) cost
                          FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE {cond} AND s.status!='void'
                          GROUP BY si.product_id ORDER BY qty DESC LIMIT 15""", args)
        cov = c.execute(f"""SELECT COALESCE(SUM(si.line_total),0) revenue,
                            COALESCE(SUM(CASE WHEN si.cost_snapshot IS NOT NULL THEN si.line_total END),0) revenue_with_cost,
                            COALESCE(SUM(CASE WHEN si.cost_snapshot IS NOT NULL THEN si.cost_snapshot*si.quantity END),0) cost
                            FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE {cond} AND s.status!='void'""", args).fetchone()
    net = t["subtotal"] - t["discount"]
    return {"from": start, "to": end, "transactions": t["n"], "subtotal": t["subtotal"], "discount": t["discount"],
            "net_sales": net, "service": t["service"], "tax": t["tax"], "rounding": t["rounding"], "total": t["total"],
            "average": round(t["total"] / t["n"]) if t["n"] else 0,
            "void_count": v["n"], "void_total": v["total"],
            "cost_known": cov["cost"], "revenue_with_cost": cov["revenue_with_cost"],
            "gross_profit_known": cov["revenue_with_cost"] - cov["cost"],
            "cost_coverage": round(cov["revenue_with_cost"] * 100 / cov["revenue"]) if cov["revenue"] else None,
            "by_method": by_method, "by_hour": by_hour, "by_day": by_day, "by_type": by_type, "top": top}


@route("GET", r"/api/reports/export.csv", "owner")
def r_export(req):
    start, end = range_args(req)
    kind = req.arg("type", "sales")
    out = io.StringIO()
    w = csv.writer(out)
    with db() as c:
        if kind == "items":
            w.writerow(["No. Nota", "Tanggal", "Menu", "Varian", "Jumlah", "Harga satuan", "Total baris", "HPP satuan", "Status"])
            for r in c.execute("""SELECT s.id,s.business_date,si.name_snapshot,si.modifiers_summary,si.quantity,si.unit_price,
                                  si.line_total,si.cost_snapshot,s.status FROM sale_items si JOIN sales s ON s.id=si.sale_id
                                  WHERE s.business_date BETWEEN ? AND ? ORDER BY s.created_at,si.id""", (start, end)):
                w.writerow([csv_safe(x) for x in r])
        else:
            w.writerow(["No. Nota", "Waktu", "Kasir", "Jenis", "Meja", "Cara bayar", "Subtotal", "Diskon", "Service",
                        "Pajak", "Pembulatan", "Total", "Dibayar", "Kembalian", "Status", "Catatan"])
            for r in c.execute("""SELECT s.id,s.created_at,u.name,s.order_type,s.table_no,s.payment_method,s.subtotal,
                                  s.discount_amount,s.service_amount,s.tax_amount,s.rounding_amount,s.total_amount,
                                  s.amount_paid,s.change_amount,s.status,s.note FROM sales s LEFT JOIN users u ON u.id=s.user_id
                                  WHERE s.business_date BETWEEN ? AND ? ORDER BY s.created_at""", (start, end)):
                w.writerow([csv_safe(x) for x in r])
    name = f"kopi-sawah-{kind}-{start}_{end}.csv"
    return Resp(200, body=("﻿" + out.getvalue()).encode("utf-8"), content_type="text/csv; charset=utf-8",
                headers=[("Content-Disposition", f'attachment; filename="{name}"')])


@route("GET", r"/api/audit", "owner")
def r_audit(req):
    with db() as c:
        return {"items": rows(c, "SELECT at,user_name,action,detail FROM audit_log ORDER BY id DESC LIMIT 100")}


@route("GET", r"/api/admin/backup", "owner")
def r_backup(req):
    stamp = datetime.now(TZ).strftime("%Y%m%d-%H%M")
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "backup.sqlite3"
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
        finally:
            dst.close(); src.close()
        data = target.read_bytes()
    with db(write=True) as c:
        audit(c, req.user, "unduh_cadangan")
    return Resp(200, body=data, content_type="application/octet-stream",
                headers=[("Content-Disposition", f'attachment; filename="kopi-sawah-cadangan-{stamp}.sqlite3"')])


# --------------------------------------------------------------------------- HTTP
SECURITY_HEADERS = [
    ("X-Content-Type-Options", "nosniff"), ("X-Frame-Options", "DENY"), ("Referrer-Policy", "no-referrer"),
    ("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                                "script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
]


class Handler(BaseHTTPRequestHandler):
    server_version = "KopiSawah/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")  # tidak mencatat isi permintaan

    def session_token(self):
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "ks_session":
                return v
        return ""

    def send_bytes(self, status, body, content_type, headers=(), cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        for k, v in (*SECURITY_HEADERS, *headers):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, data, headers=()):
        self.send_bytes(status, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                        "application/json; charset=utf-8", headers)

    def body_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            raise ApiError(400, "Panjang isi permintaan tidak valid.")
        if length < 0 or length > 1_000_000:
            raise ApiError(413, "Isi permintaan terlalu besar.")
        raw = self.rfile.read(length) if length else b""
        try:
            value = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "Format data tidak valid.")
        if not isinstance(value, dict):
            raise ApiError(400, "Isi permintaan harus berupa objek data.")
        return value

    def origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return not REQUIRE_ORIGIN
        host = self.headers.get("Host", "").strip().lower()
        scheme = self.headers.get("X-Forwarded-Proto", "http").split(",", 1)[0].strip().lower()
        p = urlparse(origin)
        return bool(host) and p.scheme.lower() == scheme and p.netloc.lower() == host and p.path in ("", "/") and not p.query and not p.fragment

    def serve_static(self, path):
        rel = "index.html" if path in ("/", "/index.html") else path.removeprefix("/static/") if path.startswith("/static/") else None
        if rel is None:
            return self.send_json(404, {"error": "Rute tidak ditemukan."})
        candidate = (STATIC / rel).resolve()
        if STATIC.resolve() not in candidate.parents or not candidate.is_file():
            return self.send_json(404, {"error": "Berkas tidak ditemukan."})
        data = candidate.read_bytes()
        mime = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        if mime.startswith("text/") or mime in ("application/javascript", "image/svg+xml"):
            mime += "; charset=utf-8"
        etag = '"' + hashlib.sha1(data).hexdigest()[:16] + '"'
        is_image = candidate.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
        cache = "public, max-age=604800" if is_image else "no-cache"
        if self.headers.get("If-None-Match") == etag:
            return self.send_bytes(304, b"", mime, [("ETag", etag)], cache)
        self.send_bytes(200, data, mime, [("ETag", etag)], cache)

    def dispatch(self, method):
        url = urlparse(self.path)
        path = unquote(url.path)
        if method in ("GET", "HEAD") and not path.startswith("/api/"):
            return self.serve_static(path)
        method = "GET" if method == "HEAD" else method
        req = Req(self, method, path, parse_qs(url.query))
        try:
            matched, path_known = None, False
            for m, rx, role, fn in ROUTES:
                mt = rx.match(path)
                if not mt:
                    continue
                path_known = True
                if m == method:
                    matched = (mt, role, fn)
                    break
            if not matched:
                raise ApiError(405 if path_known else 404, "Metode tidak diizinkan." if path_known else "Rute tidak ditemukan.")
            req.match, role, fn = matched
            if method != "GET" and not self.origin_ok():
                raise ApiError(403, "Asal permintaan tidak diizinkan.")
            if role != "public" or fn is r_auth_status:
                with db() as c:
                    req.user = user_for_token(c, self.session_token())
                if not req.user and TANPA_LOGIN and PENGGUNA_TANPA_LOGIN:
                    req.user = PENGGUNA_TANPA_LOGIN
            if role != "public" and not req.user:
                raise ApiError(401, "Silakan masuk dulu.")
            if role == "owner" and req.user["role"] != "owner":
                raise ApiError(403, "Fitur ini hanya untuk pemilik.")
            result = fn(req)
            if isinstance(result, Resp):
                if result.body is not None:
                    return self.send_bytes(result.status, result.body, result.content_type, result.headers)
                return self.send_json(result.status, result.payload, result.headers)
            return self.send_json(200, result)
        except ApiError as exc:
            return self.send_json(exc.status, {"error": exc.message})
        except sqlite3.IntegrityError as exc:
            print("IntegrityError:", exc, file=sys.stderr)
            return self.send_json(409, {"error": "Data tidak dapat disimpan karena bertabrakan dengan data lain."})
        except Exception:
            traceback.print_exc()
            return self.send_json(500, {"error": "Terjadi kesalahan di server. Coba lagi; jika berulang, hubungi pengelola sistem."})

    def do_GET(self): self.dispatch("GET")
    def do_HEAD(self): self.dispatch("HEAD")
    def do_POST(self): self.dispatch("POST")
    def do_PUT(self): self.dispatch("PUT")
    def do_DELETE(self): self.dispatch("DELETE")


def main():
    init_db()
    if TANPA_LOGIN:
        u = pastikan_pengguna_tanpa_login()
        print(f"MODE TANPA LOGIN aktif: semua permintaan dianggap {u['name']} (peran pemilik).")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    with db() as c:
        has_users = c.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0
    print(f"Kopi Sawah: http://127.0.0.1:{PORT}  (zona waktu {TZ_NAME})")
    print(f"Database: {DB_PATH}")
    if not has_users and not TANPA_LOGIN:
        print(f"PENYIAPAN AWAL: buka aplikasi, lalu masukkan KODE PENYIAPAN: {SETUP_CODE}")
    print("Port ini hanya untuk nginx/lokal. Jangan dibuka langsung ke internet.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
