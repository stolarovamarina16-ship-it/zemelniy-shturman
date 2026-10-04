// ===== ЗЕМЕЛЬНЫЙ ШТУРМАН — ГЛАВНЫЙ МОДУЛЬ =====

const chat      = document.getElementById('chat');
const inputArea = document.getElementById('input-area');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');

let currentQuestion = 0;
let currentQuestionIndex = 0; // отслеживаем номер текущего вопроса для кнопки «Назад»
const answers = {};

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
  const safeHtml = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
  return agentMessage(safeHtml, delay);
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
  const regionNote = getRegionRateNote(answers);
  const region = answers.region_ru ? findRegion(answers.region_ru) : null;

  agentMessage(`Я подобрал маршрут по вашим ответам. ${explanation}`).then(() => {
    return regionNote ? agentMessage(regionNote) : Promise.resolve();
  }).then(() => {
    return renderStrategyCards(strategies);
  }).then(() => {
    return renderDueDiligenceChecklist();
  }).then(() => {
    return renderDocumentChecklist();
  }).then(() => {
    return region ? renderCadastreCalculator(region, answers.form) : Promise.resolve();
  }).then(() => {
    return agentMessage('Нужна помощь с конкретным шагом? Напишите вопрос или начните подбор заново.');
  }).then(() => {
    showFinalActions();
  });
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
  progressWrap.style.display = 'none';
  clearInput();

  // Приветственное сообщение
  agentMessage('Привет! Я <strong>Земельный Штурман</strong>. Помогу разобраться, как получить землю от государства в вашей ситуации.')
  .then(() => agentMessage('Задам несколько коротких вопросов и покажу подходящий порядок действий. Это займёт около двух минут.'))
  .then(() => {
    setTimeout(() => askQuestion(0), 300);
  });
}

// ===== ЗАПУСК =====
// Роутер стартует по кнопке «Начать» на лендинге, не сразу при загрузке страницы
const landing = document.getElementById('landing');
const appRoot = document.querySelector('.app');

document.getElementById('landing-start').addEventListener('click', () => {
  landing.classList.add('landing-hide');
  setTimeout(() => {
    landing.style.display = 'none';
    appRoot.classList.add('visible');
    startRouter();
  }, 300);
});
