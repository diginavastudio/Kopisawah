#!/usr/bin/env python3
"""Potong foto menu dari PDF "Menu Baru Kopi Sawah" menjadi berkas 4:3 di static/images/.

Pemakaian:  python3 tools/crop_menu_photos.py <menu.pdf> [folder-keluaran]
Perlu: poppler-utils (pdfimages) dan Pillow. Alat pengembang — tidak dipakai saat aplikasi berjalan.

Setiap foto di PDF adalah gambar tersemat; kotak potong (x0, y0, x1, y1) ada di PHOTOS dalam piksel
gambar tersemat. Kotak yang hampir 4:3 dipotong pas; yang jauh (tinggi/lebar) dipasang utuh di atas
latar buram dari gambarnya sendiri, supaya piringnya tidak terpotong.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageFilter

# nama-berkas: (indeks gambar tersemat hasil `pdfimages -all`, kotak potong)
PHOTOS = {
    "nasi-goreng-seafood": (0, (195, 700, 595, 1000)),
    "bakmi-godog": (0, (15, 590, 300, 804)),
    "bakmi-goreng": (0, (250, 515, 515, 714)),
    "kwetiau-goreng": (0, (470, 560, 778, 791)),
    "ayam-goreng": (1, (0, 20, 375, 301)),
    "ayam-bakar": (1, (345, 15, 735, 308)),
    "udang-saos-tiram": (3, (295, 0, 755, 270)),
    "cumi-krispy": (3, (15, 215, 545, 615)),
    "udang-krispy": (3, (540, 170, 1090, 583)),
    "gurame-bakar-madu": (6, (90, 185, 580, 455)),
    "gurame-krispy": (6, (680, 190, 1125, 400)),
    "gurame-asam-manis": (6, (185, 420, 680, 712)),
    "gurame-asam-pedas": (6, (695, 400, 1300, 700)),
    "sop-sawah": (7, (105, 120, 420, 320)),
    "tom-yum": (7, (400, 190, 650, 375)),
    "paket-lele": (8, (110, 0, 600, 362)),
    "paket-nila": (11, (60, 0, 610, 362)),
    "paket-ayam": (13, (95, 0, 600, 361)),
    "paket-ayam-kampung": (9, (55, 0, 545, 362)),
    "wedang-uwuh": (15, (0, 520, 225, 835)),
    "wedang-jahe-sereh-jeruk": (15, (190, 530, 385, 830)),
    "lemon-tea": (15, (370, 520, 595, 830)),
    "wedang-susu-jahe": (15, (575, 530, 787, 825)),
    "long-black": (18, (10, 570, 300, 870)),
    "cappucino": (18, (235, 665, 560, 905)),
    "v60": (18, (485, 480, 720, 790)),
    "ice-americano": (18, (585, 655, 865, 915)),
    "jus-melon": (19, (0, 330, 385, 810)),
    "jus-buah-naga": (19, (350, 385, 680, 905)),
    "jus-alpukat": (19, (605, 375, 986, 870)),
    "es-telang": (20, (905, 400, 1414, 1100)),  # Ice Teh Telang & Ice Lemon Telang tampil bersama di foto
    "lychee-tea": (20, (60, 1080, 500, 1790)),
    "ice-cream": (20, (790, 1100, 1350, 1560)),
    "jangan-ndeso": (2, (0, 880, 1582, 2060)),
}
RATIO = 4 / 3
OUT_W_MAX = 800


def fit(img: Image.Image) -> Image.Image:
    w, h = img.size
    r = w / h
    out_w = min(OUT_W_MAX, max(240, round(w * 1.6)))
    out_h = round(out_w / RATIO)
    if 1.2 <= r <= 1.45:  # hampir 4:3 → potong pas dari tengah
        if r > RATIO:
            nw = round(h * RATIO); x = (w - nw) // 2; img = img.crop((x, 0, x + nw, h))
        else:
            nh = round(w / RATIO); y = (h - nh) // 2; img = img.crop((0, y, w, y + nh))
        return img.resize((out_w, out_h), Image.LANCZOS)
    bg = img.copy()  # latar buram dari gambar yang sama
    s = max(out_w / bg.width, out_h / bg.height)
    bg = bg.resize((round(bg.width * s), round(bg.height * s)), Image.LANCZOS)
    x, y = (bg.width - out_w) // 2, (bg.height - out_h) // 2
    bg = bg.crop((x, y, x + out_w, y + out_h)).filter(ImageFilter.GaussianBlur(18))
    s = min(out_w / w, out_h / h)
    fg = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    bg.paste(fg, ((out_w - fg.width) // 2, (out_h - fg.height) // 2))
    return bg


def main():
    pdf = sys.argv[1]
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / "static" / "images"
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdfimages", "-all", pdf, f"{tmp}/e"], check=True)
        for name, (idx, box) in PHOTOS.items():
            src = Path(f"{tmp}/e-{idx:03d}.jpg")
            img = Image.open(src).convert("RGB").crop(box)
            fit(img).save(out / f"{name}.jpg", "JPEG", quality=84, optimize=True, progressive=True)
            print("ok", name, img.size)


if __name__ == "__main__":
    main()
