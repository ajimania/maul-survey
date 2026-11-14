// 로컬 확인용 서버: 정적 파일 + /api/real-voice 를 함께 띄운다.
//   node real-voice-data/dev-server.mjs
// localhost 화면은 기본이 가짜 진행(비용 없음)이고, 주소 끝에 ?ai=1 을 붙여야 실제 AI를 부른다.
// 저장은 real-voice-data/.local-store/ 아래 파일에 한다(RV_STORE_SECRET 이 없을 때).
import '../jeju-youth-data/env.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {default: api} = await import('../api/real-voice.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4192);
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/real-voice') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch {}
    const shim = {
      status(code) { res.statusCode = code; return this; },
      json(obj) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return this; },
    };
    return api({method: req.method, headers: req.headers, body}, shim);
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || rel.startsWith('api') || rel.includes('.local-store') || rel.startsWith('.')) { res.statusCode = 404; return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}/real-voice.html  (음성 키 ${process.env.GEMINI_API_KEY ? '있음' : '없음'}, Claude 키 ${process.env.ANTHROPIC_API_KEY ? '있음' : '없음'})`));
