#!/usr/bin/env python3
"""Isi saran keterangan + deskripsi menu (draf AI) ke tabel product_saran.

Aturan pemilik (5 Nov 2026): kategori Lauk = lauk saja, TANPA nasi — deskripsi Lauk
tidak boleh menyebut nasi, dan deskripsi lama yang menyebut nasi diperbaiki.

Jalankan: python3 tools/saran-menu.py [--db /var/lib/kopi-sawah/kopi-sawah.sqlite3]
"""
import argparse
import sqlite3
from datetime import datetime

# (nama, varian) -> deskripsi draf
SARAN = {
    # ---- Lauk (tanpa nasi) ----
    ("Ayam Bakar", ""): "Ayam bakar berbumbu meresap, disajikan hangat dengan sambal dan lalapan segar.",
    ("Ayam Goreng", ""): "Ayam goreng gurih, renyah di luar dan lembut di dalam. Disajikan dengan sambal dan lalapan.",
    ("Ayam Kampung Bakar", ""): "Ayam kampung dibakar dengan bumbu rempah dan kecap manis, disajikan bersama sambal terasi dan lalapan.",
    ("Ayam Kampung Goreng", ""): "Ayam kampung goreng berbumbu, aroma rempah kuat, disajikan dengan sambal terasi dan lalapan.",
    ("Chicken Karage BBQ", ""): "Potongan ayam krispi dengan saus BBQ, disajikan hangat.",
    ("Chicken Karage Saos Lada Hitam", ""): "Ayam krispi dengan saus lada hitam yang gurih dan sedikit pedas.",
    ("Chicken Karage Saos Tiram", ""): "Ayam krispi dengan saus tiram gurih, disajikan hangat.",
    ("Chicken Katsu BBQ", ""): "Ayam fillet berbalut tepung roti dengan saus BBQ, disajikan dengan salad segar.",
    ("Chicken Katsu Original", ""): "Ayam fillet krispi berbalut tepung roti, disajikan dengan salad segar.",
    ("Chicken Katsu Saos Lada Hitam", ""): "Ayam fillet krispi dengan saus lada hitam, disajikan dengan salad segar.",
    ("Chicken Katsu Saos Tiram", ""): "Ayam fillet krispi dengan saus tiram, disajikan dengan salad segar.",
    ("Cumi Krispy", ""): "Cumi berbalut tepung krispi, gurih dan renyah, cocok disantap hangat.",
    ("Cumi Saos BBQ", ""): "Cumi dengan saus BBQ manis gurih, disajikan hangat.",
    ("Cumi Saos Lada Hitam", ""): "Cumi dengan saus lada hitam yang pedas gurih.",
    ("Cumi Saos Tiram", ""): "Cumi dengan saus tiram gurih, disajikan hangat.",
    ("Gurame Asam Manis", ""): "Gurame goreng dengan saus asam manis, segar dan gurih.",
    ("Gurame Asam Pedas", ""): "Gurame goreng dengan saus asam pedas yang menggugah selera.",
    ("Gurame Bakar Madu", ""): "Gurame bakar dengan olesan madu, manis dan harum.",
    ("Gurame Krispy", ""): "Gurame goreng krispi, renyah di luar dan lembut di dalam.",
    ("Lele Bakar", ""): "Lele bakar berbumbu, disajikan hangat dengan sambal.",
    ("Lele Goreng", ""): "Lele goreng gurih dan krispi, disajikan dengan sambal.",
    ("Nila Bakar", ""): "Nila bakar berbumbu, harum dan gurih, disajikan dengan sambal.",
    ("Nila Goreng", ""): "Nila goreng krispi, disajikan hangat dengan sambal.",
    ("Nila Krispy", "Tanpa tulang"): "Nila krispi tanpa tulang, praktis disantap, disajikan dengan sambal.",
    ("Nila Masak Pedas", ""): "Nila dimasak dengan bumbu pedas, disajikan hangat.",
    ("Udang Krispy", ""): "Udang berbalut tepung krispi, gurih dan renyah.",
    ("Udang Saos BBQ", ""): "Udang dengan saus BBQ manis gurih.",
    ("Udang Saos Lada Hitam", ""): "Udang dengan saus lada hitam pedas gurih.",
    ("Udang Saos Tiram", ""): "Udang dengan saus tiram gurih.",
    # ---- Camilan ----
    ("Bakwan", ""): "Bakwan sayur goreng, renyah di luar dan lembut di dalam.",
    ("Cireng", ""): "Cireng kenyal dengan sambal, camilan hangat yang gurih.",
    ("Gemblong Cotot", ""): "Gemblong ketan berbalut gula aren, manis dan legit.",
    ("Kentang Goreng", ""): "Kentang goreng renyah, cocok untuk camilan bersama.",
    ("Mendoan", ""): "Tempe mendoan tipis berbalut tepung, disajikan dengan sambal kecap.",
    ("Pisang", "Goreng / Bakar"): "Pisang goreng atau bakar, manis dan hangat.",
    ("Pisang Pasir Coklat", ""): "Pisang berbalut coklat dan keju, manis dan lembut.",
    ("Roti Bakar", ""): "Roti bakar hangat dengan isian manis.",
    ("Singkong Goreng Keju", ""): "Singkong goreng renyah dengan taburan keju.",
    ("Sosis", "Goreng / Bakar"): "Sosis goreng atau bakar, gurih dan praktis.",
    ("Tahu Bakso", ""): "Tahu isi bakso, gurih dan bertekstur.",
    ("Tahu Cabe Garam", ""): "Tahu goreng dengan taburan cabe garam, pedas gurih.",
    ("Tahu Goreng", ""): "Tahu goreng hangat, renyah di luar dan lembut di dalam.",
    ("Tempe Tanpa Tepung", ""): "Tempe goreng tanpa tepung, gurih dan sederhana.",
    # ---- Kopi ----
    ("Americano", "Es / Panas"): "Espresso dengan air, segar saat dingin dan pekat saat panas.",
    ("Cappucino", "Es"): "Espresso dengan susu dan busa lembut, disajikan dingin.",
    ("Cappucino", "Panas"): "Espresso dengan susu dan busa lembut, disajikan hangat.",
    ("Coffee Latte", "Es / Panas"): "Espresso dengan susu, lembut dan tidak terlalu pekat.",
    ("Es Kopi Susu", "Original"): "Kopi susu dingin dengan gula cair, manisnya seimbang.",
    ("Es Kopi Susu Gula Aren / Hazelnut", ""): "Kopi susu dingin dengan gula aren atau hazelnut.",
    ("Espresso", ""): "Seduhan kopi pekat, porsi kecil, untuk penikmat kopi murni.",
    ("Kopi Tubruk", "Temanggung / Merapi"): "Kopi tubruk seduhan langsung, pekat dan harum.",
    ("Long Black", ""): "Espresso dengan air panas, lebih ringan dari espresso.",
    ("Moccacino", "Es"): "Kopi dengan coklat dan susu, disajikan dingin.",
    ("Moccacino", "Panas"): "Kopi dengan coklat dan susu, disajikan hangat.",
    ("V60", ""): "Kopi seduh manual V60, ringan dan aromatik.",
    ("Vietnam Drip", ""): "Kopi Vietnam drip dengan susu kental manis.",
    # ---- Minuman ----
    ("Air Mineral 600 ml", ""): "Air mineral kemasan 600 ml.",
    ("Beras Kencur", ""): "Jamu beras kencur, manis dan menyegarkan.",
    ("Chocolate", "Es"): "Minuman coklat dingin, manis dan lembut.",
    ("Chocolate", "Panas"): "Minuman coklat hangat, manis dan lembut.",
    ("Chocolate Strawberry Ice", ""): "Coklat dan stroberi dingin, manis dan segar.",
    ("Es Campur", ""): "Es campur dengan buah, cincau, dan sirup, segar dan manis.",
    ("Es Lemon Telang", ""): "Teh telang dengan lemon, segar dan sedikit asam.",
    ("Es Teh", ""): "Teh dingin manis, minuman sehari-hari.",
    ("Es Teh Telang", ""): "Teh telang dingin, warna biru alami, segar.",
    ("Ice Cream", "Stik"): "Es krim stik, manis dan praktis.",
    ("Ice Cream", "Cup"): "Es krim cup, lembut dan manis.",
    ("Jus Alpukat", ""): "Jus alpukat segar, lembut dan mengenyangkan.",
    ("Jus Buah Naga", ""): "Jus buah naga segar, manis dan lembut.",
    ("Jus Jambu", ""): "Jus jambu segar, manis dan harum.",
    ("Jus Mangga", ""): "Jus mangga segar, manis dan kental.",
    ("Jus Melon", ""): "Jus melon segar, ringan dan manis.",
    ("Jus Nangka", ""): "Jus nangka segar, harum dan manis.",
    ("Jus Pakel", ""): "Jus pakel segar, manis sedikit asam.",
    ("Jus Semangka", ""): "Jus semangka segar, ringan dan menyegarkan.",
    ("Jus Tomat", ""): "Jus tomat segar, sedikit asam dan menyegarkan.",
    ("Jus Wortel", ""): "Jus wortel segar, manis alami.",
    ("Kunir Asem", ""): "Jamu kunir asem, segar dan sedikit asam.",
    ("Lemon Tea", ""): "Teh dengan lemon, segar dan manis asam.",
    ("Lychee Tea", ""): "Teh leci, manis dan harum.",
    ("Soda Ceria", ""): "Soda dingin dengan sirup, segar dan berbuih.",
    ("Teh Krampul", ""): "Seduhan teh krampul, hangat dan harum.",
    # ---- Wedangan ----
    ("Bir Jawa", ""): "Wedang rempah khas Jawa, hangat dan manis, tanpa alkohol.",
    ("Wedang Coklat", ""): "Seduhan coklat hangat, manis dan lembut.",
    ("Wedang Jahe", ""): "Jahe seduh hangat, pedas lembut dan menghangatkan.",
    ("Wedang Jahe Sereh Jeruk", ""): "Jahe, sereh, dan jeruk, hangat dan segar.",
    ("Wedang Jeruk", ""): "Seduhan jeruk hangat, segar dan manis asam.",
    ("Wedang Jeruk Nipis", ""): "Jeruk nipis hangat, segar dan sedikit asam.",
    ("Wedang Susu", "Putih / Coklat"): "Susu hangat, pilih putih atau coklat.",
    ("Wedang Susu Jahe", ""): "Susu hangat dengan jahe, lembut dan menghangatkan.",
    ("Wedang Tape", ""): "Wedang tape hangat, manis dan sedikit asam.",
    ("Wedang Teh", ""): "Teh hangat, sederhana dan menenangkan.",
    ("Wedang Teh Jahe", ""): "Teh hangat dengan jahe, pedas lembut.",
    ("Wedang Teh Lemon", ""): "Teh hangat dengan lemon, segar.",
    ("Wedang Teh Teko", ""): "Teh hangat disajikan satu teko, cocok untuk berbagi.",
    ("Wedang Uwuh", ""): "Wedang uwuh rempah khas, hangat dan harum.",
    # ---- Add-on ----
    ("Air Es", ""): "Segelas air dingin dengan es.",
    ("Es Batu", ""): "Es batu untuk menambah dingin minuman.",
    ("Nasi Putih", ""): "Nasi putih hangat, satu porsi.",
    ("Sambal Bawang", ""): "Sambal bawang pedas, pelengkap lauk.",
    ("Sambal Terasi", ""): "Sambal terasi pedas gurih.",
    ("Telur Goreng", ""): "Telur goreng, pelengkap lauk atau nasi.",
}

