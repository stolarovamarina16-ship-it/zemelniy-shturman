// ===== ЗЕМЕЛЬНЫЙ ШТУРМАН — ГЛАВНЫЙ МОДУЛЬ =====

const chat      = document.getElementById('chat');
const inputArea = document.getElementById('input-area');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');

let currentQuestion = 0;
let currentQuestionIndex = 0; // отслеживаем номер текущего вопроса для кнопки «Назад»
const answers = {};
// Последние реплики дают агенту контекст, но не хранятся на сервере.
let conversationHistory = [];

// Дела и лоты хранятся только в браузере пользователя. Это позволяет вести
// несколько участков без регистрации и без передачи персональных данных на сервер.
const CASE_STORAGE_KEY = 'zemelniy-shturman-case-v1';
const CASES_STORAGE_KEY = 'zemelniy-shturman-cases-v1';
const ACTIVE_CASE_STORAGE_KEY = 'zemelniy-shturman-active-case-v1';
const AUCTIONS_STORAGE_KEY = 'zemelniy-shturman-auctions-v1';
let cases = loadCases();
let activeCaseId = loadActiveCaseId();
let activeCase = loadActiveCase();
let auctionLots = loadAuctionLots();
const REMINDERS_STORAGE_KEY = 'zemelniy-shturman-reminders-v1';
let reminders = loadReminders();

// Иконка агента — компас с ростком (инлайн SVG вместо emoji, чтобы не превращалась
// в пустой квадрат на устройствах без цветных emoji-шрифтов)
const AGENT_AVATAR_SVG = `<svg width="17" height="17" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <circle cx="32" cy="32" r="21" fill="none" stroke="#C7DCC3" stroke-width="2.4" opacity=".55"/>
  <path d="M32 13 L38 32 L32 51 L26 32 Z" fill="#E8A33D"/>
  <path d="M32 13 L38 32 L32 32 Z" fill="#F4C878"/>
  <circle cx="32" cy="32" r="3.6" fill="#0F1A12" stroke="#C7DCC3" stroke-width="1.2"/>
</svg>`;

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

function scrollBottom() {
  setTimeout(() => { chat.scrollTop = chat.scrollHeight; }, 50);
}

// Добавить сообщение агента
function agentMessage(html, delay = 0) {
  return new Promise(resolve => {
    // Сначала показываем "печатает..."
    const typingEl = document.createElement('div');
    typingEl.className = 'msg-agent';
    typingEl.innerHTML = `
      <div class="agent-avatar">${AGENT_AVATAR_SVG}</div>
      <div class="bubble-agent">
        <div class="typing"><span></span><span></span><span></span></div>
      </div>`;
    chat.appendChild(typingEl);
    scrollBottom();

    setTimeout(() => {
      typingEl.remove();
      const el = document.createElement('div');
      el.className = 'msg-agent';
      el.innerHTML = `
        <div class="agent-avatar">${AGENT_AVATAR_SVG}</div>
        <div class="bubble-agent">${html}</div>`;
      chat.appendChild(el);
      scrollBottom();
      resolve();
    }, 700 + delay);
  });
}

function agentTextMessage(text, delay = 0) {
  const safeHtml = linkifyExternalUrls(text);
  return agentMessage(safeHtml, delay);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function externalLink(url, label = url) {
  const safeUrl = safeExternalUrl(url);
  if (!safeUrl) return escapeHtml(label);
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

// Ответы ЗемляБота приходят простым текстом. Если в них есть ссылка, она должна
// вести сразу на сайт, а не заставлять человека копировать адрес вручную.
function linkifyExternalUrls(text) {
  const escaped = escapeHtml(text).replace(/\n/g, '<br>');
  return escaped.replace(/https:\/\/[^\s<]+/g, rawUrl => {
    const match = rawUrl.match(/^(.*?)([),.;:!?]+)?$/);
    const visibleUrl = match?.[1] || rawUrl;
    const trailing = match?.[2] || '';
    const url = visibleUrl.replace(/&amp;/g, '&');
    return externalLink(url, url) + trailing;
  });
}

// Добавить сообщение пользователя
function userMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg-user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble-user';
  bubble.textContent = text;
  el.appendChild(bubble);
  chat.appendChild(el);
  scrollBottom();
}

// Показать кнопки-варианты + кнопку «Назад» начиная со второго вопроса
function showOptions(options, onChoose, questionIndex = 0) {
  inputArea.innerHTML = '';

  // Кнопка «Назад» — появляется начиная со второго вопроса
  if (questionIndex > 0) {
    const backBtn = document.createElement('button');
    backBtn.className = 'back-btn';
    backBtn.textContent = 'Назад';
    backBtn.onclick = () => goBack(questionIndex);
    inputArea.appendChild(backBtn);
  }

  const grid = document.createElement('div');
  grid.className = 'options-grid';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = opt.label;
    btn.onclick = () => {
      grid.querySelectorAll('button').forEach(b => b.disabled = true);
      onChoose(opt);
    };
    grid.appendChild(btn);
  });
  inputArea.appendChild(grid);
}

// Длина общего префикса двух строк — нужна для нечёткого поиска (см. matchRegionOptions)
function commonPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// Служебные слова названий регионов — исключаем их из нечёткого сравнения,
// иначе "Красн..." ложно совпадает с любым "...край" по общему префиксу "кра"
const REGION_STOPWORDS = new Set([
  'область', 'край', 'края', 'республика', 'автономный', 'округ', 'ао',
  'г', 'город', 'мораторий', 'до', 'года'
]);

// Подобрать варианты по введённому тексту: города часто не совпадают буква-в-букву
// с названием региона из-за окончания прилагательного (Саратов → Саратовская,
// Тверь → Тверская, Пермь → Пермский) — поэтому помимо вхождения подстроки
// проверяем длину общего префикса с каждым значимым словом в названии региона
function matchRegionOptions(options, typed) {
  const t = typed.trim().toLowerCase();
  if (!t) return [];

  const prefixThreshold = Math.min(t.length, 3);

  const scored = options.map(opt => {
    const nameLower = opt.label.toLowerCase();
    if (nameLower.includes(t)) {
      return { opt, score: 1000 - nameLower.indexOf(t) };
    }
    const words = nameLower
      .replace(/[^а-яё\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter(w => w && !REGION_STOPWORDS.has(w));
    let best = 0;
    words.forEach(w => {
      const cp = commonPrefixLen(t, w);
      if (cp > best) best = cp;
    });
    return best >= prefixThreshold ? { opt, score: best } : null;
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map(s => s.opt);
}

// Показать поле поиска с живой подсказкой — для вопросов с длинным списком (83 региона),
// где кнопки-варианты неюзабельны. Подсказки фильтруются по мере ввода и учитывают
// частичные/городские названия, а не только точное совпадение с полным названием региона.
function showSearchSelect(q, onChoose, questionIndex = 0) {
  inputArea.innerHTML = '';

  if (questionIndex > 0) {
    const backBtn = document.createElement('button');
    backBtn.className = 'back-btn';
    backBtn.textContent = 'Назад';
    backBtn.onclick = () => goBack(questionIndex);
    inputArea.appendChild(backBtn);
  }

  const wrap = document.createElement('div');
  wrap.className = 'search-select-wrap';

  const row = document.createElement('div');
  row.className = 'text-row';

  const inp = document.createElement('input');
  inp.className = 'text-input';
  inp.placeholder = 'Начните вводить город или регион...';
  inp.type = 'text';
  inp.autocomplete = 'off';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'send-btn';
  sendBtn.textContent = 'Выбрать';

  const suggestList = document.createElement('div');
  suggestList.className = 'autocomplete-list';
  suggestList.style.display = 'none';

  const selectMatch = (match) => {
    suggestList.style.display = 'none';
    onChoose(match);
  };

  const renderSuggestions = () => {
    const matches = matchRegionOptions(q.options, inp.value);
    suggestList.innerHTML = '';

    if (!matches.length) {
      suggestList.style.display = 'none';
      return;
    }

    matches.forEach(opt => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.textContent = opt.label;
      // mousedown вместо click — срабатывает раньше blur на инпуте, клик не теряется
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inp.value = opt.label;
        selectMatch(opt);
      });
      suggestList.appendChild(item);
    });

    suggestList.style.display = 'block';
  };

  inp.addEventListener('input', () => {
    inp.classList.remove('input-error');
    renderSuggestions();
  });
  inp.addEventListener('focus', renderSuggestions);
  inp.addEventListener('blur', () => {
    setTimeout(() => { suggestList.style.display = 'none'; }, 150);
  });

  const handleSend = () => {
    const typed = inp.value.trim();
    const exact = q.options.find(o => o.label.toLowerCase() === typed.toLowerCase());
    if (exact) {
      selectMatch(exact);
      return;
    }
    // Если после нечёткого поиска остался единственный вариант — считаем его выбором
    const fuzzy = matchRegionOptions(q.options, typed);
    if (fuzzy.length === 1) {
      inp.value = fuzzy[0].label;
      selectMatch(fuzzy[0]);
      return;
    }
    inp.classList.add('input-error');
    renderSuggestions();
  };

  sendBtn.onclick = handleSend;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') handleSend(); });

  row.appendChild(inp);
  row.appendChild(sendBtn);
  wrap.appendChild(row);
  wrap.appendChild(suggestList);
  inputArea.appendChild(wrap);

  if (q.skipOption) {
    const skipBtn = document.createElement('button');
    skipBtn.className = 'option-btn';
    skipBtn.style.marginTop = '10px';
    skipBtn.textContent = q.skipOption.label;
    skipBtn.onclick = () => onChoose(q.skipOption);
    inputArea.appendChild(skipBtn);
  }
}

// Вернуться к предыдущему вопросу
function goBack(fromIndex) {
  // Удаляем ответ на текущий вопрос если он уже был дан
  const currentQ = QUESTIONS[fromIndex];
  if (currentQ) delete answers[currentQ.id];

  clearInput();

  // Маленькая плашка «вернулись назад» в чате
  const el = document.createElement('div');
  el.className = 'msg-back';
  el.textContent = 'Вернулись к предыдущему вопросу';
  chat.appendChild(el);
  scrollBottom();

  let target = fromIndex - 1;
  while (target >= 0 && isSkipped(QUESTIONS[target])) target--;

  setTimeout(() => askQuestion(Math.max(target, 0)), 200);
}

// Обновить прогресс-бар
function updateProgress(step, total) {
  progressWrap.style.display = 'block';
  progressLabel.textContent = `Вопрос ${step} из ${total}`;
  progressFill.style.width = `${(step / total) * 100}%`;
}

// Очистить зону ввода
function clearInput() {
  inputArea.innerHTML = '';
}

function downloadText(filename, content) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
}

// Черновик можно открыть в Word и отредактировать перед подачей. Это не
// электронная подпись и не официальный заполненный бланк администрации.
function downloadWordDraft(filename, title, content) {
  const escaped = String(content)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:Times New Roman,serif;font-size:12pt;line-height:1.45;max-width:180mm;margin:20mm auto"><h2 style="font-size:14pt;text-align:center">${title}</h2><p>${escaped}</p><hr><p style="font-size:9pt;color:#555">Черновик сформирован «Земельным Штурманом». Перед подачей сверить с бланком и регламентом администрации.</p></body></html>`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' }));
  link.download = filename;
  document.body.appendChild(link); link.click();
  URL.revokeObjectURL(link.href); link.remove();
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.href : '';
  } catch (e) { return ''; }
}

const OFFICIAL_SERVICES = [
  { test: /НСПД|nspd\.gov\.ru/i, label: 'Открыть НСПД', url: 'https://nspd.gov.ru' },
  { test: /ПЗЗ|Генплан|ЗОУИТ|ФГИС ТП/i, label: 'Открыть ФГИС ТП', url: 'https://fgistp.economy.gov.ru' },
  { test: /ГИС Торги|\bторг(?:и|ов|ах|ами)?\b|torgi\.gov\.ru/i, label: 'Открыть ГИС Торги', url: 'https://torgi.gov.ru' },
  { test: /Росреестр|ЕГРН/i, label: 'Открыть Росреестр', url: 'https://rosreestr.gov.ru' },
  { test: /Госуслуг/i, label: 'Открыть Госуслуги', url: 'https://www.gosuslugi.ru' },
  { test: /Дальневосточн|Арктическ.*гектар|надальнийвосток\.рф|стопарктика\.рф/i, label: 'Открыть программу «Гектар»', url: 'https://надальнийвосток.рф' },
  { test: /Федресурс|ЕФРСБ|банкротств/i, label: 'Открыть ЕФРСБ / Федресурс', url: 'https://bankrot.fedresurs.ru' },
  { test: /Сбербанк-АСТ/i, label: 'Открыть Сбербанк-АСТ', url: 'https://www.sberbank-ast.ru' }
];

function officialLinksFor(text, className = 'service-link-row') {
  const links = OFFICIAL_SERVICES
    .filter(service => service.test.test(String(text || '')))
    .map(service => externalLink(service.url, service.label));
  return links.length ? `<div class="${className}" aria-label="Официальные сервисы">${links.join('')}</div>` : '';
}

// ===== НАПОМИНАНИЯ =====

function loadReminders() {
  try {
    const saved = JSON.parse(localStorage.getItem(REMINDERS_STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter(item => item && item.text && item.at) : [];
  } catch (e) { return []; }
}

function saveReminders() {
  try { localStorage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(reminders)); } catch (e) { /* хранилище может быть отключено */ }
}

function notifyDueReminders(showInChat = false) {
  const now = Date.now();
  const due = reminders.filter(item => !item.done && !item.notified && new Date(item.at).getTime() <= now);
  if (!due.length) return;
  due.forEach(item => { item.notified = true; });
  saveReminders();
  if (showInChat) agentTextMessage(`Напоминание: ${due.map(item => item.text).join('; ')}`);
  if ('Notification' in window && Notification.permission === 'granted') {
    due.forEach(item => new Notification('Земельный Штурман', { body: item.text }));
  }
}

function openReminderManager() {
  inputArea.innerHTML = '';
  const form = document.createElement('form');
  form.className = 'tool-form';
  form.innerHTML = '<div class="tool-form-kicker">СРОКИ</div><h3>Поставить напоминание</h3><p>Напоминание сохранится на этом устройстве. Когда сайт открыт, Штурман покажет его; можно включить уведомления браузера.</p>';
  const text = document.createElement('input'); text.className = 'text-input'; text.placeholder = 'Например: проверить ответ администрации'; text.maxLength = 160;
  const at = document.createElement('input'); at.className = 'tool-date-input'; at.type = 'datetime-local';
  const notifications = document.createElement('label'); notifications.className = 'tool-check';
  const consent = document.createElement('input'); consent.type = 'checkbox';
  notifications.append(consent, document.createTextNode('Разрешить уведомления браузера на этом устройстве'));
  const actions = document.createElement('div'); actions.className = 'tool-actions';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'send-btn'; save.textContent = 'Сохранить';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'case-cancel-btn'; cancel.textContent = 'Отмена';
  actions.append(save, cancel); form.append(text, at, notifications, actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!text.value.trim() || !at.value) return;
    reminders.push({ id: `${Date.now()}`, text: text.value.trim(), at: new Date(at.value).toISOString(), done: false, notified: false });
    saveReminders();
    if (consent.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    clearInput(); agentTextMessage('Напоминание сохранено на этом устройстве.').then(showAgentComposer);
  });
  cancel.addEventListener('click', showAgentComposer);
  inputArea.appendChild(form); text.focus();
}

// ===== РАЗБОР ДОКУМЕНТОВ =====

