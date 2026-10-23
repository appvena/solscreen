# SolScreen — Outcome

## Dashboard screening harian
- [x] Dashboard berbahasa Indonesia menampilkan ringkasan screening harian (dipindai, lolos, perlu review, ditolak) — angka dihitung dari dataset, bukan ditulis tetap.
- [x] Semua data simulasi diberi label jelas; panel Kesehatan Sumber tidak lagi menampilkan provider sebagai "sehat/live".
- [x] Tanggal dan waktu sinkron terakhir dinamis; tombol sinkron memuat ulang data.

## Kandidat token dan intelijen risiko
- [x] Kartu kandidat: simbol/nama, harga, likuiditas, volume, waktu deteksi, wallet dev, holder, bubble map, sosial, roadmap, risiko, alasan.
- [x] Modal detail aksesibel (role=dialog, Esc menutup, focus trap, fokus kembali).
- [x] Tone tiap sinyal disimpan di data (bukan ditebak dari kata kunci).
- [x] Sparkline dinormalisasi min/max sehingga aman untuk harga asli.

## Review AI (Claude API)
- [x] Endpoint server `ai.status` & `ai.reviewToken` (tRPC) memakai Anthropic SDK + structured output (Zod).
- [x] API key hanya di server (`ANTHROPIC_API_KEY`); model bisa diganti lewat `CLAUDE_MODEL`.
- [x] Validasi input, rate limit 6 permintaan/menit per klien, pesan error berbahasa Indonesia (401/404/429).
- [x] Prompt melarang saran beli/jual; hasil berisi verdict, skor risiko, keyakinan, red flag, sinyal positif, data kurang, cek berikutnya.
- [x] Test unit untuk status, validasi, parsing, dan rate limit.

## Akses aplikasi
- [x] Layar login dengan satu password bersama (awal 123456), sesi cookie bertanda tangan HMAC, 30 hari.
- [x] Ganti password dari dalam aplikasi (hash scrypt, disimpan di DATA_DIR), keluar, banner peringatan password bawaan.
- [x] Endpoint Claude hanya untuk sesi login; batas percobaan login.

## Alert dan pengaturan
- [x] Ambang kenaikan preset (10/20/30%) + kustom 1–500% dengan validasi, bisa dihapus.
- [x] Ambang penurunan, frekuensi, notifikasi push browser (meminta izin), Telegram ditandai "segera hadir".
- [x] Pengaturan disimpan di localStorage (draft → Simpan/Batal/Reset).

## Berikutnya
- [ ] Sambungkan provider data Solana (GeckoTerminal / DexScreener / RugCheck) dan kirim data live ke Claude.
- [ ] Simpan hasil screening dan review ke database.
- [ ] Pindahkan pengaturan ke backend; notifikasi push/Telegram dari server.
