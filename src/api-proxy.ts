/**
 * Lightweight HTTP reverse proxy for container → host API calls.
 *
 * Listens on the container bridge interface (192.168.64.1) so that
 * Apple Containers can reach external APIs through the host, which has
 * VPN / corporate network access that containers lack.
 *
 * Traffic flow:
 *   Default:   Container → http://192.168.64.1:8462/path      → https://llm-api/path
 *   Prefixed:  Container → http://192.168.64.1:8462/__tavily/… → https://api.tavily.com/…
 */
import http from 'http';
import https from 'https';
import { chromium, type Browser } from 'playwright';
import { logger } from './logger.js';

const PROXY_PORT = 8462;
const BRIDGE_IP = '192.168.64.1';

/**
 * Path-prefix routes. Requests matching a prefix are forwarded to the
 * corresponding origin with the prefix stripped from the path.
 */
const EXTRA_ROUTES: Record<string, URL> = {
  '/__tavily/': new URL('https://api.tavily.com/'),
};

let proxyServer: http.Server | null = null;

export function startApiProxy(targetOrigin: string): void {
  if (proxyServer) return;

  const defaultTarget = new URL(targetOrigin);

  const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
  ]);

  function resolveTarget(url: string): { target: URL; path: string } {
    for (const [prefix, origin] of Object.entries(EXTRA_ROUTES)) {
      if (url.startsWith(prefix)) {
        return { target: origin, path: '/' + url.slice(prefix.length) };
      }
    }
    return { target: defaultTarget, path: url };
  }

  let fetchBrowser: Browser | null = null;

  async function handleFetchUrl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const url = body.url as string;
        const maxChars = (body.maxChars as number) || 30000;
        if (!url) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'url is required' }));
          return;
        }
        logger.info({ url }, 'FetchURL: starting');
        if (!fetchBrowser) {
          fetchBrowser = await chromium.launch({ headless: true });
        }
        const page = await fetchBrowser.newPage();
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await page.waitForTimeout(3000);
          const title = await page.title();
          const content: string = await page.evaluate(`
            (() => {
              const sels = [
                '#js_content', '.rich_media_content', 'article', 'main',
                '.post-content', '.article-content', '.entry-content',
                '#content', 'body',
              ];
              for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el && el.textContent && el.textContent.trim().length > 100) {
                  return el.textContent.trim();
                }
              }
              return document.body ? document.body.textContent.trim() : '';
            })()
          `);
          const trimmed = content.length > maxChars
            ? content.slice(0, maxChars) + '\n[...truncated]'
            : content;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ title, content: trimmed }));
          logger.info({ url, titleLen: title.length, contentLen: trimmed.length }, 'FetchURL: done');
        } finally {
          await page.close();
        }
      } catch (err) {
        logger.error({ err }, 'FetchURL error');
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  proxyServer = http.createServer((req, res) => {
    if (req.url === '/__fetch/' || req.url === '/__fetch') {
      handleFetchUrl(req, res);
      return;
    }

    const { target, path: fwdPath } = resolveTarget(req.url || '/');

    const fwdHeaders: Record<string, string | string[] | undefined> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) fwdHeaders[key] = val as string | string[] | undefined;
    }
    fwdHeaders['host'] = target.host;

    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(bodyChunks);
      fwdHeaders['content-length'] = String(body.length);

      const options: https.RequestOptions = {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: fwdPath,
        method: req.method,
        headers: fwdHeaders,
      };

      const targetUrl = `${target.protocol}//${target.host}${fwdPath}`;
      const transport = target.protocol === 'https:' ? https : http;
      const proxyReq = transport.request(options, (proxyRes) => {
        if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
          let respBody = '';
          proxyRes.on('data', (chunk: Buffer) => { respBody += chunk.toString(); });
          proxyRes.on('end', () => {
            logger.warn(
              { status: proxyRes.statusCode, body: respBody.slice(0, 500), url: targetUrl },
              'API proxy: upstream returned error',
            );
            res.writeHead(proxyRes.statusCode!, proxyRes.headers);
            res.end(respBody);
          });
        } else {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        }
      });

      proxyReq.on('error', (err) => {
        logger.error({ err, targetUrl }, 'API proxy upstream error');
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: 'proxy upstream error' }));
        }
      });

      proxyReq.write(body);
      proxyReq.end();
    });
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
      { listen: `${BRIDGE_IP}:${PROXY_PORT}`, target: defaultTarget.origin },
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

export async function stopApiProxy(): Promise<void> {
  proxyServer?.close();
  proxyServer = null;
}
