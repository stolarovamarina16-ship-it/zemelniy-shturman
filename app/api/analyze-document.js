// Разбор пользовательского PDF/DOCX без сохранения файла на сервере.
// DOCX извлекается из XML внутри контейнера ZIP, PDF — из текстовых потоков.
// Скан-копии без текстового слоя честно возвращают ошибку: для них нужен OCR.

const https = require('https');
const { CORE_POLICY, FINAL_CHECK } = require('../data/agent-policy.js');

const MODEL = 'anthropic/claude-haiku-4.5';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS_PER_HOUR = 4;
const requestLog = new Map();

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDocx(buffer) {
  const zlib = require('zlib');
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    if ((flags & 0x08) || !compressedSize) break;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (name === 'word/document.xml') {
      const xml = method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
      return cleanText(xml.replace(/<w:p[^>]*>/g, '\n').replace(/<w:tab[^>]*\/>/g, ' '));
    }
    offset = dataStart + compressedSize;
  }
  return '';
}

function decodePdfString(value) {
  return value.replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

function textFromPdfStream(stream) {
  const parts = [];
  const literal = /\((?:\\.|[^\\)])*\)/g;
  let match;
  while ((match = literal.exec(stream))) parts.push(decodePdfString(match[0].slice(1, -1)));
  return parts.join(' ');
}

function extractPdf(buffer) {
  const zlib = require('zlib');
  const raw = buffer.toString('latin1');
  const collected = [];
  const pattern = /<<(?:.|\n|\r)*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = pattern.exec(raw))) {
    const dictionary = raw.slice(Math.max(0, match.index - 1200), match.index);
    let stream = Buffer.from(match[1], 'latin1');
    if (/\/FlateDecode/.test(dictionary)) {
      try { stream = zlib.inflateSync(stream); } catch (e) { continue; }
    }
    collected.push(textFromPdfStream(stream.toString('latin1')));
  }
  return cleanText(collected.join('\n'));
}

function extractText(buffer, mimeType, fileName) {
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(fileName)) return extractPdf(buffer);
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(fileName)) return extractDocx(buffer);
  return '';
}

function callPolza(system, prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      max_tokens: 1000
    });
    const req = https.request({
      hostname: 'polza.ai', path: '/api/v1/chat/completions', method: 'POST', timeout: 25000,
      headers: {
        Authorization: `Bearer ${process.env.POLZA_API_KEY}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`upstream_${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('invalid_json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function canAnalyze(ip) {
  const now = Date.now();
  const recent = (requestLog.get(ip) || []).filter(time => time > now - 3600000);
  if (recent.length >= MAX_REQUESTS_PER_HOUR) return false;
  recent.push(now); requestLog.set(ip, recent); return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const fileName = String(req.body?.fileName || '').slice(0, 180);
  const mimeType = String(req.body?.mimeType || '');
  const contentBase64 = String(req.body?.contentBase64 || '');
  const task = String(req.body?.task || 'other');
  const question = String(req.body?.question || '').slice(0, 800);
  if (!fileName || !contentBase64) return res.status(400).json({ error: 'missing_document' });
  if (!/\.(pdf|docx)$/i.test(fileName)) return res.status(400).json({ error: 'unsupported_type' });
  if (!canAnalyze(getClientIp(req))) return res.status(429).json({ error: 'rate_limit_exceeded' });
  if (!process.env.POLZA_API_KEY) return res.status(500).json({ error: 'no_api_key' });
  let file;
  try { file = Buffer.from(contentBase64, 'base64'); } catch (e) { return res.status(400).json({ error: 'invalid_file' }); }
  if (!file.length || file.length > MAX_BYTES) return res.status(413).json({ error: 'file_too_large' });
  let documentText = '';
  try { documentText = extractText(file, mimeType, fileName); } catch (e) { return res.status(422).json({ error: 'extract_failed' }); }
  if (documentText.length < 80) return res.status(422).json({ error: 'text_not_found' });
  const taskGuide = task === 'refusal'
    ? 'Это отказ администрации. Выдели, кто и когда отказал, точную причину, какие документы/факты упомянуты, что проверить до следующего действия. Не обещай, что отказ незаконен.'
    : task === 'pzz'
      ? 'Это ПЗЗ или градостроительный документ. Найди только явно указанные территориальные зоны, ВРИ, ограничения, минимальные/максимальные размеры и дальнейшую проверку. Не додумывай сведения о конкретном участке.'
      : 'Определи тип документа, важные факты, риски и один ближайший шаг.';
  const system = `${CORE_POLICY}

Ты разбираешь загруженный документ в справочном формате. ${taskGuide}
Не говори, что отказ незаконен, если это не следует прямо из текста и проверенной нормы. Не делай вывод о документе по сведениям, которых в нём нет.
Структура: «Что это за документ», «Главное из текста», «Следующий шаг», «Что проверить», «Чего в документе нет».
Перед финальной фразой добавь: «Документ разобран по извлечённому тексту; оригинал и приложения нужно проверить отдельно». Финальная фраза должна быть дословно: «${FINAL_CHECK}».`;
  try {
    const data = await callPolza(system, `Файл: ${fileName}\nВопрос пользователя: ${question || 'нет'}\n\nТекст документа:\n${documentText.slice(0, 24000)}`);
    const answer = data?.choices?.[0]?.message?.content;
    if (!answer) return res.status(502).json({ error: 'empty_answer' });
    return res.status(200).json({ answer, extractedCharacters: documentText.length });
  } catch (e) {
    return res.status(502).json({ error: 'upstream_unavailable' });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '7mb' } } };
