// 리얼 보이스 — 기본값, 진행자 지시문, 분석 지시문과 응답 틀. api/real-voice.js 가 쓴다.
import crypto from 'node:crypto';

export const CLAUDE_MODEL = 'claude-opus-5-5';      // 질문 가이드 초안, 인터뷰 점검, 분석
export const LIVE_MODEL = 'models/gemini-3.8-live'; // 실시간 음성 진행
export const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe'; // 녹음 다시 받아쓰기

export class InputError extends Error {}
export const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const int = (v, min, max, dflt) => (Number.isInteger(v) && v >= min && v <= max ? v : dflt);
export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
export const newToken = () => crypto.randomBytes(16).toString('base64url');

/* ---------- 기본 설정 (운영자 화면에서 바꾼다) ---------- */
export const DEFAULT_SETTINGS = {
  price: {unit: 100000, recruit: 10000, payout: 10000, min: 10, max: 20, vat: 0.1},
  supplier: {
    name: '커먼즈웍스 주식회사',
    bizno: '000-00-00000',
    ceo: '대표자명(가안)',
    addr: '사업장 주소(가안)',
    contact: 'hello@example.com · 000-0000-0000(가안)',
    bank: '',
  },
  rules: {
    minutes: 12,       // 목표 시간(분). 2분 전에 마무리 안내를 보낸다.
    followups: 2,      // 질문마다 꼬리 질문 최대 횟수
    silenceSec: 3,     // 이만큼 조용하면 말이 끝난 것으로 본다
    voice: 'Sulafat',  // 진행자 목소리
    retainMonths: 6,   // 동의문에 적는 보관 기간
    extra: '',         // 진행자에게 덧붙일 규칙
  },
};
export function mergeSettings(saved = {}) {
  return {
    price: {...DEFAULT_SETTINGS.price, ...(saved.price || {})},
    supplier: {...DEFAULT_SETTINGS.supplier, ...(saved.supplier || {})},
    rules: {...DEFAULT_SETTINGS.rules, ...(saved.rules || {})},
  };
}
export const VOICES = ['Sulafat', 'Vindemiatrix', 'Achernar', 'Gacrux', 'Aoede', 'Charon', 'Iapetus', 'Schedar'];

/* ---------- 사업(프로젝트) ---------- */
export function cleanProject(p = {}) {
  const questions = (Array.isArray(p.questions) ? p.questions : [])
    .map(q => ({text: str(q?.text, 300), intent: str(q?.intent, 300)}))
    .filter(q => q.text).slice(0, 7);
  return {
    org: str(p.org, 60),
    title: str(p.title, 80),
    brief: str(p.brief, 1500),
    goals: str(p.goals, 1000),
    intro: str(p.intro, 300),
    questions,
    minutes: int(p.minutes, 3, 14, null),
    followups: int(p.followups, 0, 3, null),
    extra: str(p.extra, 800),
    researcher: str(p.researcher, 40),
    target: int(p.target, 1, 500, 10),
    mode: p.mode === 'recruit' ? 'recruit' : 'link',       // link: 기관이 링크 발송 / recruit: 명단 받아 섭외
    payout: p.payout === 'agent' ? 'agent' : 'org',        // org: 기관 직접 지급 / agent: 지급 대행
    incentive: str(p.incentive, 80),
    status: ['draft', 'open', 'closed'].includes(p.status) ? p.status : 'draft',
  };
}

export const DEMO_ID = 'demo';
export const DEMO_PROJECT = {
  org: '리얼 보이스',
  title: '최근에 참여한 교육·행사 경험',
  brief: '리얼 보이스를 미리 써 보는 체험용 인터뷰다. 참여자는 최근에 참여한 교육, 강좌, 행사, 모임 가운데 하나를 떠올려 그 경험을 이야기한다. 특정 기관의 사업이 아니므로 어떤 자리였는지부터 듣는다.',
  goals: '참여 계기, 기억에 남는 장면, 참여 뒤 달라진 점, 아쉬운 점.',
  intro: '리얼 보이스 체험 인터뷰입니다. 최근에 참여하신 교육이나 행사 하나를 떠올리고 그 경험을 들려주세요.',
  questions: [
    {text: '최근에 참여하신 교육이나 행사 가운데 하나를 떠올려 주세요. 어떤 자리였고, 어떻게 참여하게 되셨나요?', intent: '어떤 사업이었는지와 참여 계기'},
    {text: '그 자리에서 가장 기억에 남는 순간은 언제였나요?', intent: '의미 있었던 구체적 장면'},
    {text: '참여하고 나서 생활이나 생각에 달라진 점이 있다면 무엇인가요?', intent: '참여 뒤 변화'},
    {text: '아쉬웠거나 바뀌었으면 하는 점은 무엇이었나요?', intent: '개선할 점'},
  ],
  minutes: 6, followups: 1, extra: '', researcher: '', target: 10, mode: 'link', payout: 'org', incentive: '', status: 'open',
  demo: true,
};

