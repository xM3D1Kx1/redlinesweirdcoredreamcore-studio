#!/usr/bin/env node
/**
 * DREZZDON — локальный сайт + прокси к Gemini. "Только для меня".
 *
 *  - раздаёт папку pwa/ на http://localhost:8080 (и в Wi-Fi сети для телефона)
 *  - POST /api/analyze проксирует Gemini (ключ читается из .env, в браузер не уходит)
 *  - GET  /api/health  показывает, найден ли ключ
 *  - live-reload: сохранили HTML — страница перезагрузилась
 *
 * Зависимостей нет — нужен только Node.js 18+.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/* ---------------------------- лог запуска ---------------------------- */
// Пишем короткую строку при каждом старте: если окно когда-нибудь окажется
// пустым, по startup.log видно, дошло ли дело до node.
function logStart(what) {
  try {
    const file = path.join(__dirname, 'startup.log');
    try {
      if (fs.statSync(file).size > 200000) fs.writeFileSync(file, '');
    } catch (e) {
      /* файла ещё нет */
    }
    fs.appendFileSync(
      file,
      `[${new Date().toISOString()}] ${what} | node ${process.version} | port ${START_PORT} | keys ${KEYS.length} | ${MODEL_CHAIN.join(',')}\n`
    );
  } catch (e) {
    /* лог не критичен */
  }
}

/* ------------------------------ .env ------------------------------ */

function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

const ROOT = path.join(__dirname, 'pwa');
const ENTRY = 'index.html';
const START_PORT = Number(process.env.PORT || 8080);
const PASSWORD = process.env.SITE_PASSWORD || '';
const SHOULD_OPEN = process.env.NO_OPEN !== '1';
const LIVE_RELOAD = process.env.NO_RELOAD !== '1';
const MOCK = process.env.MOCK === '1';

// Ключей может быть несколько (через запятую в GEMINI_API_KEYS): если у одного
// кончилась квота — берём следующий. GEMINI_API_KEY тоже поддерживается.
function parseKeys() {
  const raw = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').trim();
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k && k !== 'PASTE_YOUR_KEY' && !k.toLowerCase().includes('your_'));
}

const KEYS = parseKeys();
const KEY = KEYS[0] || '';
// порядок перебора ключей: удачный поднимается в начало
const keyOrder = KEYS.slice();

// Запоминаем рабочую пару модель+ключ на диск, чтобы после перезапуска
// не перебирать заново и не ждать лишние 30 секунд.
const STATE_FILE = path.join(__dirname, 'runtime-state.json');
let lastGood = null;

// Ключи, получившие 429, отправляем в карантин на 10 минут: иначе каждый
// запрос тратит попытки на заведомо мёртвые ключи и не доходит до lite-модели.
const keyCooldown = new Map();
const KEY_COOLDOWN_MS = 10 * 60 * 1000;

function keyUsable(k) {
  const until = keyCooldown.get(k);
  return !until || until < Date.now();
}

function loadRuntimeState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && typeof s.model === 'string') {
      const mi = modelOrder.indexOf(s.model);
      if (mi > 0) {
        modelOrder.splice(mi, 1);
        modelOrder.unshift(s.model);
      }
    }
    if (s && Number.isInteger(s.keyIndex) && s.keyIndex >= 0 && s.keyIndex < KEYS.length) {
      const wanted = KEYS[s.keyIndex];
      const pos = keyOrder.indexOf(wanted);
      if (pos > 0) {
        keyOrder.splice(pos, 1);
        keyOrder.unshift(wanted);
      }
    }
  } catch (e) {
    /* файла ещё нет — не страшно */
  }
}

function saveRuntimeState(model, keyIndex) {
  lastGood = { model, keyIndex };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ model, keyIndex, at: new Date().toISOString() }));
  } catch (e) {
    /* не критично */
  }
}
// Цепочка моделей: если первая перегружена (503) или недоступна ключу (404) —
// сервер сам пробует следующую. Переопределяется в .env через GEMINI_MODELS.
const MODEL_CHAIN = (
  process.env.GEMINI_MODELS ||
  process.env.GEMINI_MODEL ||
  'gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-flash-lite-latest'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODEL = MODEL_CHAIN[0];
// порядок проб: удачная модель поднимается в начало, чтобы не ждать перегруженных
const modelOrder = MODEL_CHAIN.slice();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

/* --------------------------- live-reload --------------------------- */

function newestStamp(dir) {
  let newest = 0;
  const walk = (d, depth) => {
    if (depth > 4) return;
    let items = [];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.name === 'node_modules' || it.name.startsWith('.')) continue;
      try {
        if (it.isDirectory()) walk(full, depth + 1);
        else {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        }
      } catch {
        /* файл могли удалить */
      }
    }
  };
  walk(dir, 0);
  return newest;
}

