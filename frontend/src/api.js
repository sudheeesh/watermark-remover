// Base URL for the backend API.
// - Dev: VITE_API_BASE is unset → empty string, so relative "/api/..." calls go
//   through the Vite dev proxy (see vite.config.js).
// - Prod (Vercel): set VITE_API_BASE to the Render backend origin, e.g.
//   https://watermark-remover-1-2han.onrender.com
export const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");

// Prefix an API path ("/api/...") with the backend origin.
export const apiUrl = (path) => API_BASE + path;