/* ---------- 실시간 진행자 (Gemini Live) ---------- */
export function interviewerPrompt(project, rules, priorTurns = []) {
  const minutes = project.minutes || rules.minutes;
  const followups = project.followups ?? rules.followups;
  const qs = project.questions.map((q, i) => `${i + 1}. ${q.text}${q.intent ? `\n   - 이 질문으로 알고 싶은 것: ${q.intent}` : ''}`).join('\n');
  const extra = [rules.extra, project.extra].filter(Boolean).join('\n');
  const resume = priorTurns.length
    ? `\n\n# 지금까지의 대화\n연결이 끊겼다가 다시 이어졌습니다. 아래는 끊기기 전까지 나눈 대화입니다. 인사와 안내를 다시 하지 말고 "다시 연결되었습니다. 이어서 여쭙겠습니다."라고만 말한 뒤, 아직 묻지 않은 질문부터 이어 갑니다.\n${priorTurns.map(t => `${t.role === 'ai' ? '진행자' : '참여자'}: ${t.text}`).join('\n')}`
    : '';
  return `당신은 「리얼 보이스」의 AI 인터뷰 진행자입니다. ${project.org}의 의뢰로 「${project.title}」에 참여한 분의 경험을 듣습니다. 지금부터 참여자 한 분과 한국어 음성으로 1:1 인터뷰를 합니다.

# 사업
${project.brief || '(설명 없음)'}

# 알고 싶은 것
${project.goals || '(따로 없음)'}

# 핵심 질문 (이 순서대로 모두 묻습니다)
${qs}

# 말하는 방식
- 존댓말로 차분하고 따뜻하게 말합니다.
- 한 번에 한 가지만 묻습니다. 한 번 말할 때 두 문장을 넘기지 않습니다.
- 어려운 말, 행정 용어, 영어를 쓰지 않습니다.
- 답을 들으면 참여자가 한 말에서 한 가지를 짚어 짧게 받아 준 뒤 넘어갑니다("키오스크 주문을 직접 해 보셨군요"처럼). 받아 주는 말은 매번 다르게 합니다. "네, 그러셨군요"만 되풀이하지 않습니다. 답을 길게 요약하지 않습니다.
- 답을 평가하지 않습니다. "좋은 말씀이네요", "훌륭합니다" 같은 말을 하지 않습니다.
- 답을 유도하지 않습니다. "~해서 좋으셨죠?"처럼 묻지 않습니다.
- 사업을 설명하거나 변호하지 않습니다.

# 진행 규칙
- 시작: 자신이 AI 진행자라고 밝히고, ${minutes}분쯤 걸리며 정답이 없으니 편하게 말씀하시면 된다고 짧게 안내한 뒤 1번 질문을 합니다.
- 꼬리 질문: 질문마다 최대 ${followups}번입니다. 답이 한두 문장으로 끝났거나, 구체적인 장면, 이유, 예가 빠졌거나, 그 질문으로 알고 싶은 것에 닿지 않았으면 합니다. 참여자가 뜻밖의 어려움이나 달라진 행동을 말하면 "그때 어떠셨어요?", "그래서 어떻게 하셨어요?"처럼 한 번 더 묻습니다. 장면과 이유를 충분히 들었으면 꼬리 질문 없이 다음 질문으로 넘어갑니다.
- 짧은 답("좋았어요", "그냥 그랬어요")에는 장면을 묻습니다. "어떤 순간이 기억에 남으세요?", "예를 하나만 들어 주시겠어요?"처럼 묻습니다.
- "모르겠어요", "없어요"라고 하면 한 번만 다르게 묻고, 그래도 없으면 넘어갑니다. 캐묻지 않습니다.
- 사업과 무관한 이야기(다른 민원, 개인사)는 "말씀 잘 들었습니다"로 한 번 받아 주고 질문으로 돌아옵니다.
- 참여자가 질문을 못 알아들으면 더 쉬운 말로 다시 묻습니다.
- 참여자가 사업 정보나 사례비를 물으면 "${project.org} 담당자에게 확인해 주세요"라고 답하고 질문으로 돌아옵니다.
- 힘든 이야기가 나오면 "말씀하기 어려우시면 넘어가도 괜찮습니다"라고 알립니다.
- 소리가 안 들렸거나 말이 없으면 "잘 안 들렸어요. 한 번만 더 말씀해 주시겠어요?"라고 합니다.
- 핵심 질문을 모두 물은 뒤 "마지막으로 더 하고 싶은 말씀이 있으세요?"를 묻습니다.
- 그 답을 듣고 감사 인사를 한 문장으로 한 뒤 곧바로 finish_interview 를 부릅니다. 인사 뒤에 다른 말을 덧붙이지 않습니다.
- 참여자가 그만하고 싶다고 하면 붙잡지 않고 감사 인사를 한 뒤 finish_interview 를 부릅니다.

# 운영 안내
"(진행 안내:"로 시작하는 글은 참여자의 말이 아니라 운영 시스템의 안내입니다. 소리 내어 읽거나 언급하지 말고 내용만 따릅니다.${extra ? `\n\n# 이 사업에서 더 지킬 것\n${extra}` : ''}${resume}`;
}

