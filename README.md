# SolScreen — Intelijen Token Solana

## Deploy ke Vercel (gratis, tanpa kartu kredit)

1. Di https://vercel.com/new pilih **Import Git Repository** → `appvena/solscreen`.
   Pengaturan build sudah ada di `vercel.json` — biarkan default, klik **Deploy**.
2. Proyek → **Settings → Environment Variables**: tambahkan `ANTHROPIC_API_KEY`.
3. Proyek → **Storage → Create Database → Upstash (Redis)** → hubungkan ke proyek ini.
   Vercel otomatis menambahkan `KV_REST_API_URL` dan `KV_REST_API_TOKEN`. Ini menyimpan password yang Anda ganti.
4. **Deployments → Redeploy** supaya variabel baru terbaca. Buka `https://<nama-proyek>.vercel.app`, login `123456`, lalu ganti password.

Cara kerja: `pnpm build:vercel` membangun frontend (Vite) dan membundel API Express menjadi satu fungsi
(`server/vercel.ts` → `.vercel/output/functions/api.func`). Lihat `scripts/build-vercel.mjs`.


## Menyambungkan Claude API

1. Buat API key di https://console.anthropic.com/
2. Salin `.env.example` menjadi `.env`, lalu isi:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   CLAUDE_MODEL=claude-sonnet-5-5   # opsional
   ```
   Di platform hosting, isi sebagai secret / environment variable server.
3. Jalankan `pnpm dev` (atau `pnpm build && pnpm start`). Panel "Kesehatan sumber" akan menampilkan Claude API siap,
   dan tombol **Minta review AI** di detail kandidat aktif.

Kode terkait: `server/claudeReview.ts` (prompt, skema output, rate limit), `server/routers.ts` (`ai.status`, `ai.reviewToken`),
`client/src/pages/Home.tsx` (UI review). Data kandidat masih simulasi di `client/src/data/mockScreening.ts`.

## Password aplikasi

- Password awal: **123456** (atau isi `APP_DEFAULT_PASSWORD`). Setelah login, banner kuning akan meminta Anda menggantinya.
- Ganti password: **Pengaturan alert → Keamanan** (minimal 8 karakter). Sesi lain otomatis keluar.
- Password disimpan sebagai hash:
  - **Vercel:** di Upstash Redis (key `solscreen:app-auth`). Wajib dihubungkan, karena file di Vercel tidak permanen.
  - **Docker/Railway/lokal:** di `DATA_DIR/app-auth.json` (default `./data`, di Docker `/data` — pasang volume).
- Lupa password? Hapus key `solscreen:app-auth` di Upstash (menu Data Browser) atau file `app-auth.json`, lalu muat ulang — password kembali ke awal.
- Login dibatasi 10 percobaan gagal per 15 menit per IP. Endpoint Claude hanya bisa dipakai setelah login.

> Catatan: mode `pnpm dev:static` hanya menyajikan frontend, jadi review AI butuh `pnpm dev` (server Express).

---

React / Express / tRPC / Drizzle starter, adapted from the Sandbox web-db-user template.

- `pnpm dev`: development server; honors `PORT` (default 3000).
- `pnpm build` / `pnpm start`: build and serve `dist/index.js` and `dist/public/`.
- `pnpm db:migrate`: apply checked-in migrations. `pnpm db:push`: generate and apply new schema changes.
- `pnpm check` / `pnpm test`: types and application tests.

Start with the Webdev skill's default-template guide. Platform login, storage, payments and service contracts live in its shared references; read the relevant capability before extending its helper.

`server/_core/publicConfig.ts` exposes only named public runtime values. Private keys stay server-side. The platform serves managed `/manus-storage/` assets; the application does not register a second proxy.

Platform configuration is readable and editable through `webdev.config`. Default settings are initial values, not enforced constraints. The agent may modify the files, commands and configuration or follow the flexible guide for another stack.