function openDocumentAnalyzer() {
  inputArea.innerHTML = '';
  const form = document.createElement('form');
  form.className = 'tool-form';
  form.innerHTML = '<div class="tool-form-kicker">ДОКУМЕНТЫ</div><h3>Разобрать PDF или DOCX</h3><p>Файл не сохраняется в Штурмане: из него извлекается текст для одного анализа. Не загружайте паспорт, банковские данные и другие лишние персональные данные.</p>';
  const file = document.createElement('input'); file.type = 'file'; file.accept = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document'; file.className = 'tool-file-input';
  const task = document.createElement('select'); task.className = 'tool-select';
  [['refusal', 'Отказ администрации'], ['pzz', 'ПЗЗ или градостроительный документ'], ['municipal', 'Регламент, бланк или требования администрации'], ['other', 'Другой земельный документ']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; task.appendChild(option); });
  const question = document.createElement('textarea'); question.className = 'text-input tool-textarea'; question.placeholder = 'Что именно проверить? Можно оставить пустым.'; question.rows = 2;
  const consentLabel = document.createElement('label'); consentLabel.className = 'tool-check';
  const consent = document.createElement('input'); consent.type = 'checkbox'; consentLabel.append(consent, document.createTextNode('Я понимаю, что текст файла будет отправлен AI-провайдеру для анализа'));
  const actions = document.createElement('div'); actions.className = 'tool-actions';
  const analyze = document.createElement('button'); analyze.type = 'submit'; analyze.className = 'send-btn'; analyze.textContent = 'Разобрать';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'case-cancel-btn'; cancel.textContent = 'Отмена';
  actions.append(analyze, cancel); form.append(file, task, question, consentLabel, actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const selected = file.files?.[0];
    if (!selected || !consent.checked) return;
    if (selected.size > 4 * 1024 * 1024) { agentTextMessage('Для первого разбора подходит файл до 4 МБ. Если документ больше, загрузите нужные страницы отдельным PDF.').then(showAgentComposer); return; }
    analyze.disabled = true; analyze.textContent = 'Читаю…';
    const reader = new FileReader();
    reader.onload = () => {
      const contentBase64 = String(reader.result || '').split(',')[1] || '';
      fetch('/api/analyze-document', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: selected.name, mimeType: selected.type, contentBase64, task: task.value, question: question.value.trim() }) })
        .then(response => response.json().then(data => ({ ok: response.ok, data })))
        .then(({ ok, data }) => {
          clearInput();
          if (ok) return agentTextMessage(data.answer);
          const errors = { text_not_found: 'В файле не нашёлся текстовый слой. Это может быть скан: нужен PDF с распознанным текстом или текстовая версия.', file_too_large: 'Файл больше допустимого размера.', rate_limit_exceeded: 'Лимит разборов на этот час исчерпан. Попробуйте позже.' };
          return agentTextMessage(errors[data.error] || 'Не удалось разобрать этот файл. Попробуйте другой PDF/DOCX или вставьте текст в чат.');
        })
        .catch(() => agentTextMessage('Не получилось отправить документ на разбор. Проверьте интернет и попробуйте ещё раз.'))
        .finally(showAgentComposer);
    };
    reader.readAsDataURL(selected);
  });
  cancel.addEventListener('click', showAgentComposer);
  inputArea.appendChild(form);
}

// ===== ГЕНЕРАТОР ЗАЯВЛЕНИЙ =====

function openApplicationGenerator() {
  inputArea.innerHTML = '';
  const form = document.createElement('form');
  form.className = 'tool-form';
  form.innerHTML = '<div class="tool-form-kicker">ЗАЯВЛЕНИЯ</div><h3>Подготовить черновик заявления</h3><p>Заполните только данные для заявления — паспорт, СНИЛС и банковские данные не нужны. Это редактируемый черновик: перед подачей его нужно сверить с регламентом и бланком администрации.</p>';
  const type = document.createElement('select'); type.className = 'tool-select';
  [['formed', 'Сформированный участок'], ['unformed', 'Несформированный участок'], ['srzu', 'Утверждение СРЗУ']].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; type.appendChild(option); });
  const fields = {};
  const savedProfile = (() => { try { return JSON.parse(localStorage.getItem('zemelniy-shturman-profile-v1') || '{}'); } catch (e) { return {}; } })();
  [['authority', 'Кому: администрация', 'Например: Комитет по имуществу администрации …'], ['name', 'ФИО заявителя', 'Полностью'], ['address', 'Адрес заявителя', 'Город, улица, дом'], ['email', 'Email', 'Для ответа'], ['phone', 'Телефон', ''], ['place', 'Местоположение участка', 'Адрес или описание'], ['area', 'Площадь, кв. м', ''], ['cadastre', 'Кадастровый номер', 'Если есть'], ['purpose', 'Цель / ВРИ', 'Например: индивидуальное жилищное строительство'], ['basis', 'Основание', 'Укажите только после проверки регламента']].forEach(([key, label, placeholder]) => {
    const wrap = document.createElement('label'); wrap.className = 'case-field'; wrap.textContent = label;
    const input = document.createElement('input'); input.className = 'tool-input'; input.placeholder = placeholder; input.maxLength = 240;
    input.value = savedProfile[key] || (key === 'place' ? (activeCase.goal || '') : (key === 'purpose' ? (activeCase.goal || '') : ''));
    wrap.appendChild(input); form.appendChild(wrap); fields[key] = input;
  });
  form.insertBefore(type, form.children[3]);
  const actions = document.createElement('div'); actions.className = 'tool-actions';
  const make = document.createElement('button'); make.type = 'submit'; make.className = 'send-btn'; make.textContent = 'Создать черновик';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'case-cancel-btn'; cancel.textContent = 'Отмена';
  actions.append(make, cancel); form.appendChild(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value.trim()]));
    if (!data.authority || !data.name || !data.address || !data.place || !data.purpose) return;
    try { localStorage.setItem('zemelniy-shturman-profile-v1', JSON.stringify({ name: data.name, address: data.address, email: data.email, phone: data.phone })); } catch (e) { /* локальное сохранение может быть отключено */ }
    const today = new Date().toLocaleDateString('ru-RU');
    const subject = type.value === 'formed'
      ? 'Заявление о предоставлении сформированного земельного участка'
      : type.value === 'unformed'
        ? 'Заявление о предварительном согласовании предоставления земельного участка'
        : 'Заявление об утверждении схемы расположения земельного участка на кадастровом плане территории';
    const request = type.value === 'formed'
      ? `Прошу предоставить земельный участок, находящийся в муниципальной собственности либо государственная собственность на который не разграничена, расположенный: ${data.place}, площадью ${data.area || '___'} кв. м${data.cadastre ? `, с кадастровым номером ${data.cadastre}` : ''}, для цели: ${data.purpose}. Основание: ${data.basis || 'уточнить перед подачей'}.`
      : type.value === 'unformed'
        ? `Прошу предварительно согласовать предоставление земельного участка, расположенного: ${data.place}, ориентировочной площадью ${data.area || '___'} кв. м, для цели: ${data.purpose}. Основание: ${data.basis || 'уточнить перед подачей'}. Также даю согласие на утверждение иного варианта схемы расположения земельного участка.`
        : `Прошу утвердить схему расположения земельного участка на кадастровом плане территории: местоположение — ${data.place}; ориентировочная площадь — ${data.area || '___'} кв. м; цель — ${data.purpose}. Основание: ${data.basis || 'уточнить перед подачей'}.`;
    const result = `${data.authority}\n\nот ${data.name}\nадрес: ${data.address}\nemail: ${data.email || '___'}\nтелефон: ${data.phone || '___'}\n\n${subject}\n\n${request}\n\nПриложения: копия документа, удостоверяющего личность; ${type.value === 'unformed' || type.value === 'srzu' ? 'схема расположения участка на КПТ; ' : ''}${data.cadastre ? 'выписка/сведения об участке (при наличии).' : 'иные документы по требованию администрации.'}\n\nРезультат прошу направить по электронной почте: ${data.email || '___'}.\n\nДата: ${today}\nПодпись: __________________ / ${data.name}`;
    clearInput();
    agentTextMessage('Черновик готов. Проверьте все поля перед подачей: особенно адресата, основание и приложения.').then(() => {
      const box = document.createElement('section'); box.className = 'draft-result';
      const textarea = document.createElement('textarea'); textarea.value = result; textarea.rows = 15;
      const row = document.createElement('div'); row.className = 'tool-actions';
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'case-edit-btn'; copy.textContent = 'Скопировать'; copy.onclick = () => navigator.clipboard?.writeText(textarea.value);
      const download = document.createElement('button'); download.type = 'button'; download.className = 'case-edit-btn'; download.textContent = 'Скачать .doc'; download.onclick = () => downloadWordDraft('chernovik-zayavleniya-zemelniy-shturman.doc', subject, textarea.value);
      const downloadTextButton = document.createElement('button'); downloadTextButton.type = 'button'; downloadTextButton.className = 'case-edit-btn'; downloadTextButton.textContent = 'Скачать .txt'; downloadTextButton.onclick = () => downloadText('zayavlenie-zemelniy-shturman.txt', textarea.value);
      row.append(copy, download, downloadTextButton); box.append(textarea, row); chat.appendChild(box); scrollBottom(); showAgentComposer();
    });
  });
  cancel.addEventListener('click', showAgentComposer);
  inputArea.appendChild(form);
}

// ===== ПРОВЕРКА УЧАСТКА И ТОРГОВ =====

function openLiveCheckDesk() {
  inputArea.innerHTML = '';
  const form = document.createElement('form'); form.className = 'tool-form';
  form.innerHTML = '<div class="tool-form-kicker">ПРОВЕРКА</div><h3>Проверить участок по официальным источникам</h3><p>Штурман проверит кадастровую стоимость, если реестр ответит, и даст прямой маршрут по НСПД, ГИС Торги и Росреестру. Автоматический поиск свободных участков ещё требует отдельного разрешённого источника данных.</p>';
  const number = document.createElement('input'); number.className = 'text-input'; number.placeholder = 'Кадастровый номер: 50:11:0010101:100';
  const actions = document.createElement('div'); actions.className = 'tool-actions';
  const check = document.createElement('button'); check.type = 'submit'; check.className = 'send-btn'; check.textContent = 'Проверить';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'case-cancel-btn'; cancel.textContent = 'Отмена'; actions.append(check, cancel); form.append(number, actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const value = number.value.trim();
    if (!/^\d{2}:\d{2}:\d{6,7}:\d+$/.test(value)) return;
    check.disabled = true;
    fetch(`/api/cadastre?number=${encodeURIComponent(value)}`).then(r => r.json().then(data => ({ ok:r.ok, data }))).then(({ ok, data }) => {
      clearInput();
      const cost = ok && data.cadCost ? `Кадастровая стоимость: ${formatMoney(data.cadCost)}.` : 'Кадастровую стоимость автоматически получить не удалось — её можно посмотреть на НСПД или в выписке.';
      return agentTextMessage(`${cost}\n\nДальше откройте НСПД: https://nspd.gov.ru — проверьте границы, ВРИ и ЗОУИТ; затем ГИС Торги: https://torgi.gov.ru — публикации и протоколы; перед решением закажите актуальную выписку ЕГРН на Росреестре: https://rosreestr.gov.ru. Кадастровый номер: ${value}.`);
    }).catch(() => agentTextMessage('Не получилось обратиться к реестру. Откройте НСПД вручную: https://nspd.gov.ru — и вставьте кадастровый номер.')).finally(showAgentComposer);
  });
  cancel.addEventListener('click', showAgentComposer); inputArea.appendChild(form);
}

// Не угадываем адрес администрации: у одного района может быть несколько
// ведомств. Пользователь указывает муниципалитет, а Штурман даёт точную
// последовательность поиска официального регламента и проверки бланка.
function openMunicipalityDesk() {
  inputArea.innerHTML = '';
  const form = document.createElement('form');
  form.className = 'tool-form municipality-form';
  form.innerHTML = '<div class="tool-form-kicker">ПОДАЧА В АДМИНИСТРАЦИЮ</div><h3>Собрать требования до подачи</h3><p>Я не буду угадывать адрес органа: неверный адресат — частая причина задержки. Укажите муниципалитет или вставьте найденную официальную ссылку — я дам понятный чек-лист именно для этого шага.</p>';
  const municipality = document.createElement('input'); municipality.className = 'tool-input'; municipality.placeholder = 'Муниципальный район / городской округ / поселение'; municipality.maxLength = 180;
  const officialUrl = document.createElement('input'); officialUrl.className = 'tool-input'; officialUrl.type = 'url'; officialUrl.placeholder = 'Официальный сайт администрации (если уже нашли)'; officialUrl.maxLength = 500;
  const check = document.createElement('label'); check.className = 'tool-check';
  const checked = document.createElement('input'); checked.type = 'checkbox';
  check.append(checked, document.createTextNode('Я нашёл(ла) раздел «Муниципальные услуги» / «Земля и имущество» или «Документы»'));
  const actions = document.createElement('div'); actions.className = 'tool-actions';
  const continueButton = document.createElement('button'); continueButton.type = 'submit'; continueButton.className = 'send-btn'; continueButton.textContent = 'Показать план подачи';
  const templateButton = document.createElement('button'); templateButton.type = 'button'; templateButton.className = 'case-edit-btn'; templateButton.textContent = 'Загрузить регламент или бланк';
  const draftButton = document.createElement('button'); draftButton.type = 'button'; draftButton.className = 'case-edit-btn'; draftButton.textContent = 'Заполнить черновик';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'case-cancel-btn'; cancel.textContent = 'Отмена';
  actions.append(continueButton, templateButton, draftButton, cancel); form.append(municipality, officialUrl, check, actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const place = municipality.value.trim();
    const siteUrl = safeExternalUrl(officialUrl.value);
    if (!place && !siteUrl) { municipality.focus(); return; }
    const source = siteUrl ? `Ссылка, которую вы указали: <a href="${siteUrl}" target="_blank" rel="noopener noreferrer">открыть сайт администрации</a>.` : 'Сначала найдите официальный сайт по запросу «администрация ' + place.replace(/</g, '&lt;') + ' официальный сайт» и проверьте, что в шапке сайта указан орган местного самоуправления.';
    clearInput();
    agentMessage(`<strong>План подачи для: ${place ? place.replace(/</g, '&lt;') : 'указанного органа'}.</strong><br>${source}`).then(() => {
      const card = document.createElement('section'); card.className = 'municipality-plan';
      card.innerHTML = `<h3>Что найти на сайте администрации</h3><ol><li><strong>Административный регламент</strong> услуги: «предварительное согласование», «утверждение схемы» или «предоставление участка».</li><li><strong>Бланк заявления</strong> и перечень приложений. Если бланка нет, используйте черновик Штурмана только как основу.</li><li><strong>Ответственный орган</strong>: комитет/отдел имущества и земельных отношений, способ подачи, срок и электронная почта.</li><li><strong>Требования к схеме</strong>: формат PDF/XML, подписи, число экземпляров и допустимая площадь.</li></ol><div class="municipality-risk"><strong>До подачи:</strong> адресат совпадает с регламентом; цель и ВРИ не противоречат ПЗЗ; контур не пересекает участки/ЗОУИТ; приложены только документы из перечня.</div><div class="service-link-row"><a href="https://www.gosuslugi.ru/600241/1/form" target="_blank" rel="noopener noreferrer">Проверить услугу на Госуслугах</a><a href="https://nspd.gov.ru" target="_blank" rel="noopener noreferrer">Открыть НСПД</a></div><p class="municipality-note">Госуслуги могут предлагать подачу не во всех регионах и не для каждого случая. Регламент конкретной администрации имеет приоритет по формату и приложениям.</p>`;
      chat.appendChild(card); scrollBottom(); showAgentComposer();
    });
  });
  templateButton.addEventListener('click', () => { openDocumentAnalyzer(); setTimeout(() => { const select = inputArea.querySelector('select'); if (select) select.value = 'municipal'; }, 0); });
  draftButton.addEventListener('click', openApplicationGenerator);
  cancel.addEventListener('click', showAgentComposer);
  inputArea.appendChild(form);
}

// ===== ПОМОЩНИК ПО СХЕМЕ УЧАСТКА И ВНЕШНИМ СЕРВИСАМ =====