export function liveSetup(project, rules, priorTurns) {
  return {
    model: LIVE_MODEL,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: VOICES.includes(rules.voice) ? rules.voice : 'Sulafat'}}},
    },
    systemInstruction: {parts: [{text: interviewerPrompt(project, rules, priorTurns)}]},
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // 말의 시작과 끝은 화면이 알려 준다. 진행자가 말하는 동안에는 마이크 소리를 보내지 않아 메아리로 끊기지 않는다.
    realtimeInputConfig: {automaticActivityDetection: {disabled: true}},
    tools: [{functionDeclarations: [{
      name: 'finish_interview',
      description: '인터뷰를 마칠 때 감사 인사 뒤에 부른다.',
      parameters: {type: 'OBJECT', properties: {reason: {type: 'STRING', description: 'done(질문을 모두 마침) 또는 stopped(참여자가 그만함)'}}},
    }]}],
  };
}

// 키 없이 화면을 확인할 때 쓰는 가짜 진행(질문만 순서대로 한다).
export function mockScript(project) {
  return [
    `안녕하세요. 저는 ${project.org}의 인터뷰를 도와드리는 AI 진행자입니다. 정답은 없으니 편하게 말씀해 주세요. ${project.questions[0]?.text || ''}`,
    ...project.questions.slice(1).map(q => `네, 그러셨군요. ${q.text}`),
    '마지막으로 더 하고 싶은 말씀이 있으세요?',
    '말씀 감사합니다. 들려주신 이야기는 잘 전하겠습니다.',
  ];
}

/* ---------- Claude: 질문 가이드 초안 ---------- */
export const GUIDE_SYSTEM = `당신은 공공 사업 평가를 오래 해 온 질적 연구자입니다. AI 진행자가 사업 참여자와 음성으로 10분쯤 나눌 인터뷰의 질문 가이드를 씁니다.

질문을 쓰는 기준
- 핵심 질문은 4개 또는 5개입니다. 발주 기관이 알고 싶은 것을 모두 덮되, 겹치는 질문은 합칩니다.
- 순서는 답하기 쉬운 것(참여 계기, 경험한 장면)에서 시작해 평가(달라진 점, 아쉬운 점, 바라는 점)로 갑니다.
- 질문 하나는 소리 내어 읽을 한두 문장입니다. 한 질문에 한 가지만 묻습니다.
- 참여자가 겪은 일을 떠올려 말하게 묻습니다. "예/아니오"로 끝나는 질문, 점수를 묻는 질문, 답을 유도하는 질문은 쓰지 않습니다.
- 어르신도 한 번 듣고 알아들을 쉬운 말로 씁니다. 행정 용어, 영어, 한자어 약어를 쓰지 않습니다.
- intent 에는 연구자가 이 질문으로 알고 싶은 것을 한 문장으로 적습니다. 진행자가 꼬리 질문을 할지 정하는 기준이 됩니다.
- intro 는 참여자가 인터뷰 첫 화면에서 읽는 안내 두 문장입니다. 누가 무엇을 들으려 하는지 적습니다. 사람을 주어로 쓰고 존대는 "~합니다"체로 씁니다.`;

