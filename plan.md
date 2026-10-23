# SolScreen — Rencana Implementasi

## Scope
Dashboard web berbahasa Indonesia untuk screening dan pemantauan token baru Solana. Versi awal menggunakan mock data yang selalu diberi label simulasi; tidak ada fungsi transaksi, pembelian, atau penjualan.

## Gaya desain
- **Control-room noir** (0,07): dashboard terminal modern dengan panel gelap, garis kontur, dan aksen lime untuk sinyal yang lolos.
- **Soft fintech observatory** (0,06): kartu terang, whitespace, dan warna tenang untuk pengalaman yang lebih konservatif.
- **Terminal editorial** (0,05): layout teks padat bergaya laporan riset dengan aksen amber.

Dipilih: **Control-room noir**. Prinsipnya adalah (1) sinyal penting terlihat dalam satu scan, (2) data mentah dan kesimpulan dipisahkan, (3) risiko lebih menonjol daripada hype, dan (4) setiap angka memiliki status waktu/sumber. Palet memakai ink navy hampir hitam, steel blue, off-white, lime untuk status positif, amber untuk review, dan coral untuk risiko. Layout memakai sidebar sempit dan kanvas konten asimetris dengan panel ringkasan melebar, bukan grid kartu yang seragam. Motif khasnya berupa label monospace, garis scan pada banner simulasi, dan sparkline mini. Interaksi memakai transisi pendek dan drawer detail agar konteks tidak hilang. Tipografi menggunakan Inter/system sans untuk UI dan JetBrains Mono/monospace untuk alamat wallet, timestamp, dan label data. Brand essence: **intelijen token yang mengutamakan bukti sebelum momentum** — teliti, skeptis, operasional. CTA berbunyi “Tinjau kandidat” dan “Ubah ambang alert”, bukan bahasa yang mendorong transaksi. Wordmark berupa monogram heksagonal “S” dengan titik sinyal, direpresentasikan sebagai ikon CSS/SVG sederhana.

## Implementasi
- Frontend React + Tailwind dengan state lokal untuk filter, pengaturan alert, toast, dan detail kandidat.
- Mock data terisolasi di halaman agar mudah diganti dengan query tRPC/backend pada tahap berikutnya.
- Komponen visual: sidebar, topbar, simulation banner, KPI strip, token cards, risk rail, alert feed, settings panel, detail modal.
- Route publik `/` dan route manifest `public/manus-routes.json`.
- Tidak menambahkan kredensial, transaksi, atau API key.

## Struktur
- `client/src/pages/Home.tsx`: dashboard dan state interaksi.
- `client/src/index.css`: tokens visual, background, komponen custom, responsive rules.
- `public/manus-routes.json`: deklarasi route.
- `TODO.md`: acceptance outcomes.
