/**
 * HTTP forward proxy for container outbound traffic.
 *
 * Solves: Apple Container NAT only allows containers to reach 192.168.64.1.
 * Without this proxy, containers cannot access the public internet at all.
 *
 * How it works:
 *   - Listens on 192.168.64.1:8463
 *   - Containers set HTTP_PROXY / HTTPS_PROXY pointing here
 *   - HTTPS: handled via CONNECT tunnel (raw TCP pipe to target)
 *   - HTTP:  handled as standard forward proxy (fetch and relay)
 *
 * This is the universal fix. Any tool inside the container that respects
 * HTTP_PROXY (curl, fetch, apt-get, pip, npm, Python requests, etc.)
 * will automatically route through the host without any per-tool config.
 */
import http from 'http';
import net from 'net';
import { logger } from './logger.js';

const FORWARD_PROXY_PORT = 8463;
const BRIDGE_IP = '192.168.64.1';

let server: http.Server | null = null;

export function startForwardProxy(): void {
  if (server) return;

  server = http.createServer((req, res) => {
    const targetUrl = req.url;
    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.writeHead(400);
      res.end('Bad Request: only absolute URLs accepted');
      return;
    }

    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? require('https') : http;
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...req.headers, host: parsed.host },
    };

    const proxyReq = transport.request(
      options,
      (proxyRes: http.IncomingMessage) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err: Error) => {
      logger.error({ err, url: targetUrl }, 'Forward proxy: upstream error');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    req.pipe(proxyReq);
  });

  // CONNECT method for HTTPS tunneling
  server.on(
    'connect',
    (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
      const [hostname, port] = (req.url || '').split(':');
      const targetPort = parseInt(port, 10) || 443;

      const targetSocket = net.connect(targetPort, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });

      targetSocket.on('error', (err) => {
        logger.error(
          { err, target: req.url },
          'Forward proxy: CONNECT tunnel error',
        );
        clientSocket.end();
      });

      clientSocket.on('error', () => {
        targetSocket.end();
      });
    },
  );

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRNOTAVAIL') {
      logger.warn('Forward proxy: bridge100 not available yet, skipping');
      server = null;
      return;
    }
    logger.error({ err }, 'Forward proxy error');
  });

  server.listen(FORWARD_PROXY_PORT, BRIDGE_IP, () => {
    logger.info(
      { listen: `${BRIDGE_IP}:${FORWARD_PROXY_PORT}` },
      'Forward proxy started (containers use HTTP_PROXY/HTTPS_PROXY)',
    );
  });
}

export const FORWARD_PROXY_URL = `http://${BRIDGE_IP}:${FORWARD_PROXY_PORT}`;

export function stopForwardProxy(): void {
  server?.close();
  server = null;
}