export const GUIDE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['intro', 'questions'],
  properties: {
    intro: {type: 'string'},
    questions: {type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['text', 'intent'],
      properties: {text: {type: 'string'}, intent: {type: 'string'}},
    }},
  },
};
export const guideUser = p => `기관: ${p.org}\n사업명: ${p.title}\n\n사업 개요:\n${p.brief}\n\n기관이 알고 싶은 것:\n${p.goals || '(따로 적지 않음. 사업 개요를 보고 평가에 필요한 질문을 정합니다.)'}`;

/* ---------- Claude: 인터뷰 한 건 점검 (연구자 검증을 돕는다) ---------- */
export const CODE_SYSTEM = `당신은 질적 연구 보조원입니다. AI 진행자가 사업 참여자 한 명과 나눈 음성 인터뷰의 받아쓰기를 읽고, 이 자료가 분석에 쓸 만큼 갖춰졌는지 점검합니다. 결과는 담당 연구자가 검증할 때 봅니다.

지킬 것
- 받아쓰기에 있는 내용만 씁니다. 짐작으로 채우지 않습니다.
- 받아쓰기는 음성을 기계가 옮긴 것이라 틀린 낱말이 섞여 있습니다. 문맥으로 뜻이 분명하면 그대로 읽고, 뜻을 알 수 없으면 "받아쓰기가 불분명함"이라고 적습니다.
- quotes 에는 참여자가 한 말을 받아쓰기에서 그대로 옮깁니다. 낱말을 고치거나 줄이거나 이어 붙이지 않습니다. 문장 하나에서 셋 사이로 고릅니다. 옮길 만한 말이 없으면 빈 배열로 둡니다.
- 요약은 "참여자는 ~했다"처럼 사람을 주어로 한 평서문으로 씁니다.

핵심 질문별 status
- 충분: 구체적인 장면, 이유, 예가 담긴 답을 했다.
- 부족: 답은 했지만 짧거나 막연하다.
- 없음: 진행자가 묻지 않았거나 참여자가 답하지 않았다.

completeness
- 완결: 핵심 질문 대부분이 '충분'이고 '없음'이 없다.
- 일부: '부족'이나 '없음'이 섞여 있지만 쓸 수 있는 답이 있다.
- 미흡: 쓸 수 있는 답이 거의 없다(중간에 끝남, 무관한 이야기만 함, 장난 응답, 받아쓰기 불능).

interviewer_issues 에는 진행자가 잘못한 점을 적습니다(유도 질문, 평가하는 말, 질문 건너뜀, 같은 질문 반복, 참여자 말을 끊음). 없으면 빈 문자열.
concerns 에는 연구자가 꼭 알아야 할 것을 적습니다(위기 신호, 특정인 실명 비방, 개인정보 노출, 본인이 아닌 사람이 답한 정황). 없으면 빈 문자열.
followup_worthy 는 연구자가 직접 만나 더 들어 볼 만한 참여자인지입니다. 뜻밖의 경험이나 다른 참여자와 다른 관점을 말했을 때만 true 로 합니다.`;

export const CODE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'answers', 'completeness', 'completeness_reason', 'interviewer_issues', 'concerns', 'followup_worthy', 'followup_reason'],
  properties: {
    summary: {type: 'string'},
    answers: {type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['q', 'status', 'summary', 'quotes'],
      properties: {
        q: {type: 'integer'},
        status: {type: 'string', enum: ['충분', '부족', '없음']},
        summary: {type: 'string'},
        quotes: {type: 'array', items: {type: 'string'}},
      },
    }},
    completeness: {type: 'string', enum: ['완결', '일부', '미흡']},
    completeness_reason: {type: 'string'},
    interviewer_issues: {type: 'string'},
    concerns: {type: 'string'},
    followup_worthy: {type: 'boolean'},
    followup_reason: {type: 'string'},
  },
};