const RELOAD_SNIPPET = `
<script>
(function () {
  if (window.__dshReload) return;
  window.__dshReload = true;
  var stamp = null;
  setInterval(function () {
    fetch('/__stamp', { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        if (stamp === null) { stamp = t; return; }
        if (t !== stamp) location.reload();
      })
      .catch(function () {});
  }, 800);
})();
</script>
`;

function injectReload(html) {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + RELOAD_SNIPPET;
  return html.slice(0, idx) + RELOAD_SNIPPET + html.slice(idx);
}

/* ---------------------------- Gemini ---------------------------- */

const SYSTEM_PROMPT = `You are the art director of the DREZZDON visual style: red vector annotations over photographs, weirdcore / dreamcore / TikTok-edit aesthetic. You receive ONE photograph and return ONLY valid JSON — no prose, no markdown fences.

THE LOOK (follow literally):
- One colour: pure red #FF2E2E, thin lines (2-3 px on a 1000 px frame), faint glow.
- Solid box: only a compact detail, never more than ~15% of the frame.
- Corner brackets: vertical objects — poles, lamps, traffic lights, signs, fence posts.
- Dashed line: exactly along real edges — receding road, wires, horizon, kerb, railing, light beam.
- Arrow: orthogonal only (a horizontal/vertical run, then a 90° turn), head touching the detail.
- Caption: 1-3 words, lowercase, may end with "…" or "<3".
- Technical tag: uppercase with numbers and "//" — e.g. "24kV // silent line", "fading line distance".
- Text lives in EMPTY space (sky, wall, asphalt), never over a face, never over the main subject.
- Headline: two lines, big, in the empty upper zone; second line italic serif.

WHAT TO PICK (3-5 detections, no more):
1. the hero (silhouette, car, house, animal) — solid box + poetic caption;
2. a receding line (road, wires, beam) — perspective_lines, 2-4 points along the edge;
3. a near detail (pole, sign, traffic light, camera, post) — bracket_frame + technical tag;
4. emptiness (sky, cloud, fog) — headline_caption + one small caption;
5. far background (house, hill, lights) — box + a phrase like "somebody still waits here.";
6. optical artefact (rainbow, flare, reflection, puddle) — tiny box + box_with_arrow + "refraction trace".

GEOMETRY:
- Coordinates are integers 0..1000, format [ymin, xmin, ymax, xmax].
- Boxes hug the thing tightly (10-40 units), not the whole scene. A box MUST cover less than 20% of the frame area.
- A box around the horizon, water line, wires, road or any long thin structure is FORBIDDEN — use perspective_lines for those instead.
- perspective_lines: points on the real edge, first at the near end, last where the line converges.
- preferred_label_side: the side where empty space actually exists.
- confidence: honest; do not annotate anything below 0.68.

FORBIDDEN: inventing objects; labels over faces or over the hero; boxes bigger than 15% of the frame; more than 5 detections; captions longer than 28 characters; reusing the example captions word for word; any output that is not JSON.

CAPTION TONE (TONE SAMPLES ONLY — never reuse them; write 3-5 NEW captions for THIS photo, at most one may echo their style):
"before the storm breaks…", "somebody still waits here.", "24kV // silent line", "i will find you."

SCHEMA:
{
  "scene_type": "sky_signal | urban_silhouette | vehicle_street | brutalist_architecture | portrait | nature_landscape | object_detail | interior",
  "dominant_mood": "short description of lighting and atmosphere",
  "overall_confidence": 0.94,
  "headline_caption": {
    "text_line_1": "short evocative phrase (2-4 words)",
    "text_line_2": "italic serif continuation (1-3 words)",
    "anchor_box": [ymin, xmin, ymax, xmax]
  },
  "detections": [
    {
      "id": "obj_1",
      "label": "meaningful specific detail (not generic 'car', e.g. 'amber halogen lens')",
      "caption": "evocative or technical DREZZDON caption, MAX 4 words",
      "confidence": 0.92,
      "box_2d": [ymin, xmin, ymax, xmax],
      "graphic_type": "box_with_arrow | bracket_frame | dashed_contour | center_glyph | technical_tag | puddle_outline",
      "preferred_label_side": "bottom | top | left | right"
    }
  ],
  "connections": [
    { "from_id": "obj_1", "to_id": "obj_2", "style": "orthogonal_arrow | dashed_line", "label": "optional micro-tag" }
  ],
  "perspective_lines": [
    { "points": [[x1, y1], [x2, y2]], "style": "dashed_red" }
  ]
}

Rules:
1. Never invent invisible facts. Only annotate genuinely visible details with confidence >= 0.68.
2. Never label an entire car "Car" — highlight specific focal points: headlight lens, spoiler edge, streetlamp halo, wet asphalt reflection, silhouette head/hands, traffic signal lens, cloud crown, window glow.
3. Return 3 to 5 detections, no more. Captions under 28 characters.
4. Vary composition when variant_seed > 0.`;