function openSchemeGuide() {
  clearInput();
  agentMessage('<strong>Сначала подготовим место на карте, затем нарисуем черновик схемы.</strong><br>Я покажу, что включить в НСПД. Галочки вы нажимаете сами в официальном сервисе — так мы не подменяем проверку государства.')
    .then(() => {
      const el = document.createElement('section');
      el.className = 'service-guide';
      el.innerHTML = `
        <div class="service-guide-kicker">СХЕМА УЧАСТКА</div>
        <h3>НСПД: обязательная проверка перед рисованием</h3>
        <p class="service-guide-lead">Откройте сервис «Земля просто» → «Воспользоваться сервисом» → авторизуйтесь → «Нарисовать территорию».</p>
        <div class="service-link-row">
          <a href="https://nspd.gov.ru" target="_blank" rel="noopener noreferrer">Открыть НСПД</a>
          <a href="https://fgistp.economy.gov.ru" target="_blank" rel="noopener noreferrer">Найти ПЗЗ в ФГИС ТП</a>
        </div>
        <div class="service-guide-section">
          <h4>Включите эти слои</h4>
          <p>Названия в НСПД могут немного меняться — ориентируйтесь на смысл.</p>
          <label class="layer-check"><input type="checkbox"><span><strong>Кадастровые кварталы</strong><small>Чтобы видеть квартал, в котором создаётся контур.</small></span></label>
          <label class="layer-check"><input type="checkbox"><span><strong>Участки ЕГРН и образуемые по схеме</strong><small>Чтобы не наложить контур на известный участок или уже созданную схему.</small></span></label>
          <label class="layer-check"><input type="checkbox"><span><strong>Границы населённых пунктов</strong><small>Чтобы не выйти за территорию, которую проверяете.</small></span></label>
          <label class="layer-check"><input type="checkbox"><span><strong>Здания и объекты незавершённого строительства</strong><small>Чтобы не выбрать место с видимым объектом.</small></span></label>
          <label class="layer-check"><input type="checkbox"><span><strong>Территориальные зоны и красные линии</strong><small>Проверка ПЗЗ и территории общего пользования.</small></span></label>
          <label class="layer-check"><input type="checkbox"><span><strong>ЗОУИТ, природные территории и лесничества</strong><small>Их отсутствие на карте не отменяет отдельную проверку.</small></span></label>
        </div>
        <div class="service-guide-section">
          <h4>Когда рисуете контур</h4>
          <ol class="service-guide-steps">
            <li>Включите магнитную привязку к участкам ЕГРН или территориальным зонам.</li>
            <li>Поставьте точки по границе; для соседнего участка привязывайтесь к его поворотным точкам.</li>
            <li>Нажмите «Проверить» и исправьте пересечения.</li>
            <li>Проверьте площадь по местным ПЗЗ, сохраните PDF и XML.</li>
          </ol>
        </div>
        <div class="service-guide-section service-guide-other">
          <h4>Другие полезные сервисы</h4>
          <p><strong>АРГО 7</strong> — более профессиональный вариант для точной ручной схемы; нужен, если НСПД не подходит или требуется работать с координатами.</p>
          <p><strong>ФГИС ТП и региональный геопортал</strong> — искать действующие ПЗЗ, генплан и проект межевания.</p>
          <p><strong>Яндекс Карты / спутниковые снимки</strong> — осмотреть дорогу, рельеф и фактические постройки; это не подтверждает правовой статус участка.</p>
          <p><strong>Госуслуги</strong> — подать заявление, только когда маршрут и комплект документов проверены.</p>
        </div>
        <p class="service-guide-warning">Проверка в НСПД не означает, что участок точно предоставят. Перед подачей нужно проверить регламент администрации и актуальный статус территории.</p>`;
      chat.appendChild(el);
      scrollBottom();

      const panel = document.createElement('div');
      panel.className = 'service-guide-actions';
      const next = document.createElement('button');
      next.className = 'route-primary-btn';
      next.textContent = 'Я нарисовал(а) контур — что проверить дальше';
      next.addEventListener('click', () => sendAgentQuestion('Я нарисовал(а) контур участка в НСПД. Помоги составить список проверок перед сохранением схемы и подачей заявления.', 'Проверить нарисованный контур'));
      const back = document.createElement('button');
      back.className = 'route-secondary-btn';
      back.textContent = 'Вернуться к делу';
      back.addEventListener('click', continueSavedCase);
      panel.append(next, back);
      inputArea.appendChild(panel);
    });
}

// ===== КАРТОЧКА ЗЕМЕЛЬНОГО ДЕЛА =====

function emptyCase() {
  return {
    id: '', caseName: '',
    goal: '', region: '', currentStep: '', nextDate: '', updatedAt: '',
    strategyId: '', routeStep: 0, routeStartedAt: '',
    cadastreNumber: '', plotLocation: '', municipality: '', authorityUrl: '',
    regulationUrl: '', pzzUrl: '', schemeStatus: '', submissionChecks: {},
    regionCode: '', searchCenter: '', searchRadius: '', plotSize: '',
    goalPreset: '', vri: '', strategyPreference: '',
    priorities: [], priorityOne: '', priorityTwo: '', travelTime: '', travelTimePriority: false,
    allSeasonRoad: false, futurePlan: '', authorityName: ''
  };
}

function createLocalId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isMeaningfulCase(item) {
  return Boolean(item && (item.goal || item.region || item.currentStep || item.nextDate || item.strategyId || item.cadastreNumber || item.plotLocation || item.municipality || item.searchCenter));
}

function loadLegacyCase() {
  try {
    const saved = JSON.parse(localStorage.getItem(CASE_STORAGE_KEY) || 'null');
    return saved && typeof saved === 'object' ? { ...emptyCase(), ...saved } : emptyCase();
  } catch (e) {
    return emptyCase();
  }
}

function loadCases() {
  try {
    const saved = JSON.parse(localStorage.getItem(CASES_STORAGE_KEY) || '[]');
    if (Array.isArray(saved) && saved.length) {
      return saved.filter(item => item && typeof item === 'object').map(item => ({ ...emptyCase(), ...item, id: item.id || createLocalId('case') }));
    }
  } catch (e) { /* браузер может вернуть повреждённые данные */ }

  const legacy = loadLegacyCase();
  return isMeaningfulCase(legacy) ? [{ ...legacy, id: createLocalId('case') }] : [];
}

function loadActiveCaseId() {
  try {
    const savedId = localStorage.getItem(ACTIVE_CASE_STORAGE_KEY);
    return cases.some(item => item.id === savedId) ? savedId : (cases[0]?.id || '');
  } catch (e) {
    return cases[0]?.id || '';
  }
}

function loadActiveCase() {
  const found = cases.find(item => item.id === activeCaseId);
  return found ? { ...emptyCase(), ...found } : emptyCase();
}

function persistCases() {
  try {
    localStorage.setItem(CASES_STORAGE_KEY, JSON.stringify(cases));
    localStorage.setItem(ACTIVE_CASE_STORAGE_KEY, activeCaseId);
    // Дублируем активное дело в прежнем ключе, чтобы обновление не ломало
    // уже сохранённый маршрут у пользователя со старой версией приложения.
    localStorage.setItem(CASE_STORAGE_KEY, JSON.stringify(activeCase));
  } catch (e) { /* браузер может запретить хранилище */ }
}

function saveCase(nextCase) {
  const id = nextCase.id || activeCase.id || activeCaseId || createLocalId('case');
  activeCase = { ...emptyCase(), ...nextCase, id, updatedAt: new Date().toISOString() };
  activeCaseId = id;
  cases = [...cases.filter(item => item.id !== id), activeCase];
  persistCases();
}

function switchActiveCase(id) {
  const found = cases.find(item => item.id === id);
  if (!found) return false;
  activeCaseId = id;
  activeCase = { ...emptyCase(), ...found };
  persistCases();
  return true;
}

function removeActiveCase() {
  if (!activeCaseId) return;
  cases = cases.filter(item => item.id !== activeCaseId);
  activeCaseId = cases[0]?.id || '';
  activeCase = loadActiveCase();
  persistCases();
}

function caseTitle(item) {
  return item.caseName || item.goal || item.cadastreNumber || item.plotLocation || 'Новое земельное дело';
}

function caseStatus(item) {
  if (item.schemeStatus === 'Подано в администрацию' || item.currentStep?.includes('ответ')) return 'Жду ответ администрации';
  if (item.currentStep?.includes('торг')) return 'В торгах';
  if (item.cadastreNumber || item.plotLocation) return 'Проверяю участок';
  return item.goal ? 'Ищу подходящее место' : 'Черновик';
}

function hasCase() {
  return Boolean(activeCase.goal || activeCase.region || activeCase.currentStep || activeCase.nextDate || activeCase.strategyId || activeCase.cadastreNumber || activeCase.plotLocation || activeCase.municipality || activeCase.searchCenter);
}

function casePriorities(item = activeCase) {
  const saved = Array.isArray(item.priorities) ? item.priorities.filter(Boolean) : [];
  if (saved.length) return saved;
  const legacy = [item.priorityOne, item.priorityTwo].filter(Boolean);
  if (item.allSeasonRoad && !legacy.includes('Круглогодичный подъезд')) legacy.push('Круглогодичный подъезд');
  if (item.travelTimePriority && item.travelTime && !legacy.some(value => value.startsWith('Время в дороге'))) {
    legacy.push(`Время в дороге: до ${item.travelTime} минут`);
  }
  return legacy;
}

function caseContext() {
  if (!hasCase()) return '';
  return [
    activeCase.goal && `Цель: ${activeCase.goal}`,
    activeCase.region && `Регион: ${activeCase.region}`,
    activeCase.searchCenter && `Центр поиска: ${activeCase.searchCenter}`,
    activeCase.searchRadius && `Радиус поиска: до ${activeCase.searchRadius} км`,
    activeCase.plotSize && `Площадь: ${activeCase.plotSize}`,
    casePriorities().length && `Приоритеты: ${casePriorities().join('; ')}`,
    activeCase.vri && `Планируемый ВРИ: ${activeCase.vri}`,
    activeCase.travelTime && `Дорога: до ${activeCase.travelTime} минут`,
    activeCase.allSeasonRoad && 'Нужен круглогодичный подъезд',
    activeCase.futurePlan && `Перспектива: ${activeCase.futurePlan}`,
    activeCase.municipality && `Муниципалитет: ${activeCase.municipality}`,
    activeCase.authorityName && `Орган: ${activeCase.authorityName}`,
    activeCase.cadastreNumber && `Кадастровый номер: ${activeCase.cadastreNumber}`,
    activeCase.plotLocation && `Местоположение участка: ${activeCase.plotLocation}`,
    activeCase.schemeStatus && `Статус схемы: ${activeCase.schemeStatus}`,
    activeCase.strategyId && STRATEGIES[activeCase.strategyId] && `Маршрут: ${STRATEGIES[activeCase.strategyId].title}`,
    activeCase.currentStep && `Текущий шаг: ${activeCase.currentStep}`,
    activeCase.nextDate && `Ближайшая дата пользователя: ${activeCase.nextDate}`
  ].filter(Boolean).join('\n');
}

function readableDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderCaseCard() {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'msg-agent';
    el.innerHTML = `<div class="agent-avatar">${AGENT_AVATAR_SVG}</div><div class="bubble-agent case-bubble"></div>`;
    const card = document.createElement('section');
    card.className = 'case-card';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'case-kicker';
    eyebrow.textContent = cases.length > 1 ? `МОЁ ДЕЛО · ${cases.length} В ПОРТФЕЛЕ` : 'МОЁ ДЕЛО';
    const heading = document.createElement('h3');
    heading.textContent = hasCase() ? 'Ваш маршрут сохранён' : 'Здесь будет ваше земельное дело';
    const text = document.createElement('p');
    text.textContent = hasCase()
      ? 'Штурман будет учитывать эти данные в следующем ответе.'
      : 'Сохраните цель и текущий шаг — при следующем входе не придётся начинать с нуля.';
    card.append(eyebrow, heading, text);

    if (hasCase()) {
      const facts = document.createElement('dl');
      facts.className = 'case-facts';
      [
        ['Цель', activeCase.goal],
        ['Регион', activeCase.region],
        ['Поиск', [activeCase.searchCenter, activeCase.searchRadius && `до ${activeCase.searchRadius} км`].filter(Boolean).join(' · ')],
        ['Площадь', activeCase.plotSize],
        ['Важно', casePriorities().join(' · ')],
        ['Планируемый ВРИ', activeCase.vri],
        ['Участок', activeCase.cadastreNumber || activeCase.plotLocation],
        ['Муниципалитет', activeCase.municipality],
        ['Схема', activeCase.schemeStatus],
        ['Маршрут', activeCase.strategyId && STRATEGIES[activeCase.strategyId] ? STRATEGIES[activeCase.strategyId].title : ''],
        ['Сейчас', activeCase.currentStep],
        ['Ближайшая дата', readableDate(activeCase.nextDate)]
      ].filter(([, value]) => value).forEach(([label, value]) => {
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.textContent = value;
        facts.append(dt, dd);
      });
      card.appendChild(facts);

      const sourceLinks = [
        ['Администрация', activeCase.authorityUrl],
        ['Регламент', activeCase.regulationUrl],
        ['ПЗЗ / карта', activeCase.pzzUrl]
      ].filter(([, url]) => safeExternalUrl(url));
      if (sourceLinks.length) {
        const sources = document.createElement('div'); sources.className = 'passport-source-row';
        sourceLinks.forEach(([label, url]) => {
          const link = document.createElement('a');
          link.href = safeExternalUrl(url); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label;
          sources.appendChild(link);
        });
        card.appendChild(sources);
      }
    }

    const portfolio = document.createElement('button');
    portfolio.className = 'case-edit-btn';
    portfolio.textContent = 'Все мои участки';
    portfolio.addEventListener('click', openPortfolio);
    card.appendChild(portfolio);
    const edit = document.createElement('button');
    edit.className = 'case-edit-btn';
    edit.textContent = hasCase() ? 'Обновить дело' : 'Создать дело';
    edit.addEventListener('click', openCaseEditor);
    card.appendChild(edit);
    const searchProfile = document.createElement('button');
    searchProfile.className = 'case-edit-btn case-search-profile-btn';
    searchProfile.textContent = 'Настроить поиск места';
    searchProfile.addEventListener('click', openSearchProfile);
    card.appendChild(searchProfile);
    const passport = document.createElement('button');
    passport.className = 'case-edit-btn case-passport-btn';
    passport.textContent = activeCase.cadastreNumber || activeCase.plotLocation ? 'Открыть паспорт участка' : 'Создать паспорт участка';
    passport.addEventListener('click', openPlotPassport);
    card.appendChild(passport);
    const readiness = document.createElement('button');
    readiness.className = 'case-edit-btn case-readiness-btn';
    readiness.textContent = 'Проверить готовность к подаче';
    readiness.addEventListener('click', openSubmissionReadiness);
    card.appendChild(readiness);
    el.querySelector('.case-bubble').appendChild(card);
    chat.appendChild(el);
    scrollBottom();
    resolve();
  });
}

function openCaseEditor() {
  inputArea.innerHTML = '';
  const form = document.createElement('form');
  form.className = 'case-form';
  const title = document.createElement('div');
  title.className = 'case-form-title';
  title.textContent = 'Карточка земельного дела';
  const hint = document.createElement('p');
  hint.textContent = 'Заполните только то, что уже знаете. Эти данные останутся в этом браузере.';
  form.append(title, hint);

  const fields = [
    ['caseName', 'Название дела', 'Например: участок под дом в Тверской области'],
    ['goal', 'Ваша цель', 'Например: участок под ИЖС'],
    ['region', 'Регион или город', 'Например: Тверская область'],
    ['currentStep', 'На каком шаге вы сейчас', 'Например: ищу участок на НСПД'],
    ['nextDate', 'Ближайшая важная дата', '', 'date']
  ];
  const inputs = {};
  fields.forEach(([key, label, placeholder, type = 'text']) => {
    const wrap = document.createElement('label');
    wrap.className = 'case-field';
    wrap.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.value = activeCase[key] || '';
    input.placeholder = placeholder;
    input.maxLength = 180;
    wrap.appendChild(input);
    form.appendChild(wrap);
    inputs[key] = input;
  });

  const actions = document.createElement('div');
  actions.className = 'case-form-actions';
  const save = document.createElement('button');
  save.type = 'submit'; save.className = 'send-btn'; save.textContent = 'Сохранить';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'case-cancel-btn'; cancel.textContent = 'Отмена';
  actions.append(save, cancel);
  form.appendChild(actions);

  if (hasCase()) {
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'case-clear-btn'; clear.textContent = 'Удалить это дело с устройства';
    clear.addEventListener('click', () => {
      removeActiveCase();
      clearInput();
      agentTextMessage('Дело удалено с этого устройства.').then(openPortfolio);
    });
    form.appendChild(clear);
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    saveCase(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])));
    clearInput();
    agentTextMessage('Сохранила. В следующем вопросе я учту вашу цель и текущий шаг.')
      .then(renderCaseCard)
      .then(showAgentComposer);
  });
  cancel.addEventListener('click', showAgentComposer);
  inputArea.appendChild(form);
  inputs.goal.focus();
}

