import { defineConfig } from "vite";

// The vanilla arm's port, fixed: PRD-770 names :5736 for it and the ledger rows carry the URL.
export default defineConfig({ server: { port: 5736, strictPort: true, host: "127.0.0.1" } });
