'use strict';

const net = require('net');

const target = process.env.GPUBNB_TARGET;
if (!target || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target)) {
  console.error('invalid_or_missing_gpubnb_target');
  process.exit(2);
}

const server = net.createServer((client) => {
  const upstream = net.createConnection({ host: target, port: 3000 });
  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };

  client.setNoDelay(true);
  upstream.setNoDelay(true);
  client.on('error', closeBoth);
  upstream.on('error', closeBoth);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.maxConnections = 256;
server.on('error', (error) => {
  console.error(`loopback_proxy_error:${error.code || 'unknown'}`);
  process.exit(1);
});
server.listen(3000, '0.0.0.0');
