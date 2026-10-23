# SolScreen — Intelijen Token Solana

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
- Password disimpan sebagai hash di `DATA_DIR/app-auth.json` (default `./data`, di Docker `/data`).
  **Di Railway/Render, pasang volume/disk persisten ke `/data`**; tanpa itu password kembali ke 123456 setiap redeploy.
- Lupa password? Hapus `app-auth.json` di folder data lalu restart — password kembali ke awal.
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
