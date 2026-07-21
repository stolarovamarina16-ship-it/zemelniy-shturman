// Serverless-функция (Vercel) / роут (Express на Beget) — отвечает на свободные вопросы
// пользователя в чате через Polza.ai (агрегатор, OpenAI-совместимый API).
// Ключ живёт только на сервере (POLZA_API_KEY) — в браузер не попадает.

const https = require('https');
const STRATEGIES = require('../js/strategies.js');

const MODEL = 'anthropic/claude-haiku-4.5';

const KNOWLEDGE_BASE = Object.values(STRATEGIES).map(s =>
  `Стратегия ${s.id}: ${s.title}\nОписание: ${s.desc}\nПодходит для: ${s.suitable.join(', ')}\nШаги: ${s.steps.join(' → ')}\nПредупреждение: ${s.warning}`
).join('\n\n');

const SYSTEM_PROMPT = `Ты — ассистент сервиса «Земельный Штурман», помогаешь людям получить землю от государства (не в юридической консультации, а в справочном формате).

Отвечай только на основе базы знаний ниже — это 11 стратегий получения земли, которые обсуждались на курсе. Если вопрос выходит за рамки темы «получение земли от государства» или ответа нет в базе — честно скажи, что не знаешь, и посоветуй обратиться к юристу или к автору курса, не выдумывай факты (номера законов, сроки, суммы).

Отвечай кратко (3-6 предложений), по-русски, простым языком без канцелярита. Объясняй термины (ЗОУИТ, ВРИ, СРЗУ и т.п.), если они встречаются в ответе.

БАЗА ЗНАНИЙ (11 стратегий):
${KNOWLEDGE_BASE}`;

function callPolza(question) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const question = String(req.body?.question || '').trim();

  if (!question) {
    res.status(400).json({ error: 'empty_question' });
    return;
  }

  if (question.length > 1000) {
    res.status(400).json({ error: 'question_too_long' });
    return;
  }

  if (!process.env.POLZA_API_KEY) {
    res.status(500).json({ error: 'no_api_key' });
    return;
  }

  try {
    const data = await callPolza(question);
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
