'use strict';
/* Prints a port the app can bind, preferring 3000 so the usual URL keeps working. Used by the
   launchers so an already-running server does not make a second copy fail to start. */
const net = require('node:net');

function probe(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.once('listening', () => {
      const actual = server.address().port;
      server.close(() => resolve(actual));
    });
    server.listen(port, '127.0.0.1');
  });
}

(async () => {
  const preferred = Number(process.env.PREFERRED_PORT || 3000);
  const free = await probe(preferred);
  if (free) { process.stdout.write(String(free)); return; }
  const fallback = await probe(0);
  process.stdout.write(String(fallback || preferred));
})();