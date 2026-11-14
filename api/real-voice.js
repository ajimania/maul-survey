// 리얼 보이스 — 화면 세 개(견적, 참여자 인터뷰, 운영자)가 부르는 단일 API. body.action 으로 일을 나눈다.
// 환경변수
//   GEMINI_API_KEY     실시간 음성 진행(Gemini Live)과 다시 받아쓰기
//   ANTHROPIC_API_KEY  질문 가이드 초안, 인터뷰 점검, 분석(Claude)
//   RV_ADMIN_PASS      운영자 화면 비밀번호
//   RV_STORE_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY  저장소(_rv_store.js)
import Anthropic from '@anthropic-ai/sdk';
import * as core from './_rv_core.js';
import * as store from './_rv_store.js';

export const config = {maxDuration: 300};

const {InputError, str, int} = core;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const ADMIN_PASS = process.env.RV_ADMIN_PASS || (process.env.VERCEL ? '' : 'dev');
const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
const claude = process.env.ANTHROPIC_API_KEY
  ? new Anthropic(workspace ? {defaultHeaders: {'anthropic-workspace-id': workspace}} : {})
  : null;

class Fail extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.code = error; }
}

/* ---------- 간이 호출 제한 (인스턴스마다 따로 센다) ---------- */
const hits = new Map();
function limited(ip, bucket, max, windowMs = 10 * 60 * 1000) {
  const key = `${bucket}:${ip}`, now = Date.now();
  const listed = (hits.get(key) || []).filter(t => now - t < windowMs);
  listed.push(now);
  hits.set(key, listed);
  return listed.length > max;
}

/* ---------- Claude ---------- */
async function askClaude({system, user, schema, effort = 'medium', max = 16000, stream = false, tag}) {
  if (!claude) throw new Fail(503, 'no_key', 'AI 연결이 아직 설정되지 않았어요.');
  const params = {
    model: core.CLAUDE_MODEL,
    max_tokens: max,
    system,
    messages: [{role: 'user', content: user}],
    output_config: {effort, format: {type: 'json_schema', schema}},
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  try {
    const message = stream
      ? await claude.beta.messages.stream(params).finalMessage()
      : await claude.beta.messages.create(params);
    const u = message.usage || {};
    console.log('real-voice claude', tag, JSON.stringify({input: u.input_tokens, output: u.output_tokens, stop: message.stop_reason, model: message.model}));
    if (message.stop_reason === 'refusal') throw new Fail(502, 'refusal', 'AI가 이 내용을 처리하지 못했어요.');
    if (message.stop_reason === 'max_tokens') throw new Fail(502, 'cut', 'AI 응답이 중간에 끊겼어요. 다시 시도해 주세요.');
    return JSON.parse(message.content.filter(b => b.type === 'text').map(b => b.text).join(''));
  } catch (error) {
    if (error instanceof Fail) throw error;
    if (error instanceof SyntaxError) throw new Fail(502, 'parse', 'AI 응답을 읽지 못했어요. 다시 시도해 주세요.');
    if (error instanceof Anthropic.RateLimitError) throw new Fail(429, 'busy', 'AI 사용량이 많아요. 잠시 뒤에 다시 시도해 주세요.');
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      console.error('real-voice claude auth', error.status, error.message);
      throw new Fail(503, 'no_key', 'AI 연결 설정에 문제가 있어요.');
    }
    if (error instanceof Anthropic.APIError) {
      console.error('real-voice claude api', error.status, error.message);
      throw new Fail(502, 'api', 'AI 연결이 잠시 불안정해요. 다시 시도해 주세요.');
    }
    throw error;
  }
}

/* ---------- Gemini ---------- */
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

