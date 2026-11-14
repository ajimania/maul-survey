// 리얼 보이스 — 저장소. 문서(kind, id, parent, data) 한 가지 모양만 다룬다.
//   배포: Supabase RPC(rv_get / rv_put / rv_list). 환경변수 RV_STORE_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY 필요.
//   로컬: real-voice-data/.local-store/ 아래 파일(키 없이 화면 확인용). RV_STORE_SECRET 이 없을 때만 쓴다.
// 화면(브라우저)은 저장소에 직접 닿지 않는다. 모든 읽기·쓰기는 api/real-voice.js 를 거친다.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SECRET = process.env.RV_STORE_SECRET;
const URL_ = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const ON_VERCEL = Boolean(process.env.VERCEL);

export class StoreError extends Error {}

/* ---------- Supabase ---------- */
async function rpc(name, args) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({p_secret: SECRET, ...args}),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || body?.ok === false) {
    console.error('rv-store', name, r.status, JSON.stringify(body).slice(0, 200));
    throw new StoreError('저장소에 닿지 못했어요.');
  }
  return body;
}
const remote = {
  async get(kind, id) { return (await rpc('rv_get', {p_kind: kind, p_id: id})).doc || null; },
  async put(kind, id, parent, data) { await rpc('rv_put', {p_kind: kind, p_id: id, p_parent: parent ?? null, p_data: data}); },
  async list(kind, parent) { return (await rpc('rv_list', {p_kind: kind, p_parent: parent ?? null})).docs || []; },
};

/* ---------- 로컬 파일 ---------- */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'real-voice-data', '.local-store');
const fileOf = (kind, id) => path.join(DIR, kind, encodeURIComponent(id) + '.json');
const local = {
  async get(kind, id) {
    const f = fileOf(kind, id);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  },
  async put(kind, id, parent, data) {
    const f = fileOf(kind, id);
    fs.mkdirSync(path.dirname(f), {recursive: true});
    const now = new Date().toISOString();
    const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    fs.writeFileSync(f, JSON.stringify({kind, id, parent: parent ?? null, data, created_at: prev?.created_at || now, updated_at: now}));
  },
  async list(kind, parent) {
    const d = path.join(DIR, kind);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter(n => n.endsWith('.json'))
      .map(n => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')))
      .filter(doc => parent == null || doc.parent === parent)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },
};

const backend = SECRET && URL_ && ANON ? remote : ON_VERCEL ? null : local;
export const storeReady = Boolean(backend);
export const storeKind = backend === remote ? 'supabase' : backend === local ? 'local' : 'none';

function need() {
  if (!backend) throw new StoreError('저장소가 아직 설정되지 않았어요.');
  return backend;
}
export const get = (kind, id) => need().get(kind, String(id));
export const put = (kind, id, parent, data) => need().put(kind, String(id), parent, data);
export const list = (kind, parent) => need().list(kind, parent);

// 읽고 고쳐 쓰기. 같은 문서를 동시에 고치는 일이 드문 곳(사업, 인터뷰 상태)에만 쓴다.
export async function patch(kind, id, change) {
  const doc = await get(kind, id);
  if (!doc) return null;
  const data = {...doc.data, ...(typeof change === 'function' ? change(doc.data) : change)};
  await put(kind, id, doc.parent, data);
  return {...doc, data};
}
