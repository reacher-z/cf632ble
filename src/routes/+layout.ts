// The whole app is a client-only Web Bluetooth SPA: prerender the shell to static files and
// disable SSR (nothing here can or should run on a server — no `window`/`navigator` at build time).
export const prerender = true;
export const ssr = false;