// Профиль поиска отделён от паспорта конкретного участка: сначала человек
// выбирает направление и ограничения, а уже потом проверяет отдельный контур.
// Это не «рейтинг выдачи земли», а сохранённые критерии для прозрачного подбора.
function openSearchProfile() {
  clearInput();
  const overlay = document.createElement('div');
  overlay.className = 'search-profile-modal';
  overlay.setAttribute('role', 'presentation');
  const modal = document.createElement('section');
  modal.className = 'search-profile-dialog';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'search-profile-title');
  const form = document.createElement('form');
  form.className = 'search-profile-form';
  const header = document.createElement('header');
  header.className = 'search-profile-header';
  const titleGroup = document.createElement('div');
  const eyebrow = document.createElement('span');
  eyebrow.className = 'search-profile-eyebrow';
  eyebrow.textContent = 'ЛИЧНЫЙ МАРШРУТ';
  const title = document.createElement('h2');
  title.id = 'search-profile-title';
  title.textContent = 'Настроить поиск места';
  const hint = document.createElement('p');
  hint.textContent = 'Выберите готовые варианты — Штурман переведёт их в критерии поиска. Окончательно ВРИ и возможность предоставления всегда проверяются по ПЗЗ и документам администрации.';
  titleGroup.append(eyebrow, title, hint);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'search-profile-close';
  closeButton.setAttribute('aria-label', 'Закрыть анкету');
  closeButton.textContent = '×';
  header.append(titleGroup, closeButton);
  form.appendChild(header);
  const close = (next) => {
    document.removeEventListener('keydown', onKeydown);
    document.body.classList.remove('modal-open');
    overlay.remove();
    if (typeof next === 'function') next();
  };
  const onKeydown = event => {
    if (event.key === 'Escape') close(() => getActiveStrategy() ? renderCurrentRouteStep() : showAgentComposer());
  };
  closeButton.addEventListener('click', () => close(() => getActiveStrategy() ? renderCurrentRouteStep() : showAgentComposer()));
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close(() => getActiveStrategy() ? renderCurrentRouteStep() : showAgentComposer());
  });

  const regionWrap = document.createElement('label');
  regionWrap.className = 'case-field'; regionWrap.textContent = 'Регион поиска';
  const region = document.createElement('select'); region.className = 'tool-select'; region.required = true;
  const savedRegion = activeCase.regionCode || REGIONS.find(item => item.name === activeCase.region)?.id || '';
  const emptyRegion = document.createElement('option'); emptyRegion.value = ''; emptyRegion.textContent = 'Выберите регион'; region.appendChild(emptyRegion);
  REGIONS.forEach(item => {
    const option = document.createElement('option'); option.value = item.id; option.textContent = item.name;
    option.selected = item.id === savedRegion; region.appendChild(option);
  });
  regionWrap.appendChild(region); form.appendChild(regionWrap);

  const makeSection = (headingText, noteText) => {
    const block = document.createElement('section');
    block.className = 'search-profile-section';
    const heading = document.createElement('h3'); heading.textContent = headingText;
    const note = document.createElement('p'); note.textContent = noteText;
    block.append(heading, note); form.appendChild(block);
    return block;
  };
  const goalSection = makeSection('Для чего нужен участок?', 'Выберите понятную цель. Планируемый ВРИ затем обязательно сверим с ПЗЗ.');
  const goalGrid = document.createElement('div'); goalGrid.className = 'search-goal-grid';
  const goalOptions = [
    { id: 'home', title: 'Дом для жизни', note: 'ИЖС', goal: 'Дом для проживания', vri: 'ИЖС' },
    { id: 'dacha', title: 'Дача или сад', note: 'Ведение садоводства', goal: 'Дача / сад', vri: 'Ведение садоводства' },
    { id: 'lph', title: 'Личное хозяйство', note: 'ЛПХ на приусадебном участке', goal: 'Личное подсобное хозяйство', vri: 'ЛПХ на приусадебном участке' },
    { id: 'garden', title: 'Огород', note: 'Ведение огородничества', goal: 'Огородничество', vri: 'Ведение огородничества' },
    { id: 'farm', title: 'Сено или выпас', note: 'Сельскохозяйственное использование', goal: 'Сенокошение / выпас', vri: 'Сенокошение или выпас' },
    { id: 'business', title: 'Дело или сервис', note: 'ВРИ уточним по ПЗЗ', goal: 'Коммерческое использование', vri: 'Уточнить по ПЗЗ' }
  ];
  const savedGoalPreset = activeCase.goalPreset
    || goalOptions.find(item => item.vri === activeCase.vri || item.goal === activeCase.goal)?.id
    || (/сад|дач/i.test(activeCase.goal || '') ? 'dacha' : (/ИЖС|дом/i.test(activeCase.goal || '') ? 'home' : (/ЛПХ|хозяйств/i.test(activeCase.goal || '') ? 'lph' : '')));
  const goalInputs = [];
  goalOptions.forEach(item => {
    const label = document.createElement('label'); label.className = 'search-goal-card';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'goal-preset'; input.value = item.id; input.required = true; input.checked = item.id === savedGoalPreset;
    const name = document.createElement('strong'); name.textContent = item.title;
    const note = document.createElement('span'); note.textContent = item.note;
    label.append(input, name, note); goalInputs.push({ input, item, label }); goalGrid.appendChild(label);
  });
  const refreshGoalCards = () => goalInputs.forEach(({ input, label }) => label.classList.toggle('is-selected', input.checked));
  goalInputs.forEach(({ input }) => input.addEventListener('change', refreshGoalCards));
  refreshGoalCards(); goalSection.appendChild(goalGrid);

  const strategySection = makeSection('Какой путь хотите рассмотреть?', 'Это предварительный выбор из 11 стратегий. Штурман не запустит его без проверки условий.');
  const strategy = document.createElement('select'); strategy.className = 'tool-select';
  [
    ['', 'Пока не знаю — помогите выбрать'],
    ['1', '1. Сразу в собственность без торгов'],
    ['2', '2. Аренда без торгов с возможным выкупом'],
    ['3', '3. Аренда, если уже есть зарегистрированный дом'],
    ['4', '4. Долгосрочная аренда / выкуп уже арендованного участка'],
    ['5', '5. Аренда для сенокошения или выпаса'],
    ['6', '6. Безвозмездное пользование для специалиста в селе'],
    ['7', '7. Дальневосточный или Арктический гектар'],
    ['8', '8. Прирезка к своему смежному участку'],
    ['9', '9. Торги: участок в собственность'],
    ['10', '10. Торги: участок в аренду'],
    ['11', '11. Торги по банкротству']
  ].forEach(([value, text]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = text;
    option.selected = value === String(activeCase.strategyPreference || ''); strategy.appendChild(option);
  });
  strategySection.appendChild(strategy);

  const locationSection = makeSection('Где искать?', 'Можно указать город и радиус, чтобы Штурман учитывал доступность.');
  const searchCenterWrap = document.createElement('label'); searchCenterWrap.className = 'case-field'; searchCenterWrap.textContent = 'Город или точка отсчёта';
  const searchCenter = document.createElement('input'); searchCenter.type = 'text'; searchCenter.value = activeCase.searchCenter || ''; searchCenter.placeholder = 'Например: Саратов'; searchCenter.maxLength = 180;
  searchCenterWrap.appendChild(searchCenter);
  const radiusWrap = document.createElement('label'); radiusWrap.className = 'case-field'; radiusWrap.textContent = 'Радиус поиска, км';
  const radius = document.createElement('input'); radius.type = 'number'; radius.value = activeCase.searchRadius || ''; radius.placeholder = 'Например: 60'; radius.min = '1'; radius.max = '300';
  radiusWrap.appendChild(radius); locationSection.append(searchCenterWrap, radiusWrap);

  const areaSection = makeSection('Какая площадь подходит?', 'Выберите диапазон до 15 соток или укажите свой.');
  const sizeGrid = document.createElement('div'); sizeGrid.className = 'search-size-grid';
  const sizeOptions = ['до 4 соток', '4–6 соток', '6–8 соток', '8–10 соток', '10–12 соток', '12–15 соток'];
  const sizeInputs = [];
  sizeOptions.forEach(value => {
    const label = document.createElement('label'); label.className = 'search-size-chip';
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'plot-size'; input.value = value; input.checked = activeCase.plotSize === value;
    const text = document.createElement('span'); text.textContent = value;
    label.append(input, text); sizeInputs.push({ input, label }); sizeGrid.appendChild(label);
  });
  const customSizeWrap = document.createElement('label'); customSizeWrap.className = 'case-field'; customSizeWrap.textContent = 'Другая площадь (необязательно)';
  const customSize = document.createElement('input'); customSize.type = 'text'; customSize.placeholder = 'Например: 15 соток'; customSize.maxLength = 80;
  customSize.value = sizeOptions.includes(activeCase.plotSize) ? '' : (activeCase.plotSize || '');
  const refreshSizeCards = () => sizeInputs.forEach(({ input, label }) => label.classList.toggle('is-selected', input.checked));
  sizeInputs.forEach(({ input }) => input.addEventListener('change', () => { customSize.value = ''; refreshSizeCards(); }));
  customSize.addEventListener('input', () => {
    if (customSize.value.trim()) sizeInputs.forEach(({ input }) => { input.checked = false; });
    refreshSizeCards();
  });
  refreshSizeCards(); customSizeWrap.appendChild(customSize); areaSection.append(sizeGrid, customSizeWrap);

  const prioritySection = makeSection('Что важнее всего?', 'Отметьте галочками всё важное — так не придётся выбирать только два пункта.');
  const priorityGrid = document.createElement('div'); priorityGrid.className = 'search-priority-grid';
  const oldPriorities = casePriorities();
  const priorityItems = [
    'Электричество с подтверждённой возможностью подключения',
    'Близость к городу',
    'Круглогодичный подъезд',
    'Вода',
    'Газ',
    'Тишина / природа',
    'Минимальные расходы'
  ];
  const priorityInputs = [];
  priorityItems.forEach(value => {
    const label = document.createElement('label'); label.className = 'search-priority-item';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = value;
    input.checked = oldPriorities.includes(value) || (value === 'Круглогодичный подъезд' && Boolean(activeCase.allSeasonRoad));
    const text = document.createElement('span'); text.textContent = value;
    label.append(input, text); priorityInputs.push(input); priorityGrid.appendChild(label);
  });
  prioritySection.appendChild(priorityGrid);
  const timePriority = document.createElement('div'); timePriority.className = 'search-time-priority';
  const timeCheckLabel = document.createElement('label'); timeCheckLabel.className = 'search-priority-item';
  const travelTimePriority = document.createElement('input'); travelTimePriority.type = 'checkbox'; travelTimePriority.checked = Boolean(activeCase.travelTimePriority || activeCase.travelTime);
  const timeText = document.createElement('span'); timeText.textContent = 'Предел времени в дороге';
  timeCheckLabel.append(travelTimePriority, timeText);
  const timeOptions = document.createElement('div'); timeOptions.className = 'search-time-options';
  const savedTravelTime = String(activeCase.travelTime || '60');
  const timeInputs = [];
  ['30', '45', '60', '90', '120'].forEach(value => {
    const label = document.createElement('label');
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'travel-time'; input.value = value; input.checked = value === savedTravelTime;
    const text = document.createElement('span'); text.textContent = 'до ' + value + ' мин';
    label.append(input, text); timeInputs.push(input); timeOptions.appendChild(label);
  });
  const updateTimeOptions = () => {
    timeOptions.classList.toggle('is-disabled', !travelTimePriority.checked);
    timeInputs.forEach(input => { input.disabled = !travelTimePriority.checked; });
  };
  travelTimePriority.addEventListener('change', updateTimeOptions); updateTimeOptions();
  timePriority.append(timeCheckLabel, timeOptions); prioritySection.appendChild(timePriority);

  const futureWrap = document.createElement('label'); futureWrap.className = 'case-field'; futureWrap.textContent = 'План на будущее (необязательно)';
  const futurePlan = document.createElement('input'); futurePlan.type = 'text'; futurePlan.value = activeCase.futurePlan || ''; futurePlan.maxLength = 180;
  futurePlan.placeholder = 'Например: арендовать, построить дом и затем рассмотреть выкуп';
  futureWrap.appendChild(futurePlan); form.appendChild(futureWrap);

  const directoryBox = document.createElement('section'); directoryBox.className = 'municipality-picker';
  const directoryTitle = document.createElement('h3'); directoryTitle.textContent = 'Муниципалитет и администрация';
  const directoryLead = document.createElement('p'); directoryLead.textContent = 'Можно выбрать направление из списка или указать своё. Список помогает начать проверку, но не показывает «где точно выдадут землю».';
  const sourceNote = document.createElement('a'); sourceNote.className = 'municipality-source'; sourceNote.target = '_blank'; sourceNote.rel = 'noopener noreferrer';
  const suggestions = document.createElement('div'); suggestions.className = 'municipality-suggestions';
  const municipalityWrap = document.createElement('label'); municipalityWrap.className = 'case-field'; municipalityWrap.textContent = 'Выбрать муниципалитет из списка';
  const municipality = document.createElement('select'); municipality.className = 'tool-select'; municipalityWrap.appendChild(municipality);
  const manualMunicipality = document.createElement('input'); manualMunicipality.type = 'text'; manualMunicipality.className = 'tool-input'; manualMunicipality.placeholder = 'Или впишите другой муниципалитет вручную'; manualMunicipality.maxLength = 180;
  const authorityName = document.createElement('input'); authorityName.type = 'text'; authorityName.className = 'tool-input'; authorityName.placeholder = 'Орган или администрация'; authorityName.maxLength = 220; authorityName.value = activeCase.authorityName || '';
  const authorityUrl = document.createElement('input'); authorityUrl.type = 'url'; authorityUrl.className = 'tool-input'; authorityUrl.placeholder = 'Официальный сайт администрации: https://…'; authorityUrl.maxLength = 500; authorityUrl.value = activeCase.authorityUrl || '';
  directoryBox.append(directoryTitle, directoryLead, sourceNote, suggestions, municipalityWrap, manualMunicipality, authorityName, authorityUrl);
  form.appendChild(directoryBox);

  const renderDirectory = () => {
    const directory = MUNICIPALITY_DIRECTORY[region.value];
    municipality.innerHTML = '';
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = directory ? 'Выберите из списка' : 'Для региона пока нет справочника — впишите вручную'; municipality.appendChild(empty);
    suggestions.innerHTML = '';
    sourceNote.textContent = '';
    sourceNote.removeAttribute('href');
    if (!directory) return;
    sourceNote.href = directory.sourceUrl;
    sourceNote.textContent = `${directory.sourceLabel} · проверено ${directory.updatedAt}`;
    directory.entries.forEach(entry => {
      const option = document.createElement('option'); option.value = entry.name; option.textContent = entry.name;
      option.selected = entry.name === activeCase.municipality; municipality.appendChild(option);
    });
    directory.entries.slice(0, 3).forEach(entry => {
      const card = document.createElement('article'); card.className = 'municipality-suggestion';
      const name = document.createElement('strong'); name.textContent = entry.name;
      const note = document.createElement('span'); note.textContent = entry.note;
      const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = 'Выбрать';
      choose.addEventListener('click', () => {
        municipality.value = entry.name; manualMunicipality.value = '';
        authorityName.value = entry.authority; authorityUrl.value = entry.authorityUrl;
      });
      card.append(name, note, choose); suggestions.appendChild(card);
    });
  };
  const applyMunicipality = () => {
    const entry = MUNICIPALITY_DIRECTORY[region.value]?.entries.find(item => item.name === municipality.value);
    if (!entry) return;
    manualMunicipality.value = ''; authorityName.value = entry.authority; authorityUrl.value = entry.authorityUrl;
  };
  region.addEventListener('change', renderDirectory);
  municipality.addEventListener('change', applyMunicipality);
  renderDirectory();

  const actions = document.createElement('div'); actions.className = 'case-form-actions';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'send-btn'; save.textContent = 'Сохранить критерии';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'case-cancel-btn'; cancel.textContent = 'Отмена';
  actions.append(save, cancel); form.appendChild(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const selectedGoal = goalInputs.find(({ input }) => input.checked);
    if (!selectedGoal) {
      goalInputs[0].input.focus();
      goalSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const selectedRegion = findRegion(region.value);
    const chosenMunicipality = manualMunicipality.value.trim() || municipality.value || activeCase.municipality;
    const url = authorityUrl.value.trim();
    if (url && !safeExternalUrl(url)) { authorityUrl.focus(); return; }
    const selectedSize = sizeInputs.find(({ input }) => input.checked)?.input.value || '';
    const selectedPriorities = priorityInputs.filter(input => input.checked).map(input => input.value);
    const selectedTravelTime = timeInputs.find(input => input.checked)?.value || '';
    if (travelTimePriority.checked && selectedTravelTime) selectedPriorities.push('Время в дороге: до ' + selectedTravelTime + ' минут');
    saveCase({
      ...activeCase,
      regionCode: region.value,
      region: selectedRegion?.name || activeCase.region,
      goalPreset: selectedGoal.item.id, goal: selectedGoal.item.goal, vri: selectedGoal.item.vri,
      strategyPreference: strategy.value,
      searchCenter: searchCenter.value.trim(), searchRadius: radius.value.trim(),
      plotSize: customSize.value.trim() || selectedSize,
      priorities: selectedPriorities, priorityOne: selectedPriorities[0] || '', priorityTwo: selectedPriorities[1] || '',
      travelTime: travelTimePriority.checked ? selectedTravelTime : '',
      travelTimePriority: travelTimePriority.checked,
      allSeasonRoad: selectedPriorities.includes('Круглогодичный подъезд'), futurePlan: futurePlan.value.trim(),
      municipality: chosenMunicipality, authorityName: authorityName.value.trim(), authorityUrl: url
    });
    close();
    agentTextMessage('Критерии поиска сохранены. Выбранный муниципалитет — направление для проверки, а не обещание предоставления земли.')
      .then(renderCaseCard)
      .then(() => getActiveStrategy() ? renderCurrentRouteStep() : showAgentComposer());
  });
  cancel.addEventListener('click', () => close(() => getActiveStrategy() ? renderCurrentRouteStep() : showAgentComposer()));
  modal.appendChild(form);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.body.classList.add('modal-open');
  document.addEventListener('keydown', onKeydown);
  region.focus();
}

