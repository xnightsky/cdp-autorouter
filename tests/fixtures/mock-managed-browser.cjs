const http = require('node:http');

// This file acts as a tiny fake managed browser process so the supervisor tests
// can verify launch and reclaim logic without depending on a real Chrome binary.
function readFlag(name, fallback) {
  const prefix = `--${name}=`;
  const entry = process.argv.find(value => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

const port = Number(readFlag('remote-debugging-port', '9222'));

const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(
      JSON.stringify({
        Browser: 'MockManaged/1.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/mock-managed`,
      }),
    );
    return;
  }

  if (req.url === '/json/list' || req.url === '/json') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify([]));
    return;
  }

  if (req.url === '/json/protocol') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({version: {major: '1', minor: '3'}}));
    return;
  }

  // 测试专用出口：模拟浏览器进程退出。?code=N 控制退出码——
  // code=0 模拟用户手动关窗（优雅退出），非 0 模拟崩溃。
  // 跨平台可靠：Windows 上 child.kill 信号处理器不会执行，无法用信号模拟。
  if (req.url && req.url.startsWith('/simulate-exit')) {
    const code = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('code') ?? '0');
    res.writeHead(200);
    res.end();
    setImmediate(() => process.exit(code));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1');

// Mirror the graceful shutdown behavior we expect from a normal managed child
// process when autorouter reclaims it.
function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