export const transcriptText = turns => turns.map(t => `${t.role === 'ai' ? '진행자' : '참여자'}: ${t.text}`).join('\n');
export const guideText = project => project.questions.map((q, i) => `${i + 1}. ${q.text}${q.intent ? ` (알고 싶은 것: ${q.intent})` : ''}`).join('\n');
export const codeUser = (project, turns) => `사업: ${project.title} (${project.org})\n\n핵심 질문:\n${guideText(project)}\n\n받아쓰기:\n${transcriptText(turns)}`;

/* ---------- Claude: 전체 분석 (보고서 초안) ---------- */
export const REPORT_SYSTEM = `당신은 공공 사업 평가 보고서를 쓰는 질적 연구자입니다. 사업 참여자 여러 명의 AI 음성 인터뷰를 읽고 결과보고서의 인터뷰 분석 부분을 씁니다. 발주 기관 담당자가 읽고 사업을 고치는 데 씁니다.

분석 순서
1. 인터뷰를 한 건씩 읽고 핵심 질문마다 참여자가 무엇을 말했는지 정리합니다.
2. 질문별로 비슷한 말을 묶어 주제를 세웁니다. 주제마다 그 내용을 말한 참여자 번호를 빠짐없이 적습니다.
3. 질문을 가로질러 반복되는 내용, 담당자가 몰랐을 내용, 서로 엇갈리는 내용에서 핵심 발견을 3~5개 고릅니다.
4. 발견에서 제언을 끌어냅니다.

지킬 것
- 인터뷰에 있는 내용만 씁니다. 참여자가 말하지 않은 원인이나 효과를 덧붙이지 않습니다.
- count 는 pids 에 적은 참여자 수와 같아야 합니다. 어림하지 않고 셉니다.
- 인용문(text)은 그 참여자가 한 말을 받아쓰기에서 그대로 옮깁니다. 낱말을 고치거나 줄이거나 두 군데를 이어 붙이지 않습니다. 주제마다 하나에서 셋 사이로, 그 주제를 가장 잘 보여 주는 말을 고릅니다.
- 한두 명만 말한 내용도 사업에 뜻이 있으면 주제로 세웁니다. 다수 의견에 묻지 않습니다.
- 참여자 수가 적으므로 "대부분", "전반적으로" 같은 말 대신 "12명 중 7명"처럼 수로 씁니다. 비율(%)은 쓰지 않습니다.
- 제언은 근거가 된 발견을 basis 에 적습니다. 인터뷰에서 근거를 댈 수 없는 제언은 쓰지 않습니다.
- voices 에는 연구자가 직접 만나 더 들어 볼 만한 참여자를 적습니다. 없으면 빈 배열로 둡니다.
- limits 에는 이 조사로 말할 수 없는 것을 적습니다(참여자 수, 자발적 참여에 따른 치우침, AI 진행과 음성 받아쓰기의 한계, 답이 부족했던 질문).

문장
- 평서문 "~다"체로 씁니다. 사람을 주어로 삼고, 일어난 순서대로 씁니다.
- 한 문장에 한 가지만 담습니다. 수식어와 행정 용어를 줄입니다.
- 주제 이름과 발견 제목은 내용을 말하는 짧은 문장이나 구로 씁니다("신청 절차가 어려웠다"처럼). "기타", "긍정적 반응" 같은 묶음 이름은 쓰지 않습니다.`;

const QUOTE = {type: 'object', additionalProperties: false, required: ['pid', 'text'], properties: {pid: {type: 'integer'}, text: {type: 'string'}}};
export const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'findings', 'by_question', 'voices', 'recommendations', 'limits'],
  properties: {
    summary: {type: 'string'},
    findings: {type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['title', 'detail', 'count', 'pids', 'quotes'],
      properties: {title: {type: 'string'}, detail: {type: 'string'}, count: {type: 'integer'}, pids: {type: 'array', items: {type: 'integer'}}, quotes: {type: 'array', items: QUOTE}},
    }},
    by_question: {type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['q', 'overview', 'themes'],
      properties: {
        q: {type: 'integer'},
        overview: {type: 'string'},
        themes: {type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['name', 'detail', 'count', 'pids', 'quotes'],
          properties: {name: {type: 'string'}, detail: {type: 'string'}, count: {type: 'integer'}, pids: {type: 'array', items: {type: 'integer'}}, quotes: {type: 'array', items: QUOTE}},
        }},
      },
    }},
    voices: {type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['pid', 'why'],
      properties: {pid: {type: 'integer'}, why: {type: 'string'}},
    }},
    recommendations: {type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['title', 'detail', 'basis'],
      properties: {title: {type: 'string'}, detail: {type: 'string'}, basis: {type: 'string'}},
    }},
    limits: {type: 'array', items: {type: 'string'}},
  },
};

