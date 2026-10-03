// 제주 청년 정책 길찾기 AI 베타 — 청년의 글과 자가진단을 읽고 사업을 우선순위로 추천한다.
// Vercel 환경변수 ANTHROPIC_API_KEY 가 있어야 동작한다.
import Anthropic from '@anthropic-ai/sdk';
import {validateInput, buildParams, finalize, InputError} from './_jeju_match_core.js';

export const config = {maxDuration: 60};

// 워크스페이스에 묶이지 않은 계정 단위 키는 어느 워크스페이스를 쓸지 헤더로 알려야 한다.
const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic(workspace ? {defaultHeaders: {'anthropic-workspace-id': workspace}} : {})
  : null;

// 같은 주소에서 짧은 시간에 반복 호출하는 것을 막는다(인스턴스마다 따로 세는 간이 제한).
// 사람별 하루 4번 제한은 화면(브라우저)에서 한다. 여기는 와이파이를 함께 쓰는 워크숍도 견딜 만큼 넉넉하게.
const WINDOW_MS = 10 * 60 * 1000, MAX_CALLS = 20;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_CALLS;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error: 'method'});
  if (!client) return res.status(503).json({error: 'no_key', message: 'AI 연결이 아직 설정되지 않았어요.'});

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({error: 'busy', message: '사용자가 많아 접속이 제한되고 있습니다. 다음에 다시 이용해 주세요.'});

  let input;
  try {
    input = validateInput(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  } catch (error) {
    if (error instanceof InputError) return res.status(400).json({error: 'input', message: error.message});
    return res.status(400).json({error: 'input', message: '입력을 읽지 못했어요.'});
  }

  const {params, candidates} = buildParams(input);
  if (!candidates.length) {
    return res.status(200).json(finalize({summary: '', needs: [], picks: [], gaps: [], followup: '', crisis: false}, candidates, input));
  }

  try {
    const message = await client.beta.messages.create({
      ...params,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const u = message.usage || {};
    console.log('jeju-match usage', JSON.stringify({
      input: u.input_tokens, cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens,
      output: u.output_tokens, stop: message.stop_reason, candidates: candidates.length,
    }));

    if (message.stop_reason === 'refusal') {
      return res.status(502).json({error: 'refusal', message: 'AI가 이 글을 처리하지 못했어요. 표현을 조금 바꿔 다시 시도해 주세요.'});
    }
    if (message.stop_reason === 'max_tokens') {
      return res.status(502).json({error: 'cut', message: '분석이 중간에 끊겼어요. 다시 시도해 주세요.'});
    }
    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json(finalize(JSON.parse(text), candidates, input));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return res.status(502).json({error: 'parse', message: '분석 결과를 읽지 못했어요. 다시 시도해 주세요.'});
    }
    if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({error: 'busy', message: '사용자가 많아 접속이 제한되고 있습니다. 다음에 다시 이용해 주세요.'});
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      console.error('jeju-match auth', error.status, error.message);
      return res.status(503).json({error: 'no_key', message: 'AI 연결 설정에 문제가 있어요.'});
    }
    if (error instanceof Anthropic.APIError) {
      console.error('jeju-match api', error.status, error.message);
      return res.status(502).json({error: 'api', message: 'AI 연결이 잠시 불안정해요. 다시 시도해 주세요.'});
    }
    console.error('jeju-match', error);
    return res.status(500).json({error: 'server', message: '문제가 생겼어요. 다시 시도해 주세요.'});
  }
}