// 브라우저가 Gemini Live 에 직접 붙을 때 쓰는 일회용 토큰. 진행자 지시문을 토큰에 담아 잠그므로 화면에서는 바꿀 수 없다.
async function liveToken(setup) {
  if (!GEMINI_KEY) throw new Fail(503, 'no_key', '음성 AI 연결이 아직 설정되지 않았어요.');
  const iso = ms => new Date(Date.now() + ms).toISOString();
  const r = await fetch(`${GEMINI}/auth_tokens`, {
    method: 'POST',
    headers: {'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json'},
    body: JSON.stringify({uses: 1, expireTime: iso(20 * 60000), newSessionExpireTime: iso(2 * 60000), bidiGenerateContentSetup: setup}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.name) {
    console.error('real-voice token', r.status, JSON.stringify(j).slice(0, 300));
    throw new Fail(r.status === 429 ? 429 : 502, 'voice', '음성 AI에 연결하지 못했어요. 잠시 뒤에 다시 시도해 주세요.');
  }
  return `${LIVE_WS}?access_token=${encodeURIComponent(j.name)}`;
}

async function transcribe(b64, mime) {
  if (!GEMINI_KEY) throw new Fail(503, 'no_key', '음성 AI 연결이 아직 설정되지 않았어요.');
  const r = await fetch(`${GEMINI}/interactions`, {
    method: 'POST',
    headers: {'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json'},
    body: JSON.stringify({model: core.TRANSCRIBE_MODEL, input: [{type: 'user_input', content: [{type: 'audio', data: b64, mime_type: mime}]}]}),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('real-voice transcribe', r.status, JSON.stringify(j).slice(0, 300));
    throw new Fail(502, 'voice', '받아쓰기를 하지 못했어요. 다시 시도해 주세요.');
  }
  return (j.steps || []).flatMap(s => s.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
}

/* ---------- 저장소 읽기 도우미 ---------- */
const turnId = (token, seq) => `${token}:${String(seq).padStart(4, '0')}`;
async function settings() {
  return core.mergeSettings((await store.get('settings', 'main'))?.data);
}
async function turnsOf(token) {
  return (await store.list('turn', token)).map(d => d.data).sort((a, b) => a.seq - b.seq);
}
async function projectOf(id) {
  if (id === core.DEMO_ID) {
    const doc = await store.get('project', id);
    if (doc) return doc;
    await store.put('project', id, null, {...core.DEMO_PROJECT, openToken: core.DEMO_ID, createdAt: new Date().toISOString()});
    return store.get('project', id);
  }
  return store.get('project', id);
}
async function projectByOpenToken(open) {
  if (open === core.DEMO_ID) return projectOf(core.DEMO_ID);
  return (await store.list('project')).find(d => d.data.openToken === open) || null;
}
const publicProject = (p, rules) => ({
  org: p.org, title: p.title, intro: p.intro, demo: Boolean(p.demo),
  minutes: p.minutes || rules.minutes, incentive: p.incentive, payout: p.payout,
  retainMonths: rules.retainMonths, closed: p.status === 'closed',
});

// 인터뷰 한 건을 Claude 가 점검해 연구자 검증 화면에 보여 줄 자료를 만든다.
async function codeInterview(token, {mock} = {}) {
  const iv = await store.get('interview', token);
  if (!iv) throw new Fail(404, 'none', '인터뷰를 찾지 못했어요.');
  const project = (await projectOf(iv.parent)).data;
  const turns = await turnsOf(token);
  if (turns.filter(t => t.role === 'p').length === 0) {
    const empty = core.auditCoding({completeness: '미흡', completeness_reason: '참여자가 한 말이 없다.', summary: '', answers: []}, project, turns);
    await store.patch('interview', token, {coding: empty});
    return empty;
  }
  const raw = mock
    ? mockCoding(project, turns)
    : await askClaude({system: core.CODE_SYSTEM, user: core.codeUser(project, turns), schema: core.CODE_SCHEMA, effort: 'medium', tag: 'code'});
  const coding = core.auditCoding(raw, project, turns);
  await store.patch('interview', token, {coding});
  return coding;
}

/* ---------- 가짜 응답 (키 없이 화면 확인용, 비용 없음) ---------- */
function mockCoding(project, turns) {
  const said = turns.filter(t => t.role === 'p');
  return {
    summary: '(가짜 점검) 참여자는 질문에 차례로 답했다.',
    answers: project.questions.map((q, i) => ({
      q: i + 1, status: said[i] ? (said[i].text.length > 25 ? '충분' : '부족') : '없음',
      summary: said[i] ? `참여자는 "${said[i].text.slice(0, 40)}"라고 답했다.` : '', quotes: said[i] ? [said[i].text] : [],
    })),
    completeness: said.length >= project.questions.length ? '완결' : said.length ? '일부' : '미흡',
    completeness_reason: `(가짜 점검) 핵심 질문 ${project.questions.length}개 가운데 ${Math.min(said.length, project.questions.length)}개에 답이 있다.`,
    interviewer_issues: '', concerns: '', followup_worthy: false, followup_reason: '',
  };
}
function mockReport(project, items) {
  const pids = items.map(it => it.pid);
  const quote = (it, i) => { const t = it.turns.filter(x => x.role === 'p')[i]; return t ? [{pid: it.pid, text: t.text}] : []; };
  return {
    summary: `(가짜 분석) 참여자 ${items.length}명의 인터뷰를 질문별로 묶었다. 실제 분석은 ?ai=1 로 열어 실행한다.`,
    findings: [{title: '(가짜) 참여자들은 함께한 경험을 가장 많이 말했다', detail: '가짜 분석이라 내용은 예시다.', count: pids.length, pids, quotes: items.slice(0, 2).flatMap(it => quote(it, 1))}],
    by_question: project.questions.map((q, i) => ({
      q: i + 1, overview: '(가짜) 이 질문의 답을 한 묶음으로 보여 준다.',
      themes: [{name: '(가짜) 주제 예시', detail: '가짜 분석이라 내용은 예시다.', count: pids.length, pids, quotes: items.slice(0, 2).flatMap(it => quote(it, i))}],
    })),
    voices: items.slice(0, 1).map(it => ({pid: it.pid, why: '(가짜) 직접 만나 볼 만한 참여자 예시'})),
    recommendations: [{title: '(가짜) 제언 예시', detail: '가짜 분석이라 내용은 예시다.', basis: '핵심 발견 1'}],
    limits: ['(가짜) 실제 분석이 아니다.'],
  };
}
const MOCK_GUIDE = p => ({
  intro: `${p.org || '기관'}이 「${p.title || '사업'}」에 참여하신 분들의 이야기를 듣습니다. 겪으신 그대로 편하게 말씀해 주세요.`,
  questions: [
    {text: '이 사업에 어떻게 참여하게 되셨나요?', intent: '참여 계기와 기대'},
    {text: '참여하면서 가장 기억에 남는 순간은 언제였나요?', intent: '의미 있었던 구체적 장면'},
    {text: '참여하고 나서 달라진 점이 있다면 무엇인가요?', intent: '참여 뒤 변화'},
    {text: '아쉬웠거나 바뀌었으면 하는 점은 무엇이었나요?', intent: '개선할 점'},
  ],
});

/* ---------- 누구나 부르는 일 ---------- */
const open = {
  async pricing() {
    const s = await settings();
    return {price: s.price, supplier: s.supplier};
  },

  async lead(b) {
    const lead = {
      org: str(b.org, 60), project: str(b.project, 80), name: str(b.name, 40), contact: str(b.contact, 80),
      note: str(b.note, 600), people: int(b.people, 1, 500, 10),
      recruit: b.recruit === true, payout: b.payout === true, total: int(b.total, 0, 1e9, 0),
      at: new Date().toISOString(),
    };
    if (!lead.org || !lead.contact) throw new InputError('기관명과 연락처를 적어 주세요.');
    await store.put('lead', core.newId(), null, lead);
    return {ok: true};
  },

  // 링크를 열었을 때: 인터뷰 안내에 쓸 정보만 준다.
  async 'iv.open'(b) {
    const rules = (await settings()).rules;
    if (b.t) {
      const iv = await store.get('interview', str(b.t, 40));
      if (!iv) throw new Fail(404, 'none', '링크를 다시 확인해 주세요.');
      const p = (await projectOf(iv.parent)).data;
      return {project: publicProject(p, rules), status: iv.data.status, name: iv.data.name || ''};
    }
    const p = await projectByOpenToken(str(b.p, 40));
    if (!p) throw new Fail(404, 'none', '링크를 다시 확인해 주세요.');
    return {project: publicProject(p.data, rules), status: 'new'};
  },

  // 동의 뒤 인터뷰를 시작(또는 끊긴 뒤 다시 연결)한다. 음성 AI에 붙을 일회용 주소를 준다.
  async 'iv.start'(b, ip) {
    if (limited(ip, 'start', 12)) throw new Fail(429, 'busy', '잠시 뒤에 다시 시도해 주세요.');
    if (b.consent !== true) throw new InputError('동의가 필요해요.');
    const s = await settings();
    let token = str(b.t, 40), iv, projectDoc;
    if (token) {
      iv = await store.get('interview', token);
      if (!iv) throw new Fail(404, 'none', '링크를 다시 확인해 주세요.');
      projectDoc = await projectOf(iv.parent);
    } else {
      projectDoc = await projectByOpenToken(str(b.p, 40));
      if (!projectDoc) throw new Fail(404, 'none', '링크를 다시 확인해 주세요.');
      token = core.newToken();
      const pid = (await store.list('interview', projectDoc.id)).length + 1;
      await store.put('interview', token, projectDoc.id, {pid, status: 'invited', via: 'open'});
      iv = await store.get('interview', token);
    }
    const project = projectDoc.data;
    if (project.status === 'closed') throw new Fail(403, 'closed', '참여 기간이 끝났어요.');
    if (iv.data.status === 'completed') throw new Fail(409, 'done', '이미 인터뷰를 마치셨어요. 고맙습니다.');
    if (!project.questions?.length) throw new Fail(409, 'draft', '아직 준비 중인 인터뷰예요.');

    const prior = await turnsOf(token);
    const mock = b.mock === true;
    const now = new Date().toISOString();
    await store.patch('interview', token, d => ({
      status: 'started', mock, mode: b.mode === 'text' ? 'text' : 'voice',
      consentAt: d.consentAt || now, startedAt: d.startedAt || now, resumes: (d.resumes || 0) + (prior.length ? 1 : 0),
      agent: str(b.agent, 200),
    }));
    const base = {
      token, nextSeq: prior.length ? prior[prior.length - 1].seq + 1 : 0, resumed: prior.length > 0,
      minutes: project.minutes || s.rules.minutes, silenceSec: s.rules.silenceSec,
    };
    if (mock) return {...base, mock: true, script: core.mockScript(project).slice(Math.floor(prior.length / 2))};
    return {...base, ws: await liveToken(core.liveSetup(project, s.rules, prior)), model: core.LIVE_MODEL};
  },

  async 'iv.turn'(b) {
    const token = str(b.t, 40), seq = int(b.seq, 0, 999, -1), text = str(b.text, 6000);
    if (!token || seq < 0 || !['ai', 'p'].includes(b.role)) throw new InputError('입력을 읽지 못했어요.');
    if (!(await store.get('interview', token))) throw new Fail(404, 'none', '인터뷰를 찾지 못했어요.');
    await store.put('turn', turnId(token, seq), token, {
      seq, role: b.role, text, at: new Date().toISOString(), sec: int(b.sec, 0, 3600, 0),
      audio: b.audio === true, typed: b.typed === true,
    });
    return {ok: true};
  },

  async 'iv.audio'(b) {
    const token = str(b.t, 40), seq = int(b.seq, 0, 999, -1);
    const mime = /^audio\/[a-z0-9.+-]+/i.exec(String(b.mime || ''))?.[0];
    if (!token || seq < 0 || !mime || typeof b.b64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(b.b64)) throw new InputError('녹음을 읽지 못했어요.');
    if (b.b64.length > 4_000_000) throw new InputError('녹음이 너무 길어요.');
    if (!(await store.get('interview', token))) throw new Fail(404, 'none', '인터뷰를 찾지 못했어요.');
    await store.put('audio', turnId(token, seq), token, {mime, b64: b.b64});
    return {ok: true};
  },

  async 'iv.finish'(b) {
    const token = str(b.t, 40);
    const iv = await store.get('interview', token);
    if (!iv) throw new Fail(404, 'none', '인터뷰를 찾지 못했어요.');
    const reason = ['done', 'stopped', 'time', 'left', 'error'].includes(b.reason) ? b.reason : 'left';
    await store.patch('interview', token, {
      status: reason === 'done' ? 'completed' : 'partial', endReason: reason,
      endedAt: new Date().toISOString(), sec: int(b.sec, 0, 3600, 0),
    });
    // 점검은 연구자 화면을 위한 것이라, 여기서 실패해도 참여자에게는 알리지 않는다.
    try { await codeInterview(token, {mock: iv.data.mock}); } catch (error) { console.error('real-voice finish code', error.message); }
    return {ok: true};
  },

  async 'iv.phone'(b) {
    const token = str(b.t, 40), phone = str(b.phone, 20).replace(/[^0-9-]/g, '');
    if (!/^01[0-9]-?\d{3,4}-?\d{4}$/.test(phone)) throw new InputError('휴대폰 번호를 다시 확인해 주세요.');
    if (!(await store.patch('interview', token, {phone}))) throw new Fail(404, 'none', '인터뷰를 찾지 못했어요.');
    return {ok: true};
  },
};

/* ---------- 운영자만 부르는 일 ---------- */
const summaryOf = d => ({
  token: d.id, pid: d.data.pid, name: d.data.name || '', contact: d.data.contact || '', status: d.data.status,
  mode: d.data.mode, mock: Boolean(d.data.mock), startedAt: d.data.startedAt, endedAt: d.data.endedAt, sec: d.data.sec || 0,
  endReason: d.data.endReason, phone: d.data.phone || '', resumes: d.data.resumes || 0,
  completeness: d.data.coding?.completeness || '', followup: Boolean(d.data.coding?.followup_worthy), concerns: Boolean(d.data.coding?.concerns),
  verdict: d.data.review?.verdict || '', reviewNote: d.data.review?.note || '',
});

const admin = {
  async 'admin.login'() { return {ok: true, store: store.storeKind, claude: Boolean(claude), voice: Boolean(GEMINI_KEY)}; },

  async 'admin.projects'() {
    await projectOf(core.DEMO_ID);
    const projects = await store.list('project');
    return {projects: await Promise.all(projects.map(async p => {
      const ivs = (await store.list('interview', p.id)).map(summaryOf);
      return {
        id: p.id, org: p.data.org, title: p.data.title, status: p.data.status, demo: Boolean(p.data.demo),
        target: p.data.target, researcher: p.data.researcher, createdAt: p.data.createdAt,
        counts: {
          all: ivs.length, completed: ivs.filter(i => i.status === 'completed').length,
          partial: ivs.filter(i => i.status === 'partial').length,
          waiting: ivs.filter(i => ['completed', 'partial'].includes(i.status) && !i.verdict).length,
          included: ivs.filter(i => i.verdict === 'include').length,
        },
      };
    }))};
  },

  async 'admin.project.get'(b) {
    const p = await projectOf(str(b.id, 40));
    if (!p) throw new Fail(404, 'none', '사업을 찾지 못했어요.');
    const [ivs, report] = await Promise.all([store.list('interview', p.id), store.get('report', p.id)]);
    return {project: {id: p.id, ...p.data}, interviews: ivs.map(summaryOf).sort((a, b) => a.pid - b.pid), report: report?.data || null};
  },

  async 'admin.project.save'(b) {
    const clean = core.cleanProject(b.project);
    if (!clean.org || !clean.title) throw new InputError('기관명과 사업명을 적어 주세요.');
    const id = str(b.id, 40);
    if (id) {
      const doc = await store.patch('project', id, clean);
      if (!doc) throw new Fail(404, 'none', '사업을 찾지 못했어요.');
      return {id};
    }
    const newId = core.newId();
    await store.put('project', newId, null, {...clean, openToken: core.newToken(), createdAt: new Date().toISOString()});
    return {id: newId};
  },

  async 'admin.guide.draft'(b) {
    const p = core.cleanProject(b.project);
    if (!p.title || p.brief.length < 20) throw new InputError('사업명과 사업 개요를 조금 더 적어 주세요.');
    if (b.mock === true) return MOCK_GUIDE(p);
    const raw = await askClaude({system: core.GUIDE_SYSTEM, user: core.guideUser(p), schema: core.GUIDE_SCHEMA, effort: 'medium', tag: 'guide'});
    return {intro: str(raw.intro, 300), questions: (raw.questions || []).slice(0, 6).map(q => ({text: str(q.text, 300), intent: str(q.intent, 300)}))};
  },

  // 명단을 넣으면 참여자별 링크를 만든다.
  async 'admin.invite'(b) {
    const p = await projectOf(str(b.id, 40));
    if (!p) throw new Fail(404, 'none', '사업을 찾지 못했어요.');
    const people = (Array.isArray(b.people) ? b.people : []).map(x => ({name: str(x?.name, 40), contact: str(x?.contact, 60)})).filter(x => x.name).slice(0, 200);
    if (!people.length) throw new InputError('명단을 한 줄에 한 명씩 적어 주세요.');
    let pid = (await store.list('interview', p.id)).length;
    for (const person of people) {
      pid += 1;
      await store.put('interview', core.newToken(), p.id, {pid, ...person, status: 'invited', via: 'list'});
    }
    return {added: people.length};
  },

  async 'admin.interview.get'(b) {
    const iv = await store.get('interview', str(b.token, 40));
    if (!iv) throw new Fail(404, 'none', '인터뷰를 찾지 못했어요.');
    return {interview: {...summaryOf(iv), coding: iv.data.coding || null, review: iv.data.review || null, agent: iv.data.agent || ''}, turns: await turnsOf(iv.id)};
  },

  async 'admin.audio'(b) {
    const doc = await store.get('audio', turnId(str(b.token, 40), int(b.seq, 0, 999, 0)));
    if (!doc) throw new Fail(404, 'none', '이 발화에는 녹음이 없어요.');
    return {mime: doc.data.mime, b64: doc.data.b64};
  },

  // 실시간 받아쓰기가 틀려 보일 때 녹음을 전용 모델로 다시 받아쓴다.
  async 'admin.retranscribe'(b) {
    const token = str(b.token, 40), seq = int(b.seq, 0, 999, 0);
    const [audio, turn] = await Promise.all([store.get('audio', turnId(token, seq)), store.get('turn', turnId(token, seq))]);
    if (!audio || !turn) throw new Fail(404, 'none', '이 발화에는 녹음이 없어요.');
    const text = b.mock === true ? `${turn.data.text} (가짜 다시 받아쓰기)` : await transcribe(audio.data.b64, audio.data.mime.replace('audio/mp4', 'audio/m4a'));
    return {text};
  },

  async 'admin.turn.edit'(b) {
    const token = str(b.token, 40), seq = int(b.seq, 0, 999, 0), text = str(b.text, 6000);
    const doc = await store.patch('turn', turnId(token, seq), d => ({text, original: d.original ?? d.text, editedAt: new Date().toISOString()}));
    if (!doc) throw new Fail(404, 'none', '발화를 찾지 못했어요.');
    return {ok: true};
  },

  async 'admin.review'(b) {
    const verdict = ['include', 'fix', 'exclude', ''].includes(b.verdict) ? b.verdict : '';
    const doc = await store.patch('interview', str(b.token, 40), {
      review: verdict ? {verdict, note: str(b.note, 600), by: str(b.by, 40), at: new Date().toISOString()} : null,
    });
    if (!doc) throw new Fail(404, 'none', '인터뷰를 찾지 못했어요.');
    return {ok: true};
  },

  async 'admin.code'(b) {
    return {coding: await codeInterview(str(b.token, 40), {mock: b.mock === true})};
  },

  // 검증에서 '분석에 포함'으로 판정한 인터뷰만 모아 보고서 초안을 만든다.
  async 'admin.analyze'(b) {
    const p = await projectOf(str(b.id, 40));
    if (!p) throw new Fail(404, 'none', '사업을 찾지 못했어요.');
    const included = (await store.list('interview', p.id)).filter(d => d.data.review?.verdict === 'include');
    if (included.length < 1) throw new Fail(409, 'empty', "검증에서 '분석에 포함'으로 판정한 인터뷰가 없어요.");
    const items = await Promise.all(included.map(async d => ({pid: d.data.pid, turns: await turnsOf(d.id), sec: d.data.sec || 0})));
    items.sort((a, b) => a.pid - b.pid);
    const raw = b.mock === true
      ? mockReport(p.data, items)
      : await askClaude({system: core.REPORT_SYSTEM, user: core.reportUser(p.data, items), schema: core.REPORT_SCHEMA, effort: 'medium', max: 32000, stream: true, tag: 'report'});
    const report = core.auditReport(raw, new Map(items.map(it => [it.pid, it.turns])));
    const all = await store.list('interview', p.id);
    const data = {
      report, at: new Date().toISOString(), mock: b.mock === true, pids: items.map(it => it.pid),
      stats: {
        included: items.length,
        completed: all.filter(d => d.data.status === 'completed').length,
        partial: all.filter(d => d.data.status === 'partial').length,
        excluded: all.filter(d => d.data.review?.verdict === 'exclude').length,
        avgMin: Math.round(items.reduce((s, it) => s + it.sec, 0) / items.length / 6) / 10,
        from: all.map(d => d.data.startedAt).filter(Boolean).sort()[0] || null,
        to: all.map(d => d.data.endedAt).filter(Boolean).sort().pop() || null,
      },
    };
    await store.put('report', p.id, null, data);
    return data;
  },

  async 'admin.settings.get'() { return {settings: await settings(), voices: core.VOICES}; },

  async 'admin.settings.save'(b) {
    const s = b.settings || {};
    const num = (v, min, max, d) => (Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : d);
    const D = core.DEFAULT_SETTINGS;
    const next = {
      price: {
        unit: num(s.price?.unit, 0, 1e7, D.price.unit), recruit: num(s.price?.recruit, 0, 1e7, D.price.recruit), payout: num(s.price?.payout, 0, 1e7, D.price.payout),
        min: num(s.price?.min, 1, 500, D.price.min), max: num(s.price?.max, 1, 500, D.price.max), vat: D.price.vat,
      },
      supplier: Object.fromEntries(Object.keys(D.supplier).map(k => [k, str(s.supplier?.[k], 120)])),
      rules: {
        minutes: num(s.rules?.minutes, 3, 14, D.rules.minutes), followups: num(s.rules?.followups, 0, 3, D.rules.followups),
        silenceSec: num(s.rules?.silenceSec, 2, 8, D.rules.silenceSec), retainMonths: num(s.rules?.retainMonths, 1, 60, D.rules.retainMonths),
        voice: core.VOICES.includes(s.rules?.voice) ? s.rules.voice : D.rules.voice, extra: str(s.rules?.extra, 1500),
      },
    };
    await store.put('settings', 'main', null, next);
    return {settings: next};
  },

  async 'admin.leads'() {
    return {leads: (await store.list('lead')).map(d => ({id: d.id, ...d.data})).reverse()};
  },
};

/* ---------- 들어오는 문 ---------- */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error: 'method'});
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { body = null; }
  if (!body || typeof body.action !== 'string') return res.status(400).json({error: 'input', message: '입력을 읽지 못했어요.'});
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  try {
    if (Object.hasOwn(admin, body.action)) {
      if (limited(ip, 'admin', 600)) throw new Fail(429, 'busy', '잠시 뒤에 다시 시도해 주세요.');
      if (!ADMIN_PASS) throw new Fail(503, 'no_pass', '운영자 비밀번호가 아직 설정되지 않았어요.');
      if (body.pass !== ADMIN_PASS) {
        if (limited(ip, 'badpass', 10)) throw new Fail(429, 'busy', '잠시 뒤에 다시 시도해 주세요.');
        throw new Fail(401, 'pass', '비밀번호가 맞지 않아요.');
      }
      return res.status(200).json(await admin[body.action](body, ip));
    }
    if (Object.hasOwn(open, body.action)) {
      if (limited(ip, 'open', 900)) throw new Fail(429, 'busy', '잠시 뒤에 다시 시도해 주세요.');
      return res.status(200).json(await open[body.action](body, ip));
    }
    return res.status(400).json({error: 'action', message: '알 수 없는 요청이에요.'});
  } catch (error) {
    if (error instanceof Fail) return res.status(error.status).json({error: error.code, message: error.message});
    if (error instanceof InputError) return res.status(400).json({error: 'input', message: error.message});
    if (error instanceof store.StoreError) return res.status(503).json({error: 'store', message: error.message});
    console.error('real-voice', body.action, error);
    return res.status(500).json({error: 'server', message: '문제가 생겼어요. 다시 시도해 주세요.'});
  }
}
