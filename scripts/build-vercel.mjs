// Builds the Vercel Build Output API layout (https://vercel.com/docs/build-output-api):
//   .vercel/output/static            -> Vite frontend (served by Vercel's CDN)
//   .vercel/output/functions/api.func -> bundled Express API (one Node function)
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".vercel/output");
const fnDir = path.join(out, "functions/api.func");

rmSync(out, { recursive: true, force: true });
mkdirSync(fnDir, { recursive: true });

// 1. Frontend (already built by `vite build` into dist/public)
cpSync(path.join(root, "dist/public"), path.join(out, "static"), { recursive: true });

// 2. API function: bundle everything into one CommonJS file.
await build({
  entryPoints: [path.join(root, "server/vercel.ts")],
  outfile: path.join(fnDir, "index.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  tsconfig: path.join(root, "tsconfig.json"),
  footer: { js: "module.exports = module.exports.default || module.exports;" },
  logLevel: "info",
});
writeFileSync(
  path.join(fnDir, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.cjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 60 }, null, 2),
);

// 3. Routing: static files first, then /api/* -> function, everything else -> SPA.
writeFileSync(
  path.join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/assets/(.*)", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
        { handle: "filesystem" },
        { src: "/api/(.*)", dest: "/api" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);
console.log("Vercel output ready in .vercel/output");
