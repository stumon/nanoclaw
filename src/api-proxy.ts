/**
 * Lightweight HTTP reverse proxy for LLM API calls.
 *
 * Listens on the container bridge interface (192.168.64.1) so that
 * Apple Containers can reach the LLM API through the host, which has
 * VPN / corporate network access that containers lack.
 *
 * Traffic flow:
 *   Container → http://192.168.64.1:8462/path → proxy → https://real-api/path
 */
import http from 'http';
import https from 'https';
import { logger } from './logger.js';

const PROXY_PORT = 8462;
const BRIDGE_IP = '192.168.64.1';

let proxyServer: http.Server | null = null;

export function startApiProxy(targetOrigin: string): void {
  if (proxyServer) return;

  const target = new URL(targetOrigin);

  proxyServer = http.createServer((req, res) => {
    const targetUrl = `${target.protocol}//${target.host}${req.url}`;

    const options: https.RequestOptions = {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    };

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      logger.error({ err, targetUrl }, 'API proxy upstream error');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'proxy upstream error' }));
      }
    });

    req.pipe(proxyReq);
  });

  proxyServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRNOTAVAIL') {
      logger.warn('API proxy: bridge100 not available yet, skipping');
      proxyServer = null;
      return;
    }
    logger.error({ err }, 'API proxy error');
  });

  proxyServer.listen(PROXY_PORT, BRIDGE_IP, () => {
    logger.info(
      { listen: `${BRIDGE_IP}:${PROXY_PORT}`, target: target.origin },
      'API proxy started',
    );
  });
}

/**
 * Rewrite OPENAI_BASE_URL to point through the proxy.
 * e.g. https://compass.llm.shopee.io/compass-api/v1
 *    → http://192.168.64.1:8462/compass-api/v1
 */
export function proxyBaseUrl(originalUrl: string): string {
  const parsed = new URL(originalUrl);
  return `http://${BRIDGE_IP}:${PROXY_PORT}${parsed.pathname}`;
}

export function stopApiProxy(): void {
  proxyServer?.close();
  proxyServer = null;
}