// Самый полезный следующий слой после маршрута: не большая база данных, а
// один сохранённый «паспорт» выбранного участка с первоисточниками.
function openPlotPassport() {
  inputArea.innerHTML = '';
  const form = document.createElement('form');
  form.className = 'case-form plot-passport-form';
  const title = document.createElement('div');
  title.className = 'case-form-title';
  title.textContent = 'Паспорт участка';
  const hint = document.createElement('p');
  hint.textContent = 'Сохраните только проверенные сведения и ссылки. Это не заключение о возможности предоставления участка — оно помогает не потерять результаты проверок.';
  const links = document.createElement('div');
  links.className = 'service-link-row';
  links.innerHTML = '<a href="https://nspd.gov.ru" target="_blank" rel="noopener noreferrer">НСПД</a><a href="https://fgistp.economy.gov.ru" target="_blank" rel="noopener noreferrer">ФГИС ТП / ПЗЗ</a><a href="https://torgi.gov.ru" target="_blank" rel="noopener noreferrer">ГИС Торги</a>';
  form.append(title, hint, links);

  const fields = [
    ['cadastreNumber', 'Кадастровый номер', 'Например: 50:11:0010101:100'],
    ['plotLocation', 'Адрес или ориентир участка', 'Населённый пункт, квартал, ориентир'],
    ['municipality', 'Муниципалитет', 'Район, городской округ или поселение'],
    ['authorityUrl', 'Официальный сайт администрации', 'Вставьте ссылку https://…', 'url'],
    ['regulationUrl', 'Ссылка на регламент или услугу', 'Если уже найдена', 'url'],
    ['pzzUrl', 'Ссылка на ПЗЗ / карту', 'Если уже найдена', 'url']
  ];
  const inputs = {};
  fields.forEach(([key, label, placeholder, type = 'text']) => {
    const wrap = document.createElement('label');
    wrap.className = 'case-field'; wrap.textContent = label;
    const input = document.createElement('input');
    input.type = type; input.placeholder = placeholder; input.maxLength = 500;
    input.value = activeCase[key] || '';
    wrap.appendChild(input); form.appendChild(wrap); inputs[key] = input;
  });

  const statusWrap = document.createElement('label');
  statusWrap.className = 'case-field'; statusWrap.textContent = 'Статус схемы';
  const status = document.createElement('select'); status.className = 'tool-select';
  ['', 'Место найдено', 'Проверено в НСПД', 'Контур нарисован', 'Схема сохранена', 'Подано в администрацию'].forEach(value => {
    const option = document.createElement('option'); option.value = value; option.textContent = value || 'Пока не выбрано';
    if (value === activeCase.schemeStatus) option.selected = true;
    status.appendChild(option);
  });
  statusWrap.appendChild(status); form.appendChild(statusWrap);

  const actions = document.createElement('div'); actions.className = 'case-form-actions';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'send-btn'; save.textContent = 'Сохранить паспорт';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'case-cancel-btn'; cancel.textContent = 'Отмена';
  actions.append(save, cancel); form.appendChild(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]));
    const invalidUrl = ['authorityUrl', 'regulationUrl', 'pzzUrl'].find(key => values[key] && !safeExternalUrl(values[key]));
    if (invalidUrl) { inputs[invalidUrl].focus(); return; }
    saveCase({ ...activeCase, ...values, schemeStatus: status.value });
    clearInput();
    agentTextMessage('Паспорт участка сохранён на этом устройстве. Дальше можно открыть требования администрации или продолжить маршрут.')
      .then(renderCaseCard)
      .then(showAgentComposer);
  });
  cancel.addEventListener('click', showAgentComposer);
  inputArea.appendChild(form);
  inputs.cadastreNumber.focus();
}

function applicantProfile() {
  try { return JSON.parse(localStorage.getItem('zemelniy-shturman-profile-v1') || '{}'); } catch (e) { return {}; }
}

// Контрольная точка до отправки документов. Она не заменяет местный регламент,
// но не даёт пользователю перейти к черновику, пока в деле нет базовых опор.
function openSubmissionReadiness() {
  clearInput();
  agentMessage('<strong>Проверим готовность к подаче.</strong><br>Это короткий стоп-лист перед заявлением: он показывает пробелы, которые чаще всего приводят к возврату документов.').then(() => {
    const card = document.createElement('section');
    card.className = 'submission-readiness';
    const title = document.createElement('h3'); title.textContent = 'Перед подачей в администрацию';
    const intro = document.createElement('p'); intro.textContent = 'Выберите услугу. Штурман сопоставит её с паспортом участка и покажет только нужные проверки.';
    const service = document.createElement('select'); service.className = 'tool-select';
    [
      ['unformed', 'Предварительное согласование: участок ещё не сформирован'],
      ['srzu', 'Утверждение схемы расположения участка'],
      ['formed', 'Предоставление сформированного участка']
    ].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; service.appendChild(option); });
    const list = document.createElement('div'); list.className = 'readiness-list';
    const note = document.createElement('p'); note.className = 'readiness-note';
    const actions = document.createElement('div'); actions.className = 'tool-actions';
    const draft = document.createElement('button'); draft.type = 'button'; draft.className = 'send-btn'; draft.textContent = 'Открыть черновик заявления';
    const regulation = document.createElement('button'); regulation.type = 'button'; regulation.className = 'case-edit-btn'; regulation.textContent = 'Разобрать регламент / бланк';
    const municipality = document.createElement('button'); municipality.type = 'button'; municipality.className = 'case-edit-btn'; municipality.textContent = 'Открыть требования администрации';
    const back = document.createElement('button'); back.type = 'button'; back.className = 'case-cancel-btn'; back.textContent = 'Назад';
    actions.append(draft, regulation, municipality, back);
    card.append(title, intro, service, list, note, actions);
    chat.appendChild(card); scrollBottom();

    const render = () => {
      const type = service.value;
      const profile = applicantProfile();
      const manual = activeCase.submissionChecks && typeof activeCase.submissionChecks === 'object' ? activeCase.submissionChecks : {};
      const isFormed = type === 'formed';
      const needsScheme = type === 'unformed' || type === 'srzu';
      const schemeReady = ['Схема сохранена', 'Подано в администрацию'].includes(activeCase.schemeStatus);
      const items = [
        { id: 'plot', ready: isFormed ? Boolean(activeCase.cadastreNumber) : Boolean(activeCase.cadastreNumber || activeCase.plotLocation), text: isFormed ? 'Указан кадастровый номер сформированного участка' : 'Указан участок: кадастровый номер или ориентир' },
        { id: 'municipality', ready: Boolean(activeCase.municipality), text: 'Указан муниципалитет' },
        { id: 'authority', ready: Boolean(safeExternalUrl(activeCase.authorityUrl)), text: 'Сохранён официальный сайт или уполномоченный орган' },
        { id: 'regulation', ready: Boolean(safeExternalUrl(activeCase.regulationUrl)), text: 'Сохранена ссылка на регламент или конкретную услугу' },
        { id: 'pzz', ready: Boolean(safeExternalUrl(activeCase.pzzUrl)), text: 'Сохранена ссылка на ПЗЗ / карту и выполнена проверка ВРИ и ограничений' },
        { id: 'profile', ready: Boolean(profile.name && profile.address), text: 'В черновике уже сохранены ФИО и адрес заявителя' },
        ...(needsScheme ? [{ id: 'scheme', ready: schemeReady, text: 'Схема подготовлена и сохранена для подачи' }] : []),
        { id: 'formReviewed', ready: Boolean(manual.formReviewed), manual: true, text: 'Я сверил(а) поля черновика с муниципальным бланком' },
        { id: 'attachmentsPrepared', ready: Boolean(manual.attachmentsPrepared), manual: true, text: 'Я собрал(а) приложения строго по перечню регламента' }
      ];
      list.innerHTML = '';
      items.forEach(item => {
        const row = document.createElement('label'); row.className = `readiness-item${item.ready ? ' is-ready' : ''}`;
        const mark = document.createElement('span'); mark.className = 'readiness-mark'; mark.textContent = item.ready ? 'Готово' : 'Нужно';
        const body = document.createElement('span'); body.textContent = item.text;
        row.append(mark, body);
        if (item.manual) {
          const input = document.createElement('input'); input.type = 'checkbox'; input.checked = item.ready;
          input.setAttribute('aria-label', item.text);
          input.addEventListener('change', () => {
            const checks = { ...(activeCase.submissionChecks || {}), [item.id]: input.checked };
            saveCase({ ...activeCase, submissionChecks: checks }); render();
          });
          row.appendChild(input);
        }
        list.appendChild(row);
      });
      const readyCount = items.filter(item => item.ready).length;
      const completed = readyCount === items.length;
      note.textContent = completed
        ? 'Базовый комплект собран. Можно открыть черновик, ещё раз сверить его с бланком и подать способом из регламента.'
        : `Готово ${readyCount} из ${items.length}. Сначала закройте пункты «Нужно» — черновик не заменяет эти проверки.`;
      draft.disabled = !completed;
      draft.title = completed ? '' : 'Сначала завершите проверки из списка';
    };
    service.addEventListener('change', render);
    draft.addEventListener('click', openApplicationGenerator);
    regulation.addEventListener('click', () => { openDocumentAnalyzer(); setTimeout(() => { const select = inputArea.querySelector('select'); if (select) select.value = 'municipal'; }, 0); });
    municipality.addEventListener('click', openMunicipalityDesk);
    back.addEventListener('click', showAgentComposer);
    render();
  });
}

// ===== ДИАЛОГОВЫЙ АГЕНТ =====

function getActiveStrategy() {
  return activeCase.strategyId ? STRATEGIES[activeCase.strategyId] : null;
}

function saveRoute(strategy, stepIndex = 0, extra = {}) {
  const step = strategy.steps[stepIndex] || '';
  saveCase({
    ...activeCase,
    ...extra,
    strategyId: String(strategy.id),
    routeStep: stepIndex,
    routeStartedAt: activeCase.routeStartedAt || new Date().toISOString(),
    currentStep: step ? `Шаг ${stepIndex + 1} из ${strategy.steps.length}: ${step}` : 'Маршрут пройден'
  });
}

function getRouteStepGuide(step) {
  if (/Дальневосточн|Арктическ.*гектар|надальнийвосток\.рф|стопарктика\.рф/i.test(step)) {
    return '<div class="route-guide"><strong>Куда идти:</strong> ' + externalLink('https://надальнийвосток.рф', 'официальная программа «Гектар»') + '. Выберите регион и участок на карте, затем проверьте условия подачи в своём регионе.</div>';
  }
  if (/Федресурс|ЕФРСБ|банкротств/i.test(step)) {
    return '<div class="route-guide"><strong>Куда идти:</strong> ' + externalLink('https://bankrot.fedresurs.ru', 'ЕФРСБ / Федресурс') + '. Найдите сообщение о торгах и переходите на электронную площадку только из карточки конкретного лота.</div>';
  }
  if (/НСПД/.test(step)) {
    return '<div class="route-guide"><strong>Куда идти:</strong> <a href="https://nspd.gov.ru" target="_blank" rel="noopener noreferrer">НСПД</a>. Найдите район или кадастровый квартал, включите нужные слои и сохраните номер либо скрин выбранного места.</div>';
  }
  if (/ГИС Торги|лоты на аренду/.test(step)) {
    return '<div class="route-guide"><strong>Куда идти:</strong> <a href="https://torgi.gov.ru" target="_blank" rel="noopener noreferrer">ГИС Торги</a>. Выберите регион, тип имущества «земельный участок» и сохраните ссылку на лот, срок подачи и размер задатка.</div>';
  }
  if (/администрац|местный орган управления землёй/.test(step)) {
    return '<div class="route-guide"><strong>Куда идти:</strong> на сайт администрации района или в МФЦ. Сначала откройте раздел «Имущество и земельные отношения» и сверяйте форму заявления именно для вашего муниципалитета.</div>' + officialLinksFor('Госуслуги');
  }
  if (/ПЗЗ|Генплан|ЗОУИТ/.test(step)) {
    return '<div class="route-guide"><strong>Что проверить:</strong> территориальную зону, допустимый ВРИ, красные линии и ограничения. Обычно ПЗЗ и Генплан опубликованы на сайте администрации в разделе градостроительства.</div>' + officialLinksFor('ПЗЗ');
  }
  if (/Росреестр|ЕГРН/.test(step)) {
    return '<div class="route-guide"><strong>Где проверить сведения:</strong> на <a href="https://rosreestr.gov.ru" target="_blank" rel="noopener noreferrer">сайте Росреестра</a> или через МФЦ. Сохраните выписку и дату, на которую она получена.</div>';
  }
  return '<div class="route-guide"><strong>Результат шага:</strong> сохраните ссылку, документ или краткую заметку. Это поможет продолжить дело без повторного поиска.</div>';
}

function showRouteActions(strategy) {
  inputArea.innerHTML = '';
  const stepIndex = Number(activeCase.routeStep || 0);
  const completed = stepIndex >= strategy.steps.length;
  const panel = document.createElement('div');
  panel.className = 'route-actions';

  const note = document.createElement('p');
  note.textContent = completed
    ? 'Маршрут завершён. Сохраните итоговые документы и следите за сроками.'
    : 'Отметьте только реальный результат — тогда следующий шаг останется понятным.';
  panel.appendChild(note);

  if (!completed) {
    const done = document.createElement('button');
    done.className = 'route-primary-btn';
    done.textContent = 'Шаг выполнен — показать следующий';
    done.addEventListener('click', () => {
      saveRoute(strategy, stepIndex + 1);
      renderCurrentRouteStep();
    });
    panel.appendChild(done);
  }

  const row = document.createElement('div');
  row.className = 'route-secondary-actions';
  const problem = document.createElement('button');
  problem.className = 'route-secondary-btn';
  problem.textContent = 'Пришёл отказ или требование';
  problem.addEventListener('click', openDocumentAnalyzer);
  const administration = document.createElement('button');
  administration.className = 'route-secondary-btn';
  administration.textContent = 'Требования администрации';
  administration.addEventListener('click', openMunicipalityDesk);
  const question = document.createElement('button');
  question.className = 'route-secondary-btn';
  question.textContent = 'Задать вопрос по шагу';
  question.addEventListener('click', showAgentComposer);
  row.append(problem, administration, question);
  panel.appendChild(row);

  inputArea.appendChild(panel);
}

function renderCurrentRouteStep() {
  const strategy = getActiveStrategy();
  if (!strategy) return showAgentComposer();
  clearInput();
  const stepIndex = Number(activeCase.routeStep || 0);

  if (stepIndex >= strategy.steps.length) {
    saveRoute(strategy, stepIndex);
    return agentMessage(`<strong>Основной маршрут завершён.</strong><br>Вы прошли «${strategy.title}». Сохраните полученные документы и отметьте важные даты. Если администрация отказала или попросила дополнения — загрузите документ, и я разберу причину.`)
      .then(renderCaseCard)
      .then(() => showRouteActions(strategy));
  }

  const warning = stepIndex === 0 && strategy.warning
    ? `<div class="route-warning"><strong>Важно:</strong> ${strategy.warning}</div>`
    : '';
  const guide = getRouteStepGuide(strategy.steps[stepIndex]);
  return agentMessage(`<div class="route-step-kicker">ВАШЕ ДЕЛО · ${strategy.title}</div><strong>Шаг ${stepIndex + 1} из ${strategy.steps.length}</strong><br>${strategy.steps[stepIndex]}${guide}${warning}`)
    .then(() => agentMessage('<span class="agent-base-note">Сделайте только этот шаг. Когда будет результат, нажмите кнопку ниже — я открою следующий.</span>'))
    .then(() => showRouteActions(strategy));
}

function continueSavedCase() {
  if (getActiveStrategy()) return renderCurrentRouteStep();
  if (hasCase()) return renderCaseCard().then(showAgentComposer);
  return startRouter();
}

function startNewCase() {
  closeLandBot();
  openCaseWorkspace();
}