DRINK_CATS = ("Kopi", "Minuman", "Wedangan")


def short_suggestion(name, variant, category):
    if variant:
        return variant
    low = name.lower()
    if "es" in low.split():
        return "Es"
    if "panas" in low.split():
        return "Panas"
    if category == "Lauk":
        return "Tanpa nasi"
    if category == "Wedangan":
        return "Panas"
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/var/lib/kopi-sawah/kopi-sawah.sqlite3")
    args = ap.parse_args()
    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row
    con.execute("""CREATE TABLE IF NOT EXISTS product_saran (
        product_id TEXT PRIMARY KEY REFERENCES products(id),
        short TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        sumber TEXT NOT NULL DEFAULT 'digi', dibuat_at TEXT NOT NULL)""")
    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    rows = list(con.execute("SELECT id,name,category,variant,description FROM products WHERE active=1"))
    terisi = dipakai_lama = 0
    for p in rows:
        key = (p["name"], p["variant"] or "")
        desc = SARAN.get(key)
        if desc is None:
            desc = p["description"] or ""
            dipakai_lama += 1
        short = short_suggestion(p["name"], p["variant"] or "", p["category"])
        con.execute("""INSERT INTO product_saran(product_id,short,description,sumber,dibuat_at) VALUES(?,?,?,?,?)
                       ON CONFLICT(product_id) DO UPDATE SET short=excluded.short, description=excluded.description,
                       sumber=excluded.sumber, dibuat_at=excluded.dibuat_at""",
                    (p["id"], short, desc, "digi", stamp))
        if desc and desc != (p["description"] or ""):
            terisi += 1
    # deskripsi Lauk yang menyebut nasi diperbaiki (aturan pemilik: Lauk tanpa nasi)
    lauk = 0
    for p in rows:
        if p["category"] != "Lauk":
            continue
        key = (p["name"], p["variant"] or "")
        new = SARAN.get(key)
        if new and new != (p["description"] or ""):
            con.execute("UPDATE products SET description=?, updated_at=? WHERE id=?", (new, stamp, p["id"]))
            lauk += 1
    con.commit()
    sisa_nasi = con.execute("SELECT COUNT(*) FROM products WHERE category='Lauk' AND active=1 AND lower(description) LIKE '%nasi%'").fetchone()[0]
    print(f"produk aktif: {len(rows)} · saran ditulis: {len(rows)} · deskripsi baru: {terisi} · deskripsi Lauk diperbaiki: {lauk}")
    print(f"deskripsi Lauk yang masih menyebut nasi: {sisa_nasi}")
    con.close()


if __name__ == "__main__":
    main()
