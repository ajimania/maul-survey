// 정책 인포그래픽 만들기 — 그림 프롬프트와 입력 검증. infographic-draw.js(Gemini)가 쓴다.

export const IMAGE_MODEL = 'gemini-3-pro-image';

export class InputError extends Error {}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, maxItems, maxLen) =>
  (Array.isArray(v) ? v : []).map(s => str(s, maxLen)).filter(Boolean).slice(0, maxItems);

export function cleanFields(f = {}) {
  return {
    title: str(f.title, 40),
    oneLiner: str(f.oneLiner, 80),
    persona: str(f.persona, 60),
    now: str(f.now, 100),
    scenes: list(f.scenes, 6, 40),
    benefits: list(f.benefits, 4, 40),
    operators: str(f.operators, 60),
  };
}

/* ---------- 그림 (Gemini) ---------- */

export const STYLES = {
  warm: '따뜻한 손그림 일러스트 (색연필과 수채화 느낌, 부드러운 선)',
  public: '깔끔한 공공기관 안내물 (평면 벡터 일러스트, 정돈된 격자, 단정한 색)',
  cartoon: '귀여운 캐릭터 만화 (둥글고 귀여운 인물, 밝은 색, 말풍선 느낌)',
  icon: '단순한 아이콘 도표 (굵은 선 아이콘 위주, 그림은 최소화, 도표처럼 명료하게)',
};

const MAX_IMAGE_B64 = 3_000_000; // 약 2.2MB. 스케치·이전 그림은 화면에서 줄여 보낸다.

function imageInput(v) {
  if (typeof v !== 'string' || !v) return null;
  const m = v.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new InputError('사진 형식을 읽지 못했어요. 다른 사진으로 해 주세요.');
  if (m[2].length > MAX_IMAGE_B64) throw new InputError('사진이 너무 커요. 다른 사진으로 해 주세요.');
  return {mimeType: m[1], data: m[2]};
}

export function validateDraw(body) {
  if (!body || typeof body !== 'object') throw new InputError('입력을 읽지 못했어요.');
  const fields = cleanFields(body.fields);
  if (!fields.title) throw new InputError('서비스 이름을 적어 주세요.');
  if (fields.scenes.length < 2) throw new InputError('시나리오 장면을 두 개 이상 적어 주세요.');
  const edit = body.edit && typeof body.edit === 'object'
    ? {request: str(body.edit.request, 300), image: imageInput(body.edit.image)}
    : null;
  if (edit && (!edit.request || !edit.image)) throw new InputError('무엇을 고칠지 적어 주세요.');
  return {
    fields,
    region: str(body.region, 30),
    style: STYLES[body.style] ? body.style : 'warm',
    sketch: edit ? null : imageInput(body.sketch),
    edit,
    mock: body.mock === true,
  };
}

// 그림에 들어갈 문구 목록. 새로 그릴 때와 고쳐 그릴 때 모두 같은 문구를 정확히 넣게 한다.
function textBlock(f) {
  const lines = [
    `[맨 위 제목] "${f.title}"`,
    f.oneLiner && `[제목 아래 한 줄] "${f.oneLiner}"`,
    f.now && `[지금은 — 붉은 톤 상자, 힘들어하는 주인공 그림] "지금은" / "${f.now}"`,
    `[가운데 — 번호가 붙은 ${f.scenes.length}칸 시나리오, 칸마다 장면 그림과 짧은 글]`,
    ...f.scenes.map((s, i) => ` ${i + 1} "${s}"`),
    f.benefits.length && `[아래 — 초록 톤 상자] "무엇이 좋아지나요" / ${f.benefits.map(b => `"${b}"`).join(' / ')}`,
    f.operators && `[아래 상자] "누가 운영하나요" / "${f.operators}"`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function buildDrawRequest({fields: f, region, style, sketch, edit}) {
  const parts = [];
  if (edit) {
    parts.push({text: `첨부한 정책 인포그래픽을 다음 요청대로 고쳐 주세요.
요청: ${edit.request}

요청한 부분 외에는 배치와 그림체를 그대로 둡니다. 세로형(3:4)을 유지합니다.
그림 속 한국어 문구는 아래와 글자 하나 틀리지 않게 정확히 같아야 하고, 다른 글자는 넣지 않습니다.
(요청이 문구를 바꾸라는 것이면 그 부분만 요청대로 바꿉니다.)

${textBlock(f)}`});
    parts.push({inlineData: edit.image});
  } else {
    parts.push({text: `세로형(3:4) 정책 소개 인포그래픽을 그려 주세요.
그림체: ${STYLES[style]}. 흰 바탕에 여백을 넉넉히 두고, 색은 서너 가지로 조화롭게.
주인공은 "${f.persona || '이 서비스를 쓰는 주민'}"이고, 모든 장면에 같은 인물로 일관되게 등장합니다.${region ? `\n배경은 한국의 ${region} 지역 분위기로 그립니다.` : ''}
시나리오 칸은 번호 순서대로 화살표로 이어지게 하고, 장면마다 글의 내용이 그림으로 분명히 보이게 합니다.
아래 한국어 문구를 글자 하나 틀리지 않게 정확히 그대로 넣고, 다른 글자는 넣지 마세요.

${textBlock(f)}`});
    if (sketch) {
      parts.push({text: '첨부한 사진은 조원들이 손으로 그린 스케치입니다. 배치와 구도, 그림 아이디어를 참고하되, 문구는 위의 것을 씁니다.'});
      parts.push({inlineData: sketch});
    }
  }
  return {
    contents: [{role: 'user', parts}],
    generationConfig: {responseModalities: ['IMAGE'], imageConfig: {aspectRatio: '3:4', imageSize: '2K'}},
  };
}