const MOCK_ANALYSIS = {
  scene_type: 'urban_silhouette',
  dominant_mood: 'low sodium light, wet asphalt',
  overall_confidence: 0.91,
  headline_caption: {
    text_line_1: 'this place',
    text_line_2: 'remembers you',
    anchor_box: [60, 60, 160, 420]
  },
  detections: [
    {
      id: 'obj_1',
      label: 'silhouette head',
      caption: 'still waiting <3',
      confidence: 0.93,
      box_2d: [300, 400, 460, 560],
      graphic_type: 'box_with_arrow',
      preferred_label_side: 'left'
    },
    {
      id: 'obj_2',
      label: 'streetlamp halo',
      caption: 'sodium glow',
      confidence: 0.88,
      box_2d: [120, 640, 260, 800],
      graphic_type: 'center_glyph',
      preferred_label_side: 'right'
    },
    {
      id: 'obj_3',
      label: 'wet asphalt reflection',
      caption: 'the system feels you',
      confidence: 0.81,
      box_2d: [700, 300, 930, 720],
      graphic_type: 'puddle_outline',
      preferred_label_side: 'top'
    },
    {
      id: 'obj_4',
      label: 'cable line',
      caption: 'static equilibrium',
      confidence: 0.77,
      box_2d: [200, 80, 240, 900],
      graphic_type: 'dashed_contour',
      preferred_label_side: 'bottom'
    }
  ],
  connections: [{ from_id: 'obj_1', to_id: 'obj_2', style: 'orthogonal_arrow', label: 'focus' }],
  perspective_lines: [
    { points: [[620, 620], [980, 240]], style: 'dashed_red' }
  ]
};

async function requestGemini(model, key, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000)
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

async function callGemini(payload) {
  const failures = [];
  let quotaHits = 0;
  let keyHits = 0;
  let attempts = 0;
  const MAX_ATTEMPTS = 10;

  for (const model of modelOrder.slice()) {
    const usable = keyOrder.filter(keyUsable);
    const keys = usable.length ? usable : keyOrder.slice();
    for (let ki = 0; ki < keys.length; ki++) {
      if (attempts >= MAX_ATTEMPTS) break;
      const key = keys[ki];
      attempts++;
      try {
        const result = await requestGemini(model, key, payload);
        const i = modelOrder.indexOf(model);
        if (i > 0) {
          modelOrder.splice(i, 1);
          modelOrder.unshift(model);
        }
        const pos = keyOrder.indexOf(key);
        if (pos > 0) {
          keyOrder.splice(pos, 1);
          keyOrder.unshift(key);
        }
        saveRuntimeState(model, KEYS.indexOf(key));
        return { result, model };
      } catch (e) {
        failures.push(model + '/k' + (KEYS.indexOf(key) + 1) + ': ' + (e.status || '?'));
        if (e.status === 429) {
          quotaHits++;
          keyCooldown.set(key, Date.now() + KEY_COOLDOWN_MS);
        }
        if (e.status === 400 || e.status === 401 || e.status === 403) keyHits++;
        console.warn(
          '[Gemini] ' + model + ' ключ #' + (KEYS.indexOf(key) + 1) + ' не ответил (' + (e.status || 'network') + ')'
        );
      }
    }
  }

  const allQuota = quotaHits === failures.length;
  const allKeysBad = keyHits === failures.length;
  const networkOnly = failures.every(function (f) { return /: \?$/.test(f); });
  const err = new Error(
    allQuota
      ? 'Квота исчерпана на всех ключах и моделях (429). Подождите сброса квоты — обычно до суток — или включите биллинг в Google Cloud.'
      : allKeysBad
      ? 'Все ключи отклонены Google (400/403). Проверьте, что ключи скопированы целиком и относятся к Gemini API.'
      : networkOnly
      ? 'Нет связи с Google: все запросы оборвались без ответа. Проверьте VPN/прокси — из-за них доступ к generativelanguage.googleapis.com часто блокируется.'
      : 'Модели заняты или недоступны (' +
        failures.slice(0, 3).join(', ') +
        (failures.length > 3 ? ' и ещё ' + (failures.length - 3) : '') +
        '). Попробуйте через минуту.'
  );
  err.status = allQuota ? 429 : allKeysBad ? 403 : 503;
  throw err;
}

