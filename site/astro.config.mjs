import { defineConfig } from 'astro/config';

// Fully static: the dashboard reads its data from files next to the page, so
// there is nothing to render on a server and nothing to run at the edge.
export default defineConfig({
  output: 'static',
  build: { inlineStylesheets: 'auto' },
  vite: {
    // Every dependency is bundled so the page runs under a CSP with no external
    // script origins at all. See public/_headers.
    build: { target: 'es2022', assetsInlineLimit: 2048 },
  },
});