function openPortfolio() {
  chat.innerHTML = '';
  conversationHistory = [];
  progressWrap.style.display = 'none';
  clearInput();

  agentMessage('<strong>Мои участки</strong><br>Здесь каждое дело ведётся отдельно. Выберите участок, чтобы продолжить его маршрут, или создайте новый.').then(() => {
    const panel = document.createElement('section');
    panel.className = 'portfolio-panel';
    const summary = document.createElement('p');
    summary.className = 'portfolio-summary';
    summary.textContent = cases.length ? `В портфеле: ${cases.length}. Активное дело выделено.` : 'Пока нет сохранённых дел. Можно начать с цели или добавить уже найденный участок.';
    panel.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'portfolio-list';
    cases.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).forEach(item => {
      const card = document.createElement('article');
      card.className = `portfolio-case${item.id === activeCaseId ? ' is-active' : ''}`;
      const title = document.createElement('strong'); title.textContent = caseTitle(item);
      const meta = document.createElement('span'); meta.textContent = [caseStatus(item), item.region, item.currentStep].filter(Boolean).join(' · ');
      const open = document.createElement('button');
      open.className = 'portfolio-open-btn'; open.textContent = item.id === activeCaseId ? 'Открыто' : 'Открыть';
      open.addEventListener('click', () => {
        switchActiveCase(item.id);
        chat.innerHTML = '';
        agentTextMessage(`Открыла дело «${caseTitle(activeCase)}».`).then(continueSavedCase);
      });
      card.append(title, meta, open); list.appendChild(card);
    });
    panel.appendChild(list);
    chat.appendChild(panel);
    scrollBottom();

    const actions = document.createElement('div'); actions.className = 'portfolio-actions';
    const newCase = document.createElement('button'); newCase.className = 'route-primary-btn'; newCase.textContent = 'Создать новое дело'; newCase.addEventListener('click', startNewCase);
    const auctions = document.createElement('button'); auctions.className = 'route-secondary-btn'; auctions.textContent = `Торги${auctionLots.length ? ` · ${auctionLots.length}` : ''}`; auctions.addEventListener('click', openAuctionDesk);
    const back = document.createElement('button'); back.className = 'route-secondary-btn'; back.textContent = 'Вернуться в чат'; back.addEventListener('click', startAgent);
    actions.append(newCase, auctions, back); inputArea.appendChild(actions);
  });
}

function emptyAuctionLot() {
  return { id: '', title: '', source: '', deadline: '', status: 'Наблюдаю', linkedCaseId: '', createdAt: '', updatedAt: '' };
}

function loadAuctionLots() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUCTIONS_STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter(item => item && typeof item === 'object').map(item => ({ ...emptyAuctionLot(), ...item, id: item.id || createLocalId('lot') })) : [];
  } catch (e) { return []; }
}

function saveAuctionLots() {
  try { localStorage.setItem(AUCTIONS_STORAGE_KEY, JSON.stringify(auctionLots)); } catch (e) { /* браузер может запретить хранилище */ }
}

function openAuctionDesk() {
  chat.innerHTML = '';
  progressWrap.style.display = 'none';
  clearInput();
  agentMessage('<strong>Торги</strong><br>Добавьте лот ссылкой из ГИС Торги или кадастровым номером. Я сохраню срок, свяжу лот с участком и помогу пройти проверку до заявки.').then(() => {
    const panel = document.createElement('section'); panel.className = 'auction-panel';
    const note = document.createElement('p'); note.className = 'auction-note'; note.textContent = 'Автоподбор публичных лотов появится после подключения подтверждённого источника. Сейчас лоты можно добавлять вручную — это надёжный способ ничего не потерять.';
    const list = document.createElement('div'); list.className = 'auction-list';
    if (!auctionLots.length) {
      const empty = document.createElement('div'); empty.className = 'auction-empty'; empty.textContent = 'Пока нет добавленных лотов.'; list.appendChild(empty);
    }
    auctionLots.slice().sort((a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999'))).forEach(lot => {
      const card = document.createElement('article'); card.className = 'auction-lot';
      const title = document.createElement('strong'); title.textContent = lot.title || 'Лот без названия';
      const linked = cases.find(item => item.id === lot.linkedCaseId);
      const meta = document.createElement('span'); meta.textContent = [lot.status, lot.deadline ? `заявки до ${readableDate(lot.deadline)}` : 'срок не указан', linked ? `дело: ${caseTitle(linked)}` : 'дело не выбрано'].join(' · ');
      const actions = document.createElement('div'); actions.className = 'auction-lot-actions';
      if (safeExternalUrl(lot.source)) {
        const source = document.createElement('a'); source.href = safeExternalUrl(lot.source); source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = 'Открыть лот'; actions.appendChild(source);
      }
      const check = document.createElement('button'); check.type = 'button'; check.textContent = 'Проверить с ЗемляБотом'; check.addEventListener('click', () => {
        if (linked) switchActiveCase(linked.id);
        sendAgentQuestion(`Помоги проверить лот для торгов: ${lot.title}. Источник или номер: ${lot.source || 'не указан'}. Сначала назови один самый важный шаг и что проверить до заявки.`, `Проверить лот: ${lot.title}`);
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'auction-remove-btn'; remove.textContent = 'Убрать'; remove.addEventListener('click', () => { auctionLots = auctionLots.filter(item => item.id !== lot.id); saveAuctionLots(); openAuctionDesk(); });
      actions.append(check, remove); card.append(title, meta, actions); list.appendChild(card);
    });
    panel.append(note, list); chat.appendChild(panel); scrollBottom();

    const form = document.createElement('form'); form.className = 'auction-form';
    form.innerHTML = '<div class="tool-form-kicker">НОВЫЙ ЛОТ</div><h3>Добавить лот в наблюдение</h3><p>Ссылку из ГИС Торги можно вставить целиком. Если её пока нет, укажите кадастровый номер или краткое название.</p>';
    const title = document.createElement('input'); title.className = 'tool-input'; title.placeholder = 'Например: аренда участка под ИЖС'; title.required = true; title.maxLength = 180;
    const source = document.createElement('input'); source.className = 'tool-input'; source.placeholder = 'Ссылка ГИС Торги или кадастровый номер'; source.maxLength = 500;
    const deadline = document.createElement('input'); deadline.className = 'tool-date-input'; deadline.type = 'date';
    const status = document.createElement('select'); status.className = 'tool-select'; ['Наблюдаю', 'Готовлю заявку', 'Заявка подана', 'Допущен(а)', 'Торги завершены'].forEach(value => { const option = document.createElement('option'); option.value = value; option.textContent = value; status.appendChild(option); });
    const caseSelect = document.createElement('select'); caseSelect.className = 'tool-select'; const none = document.createElement('option'); none.value = ''; none.textContent = 'Не связывать с делом пока'; caseSelect.appendChild(none); cases.forEach(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = caseTitle(item); if (item.id === activeCaseId) option.selected = true; caseSelect.appendChild(option); });
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'send-btn'; submit.textContent = 'Сохранить лот';
    form.append(title, source, deadline, status, caseSelect, submit);
    form.addEventListener('submit', event => { event.preventDefault(); auctionLots.push({ ...emptyAuctionLot(), id: createLocalId('lot'), title: title.value.trim(), source: source.value.trim(), deadline: deadline.value, status: status.value, linkedCaseId: caseSelect.value, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); saveAuctionLots(); openAuctionDesk(); });
    inputArea.appendChild(form);
  });
}

function showAgentComposer() {
  inputArea.innerHTML = '';
  const quick = document.createElement('div');
  quick.className = 'agent-quick-actions';
  const actions = hasCase()
    ? [
      ['Мои участки', 'portfolio'],
      ['Торги', 'auctions'],
      ['Продолжить моё дело', 'continue'],
      ['Настроить поиск места', 'search-profile'],
      ['Паспорт участка', 'plot-passport'],
      ['Готовность к подаче', 'submission-readiness'],
      ['Подать в администрацию', 'municipality'],
      ['Нарисовать схему', 'scheme-guide'],
      ['Пришёл отказ / требование', 'document'],
      ['Проверить участок', 'live-check'],
      ['Моё дело', 'case']
    ]
    : [
      ['Мои участки', 'portfolio'],
      ['Торги', 'auctions'],
      ['Начать путь к участку', 'start-route'],
      ['Настроить поиск места', 'search-profile'],
      ['Паспорт участка', 'plot-passport'],
      ['Готовность к подаче', 'submission-readiness'],
      ['Подать в администрацию', 'municipality'],
      ['Нарисовать схему', 'scheme-guide'],
      ['У меня есть отказ', 'document'],
      ['У меня есть кадастровый номер', 'live-check']
    ];
  actions.forEach(([label, action]) => {
    const button = document.createElement('button');
    button.className = 'agent-quick-btn';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (action === 'start-route') return startNewCase();
      if (action === 'portfolio') return openPortfolio();
      if (action === 'auctions') return openAuctionDesk();
      if (action === 'continue') return continueSavedCase();
      if (action === 'scheme-guide') return openSchemeGuide();
      if (action === 'live-check') return openLiveCheckDesk();
      if (action === 'plot-passport') return openPlotPassport();
      if (action === 'search-profile') return openSearchProfile();
      if (action === 'submission-readiness') return openSubmissionReadiness();
      if (action === 'municipality') return openMunicipalityDesk();
      if (action === 'document') return openDocumentAnalyzer();
      if (action === 'application') return openApplicationGenerator();
      if (action === 'reminder') return openReminderManager();
      if (action === 'case') return openCaseEditor();
      return sendAgentQuestion(action, label);
    });
    quick.appendChild(button);
  });

  const row = document.createElement('div');
  row.className = 'text-row agent-composer-row';
  const inp = document.createElement('textarea');
  inp.className = 'text-input agent-textarea';
  inp.placeholder = 'Например: «Хочу участок под дом в Тверской области, с чего начать?»';
  inp.rows = 2;
  inp.setAttribute('aria-label', 'Ваш вопрос Земельному Штурману');
  const sendBtn = document.createElement('button');
  sendBtn.className = 'send-btn';
  sendBtn.textContent = 'Спросить';
  const send = () => {
    const question = inp.value.trim();
    if (!question) return;
    inp.value = '';
    sendAgentQuestion(question, question, sendBtn);
  };
  sendBtn.addEventListener('click', send);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  row.append(inp, sendBtn);

  const interview = document.createElement('button');
  interview.className = 'agent-interview-link';
  interview.textContent = hasCase() ? 'Начать новое дело с нуля' : 'Не хотите проходить маршрут? Задать вопрос в свободной форме';
  interview.addEventListener('click', hasCase() ? startNewCase : startRouter);
  inputArea.append(quick, row, interview);
}

function sendAgentQuestion(question, displayText = question, button = null) {
  if (button) button.disabled = true;
  userMessage(displayText);
  clearInput();
  fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history: conversationHistory, caseContext: caseContext() })
  })
    .then(r => r.json().then(data => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      const answer = ok
        ? data.answer
        : 'Сейчас не получилось получить ответ. Попробуйте ещё раз через минуту или перейдите к короткому интервью ниже.';
      conversationHistory.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      conversationHistory = conversationHistory.slice(-8);
      return agentTextMessage(answer);
    })
    .catch(() => agentMessage('Не получилось связаться с сервером. Проверьте подключение и попробуйте снова.'))
    .finally(() => showAgentComposer());
}

function startAgent() {
  chat.innerHTML = '';
  conversationHistory = [];
  progressWrap.style.display = 'none';
  clearInput();
  agentMessage('<strong>Я — ЗемляБот, помощник Земельного Штурмана.</strong><br>Помогу начать путь к земле с нуля: уточню цель и регион, создам одно земельное дело, выберу реалистичный маршрут и буду вести вас по одному шагу — от поиска до подачи документов.')
    .then(() => agentMessage('<span class="agent-base-note">Если после подачи придёт отказ, не нужно начинать сначала: загрузите документ, и я помогу понять причину и следующий вариант действий.</span>'))
    .then(() => hasCase() ? renderCaseCard() : Promise.resolve())
    .then(showAgentComposer);
  notifyDueReminders(true);
}

setInterval(() => notifyDueReminders(false), 60000);

// ===== ПОКАЗАТЬ РЕЗУЛЬТАТ =====

// Число с пробелами между разрядами, ₽
function formatMoney(n) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

// Ставка, применимая к выбранной пользователем форме получения земли
function getApplicableRate(region, form) {
  if (form === 'аренда') {
    return { label: 'при выкупе после аренды', str: region.lease, percent: parseRatePercent(region.lease) };
  }
  return { label: 'при оформлении сразу в собственность', str: region.buyout, percent: parseRatePercent(region.buyout) };
}

// Калькулятор итоговой цены выкупа: кадастровый номер (автопоиск, best-effort через
// /api/cadastre) или ручной ввод кадастровой стоимости × ставка региона.
// Автопоиск может не сработать (НСПД блокирует часть запросов с зарубежных серверов) —
// в этом случае просто предлагаем вписать стоимость вручную, калькулятор работает и без него.
function renderCadastreCalculator(region, form) {
  return new Promise((resolve) => {
    const rate = getApplicableRate(region, form);

    const el = document.createElement('div');
    el.className = 'msg-agent';
    el.innerHTML = `
      <div class="agent-avatar">${AGENT_AVATAR_SVG}</div>
      <div class="bubble-agent">
        <div class="cadastre-calc">
          <div style="font-weight:600;margin-bottom:10px;">💰 Посчитать сумму выкупа</div>
        </div>
      </div>`;
    const calcWrap = el.querySelector('.cadastre-calc');

    const lookupRow = document.createElement('div');
    lookupRow.className = 'text-row';
    const numberInp = document.createElement('input');
    numberInp.className = 'text-input';
    numberInp.type = 'text';
    numberInp.placeholder = 'Кадастровый номер, напр. 50:11:0010101:100 (необязательно)';
    const lookupBtn = document.createElement('button');
    lookupBtn.className = 'send-btn';
    lookupBtn.textContent = 'Найти стоимость';
    lookupRow.appendChild(numberInp);
    lookupRow.appendChild(lookupBtn);

    const lookupStatus = document.createElement('div');
    lookupStatus.style.cssText = 'font-size:12px;opacity:.7;margin-top:6px;min-height:16px;';

    const valueRow = document.createElement('div');
    valueRow.className = 'text-row';
    valueRow.style.marginTop = '10px';
    const valueInp = document.createElement('input');
    valueInp.className = 'text-input';
    valueInp.type = 'text';
    valueInp.inputMode = 'numeric';
    valueInp.placeholder = 'Кадастровая стоимость участка, ₽';
    const calcBtn = document.createElement('button');
    calcBtn.className = 'send-btn';
    calcBtn.textContent = 'Посчитать';
    valueRow.appendChild(valueInp);
    valueRow.appendChild(calcBtn);

    const resultBox = document.createElement('div');
    resultBox.style.cssText = 'margin-top:10px;font-size:14px;line-height:1.5;';

    lookupBtn.onclick = () => {
      const number = numberInp.value.trim();
      if (!/^\d{2}:\d{2}:\d{6,7}:\d+$/.test(number)) {
        lookupStatus.textContent = 'Формат номера: XX:XX:XXXXXXX:XX — либо впишите стоимость вручную ниже';
        return;
      }
      lookupBtn.disabled = true;
      lookupStatus.textContent = 'Ищу...';
      fetch(`/api/cadastre?number=${encodeURIComponent(number)}`)
        .then(r => r.json().then(data => ({ ok: r.ok, data })))
        .then(({ ok, data }) => {
          lookupBtn.disabled = false;
          if (ok && data.cadCost) {
            valueInp.value = String(Math.round(data.cadCost));
            lookupStatus.textContent = `Найдено: ${formatMoney(data.cadCost)}`;
          } else {
            lookupStatus.textContent = 'Не удалось найти автоматически (реестр недоступен) — впишите стоимость вручную ниже';
          }
        })
        .catch(() => {
          lookupBtn.disabled = false;
          lookupStatus.textContent = 'Не удалось найти автоматически — впишите стоимость вручную ниже';
        });
    };

    calcBtn.onclick = () => {
      const raw = valueInp.value.replace(/[^\d.,]/g, '').replace(',', '.');
      const value = parseFloat(raw);
      if (!value || value <= 0) {
        resultBox.innerHTML = '<span style="opacity:.7">Впишите кадастровую стоимость числом</span>';
        return;
      }
      if (rate.percent !== null) {
        const total = value * rate.percent / 100;
        resultBox.innerHTML = `Ставка ${rate.label} в «${region.name}»: <strong>${rate.percent}%</strong><br>Итоговая цена выкупа: <strong>${formatMoney(total)}</strong>`;
      } else {
        resultBox.innerHTML = `В вашем регионе ставка задана формулой/диапазоном: <strong>${rate.str}</strong><br>Точную сумму так не посчитать — нужны дополнительные данные (например, ставка земельного налога на участок). Уточните точный расчёт в администрации.`;
      }
    };

    calcWrap.appendChild(lookupRow);
    calcWrap.appendChild(lookupStatus);
    calcWrap.appendChild(valueRow);
    calcWrap.appendChild(resultBox);

    chat.appendChild(el);
    scrollBottom();
    resolve();
  });
}

