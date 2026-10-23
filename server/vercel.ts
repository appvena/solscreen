// Vercel serverless entry: the same Express API, without Vite or static serving
// (Vercel's CDN serves the built frontend from .vercel/output/static).
import { createApiApp } from "./_core/app";

const app = createApiApp();
export default app;
