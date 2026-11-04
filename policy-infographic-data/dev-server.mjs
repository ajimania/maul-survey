// 로컬 확인용 서버: 정적 파일 + /api/infographic-draw 를 함께 띄운다.
//   node policy-infographic-data/dev-server.mjs
// localhost 화면은 기본이 가짜 응답이고, 주소 끝에 ?ai=1 을 붙여야 실제 AI를 부른다(비용 발생).
import '../jeju-youth-data/env.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import draw from '../api/infographic-draw.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4191);
const ROUTES = {'/api/infographic-draw': draw};
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = ROUTES[url.pathname];
  if (handler) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try { body = JSON.parse(raw || 'null'); } catch {}
    const shim = {
      status(code) { res.statusCode = code; return this; },
      json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return this; },
    };
    return handler({method: req.method, headers: req.headers, body}, shim);
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || file.includes(`${path.sep}api${path.sep}`)) { res.statusCode = 404; return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}/policy-infographic.html  (Gemini 키 ${process.env.GEMINI_API_KEY ? '있음' : '없음'})`));
