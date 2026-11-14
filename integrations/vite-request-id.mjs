// Request-ID injection for the Vite dev proxy (plan section 5, level 2).
//
// Every proxied request gets an X-Request-Id header on its way to Tomcat, and the same ID is
// echoed on the response so the browser (and therefore Debug Hub) can see it.
//
// vite.config.js:
//
//   import { withRequestId } from '/path/to/WebAssist/integrations/vite-request-id.mjs';
//
//   export default defineConfig({
//     server: {
//       proxy: {
//         '/api': withRequestId({ target: 'http://localhost:8080', changeOrigin: true }),
//       },
//     },
//   });
import { randomUUID } from 'node:crypto';

export function withRequestId(proxyOptions, header = 'X-Request-Id') {
  const name = header.toLowerCase();
  const userConfigure = proxyOptions.configure;
  return {
    ...proxyOptions,
    configure(proxy, options) {
      proxy.on('proxyReq', (proxyReq, req) => {
        const id = req.headers[name] || randomUUID();
        req.headers[name] = id;
        proxyReq.setHeader(header, id);
      });
      proxy.on('proxyRes', (proxyRes, req) => {
        if (req.headers[name] && !proxyRes.headers[name]) proxyRes.headers[name] = req.headers[name];
      });
      userConfigure?.(proxy, options);
    },
  };
}
