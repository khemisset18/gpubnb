import http from 'node:http';
import net from 'node:net';

const [targetHost = '127.0.0.1', targetPortRaw = '3000', listenPortRaw = '39000'] = process.argv.slice(2);
const targetPort = Number(targetPortRaw);
const listenPort = Number(listenPortRaw);
const prefix = '/workspace-gateway/test-session';
const safeResponseHeaders = new Set(['content-type','cache-control','etag','last-modified','content-length','content-disposition','content-encoding','vary','location']);
const allowedRequestHeaders = new Set(['accept','accept-language','accept-encoding','content-type','if-none-match','if-modified-since','range','user-agent']);

const workspaceCsp = "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self'; script-src 'self' 'unsafe-eval' blob:; child-src 'self'; frame-src 'self' https://*.vscode-cdn.net data:; worker-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: https:; font-src 'self' blob:; manifest-src 'self';";

function stripPrefix(url = '/') {
  const parsed = new URL(url, 'http://local');
  if (!parsed.pathname.startsWith(prefix)) return null;
  const suffix = parsed.pathname.slice(prefix.length) || '/';
  return `${suffix}${parsed.search}`;
}

function requestHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (allowedRequestHeaders.has(name.toLowerCase()) && typeof value === 'string') out[name] = value;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const targetPath = stripPrefix(req.url);
  if (!targetPath) {
    res.writeHead(404, {'content-type':'text/plain'});
    res.end('not found');
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: targetPath,
      headers: requestHeaders(req.headers),
    }, upstreamRes => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!safeResponseHeaders.has(name.toLowerCase()) || value == null) continue;
        responseHeaders[name] = value;
      }
      if ((responseHeaders['content-type'] || responseHeaders['Content-Type'] || '').includes('text/html')) {
        responseHeaders['content-security-policy'] = workspaceCsp;
        delete responseHeaders['content-length'];
        delete responseHeaders['Content-Length'];
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
    });
    upstream.on('error', error => {
      res.writeHead(502, {'content-type':'text/plain'});
      res.end(String(error));
    });
    for (const chunk of chunks) upstream.write(chunk);
    upstream.end();
  });
});

server.on('upgrade', (req, socket, head) => {
  const targetPath = stripPrefix(req.url);
  if (!targetPath) return socket.destroy();

  const upstream = net.createConnection({host: targetHost, port: targetPort}, () => {
    const lines = [`GET ${targetPath} HTTP/1.1`];
    for (const [name, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else {
        lines.push(`${name}: ${value}`);
      }
    }
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const close = () => { socket.destroy(); upstream.destroy(); };
  socket.on('error', close);
  upstream.on('error', close);
});

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`gateway-shape-proxy listening on http://127.0.0.1:${listenPort}${prefix}/`);
});
