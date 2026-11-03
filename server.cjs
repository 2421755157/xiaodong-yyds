const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname);
const PORT = 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url).split('?')[0];
  if (url === '/') url = '/index.html';
  const filePath = path.join(ROOT, url);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
    } else {
      // 本地开发服务器禁用缓存：改了 css/js 刷新就能看到。
      // 之前没有这个头，浏览器会heuristic缓存，改完样式刷新还是旧的，
      // 排查时很容易误以为改动没生效（截图/测试都踩过）。
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(data);
    }
  });
}).listen(PORT, () => {
  console.log('Server running at http://localhost:' + PORT + '/');
});
