// Serverless-функция (Vercel) / роут (Express на Beget) — отвечает на свободные вопросы
// пользователя в чате через Polza.ai (агрегатор, OpenAI-совместимый API).
// Ключ живёт только на сервере (POLZA_API_KEY) — в браузер не попадает.

const https = require('https');
const STRATEGIES = require('../js/strategies.js');
const { REGIONS } = require('../js/region-data.js');

const MODEL = 'anthropic/claude-haiku-4.5';
const MAX_REQUESTS_PER_HOUR = 12;
const requestLog = new Map();

const KNOWLEDGE_BASE = Object.values(STRATEGIES).map(s =>
  `Стратегия ${s.id}: ${s.title}\nОписание: ${s.desc}\nПодходит для: ${s.suitable.join(', ')}\nШаги: ${s.steps.join('; затем ')}\nПредупреждение: ${s.warning}`
).join('\n\n');

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е');
}

function findMentionedRegion(question) {
  const text = normalizeText(question);
  return REGIONS.find(region => {
    const name = normalizeText(region.name)
      .replace(/республика|область|край|автономный округ|г\.\s*/g, '')
      .trim();
    return name.length > 3 && text.includes(name);
  }) || null;
}

function regionalContext(question) {
  const region = findMentionedRegion(question);
  if (!region) return 'Регион в вопросе не распознан. Не называй ставку выкупа, пока пользователь не назовёт регион.';
  return `Региональная справка для «${region.name}» (источник базы: июнь 2026, перед действием перепроверить региональный акт):\n- Выкуп сразу в собственность: ${region.buyout}\n- Выкуп после аренды: ${region.lease}`;
}

const SYSTEM_PROMPT = `Ты — ассистент сервиса «Земельный Штурман», помогаешь людям получить землю от государства (не в юридической консультации, а в справочном формате).

Отвечай только на основе базы знаний ниже — это 11 стратегий получения земли, которые обсуждались на курсе. Если вопрос выходит за рамки темы «получение земли от государства» или ответа нет в базе — честно скажи, что не знаешь, и посоветуй обратиться к юристу или к автору курса, не выдумывай факты (номера законов, сроки, суммы).

Отвечай по-русски, простым языком без канцелярита, без эмодзи и без Markdown-разметки.

Каждый ответ строй в понятной последовательности:
Короткий вывод: одна фраза.
Что сделать сейчас: один самый ближайший конкретный шаг.
Дальше: 2–4 действия в порядке очереди.
Что проверить: риски, документы или данные, без которых нельзя двигаться.
Если действительно не хватает важной детали — один короткий уточняющий вопрос в конце.

Не придумывай названия кнопок, сроки, суммы или законы. Не утверждай, что участок свободен, торги опубликованы, а данные Росреестра актуальны: у тебя нет прямого доступа к реестрам в реальном времени. В таких случаях дай путь проверки через НСПД, ГИС Торги, Росреестр или администрацию. Если точный путь зависит от региона, прямо скажи, что именно нужно уточнить в администрации. Термины объясняй в скобках при первом упоминании.

БАЗА ЗНАНИЙ (11 стратегий):
${KNOWLEDGE_BASE}`;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map(item => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: String(item?.content || '').slice(0, 1200)
  })).filter(item => item.content.trim());
}

function callPolza(question, history) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...sanitizeHistory(history),
        { role: 'system', content: regionalContext(question) },
        { role: 'user', content: question }
      ],
      max_tokens: 700
    });

    const req = https.request({
      hostname: 'polza.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.POLZA_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 20000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`polza_status_${res.statusCode}: ${body}`);
          err.status = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('invalid_json_response'));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function canAsk(ip) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const recent = (requestLog.get(ip) || []).filter(time => time > hourAgo);

  if (recent.length >= MAX_REQUESTS_PER_HOUR) {
    requestLog.set(ip, recent);
    return false;
  }

  recent.push(now);
  requestLog.set(ip, recent);
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const question = String(req.body?.question || '').trim();
  const history = req.body?.history;

  if (!question) {
    res.status(400).json({ error: 'empty_question' });
    return;
  }

  if (question.length > 1000) {
    res.status(400).json({ error: 'question_too_long' });
    return;
  }

  if (!canAsk(getClientIp(req))) {
    res.status(429).json({ error: 'rate_limit_exceeded' });
    return;
  }

  if (!process.env.POLZA_API_KEY) {
    res.status(500).json({ error: 'no_api_key' });
    return;
  }

  try {
    const data = await callPolza(question, history);
    const answer = data?.choices?.[0]?.message?.content;

    if (!answer) {
      res.status(502).json({ error: 'empty_answer' });
      return;
    }

    res.status(200).json({ answer });
  } catch (e) {
    res.status(502).json({ error: 'upstream_unavailable', message: String(e.message || e) });
  }
};