export function reportUser(project, items) {
  const body = items.map(it => `## 참여자 ${it.pid}\n${transcriptText(it.turns)}`).join('\n\n');
  return `사업: ${project.title} (${project.org})\n\n사업 개요:\n${project.brief}\n\n기관이 알고 싶은 것:\n${project.goals || '(따로 없음)'}\n\n핵심 질문:\n${guideText(project)}\n\n인터뷰 ${items.length}건의 받아쓰기입니다. 참여자 번호는 아래 제목의 번호를 그대로 씁니다.\n\n${body}`;
}

/* ---------- 인용문 대조 — 받아쓰기에 없는 인용문을 걸러 낸다 ---------- */
const squash = s => String(s).replace(/[\s.,!?…~"'“”‘’·()\-]/g, '');
export function quoteFound(text, turns) {
  const q = squash(text);
  if (q.length < 2) return false;
  const said = squash(turns.filter(t => t.role === 'p').map(t => t.text).join(' '));
  return said.includes(q);
}

// 분석 결과의 수와 인용문을 받아쓰기와 대조해 고친다. 대조에 실패한 인용문은 unverified 로 옮긴다.
export function auditReport(raw, byPid) {
  const dropped = [];
  const fixQuotes = (quotes, where) => (Array.isArray(quotes) ? quotes : []).filter(q => {
    const ok = byPid.has(q.pid) && quoteFound(q.text, byPid.get(q.pid));
    if (!ok) dropped.push({where, pid: q.pid, text: str(q.text, 300)});
    return ok;
  }).map(q => ({pid: q.pid, text: str(q.text, 400)}));
  const fixPids = pids => [...new Set((Array.isArray(pids) ? pids : []).filter(p => byPid.has(p)))].sort((a, b) => a - b);
  const block = (x, where) => {
    const pids = fixPids(x.pids);
    return {detail: str(x.detail, 1200), pids, count: pids.length, quotes: fixQuotes(x.quotes, where)};
  };
  return {
    summary: str(raw.summary, 1500),
    findings: (raw.findings || []).slice(0, 6).map(f => ({title: str(f.title, 120), ...block(f, `핵심 발견 · ${str(f.title, 40)}`)})),
    by_question: (raw.by_question || []).map(b => ({
      q: b.q, overview: str(b.overview, 800),
      themes: (b.themes || []).slice(0, 8).map(t => ({name: str(t.name, 120), ...block(t, `질문 ${b.q} · ${str(t.name, 40)}`)})),
    })),
    voices: (raw.voices || []).filter(v => byPid.has(v.pid)).slice(0, 5).map(v => ({pid: v.pid, why: str(v.why, 400)})),
    recommendations: (raw.recommendations || []).slice(0, 6).map(r => ({title: str(r.title, 120), detail: str(r.detail, 800), basis: str(r.basis, 400)})),
    limits: (raw.limits || []).map(l => str(l, 400)).filter(Boolean).slice(0, 6),
    unverified: dropped,
  };
}

export function auditCoding(raw, project, turns) {
  const n = project.questions.length;
  const dropped = [];
  const answers = Array.from({length: n}, (_, i) => {
    const a = (raw.answers || []).find(x => x.q === i + 1) || {status: '없음', summary: '', quotes: []};
    const quotes = (a.quotes || []).filter(q => {
      const ok = quoteFound(q, turns);
      if (!ok) dropped.push(str(q, 300));
      return ok;
    }).map(q => str(q, 400)).slice(0, 3);
    return {q: i + 1, status: ['충분', '부족', '없음'].includes(a.status) ? a.status : '없음', summary: str(a.summary, 600), quotes};
  });
  return {
    summary: str(raw.summary, 800),
    answers,
    completeness: ['완결', '일부', '미흡'].includes(raw.completeness) ? raw.completeness : '미흡',
    completeness_reason: str(raw.completeness_reason, 400),
    interviewer_issues: str(raw.interviewer_issues, 600),
    concerns: str(raw.concerns, 600),
    followup_worthy: raw.followup_worthy === true,
    followup_reason: str(raw.followup_reason, 400),
    unverified: dropped,
    at: new Date().toISOString(),
  };
}