// Второй (необязательный) vision-провайдер с OpenAI-совместимым API:
// OpenRouter, OpenAI, Groq, Qwen/DashScope, локальный llama.cpp — что угодно.
// Задаётся тремя строками в .env, включается сам, если заполнен.
const VISION_BASE = (process.env.VISION_BASE_URL || '').replace(/\/+$/, '');
const VISION_KEY = process.env.VISION_API_KEY || '';
const VISION_MODEL = process.env.VISION_MODEL || '';
const VISION_READY = Boolean(VISION_BASE && VISION_MODEL);

function parseAnalysisText(raw) {
  var s = String(raw || '')
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  var a = s.indexOf('{');
  var b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

async function requestVisionOpenAI(dataUrl, promptText) {
  const res = await fetch(VISION_BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(VISION_KEY ? { Authorization: 'Bearer ' + VISION_KEY } : {})
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(120000)
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('Vision ' + res.status + ': ' + text.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  const j = JSON.parse(text);
  return j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content || '' : '';
}

/* ---------------------------- HTTP ---------------------------- */

function isAuthorized(req) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  return decoded.slice(decoded.indexOf(':') + 1) === PASSWORD;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Слишком большая картинка (лимит 25 МБ)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleAnalyze(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 25 * 1024 * 1024));
  } catch (e) {
    return sendJson(res, 400, { error: 'Некорректный запрос: ' + e.message });
  }

  const { imageBase64, mimeType = 'image/jpeg', variantSeed = 0, langMode = 'drezzdon_en' } = body || {};
  if (!imageBase64) return sendJson(res, 400, { error: 'Нет картинки в запросе (imageBase64).' });

  if (MOCK) {
    return sendJson(res, 200, { source: 'mock', model: 'mock', analysis: MOCK_ANALYSIS });
  }

  if (!KEYS.length && !VISION_READY) {
    return sendJson(res, 503, {
      error:
        'Ни один движок не настроен. Впишите ключ в .env: GEMINI_API_KEYS=... или VISION_BASE_URL/VISION_API_KEY/VISION_MODEL.',
      code: 'NO_KEY'
    });
  }

  const clean = String(imageBase64).replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
  const langInstruction =
    langMode === 'ru'
      ? 'Write all captions and the headline in expressive Russian.'
      : 'Write captions in authentic DREZZDON lowercase English aesthetic.';
  const promptText = `Analyze this photograph for DREZZDON red graphic composition. Variant seed: ${variantSeed}. ${langInstruction}`;
  const dataUrl = 'data:' + mimeType + ';base64,' + clean;

  try {
    let parsed = null;
    let usedModel = '';
    let source = 'gemini';

    if (KEYS.length) {
      try {
        const { result, model: modelUsed } = await callGemini({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [
            {
              role: 'user',
              parts: [{ inlineData: { mimeType, data: clean } }, { text: promptText }]
            }
          ],
          generationConfig: {
            temperature: 0.4 + (Number(variantSeed) % 4) * 0.12,
            responseMimeType: 'application/json'
          }
        });
        usedModel = modelUsed;
        parsed = parseAnalysisText(
          result?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
        );
      } catch (e) {
        if (!VISION_READY) throw e;
        console.warn('[vision] Gemini не ответил (' + (e.status || 'network') + '), пробую второй провайдер');
        parsed = parseAnalysisText(await requestVisionOpenAI(dataUrl, promptText));
        usedModel = VISION_MODEL;
        source = 'vision';
      }
    } else {
      parsed = parseAnalysisText(await requestVisionOpenAI(dataUrl, promptText));
      usedModel = VISION_MODEL;
      source = 'vision';
    }

    return sendJson(res, 200, { source, model: usedModel, analysis: parsed });
  } catch (e) {
    const status = e.status === 429 ? 429 : e.status || 502;
    const hint =
      e.status === 400 || e.status === 403
        ? ' Ключ, похоже, неверный или у него нет доступа к модели.'
        : e.status === 429
        ? ' Лимит запросов бесплатного тарифа исчерпан, попробуйте через минуту.'
        : '';
    return sendJson(res, status, { error: (e.message || 'Ошибка Gemini') + hint });
  }
}