// «Кабинет решения» — сильный принцип аналитических сервисов: сначала собрать
// подтверждаемые данные, затем принимать решение. Штурман не выдаёт выдуманную
// рыночную цену: пользователь видит источники и сам вводит проверенные цифры.
function renderDecisionDesk(region) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'msg-agent';
    el.innerHTML = `
      <div class="agent-avatar">${AGENT_AVATAR_SVG}</div>
      <div class="bubble-agent decision-bubble">
        <section class="decision-desk">
          <div class="decision-kicker">Решение на фактах</div>
          <h3>Паспорт участка перед заявлением или торгами</h3>
          <p class="decision-lead">Штурман не обещает цену «на глаз». Сначала соберите подтверждаемые данные, затем посчитайте предел своей ставки.</p>
          <ol class="source-checklist">
            <li><span>01</span><div><strong>Границы, ВРИ и ограничения</strong><br>Проверьте кадастровый номер на НСПД.</div></li>
            <li><span>02</span><div><strong>Конкуренция и документы лота</strong><br>Откройте публикации и протоколы на ГИС Торги.</div></li>
            <li><span>03</span><div><strong>Реальная цена, а не цена объявления</strong><br>Сопоставьте сделки в кадастровом квартале с особенностями участка.</div></li>
          </ol>
          <div class="official-links" aria-label="Официальные источники проверки">
            <a href="https://nspd.gov.ru" target="_blank" rel="noopener noreferrer">Открыть НСПД</a>
            <a href="https://torgi.gov.ru" target="_blank" rel="noopener noreferrer">Открыть ГИС Торги</a>
            <a href="https://rosreestr.gov.ru" target="_blank" rel="noopener noreferrer">Открыть Росреестр</a>
          </div>
          <div class="bid-calculator">
            <div class="bid-title">Предел ставки на торгах</div>
            <p>Заполните цифры после проверки. Расчёт покажет сумму, выше которой сделка перестаёт соответствовать вашему плану.</p>
            <label>Ожидаемая цена продажи / ценность для вас, ₽
              <input class="bid-input" inputmode="numeric" data-bid-field="value" placeholder="Например, 1 100 000">
            </label>
            <label>Все расходы кроме ставки, ₽
              <input class="bid-input" inputmode="numeric" data-bid-field="costs" placeholder="Госпошлина, инженер, подключение, ремонт">
            </label>
            <label>Минимальная прибыль или резерв, ₽
              <input class="bid-input" inputmode="numeric" data-bid-field="reserve" placeholder="Сумма, которую нельзя съедать">
            </label>
            <button type="button" class="bid-calc-btn">Рассчитать предел</button>
            <div class="bid-result" aria-live="polite"></div>
          </div>
          <p class="decision-note">Расчёт — ориентир для дисциплины на торгах, а не оценка участка и не юридическое заключение. Перед подачей всё равно проверьте документы, ограничения и фактическое состояние участка.</p>
        </section>
      </div>`;

    const result = el.querySelector('.bid-result');
    const getNumber = (field) => {
      const input = el.querySelector(`[data-bid-field="${field}"]`);
      const raw = String(input.value || '').replace(/[^\d,]/g, '').replace(',', '.');
      return raw ? Number(raw) : null;
    };

    el.querySelector('.bid-calc-btn').addEventListener('click', () => {
      const value = getNumber('value');
      const costs = getNumber('costs');
      const reserve = getNumber('reserve');
      result.classList.remove('is-warning', 'is-ready');

      if (value === null || costs === null || reserve === null || value <= 0 || costs < 0 || reserve < 0) {
        result.textContent = 'Заполните все три поля числами: ценность участка, расходы и резерв.';
        result.classList.add('is-warning');
        return;
      }

      const maxBid = value - costs - reserve;
      if (maxBid <= 0) {
        result.textContent = 'При таких вводных ставка не должна быть положительной: проверьте цену, расходы или желаемый резерв.';
        result.classList.add('is-warning');
        return;
      }

      result.innerHTML = '';
      const label = document.createElement('span');
      label.textContent = 'Ваша предельная ставка';
      const amount = document.createElement('strong');
      amount.textContent = formatMoney(maxBid);
      const note = document.createElement('small');
      note.textContent = `Проверьте, что в расходах учтены все обязательные платежи. Регион: ${region ? region.name : 'не указан'}.`;
      result.append(label, amount, note);
      result.classList.add('is-ready');
    });

    chat.appendChild(el);
    scrollBottom();
    resolve();
  });
}

// Чек-лист того, что реально валит заявки на землю — не привязан к конкретной
// стратегии, поэтому показывается один раз в результате, а не дублируется
// в каждой из 11 карточек.
const DUE_DILIGENCE_ITEMS = [
  "Категория земель — для ИЖС нужны «земли населённых пунктов». Участок сельхозназначения не подойдёт под дом, даже если он свободен и найден на НСПД.",
  "ВРИ и ЗОУИТ — по ПЗЗ проверьте разрешённый вид использования и нет ли зоны с особыми условиями (охранная зона газопровода/ЛЭП, водоохранная, санитарная). Это самая частая причина отказа.",
  "Наложение с лесным фондом — сверьте участок с публичной лесной картой Рослесхоза. Расхождения между Росреестром и гослесреестром блокируют даже полностью законные участки.",
  "Доступ к участку — есть ли дорога или сервитут. Участок без подъезда почти невозможно освоить и застроить.",
  "Стоимость подключения коммуникаций — узнайте цену техприсоединения (свет, вода, газ) у сетевых компаний до подачи заявления. Иногда она выше стоимости самого участка.",
  "Обременения — перед торгами закажите выписку ЕГРН и убедитесь, что нет ареста, ипотеки или судебного спора.",
  "Срок освоения — по большинству бесплатных и льготных схем участок нужно начать осваивать в течение 3 лет (закон с 2025 года), иначе есть риск изъятия."
];

function renderDueDiligenceChecklist() {
  return new Promise((resolve) => {
    const itemsHtml = DUE_DILIGENCE_ITEMS.map((item, i) =>
          `<div class="step-item"><div class="step-num">${i + 1}</div><div>${item}</div></div>`
    ).join('');

    const el = document.createElement('div');
    el.className = 'msg-agent';
    el.innerHTML = `
      <div class="agent-avatar">${AGENT_AVATAR_SVG}</div>
      <div class="bubble-agent" style="padding:0; overflow:hidden; border-radius: 4px 16px 16px 16px;">
        <div class="strategy-card">
          <div class="tag">Проверка участка</div>
          <h3>Проверьте до подачи заявления</h3>
          ${itemsHtml}
        </div>
      </div>`;
    chat.appendChild(el);
    scrollBottom();
    resolve();
  });
}

// Чек-лист документов для подачи заявления — общий пакет для большинства
// из 11 стратегий (без-торгов и с торгами). Ссылки ведут на официальные
// государственные порталы, где документ готовится/заказывается.
const DOCUMENT_CHECKLIST_ITEMS = [
  {
    text: "Заявление о предварительном согласовании предоставления земельного участка (или о предоставлении, если участок уже стоит на кадастровом учёте).",
    linkLabel: "Госуслуги",
    linkUrl: "https://www.gosuslugi.ru"
  },
  {
    text: "Схема расположения земельного участка (СРЗУ) — готовится на публичной кадастровой карте, если участок ещё не сформирован.",
    linkLabel: "НСПД",
    linkUrl: "https://nspd.gov.ru"
  },
  {
    text: "Копия паспорта (документ, удостоверяющий личность) — прикладывается к заявлению."
  },
  {
    text: "Выписка из ЕГРН на участок (если уже стоит на кадастровом учёте) — подтверждает отсутствие правообладателя и обременений.",
    linkLabel: "Росреестр",
    linkUrl: "https://rosreestr.gov.ru"
  },
  {
    text: "Правоустанавливающие документы на дом на участке — нужны для стратегий, где право на землю следует из права на строение.",
    linkLabel: "Росреестр",
    linkUrl: "https://rosreestr.gov.ru"
  },
  {
    text: "Нотариальное согласие супруга на сделку — если участок оформляется в браке. Оформляется у любого нотариуса."
  },
  {
    text: "Подтверждение льготной категории (многодетная семья, ветеран, молодой специалист и т.п.) — если претендуете на льготную схему получения."
  },
  {
    text: "Нотариальная доверенность — если документы подаёт представитель, а не сам заявитель."
  }
];

function renderDocumentChecklist() {
  return new Promise((resolve) => {
    const itemsHtml = DOCUMENT_CHECKLIST_ITEMS.map((item, i) => `
      <div class="step-item">
        <div class="step-num">${i + 1}</div>
        <div>${item.text}${item.linkUrl ? ` <a href="${item.linkUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--ochre-light);white-space:nowrap;">Открыть ${item.linkLabel}</a>` : ''}</div>
      </div>`
    ).join('');

    const el = document.createElement('div');
    el.className = 'msg-agent';
    el.innerHTML = `
      <div class="agent-avatar">${AGENT_AVATAR_SVG}</div>
      <div class="bubble-agent" style="padding:0; overflow:hidden; border-radius: 4px 16px 16px 16px;">
        <div class="strategy-card">
          <div class="tag">Документы</div>
          <h3>Что понадобится для подачи</h3>
          ${itemsHtml}
        </div>
      </div>`;
    chat.appendChild(el);
    scrollBottom();
    resolve();
  });
}

function renderStrategyCards(strategies) {
  return new Promise(resolve => {
    strategies.forEach((s, idx) => {
      setTimeout(() => {
        const stepsHtml = s.steps.map((step, i) =>
          `<div class="step-item"><div class="step-num">${i + 1}</div><div>${step}</div></div>`
        ).join('');
        const hint = getStrategyHint(s, answers);
        const card = document.createElement('div');
        card.className = 'msg-agent';
        card.innerHTML = `
          <div class="agent-avatar">${s.id}</div>
          <div class="bubble-agent" style="padding:0; overflow:hidden; border-radius: 4px 16px 16px 16px;">
            <div class="strategy-card">
              <div class="tag">${s.tag}</div>
              <h3>${s.title}</h3>
              ${hint ? `<div class="strategy-hint">${hint}</div>` : ''}
              <p class="desc">${s.desc}</p>
              <div class="steps-title">Действуйте по порядку</div>
              ${stepsHtml}
              ${officialLinksFor(s.steps.join(' '), 'official-links strategy-official-links')}
              ${s.warning ? `<div class="strategy-warning">${s.warning}</div>` : ''}
            </div>
          </div>`;
        chat.appendChild(card);
        scrollBottom();
      }, idx * 350);
    });
    setTimeout(resolve, strategies.length * 350 + 120);
  });
}

function showResult(strategies) {
  clearInput();
  progressWrap.style.display = 'none';

  const explanation = explainChoice(strategies, answers);
  const primary = strategies[0];
  const region = answers.region_ru ? findRegion(answers.region_ru) : null;
  const regionName = region ? region.name : (answers.region === 'far_east' ? 'Дальний Восток или Арктика' : 'Регион уточняется');

  if (!primary) {
    return agentMessage('По этим ответам я не могу безопасно выбрать маршрут. Уточните регион и цель — тогда начнём заново без лишних действий.')
      .then(showAgentComposer);
  }

  // Не выдаём человеку все чек-листы и альтернативы одновременно. Сохраняем один
  // основной маршрут, чтобы при следующем входе он продолжил дело с нужного шага.
  saveRoute(primary, 0, {
    goal: answers.goal || activeCase.goal,
    region: regionName,
    regionCode: answers.region_ru || activeCase.regionCode || '',
    nextDate: activeCase.nextDate || ''
  });

  agentMessage(`<strong>Я открыла ваше земельное дело.</strong><br>${explanation}`)
    .then(() => agentMessage(`Основной маршрут: <strong>${primary.title}</strong>. Сейчас не буду перегружать вас альтернативами и документами — сначала пройдём первый проверяемый шаг.`))
    .then(() => strategies.length > 1
      ? agentMessage(`<span class="agent-base-note">Есть ещё один запасной вариант: «${strategies[1].title}». Вернёмся к нему, только если основной путь не подойдёт.</span>`)
      : Promise.resolve())
    .then(() => agentMessage('Перед первым поиском настроим место: радиус, площадь, приоритеты и муниципалитет. Это поможет не начинать с карты вслепую.'))
    .then(openSearchProfile);
}

function showFinalActions() {
  inputArea.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'options-grid';

  // Кнопка "начать сначала"
  const restartBtn = document.createElement('button');
  restartBtn.className = 'option-btn';
  restartBtn.textContent = 'Начать заново';
  restartBtn.onclick = () => { startRouter(); };
  grid.appendChild(restartBtn);

  // Текстовый ввод вопроса
  const row = document.createElement('div');
  row.className = 'text-row';
  row.style.marginTop = '10px';
  row.style.width = '100%';

  const inp = document.createElement('input');
  inp.className = 'text-input';
  inp.placeholder = 'Задайте вопрос по земле...';
  inp.type = 'text';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'send-btn';
  sendBtn.textContent = 'Отправить';

  const handleSend = () => {
    const q = inp.value.trim();
    if (!q) return;
    userMessage(q);
    inp.value = '';
    sendBtn.disabled = true;

    fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q })
    })
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        const answer = ok
          ? data.answer
          : 'Не получилось получить ответ прямо сейчас. Попробуйте ещё раз чуть позже или посмотрите предложенный маршрут выше.';
        return agentTextMessage(answer);
      })
      .catch(() => agentMessage('Не получилось связаться с сервером. Проверьте подключение и попробуйте снова.'))
      .finally(() => { sendBtn.disabled = false; });
  };

  sendBtn.onclick = handleSend;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') handleSend(); });

  row.appendChild(inp);
  row.appendChild(sendBtn);

  inputArea.appendChild(grid);
  inputArea.appendChild(row);
}

// ===== РОУТЕР ВОПРОСОВ =====

// Вопрос пропускается, если для текущих ответов не имеет смысла
// (например, выбор конкретного региона не нужен для программы ДВ-гектар)
function isSkipped(q) {
  return !!(q && typeof q.skipIf === 'function' && q.skipIf(answers));
}

function askQuestion(index) {
  while (index < QUESTIONS.length && isSkipped(QUESTIONS[index])) index++;

  currentQuestionIndex = index; // запоминаем где находимся

  if (index >= QUESTIONS.length) {
    const strategies = pickStrategies(answers);
    showResult(strategies);
    return;
  }

  const q = QUESTIONS[index];
  updateProgress(index + 1, QUESTIONS.length);

  agentMessage(
    `<strong>${q.text}</strong>${q.hint ? `<br><span style="font-size:13px;opacity:.7;margin-top:4px;display:block">${q.hint}</span>` : ''}`
  ).then(() => {
    const onChoose = (chosen) => {
      answers[q.id] = chosen.value;
      userMessage(chosen.label);
      clearInput();
      setTimeout(() => askQuestion(index + 1), 400);
    };

    if (q.type === 'select') {
      showSearchSelect(q, onChoose, index);
    } else {
      showOptions(q.options, onChoose, index);
    }
  });
}

function startRouter() {
  // Сброс состояния
  chat.innerHTML = '';
  currentQuestion = 0;
  Object.keys(answers).forEach(k => delete answers[k]);
  conversationHistory = [];
  progressWrap.style.display = 'none';
  clearInput();

  // Приветственное сообщение
  agentMessage('<strong>Откроем новое земельное дело.</strong><br>Я задам шесть коротких вопросов, чтобы не отправить вас по неподходящему пути.')
  .then(() => agentMessage('После этого сохраню один основной маршрут и покажу только первый шаг. Остальные шаги будут открываться по мере движения. Это займёт около двух минут.'))
  .then(() => {
    setTimeout(() => askQuestion(0), 300);
  });
}

// ===== ЗАПУСК =====
// Вход устроен как личный кабинет: создание и ведение дела происходят на
// главном экране, а диалог с ЗемляБотом открывается только по необходимости.
const landing = document.getElementById('landing');
const appRoot = document.querySelector('.app');
const dashboard = document.getElementById('dashboard');
const cabinetHome = document.getElementById('cabinet-home');
const caseWorkspace = document.getElementById('case-workspace');
const cabinetListScreen = document.getElementById('cabinet-list-screen');
const caseSetupContent = document.getElementById('case-setup-content');
let workspaceCaseId = '';

function hideCabinetScreens() {
  cabinetHome.hidden = true;
  caseWorkspace.hidden = true;
  cabinetListScreen.hidden = true;
}

function setDashboardNav(page) {
  document.querySelectorAll('.dashboard-nav-btn').forEach(button => {
    button.classList.toggle('is-active', button.dataset.dashboardPage === page);
  });
}

