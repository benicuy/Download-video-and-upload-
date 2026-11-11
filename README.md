# DownloadMaster

Website unduh video/foto dari direct link + upload foto & video dengan penyimpanan di backend.
Tidak ada dependensi eksternal: cukup Node.js 18 atau lebih baru.

## Menjalankan

```bash
npm start            # atau: node server.js
```

Buka http://localhost:3000

## Konfigurasi (environment variable)

| Nama | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port server |
| `DATA_DIR` | `./data` | Lokasi penyimpanan (`uploads/` berisi file, `db.json` berisi metadata & riwayat) |
| `MAX_UPLOAD_MB` | `1024` | Batas ukuran satu file upload |
| `ALLOW_PRIVATE_TARGETS` | (kosong) | Hanya untuk pengujian: `1` mengizinkan proxy ke alamat lokal/private |

## Cara kerja

- **Analisis** (`GET /api/info?url=`): server membaca nama, ukuran, dan tipe file dari link.
- **Download** (`GET /api/download?url=`): server mengambil file dari link asal lalu mengalirkannya ke browser
  sebagai attachment. Karena lewat server, aturan CORS browser tidak berlaku.
- **Upload** (`POST /api/upload`, header `Content-Type` dan `X-File-Name`): foto dan video disimpan ke `data/uploads/`
  dengan SHA-256 dan metadata di `data/db.json`.
- **Koleksi** (`GET /api/files?kind=image|video`), konten (`GET /api/files/:id/content`, mendukung Range untuk
  pemutaran video), dan hapus (`DELETE /api/files/:id`).
- **Riwayat download** (`GET /api/downloads`) tersimpan di `data/db.json`.

## Sebelum dipublikasikan ke internet

- Tidak ada login. Siapa pun yang punya alamat website bisa melihat, mengunduh, dan menghapus koleksi, serta
  memakai proxy download. Tambahkan autentikasi sebelum dipasang untuk umum.
- Penyimpanan berupa file lokal dan `db.json`. Untuk banyak data, pertimbangkan database sungguhan dan penyimpanan
  object (mis. S3) dengan backup.
- Proxy sudah memblokir alamat private/localhost, tetapi belum ada batas lalu lintas per pengguna.
