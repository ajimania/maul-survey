// 정책 인포그래픽 만들기 — 확정된 구성안으로 Gemini가 인포그래픽을 그린다(고쳐 그리기 포함).
// Vercel 환경변수 GEMINI_API_KEY 가 있어야 동작한다.
import jpeg from 'jpeg-js';
import {validateDraw, buildDrawRequest, IMAGE_MODEL, InputError} from './_infographic_core.js';

export const config = {maxDuration: 120};

const KEY = process.env.GEMINI_API_KEY;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`;

// 사람별 하루 횟수 제한은 화면(브라우저)에서 한다. 여기는 한 주소에서 몰아 부르는 것만 막는다.
const WINDOW_MS = 10 * 60 * 1000, MAX_CALLS = 40;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_CALLS;
}

// Gemini가 주는 그림은 2~3MB라 Vercel 응답 한도(4.5MB)에 가깝다. 화질 88로 다시 저장해 줄인다.
function shrink(b64) {
  try {
    const raw = jpeg.decode(Buffer.from(b64, 'base64'), {useTArray: true, maxMemoryUsageInMB: 512});
    return jpeg.encode(raw, 88).data.toString('base64');
  } catch {
    return b64; // PNG 등 jpeg-js가 못 읽는 형식은 그대로 보낸다.
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error: 'method'});

  let input;
  try {
    input = validateDraw(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  } catch (error) {
    return res.status(400).json({error: 'input', message: error instanceof InputError ? error.message : '입력을 읽지 못했어요.'});
  }
  if (input.mock) {
    await new Promise(r => setTimeout(r, 2500));
    return res.status(200).json({mockUrl: '/policy-infographic-data/sample.jpg'});
  }

  if (!KEY) return res.status(503).json({error: 'no_key', message: '그림 AI 연결이 아직 설정되지 않았어요.'});
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({error: 'busy', message: '그리는 요청이 많아 잠시 쉬어 가요. 몇 분 뒤에 다시 눌러 주세요.'});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 110_000);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {'x-goog-api-key': KEY, 'Content-Type': 'application/json'},
      body: JSON.stringify(buildDrawRequest(input)),
      signal: controller.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      const code = data.error?.code || r.status;
      console.error('infographic-draw api', code, data.error?.message);
      if (code === 429) return res.status(429).json({error: 'busy', message: '그림 AI가 바빠요. 1~2분 뒤에 다시 눌러 주세요.'});
      if (code === 401 || code === 403) return res.status(503).json({error: 'no_key', message: '그림 AI 연결 설정에 문제가 있어요.'});
      return res.status(502).json({error: 'api', message: '그림 AI 연결이 잠시 불안정해요. 다시 눌러 주세요.'});
    }
    console.log('infographic-draw usage', JSON.stringify({...data.usageMetadata, edit: Boolean(input.edit), sketch: Boolean(input.sketch)}));

    const candidate = data.candidates?.[0];
    const part = candidate?.content?.parts?.find(p => p.inlineData?.data);
    if (!part) {
      console.error('infographic-draw no image', candidate?.finishReason, JSON.stringify(data.promptFeedback || {}));
      return res.status(502).json({error: 'no_image', message: '이번에는 그림이 나오지 않았어요. 문구를 조금 바꾸거나 다시 눌러 주세요.'});
    }
    const isJpeg = part.inlineData.mimeType === 'image/jpeg';
    const image = isJpeg ? shrink(part.inlineData.data) : part.inlineData.data;
    return res.status(200).json({image: `data:${part.inlineData.mimeType};base64,${image}`});
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({error: 'timeout', message: '그리는 시간이 너무 길어졌어요. 다시 눌러 주세요.'});
    }
    console.error('infographic-draw', error);
    return res.status(500).json({error: 'server', message: '문제가 생겼어요. 다시 눌러 주세요.'});
  } finally {
    clearTimeout(timer);
  }
}