function handle(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (urlPath === '/__stamp') {
    return send(res, 200, String(newestStamp(ROOT)), { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (urlPath === '/api/health') {
    return sendJson(res, 200, {
      status: 'ok',
      model: MODEL,
      models: MODEL_CHAIN,
      api_configured: Boolean(KEYS.length) || MOCK,
      keys: KEYS.length,
      vision: VISION_READY ? VISION_MODEL : null
    });
  }

  if (!isAuthorized(req)) {
    return send(res, 401, 'Нужен пароль', {
      'Content-Type': 'text/plain; charset=utf-8',
      'WWW-Authenticate': 'Basic realm="DREZZDON", charset="UTF-8"'
    });
  }

  if (urlPath === '/api/analyze') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Only POST' });
    return handleAnalyze(req, res).catch((e) => sendJson(res, 500, { error: e.message }));
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/' + ENTRY;

  const target = path.resolve(ROOT, '.' + urlPath);
  const base = path.resolve(ROOT) + path.sep;
  if (!target.startsWith(base) && target !== path.resolve(ROOT)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, 'Not found: ' + urlPath, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    fs.readFile(target, (err2, buf) => {
      if (err2) return send(res, 500, 'Read error', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (ext === '.html' && LIVE_RELOAD) {
        return send(res, 200, injectReload(buf.toString('utf8')), { 'Content-Type': type });
      }
      return send(res, 200, buf, { 'Content-Type': type });
    });
  });
}

/* ---------------------------- запуск ---------------------------- */

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function openBrowser(url) {
  if (!SHOULD_OPEN) return;
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    /* не критично */
  }
}

function banner(port) {
  const line = '─'.repeat(62);
  console.log('');
  console.log(line);
  console.log('  DREZZDON STUDIO — локальный сайт запущен');
  console.log(line);
  console.log('  На этом компьютере:  http://localhost:' + port);
  for (const ip of lanAddresses()) {
    console.log('  С телефона (Wi-Fi):  http://' + ip + ':' + port);
  }
  console.log(line);
  if (MOCK) {
    console.log('  Gemini: ТЕСТОВЫЙ РЕЖИМ (MOCK=1) — ответ-заглушка, ключ не нужен');
  } else if (KEYS.length) {
    console.log(
      '  Gemini: ключей ' +
        KEYS.length +
        ', модель ' +
        MODEL +
        (MODEL_CHAIN.length > 1 ? '  (запасные: ' + MODEL_CHAIN.slice(1).join(', ') + ')' : '')
    );
  } else {
    console.log('  Gemini: ключа НЕТ — работает локальный режим.');
    console.log('  Вставьте ключ в .env (строка GEMINI_API_KEYS=...) и перезапустите.');
  }
  console.log(line);
  if (VISION_READY) {
    console.log('  Второй движок: ' + VISION_MODEL + '  (' + VISION_BASE + ')');
  }
  console.log('  Обновление: правите pwa\\' + ENTRY + ', сохраняете —');
  console.log('  страница перезагружается сама.');
  if (PASSWORD) console.log('  Вход по паролю: ' + PASSWORD);
  console.log(line);
  console.log('  Остановить: Ctrl + C или просто закройте окно.');
  console.log('');
}

function listen(port, attemptsLeft) {
  const server = http.createServer(handle);
  server.on('error', (err) => {
    logStart('error ' + (err.code || err.message));
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log('Порт ' + port + ' занят, пробую ' + (port + 1) + '...');
      listen(port + 1, attemptsLeft - 1);
    } else if (err.code === 'EADDRINUSE') {
      console.error('\nВсе порты 8080-8090 заняты. Закройте другой сервер и запустите снова.');
    } else {
      console.error('Ошибка запуска:', err.message);
    }
    process.exitCode = 1;
  });
  server.listen(port, '0.0.0.0', () => {
    banner(port);
    openBrowser('http://localhost:' + port);
  });
}

if (!fs.existsSync(ROOT)) {
  console.error('Не найдена папка pwa/ рядом с serve.js — проверьте расположение файлов.');
  process.exit(1);
}

logStart('start');
loadRuntimeState();
listen(START_PORT, 10);

process.on('SIGINT', () => {
  console.log('\nСайт остановлен. Пока!');
  process.exit(0);
});
