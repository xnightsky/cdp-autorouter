import http from 'node:http';
import {AddressInfo} from 'node:net';
import {WebSocketServer} from 'ws';

/**
 * Simple downstream Chrome test double used by HTTP and websocket proxy tests.
 */
export interface MockChromeServer {
  close(): Promise<void>;
  origin: string;
  wsUrl: string;
}

/**
 * Starts a fake Chrome remote debugging endpoint with both HTTP and WS support.
 */
export async function startMockChromeServer(): Promise<MockChromeServer> {
  let port = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(
        JSON.stringify({
          Browser: 'Chrome/123.0.0.0',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/mock-id`,
        }),
      );
      return;
    }

    if (req.url === '/json/list' || req.url === '/json') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(
        JSON.stringify([
          {
            id: 'page-1',
            title: 'Mock Page',
            type: 'page',
            url: 'https://example.com',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/mock-page-id`,
            devtoolsFrontendUrl: `http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/mock-page-id`,
          },
        ]),
      );
      return;
    }

    if (req.url === '/json/protocol') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({version: {major: '1', minor: '3'}}));
      return;
    }

    // P1-5: serve a fake devtools static asset for transparent proxy testing
    if (req.url?.startsWith('/devtools/')) {
      res.writeHead(200, {'content-type': 'text/html'});
      res.end('<html><body>devtools-mock</body></html>');
      return;
    }

    res.writeHead(404);
    res.end();
  });
  const wsServer = new WebSocketServer({server});

  // Echo traffic is enough to prove the autorouter WS proxy is wired correctly.
  wsServer.on('connection', socket => {
    socket.on('message', payload => {
      socket.send(`echo:${payload.toString()}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo;
  port = address.port;
  const origin = `http://${address.address}:${address.port}`;

  return {
    origin,
    wsUrl: `${origin.replace('http', 'ws')}/devtools/browser/mock-id`,
    close: async () => {
      await new Promise<void>(resolve => {
        wsServer.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
