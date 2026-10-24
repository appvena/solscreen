# SolScreen — Intelijen Token Solana

Dashboard screening token **baru** Solana (≤24 jam, harga < Rp1) dengan data live:
GeckoTerminal (pool baru) + DexScreener (harga, likuiditas, media sosial) + RugCheck (authority, wallet dev,
distribusi holder, jaringan insider sebagai pengganti bubble map). Kandidat yang lolos ditinjau Claude
(otomatis: `claude-haiku-5-5` + pencarian web untuk media sosial & rencana proyek; "Review mendalam": `CLAUDE_MODEL`).
Bukan saran investasi. Kode screening: `server/screening/`, Claude: `server/claudeReview.ts`, meter kredit: `server/usage.ts`.

Bagian "Hampir rilis": token pump.fun yang masih di bonding curve (≥60%), progres dibaca dari akun bonding curve
on-chain lewat Solana RPC (`SOLANA_RPC_URL`, default RPC publik mainnet; bisa diganti RPC Helius/QuickNode bila dibatasi).

Variabel opsional: `CLAUDE_AUTO_MODEL`, `CLAUDE_MODEL`, `CLAUDE_WEB_SEARCH=off`, `CLAUDE_DAILY_REVIEW_LIMIT` (default 60 review baru/hari).
Hubungkan Upstash Redis agar cache review, meter kredit, dan ganti password dari web tersimpan permanen.

## Deploy ke Vercel (gratis, tanpa kartu kredit)

1. Di https://vercel.com/new pilih `appvena/solscreen`, Application Preset **Other**, klik **Deploy**.
2. Proyek → **Settings → Environment Variables**, tambahkan:
   - `ANTHROPIC_API_KEY` — key dari platform.claude.com (untuk review AI)
   - `APP_PASSWORD` — password untuk masuk aplikasi (tanpa ini: `123456`)
3. **Deployments → ⋯ → Redeploy**.

Hanya itu. Tidak perlu database: di Vercel password dibaca dari `APP_PASSWORD`.
Ganti password = edit `APP_PASSWORD` lalu Redeploy (semua perangkat diminta login ulang).

Opsional — ingin ganti password dari dalam aplikasi? Hubungkan **Storage → Upstash (Redis)** dan jangan isi
`APP_PASSWORD`; menu Pengaturan → Keamanan akan menampilkan form ganti password.

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

- Password awal: **123456**. Setelah login, banner kuning akan meminta Anda menggantinya.
- Jika `APP_PASSWORD` diisi (atau di Vercel tanpa Redis): password = nilai variabel itu; ganti di dashboard hosting.
- Selain itu: ganti di **Pengaturan alert → Keamanan** (minimal 8 karakter). Sesi lain otomatis keluar.
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