function showDashboard(page = 'home') {
  appRoot.classList.remove('visible', 'agent-room-open');
  dashboard.classList.add('visible');
  hideCabinetScreens();
  setDashboardNav(page);
  if (page === 'home') {
    cabinetHome.hidden = false;
    renderCabinetHome();
  }
  if (page === 'cases') renderCabinetList('cases');
  if (page === 'auctions') renderCabinetList('auctions');
}

function openLandBot() {
  dashboard.classList.remove('visible');
  appRoot.classList.add('visible', 'agent-room-open');
  startAgent();
}

function closeLandBot() {
  appRoot.classList.remove('visible', 'agent-room-open');
  showDashboard('home');
}

function casePrioritiesLabel(item) {
  const values = casePriorities(item);
  return values.length ? values.slice(0, 3).join(' · ') : 'Критерии ещё не заданы';
}

function renderCabinetHome() {
  const box = document.getElementById('cabinet-current-case');
  box.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'cabinet-card-label';
  label.textContent = 'ТЕКУЩЕЕ ДЕЛО';
  const title = document.createElement('h3');
  const description = document.createElement('p');
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'cabinet-secondary-btn';
  if (hasCase()) {
    title.textContent = caseTitle(activeCase);
    description.textContent = [activeCase.region, activeCase.plotSize, casePrioritiesLabel(activeCase)].filter(Boolean).join(' · ');
    action.textContent = 'Открыть дело';
    action.addEventListener('click', () => openCaseWorkspace(activeCase.id));
  } else {
    title.textContent = 'Пока нет земельного дела';
    description.textContent = 'Создайте первое дело: оно сохранит цель, регион и критерии поиска в одном месте.';
    action.textContent = 'Создать первое дело';
    action.addEventListener('click', () => openCaseWorkspace());
  }
  box.append(label, title, description, action);
}

function renderCabinetList(type) {
  hideCabinetScreens();
  cabinetListScreen.hidden = false;
  cabinetListScreen.innerHTML = '';
  const title = document.createElement('h2');
  const lead = document.createElement('p');
  const list = document.createElement('div');
  list.className = 'cabinet-record-list';
  if (type === 'cases') {
    title.textContent = 'Мои земельные дела';
    lead.textContent = 'Каждое дело хранит свои критерии, маршрут и результаты проверок.';
    if (!cases.length) {
      const empty = document.createElement('div');
      empty.className = 'cabinet-empty';
      empty.textContent = 'Пока нет дел. Создайте первое — и Штурман не потеряет ваш контекст.';
      list.appendChild(empty);
    } else {
      cases.slice().reverse().forEach(item => {
        const card = document.createElement('article');
        card.className = 'cabinet-record';
        const heading = document.createElement('strong'); heading.textContent = caseTitle(item);
        const meta = document.createElement('span'); meta.textContent = [item.region, item.plotSize, casePrioritiesLabel(item)].filter(Boolean).join(' · ');
        const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Открыть дело';
        open.addEventListener('click', () => openCaseWorkspace(item.id));
        card.append(heading, meta, open); list.appendChild(card);
      });
    }
  } else {
    title.textContent = 'Торги';
    lead.textContent = 'Здесь будут сохранённые лоты, их риски и ваш личный предел ставки.';
    if (!auctionLots.length) {
      const empty = document.createElement('div');
      empty.className = 'cabinet-empty';
      empty.textContent = 'Пока нет добавленных лотов. Откройте ЗемляБот, когда понадобится разобрать конкретные торги.';
      list.appendChild(empty);
    } else {
      auctionLots.slice().reverse().forEach(lot => {
        const card = document.createElement('article');
        card.className = 'cabinet-record';
        const heading = document.createElement('strong'); heading.textContent = lot.title || 'Лот на торгах';
        const meta = document.createElement('span'); meta.textContent = [lot.status, lot.deadline].filter(Boolean).join(' · ');
        card.append(heading, meta); list.appendChild(card);
      });
    }
  }
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'back-to-cabinet'; back.textContent = '← Вернуться в обзор';
  back.addEventListener('click', () => showDashboard('home'));
  cabinetListScreen.append(title, lead, list, back);
}

function openCaseWorkspace(id = '') {
  workspaceCaseId = id;
  hideCabinetScreens();
  caseWorkspace.hidden = false;
  setDashboardNav('cases');
  renderCaseSetup(id ? cases.find(item => item.id === id) : null);
}

function renderCaseSetup(record) {
  const draft = { ...emptyCase(), ...(record || {}) };
  caseSetupContent.innerHTML = '';
  const title = document.createElement('h1');
  title.textContent = record ? 'Настройте земельное дело' : 'Создайте земельное дело';
  const lead = document.createElement('p');
  lead.className = 'case-setup-lead';
  lead.textContent = 'Сначала задайте цель и рамки поиска. Это основа дела; к ЗемляБоту перейдём, когда потребуется разбор вопроса или документа.';
  const form = document.createElement('form');
  form.className = 'case-setup-form';
  const addSection = (headingText, noteText) => {
    const section = document.createElement('section');
    section.className = 'case-setup-section';
    const heading = document.createElement('h2'); heading.textContent = headingText;
    const note = document.createElement('p'); note.textContent = noteText;
    section.append(heading, note); form.appendChild(section);
    return section;
  };

  const basics = addSection('1. Цель и направление', 'Выберите понятный вариант. Штурман подскажет, что потом проверить по ПЗЗ.');
  const goalGrid = document.createElement('div'); goalGrid.className = 'case-goal-grid';
  const goals = [
    ['home', 'Дом для жизни', 'ИЖС', 'Дом для проживания', 'ИЖС'],
    ['dacha', 'Дача или сад', 'Ведение садоводства', 'Дача / сад', 'Ведение садоводства'],
    ['lph', 'Личное хозяйство', 'ЛПХ на приусадебном участке', 'Личное подсобное хозяйство', 'ЛПХ на приусадебном участке'],
    ['garden', 'Огород', 'Ведение огородничества', 'Огородничество', 'Ведение огородничества'],
    ['farm', 'Сено или выпас', 'Сельскохозяйственное использование', 'Сенокошение / выпас', 'Сенокошение или выпас'],
    ['business', 'Дело или сервис', 'Точный ВРИ проверим по ПЗЗ', 'Коммерческое использование', 'Уточнить по ПЗЗ']
  ];
  const savedPreset = draft.goalPreset || goals.find(goal => goal[4] === draft.vri || goal[3] === draft.goal)?.[0] || (/сад|дач/i.test(draft.goal || '') ? 'dacha' : '');
  const goalInputs = [];
  goals.forEach(([idValue, name, note, goal, vri]) => {
    const label = document.createElement('label'); label.className = 'case-goal-choice';
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'case-goal'; input.value = idValue; input.required = true; input.checked = idValue === savedPreset;
    const nameNode = document.createElement('strong'); nameNode.textContent = name;
    const noteNode = document.createElement('span'); noteNode.textContent = note;
    label.append(input, nameNode, noteNode); goalInputs.push({ input, label, goal, vri, idValue }); goalGrid.appendChild(label);
  });
  const refreshGoals = () => goalInputs.forEach(item => item.label.classList.toggle('is-selected', item.input.checked));
  goalInputs.forEach(item => item.input.addEventListener('change', refreshGoals));
  refreshGoals(); basics.appendChild(goalGrid);

  const regionLabel = document.createElement('label'); regionLabel.className = 'case-setup-field'; regionLabel.textContent = 'Регион';
  const region = document.createElement('select'); region.className = 'tool-select'; region.required = true;
  const blankRegion = document.createElement('option'); blankRegion.value = ''; blankRegion.textContent = 'Выберите регион'; region.appendChild(blankRegion);
  REGIONS.forEach(item => {
    const option = document.createElement('option'); option.value = item.id; option.textContent = item.name;
    option.selected = item.id === (draft.regionCode || REGIONS.find(regionItem => regionItem.name === draft.region)?.id); region.appendChild(option);
  });
  regionLabel.appendChild(region); basics.appendChild(regionLabel);

  const strategyLabel = document.createElement('label'); strategyLabel.className = 'case-setup-field'; strategyLabel.textContent = 'Предварительный путь';
  const strategy = document.createElement('select'); strategy.className = 'tool-select';
  [['', 'Пока не знаю — Штурман поможет выбрать'], ['1', 'Сразу в собственность без торгов'], ['2', 'Аренда без торгов с возможным выкупом'], ['3', 'Аренда при зарегистрированном доме'], ['4', 'Уже арендованный участок: выкуп или долгий срок'], ['5', 'Сенокошение или выпас'], ['6', 'Безвозмездное пользование для специалиста'], ['7', 'Дальневосточный / Арктический гектар'], ['8', 'Прирезка к своему участку'], ['9', 'Торги: собственность'], ['10', 'Торги: аренда'], ['11', 'Торги по банкротству']].forEach(([value, text]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = text; option.selected = value === String(draft.strategyPreference || ''); strategy.appendChild(option);
  });
  strategyLabel.appendChild(strategy); basics.appendChild(strategyLabel);

  const location = addSection('2. Где и что искать', 'Эти ответы станут фильтрами для поиска и проверки участка.');
  const fieldRow = document.createElement('div'); fieldRow.className = 'case-setup-row';
  const textField = (labelText, type, value, placeholder, min, max) => {
    const label = document.createElement('label'); label.className = 'case-setup-field'; label.textContent = labelText;
    const input = document.createElement('input'); input.type = type; input.value = value || ''; input.placeholder = placeholder;
    if (min) input.min = min; if (max) input.max = max; label.appendChild(input); return { label, input };
  };
  const centerField = textField('Город или точка отсчёта', 'text', draft.searchCenter, 'Например: Саратов');
  const radiusField = textField('Радиус поиска, км', 'number', draft.searchRadius, 'Например: 60', '1', '300');
  fieldRow.append(centerField.label, radiusField.label); location.appendChild(fieldRow);
  const sizeLabel = document.createElement('div'); sizeLabel.className = 'case-setup-label'; sizeLabel.textContent = 'Площадь';
  const sizeGrid = document.createElement('div'); sizeGrid.className = 'case-size-grid';
  const sizeInputs = [];
  ['до 4 соток', '4–6 соток', '6–8 соток', '8–10 соток', '10–12 соток', '12–15 соток'].forEach(value => {
    const label = document.createElement('label'); label.className = 'case-size-choice';
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'case-size'; input.value = value; input.checked = draft.plotSize === value;
    const span = document.createElement('span'); span.textContent = value; label.append(input, span); sizeInputs.push({ input, label }); sizeGrid.appendChild(label);
  });
  const refreshSizes = () => sizeInputs.forEach(item => item.label.classList.toggle('is-selected', item.input.checked));
  sizeInputs.forEach(item => item.input.addEventListener('change', refreshSizes)); refreshSizes();
  location.append(sizeLabel, sizeGrid);

  const prioritySection = addSection('3. Что для вас важно', 'Отметьте всё, что Штурман должен учитывать в первую очередь.');
  const priorityGrid = document.createElement('div'); priorityGrid.className = 'case-priority-grid';
  const oldPriorities = casePriorities(draft);
  const priorityInputs = [];
  ['Электричество с подтверждённой возможностью подключения', 'Близость к городу', 'Круглогодичный подъезд', 'Вода', 'Газ', 'Тишина / природа', 'Минимальные расходы'].forEach(value => {
    const label = document.createElement('label'); label.className = 'case-priority-choice';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = value; input.checked = oldPriorities.includes(value);
    const span = document.createElement('span'); span.textContent = value; label.append(input, span); priorityInputs.push(input); priorityGrid.appendChild(label);
  });
  const travelLabel = document.createElement('label'); travelLabel.className = 'case-setup-field'; travelLabel.textContent = 'Предел времени в дороге';
  const travel = document.createElement('select'); travel.className = 'tool-select';
  [['', 'Не учитывать'], ['30', 'До 30 минут'], ['45', 'До 45 минут'], ['60', 'До 60 минут'], ['90', 'До 90 минут'], ['120', 'До 120 минут']].forEach(([value, text]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = text; option.selected = value === String(draft.travelTime || ''); travel.appendChild(option);
  });
  travelLabel.appendChild(travel); prioritySection.append(priorityGrid, travelLabel);

  const municipalitySection = addSection('4. Муниципалитет', 'Можно выбрать из доступного справочника или вписать свой. Это направление первой проверки, а не обещание выдачи земли.');
  const municipalityLabel = document.createElement('label'); municipalityLabel.className = 'case-setup-field'; municipalityLabel.textContent = 'Муниципалитет из списка';
  const municipality = document.createElement('select'); municipality.className = 'tool-select'; municipalityLabel.appendChild(municipality);
  const manualMunicipality = textField('Или укажите вручную', 'text', draft.municipality, 'Например: Энгельсский район').input;
  const manualLabel = manualMunicipality.parentElement;
  const authorityField = textField('Администрация / орган (необязательно)', 'text', draft.authorityName, 'Например: Комитет по имуществу').input;
  const authorityLabel = authorityField.parentElement;
  municipalitySection.append(municipalityLabel, manualLabel, authorityLabel);
  const renderMunicipalities = () => {
    municipality.innerHTML = '';
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Выберите из списка или укажите вручную'; municipality.appendChild(empty);
    const directory = MUNICIPALITY_DIRECTORY[region.value];
    if (!directory) return;
    directory.entries.forEach(entry => {
      const option = document.createElement('option'); option.value = entry.name; option.textContent = entry.name; option.selected = !manualMunicipality.value && entry.name === draft.municipality; municipality.appendChild(option);
    });
  };
  municipality.addEventListener('change', () => {
    const entry = MUNICIPALITY_DIRECTORY[region.value]?.entries.find(item => item.name === municipality.value);
    if (entry) { manualMunicipality.value = ''; authorityField.value = entry.authority; }
  });
  region.addEventListener('change', renderMunicipalities); renderMunicipalities();

  const futureField = textField('План на будущее (необязательно)', 'text', draft.futurePlan, 'Например: арендовать, построить дом и рассмотреть выкуп');
  form.appendChild(futureField.label);
  const actions = document.createElement('div'); actions.className = 'case-setup-actions';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'cabinet-primary-btn'; save.textContent = 'Сохранить земельное дело';
  const askBot = document.createElement('button'); askBot.type = 'button'; askBot.className = 'cabinet-secondary-btn'; askBot.textContent = 'Есть вопрос — спросить ЗемляБота';
  askBot.addEventListener('click', openLandBot);
  actions.append(save, askBot); form.appendChild(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const goal = goalInputs.find(item => item.input.checked);
    if (!goal) { goalInputs[0].input.focus(); return; }
    const selectedPriorities = priorityInputs.filter(input => input.checked).map(input => input.value);
    if (travel.value) selectedPriorities.push('Время в дороге: до ' + travel.value + ' минут');
    const selectedRegion = findRegion(region.value);
    const caseId = record?.id || createLocalId('case');
    saveCase({
      ...draft, id: caseId, caseName: draft.caseName || goal.goal,
      goalPreset: goal.idValue, goal: goal.goal, vri: goal.vri, strategyPreference: strategy.value,
      regionCode: region.value, region: selectedRegion?.name || '', searchCenter: centerField.input.value.trim(),
      searchRadius: radiusField.input.value.trim(), plotSize: sizeInputs.find(item => item.input.checked)?.input.value || '',
      priorities: selectedPriorities, priorityOne: selectedPriorities[0] || '', priorityTwo: selectedPriorities[1] || '',
      travelTime: travel.value, travelTimePriority: Boolean(travel.value),
      allSeasonRoad: selectedPriorities.includes('Круглогодичный подъезд'), municipality: manualMunicipality.value.trim() || municipality.value,
      authorityName: authorityField.value.trim(), futurePlan: futureField.input.value.trim()
    });
    showDashboard('home');
  });
  caseSetupContent.append(title, lead, form);
}

document.getElementById('landing-start').addEventListener('click', () => {
  landing.classList.add('landing-hide');
  setTimeout(() => {
    landing.style.display = 'none';
    showDashboard('home');
  }, 300);
});

document.getElementById('portfolio-button').addEventListener('click', openPortfolio);
document.getElementById('bot-back').addEventListener('click', closeLandBot);
document.getElementById('open-land-bot').addEventListener('click', openLandBot);
document.getElementById('dashboard-open-bot').addEventListener('click', openLandBot);
document.getElementById('dashboard-new-case').addEventListener('click', () => openCaseWorkspace());
document.getElementById('dashboard-open-cases').addEventListener('click', () => showDashboard('cases'));
document.getElementById('dashboard-open-auctions').addEventListener('click', () => showDashboard('auctions'));
document.getElementById('back-to-cabinet').addEventListener('click', () => showDashboard('home'));
document.getElementById('dashboard-home-link').addEventListener('click', event => { event.preventDefault(); showDashboard('home'); });
document.querySelectorAll('.dashboard-nav-btn').forEach(button => {
  button.addEventListener('click', () => showDashboard(button.dataset.dashboardPage));
});
