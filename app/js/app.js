// ===== ЗЕМЕЛЬНЫЙ ШТУРМАН — ГЛАВНЫЙ МОДУЛЬ =====

const chat      = document.getElementById('chat');
const inputArea = document.getElementById('input-area');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');

let currentQuestion = 0;
const answers = {};

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
      <div class="agent-avatar">🗺️</div>
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
        <div class="agent-avatar">🗺️</div>
        <div class="bubble-agent">${html}</div>`;
      chat.appendChild(el);
      scrollBottom();
      resolve();
    }, 700 + delay);
  });
}

// Добавить сообщение пользователя
function userMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg-user';
  el.innerHTML = `<div class="bubble-user">${text}</div>`;
  chat.appendChild(el);
  scrollBottom();
}

// Показать кнопки-варианты
function showOptions(options, onChoose) {
  inputArea.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'options-grid';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = opt.label;
    btn.onclick = () => {
      // Блокируем все кнопки
      grid.querySelectorAll('button').forEach(b => b.disabled = true);
      onChoose(opt);
    };
    grid.appendChild(btn);
  });
  inputArea.appendChild(grid);
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

function showResult(strategies) {
  clearInput();
  progressWrap.style.display = 'none';

  const explanation = explainChoice(strategies, answers);

  // Сообщение с объяснением
  agentMessage(`Отлично! Я проанализировал ваши ответы. ${explanation}`).then(() => {

    strategies.forEach((s, idx) => {
      setTimeout(() => {
        const stepsHtml = s.steps.map((step, i) =>
          `<div class="step-item"><div class="step-num">${i+1}</div><div>${step}</div></div>`
        ).join('');

        const hint = getStrategyHint(s, answers);

        const card = document.createElement('div');
        card.className = 'msg-agent';
        card.innerHTML = `
          <div class="agent-avatar">${s.emoji}</div>
          <div class="bubble-agent" style="padding:0; overflow:hidden; border-radius: 4px 16px 16px 16px;">
            <div class="strategy-card">
              <div class="tag">${s.tag}</div>
              <h3>${s.title}</h3>
              ${hint ? `<div style="margin-bottom:12px;padding:10px 12px;background:rgba(255,255,255,.15);border-radius:8px;font-size:13px;line-height:1.5;">${hint}</div>` : ''}
              <p class="desc">${s.desc}</p>
              <div class="steps-title">Первые шаги:</div>
              ${stepsHtml}
              ${s.warning ? `<div style="margin-top:12px;padding:10px 12px;background:rgba(255,255,255,.12);border-radius:8px;font-size:13px;opacity:.9;">⚠️ ${s.warning}</div>` : ''}
            </div>
          </div>`;
        chat.appendChild(card);
        scrollBottom();
      }, idx * 400);
    });

    // Кнопка "начать сначала" и "задать вопрос"
    setTimeout(() => {
      agentMessage('Хотите узнать подробнее о любом шаге? Задайте вопрос — или начните сначала, чтобы выбрать другую стратегию.').then(() => {
        showFinalActions();
      });
    }, strategies.length * 400 + 300);
  });
}

function showFinalActions() {
  inputArea.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'options-grid';

  // Кнопка "начать сначала"
  const restartBtn = document.createElement('button');
  restartBtn.className = 'option-btn';
  restartBtn.textContent = '🔄 Начать сначала';
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
    // Заглушка — позже подключим Claude API
    agentMessage('Я принял ваш вопрос. Функция ответов через AI будет добавлена на следующем шаге. Пока используйте роутер стратегий выше 👆');
  };

  sendBtn.onclick = handleSend;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') handleSend(); });

  row.appendChild(inp);
  row.appendChild(sendBtn);

  inputArea.appendChild(grid);
  inputArea.appendChild(row);
}

// ===== РОУТЕР ВОПРОСОВ =====

function askQuestion(index) {
  if (index >= QUESTIONS.length) {
    // Все вопросы заданы — подбираем стратегию
    const strategies = pickStrategies(answers);
    showResult(strategies);
    return;
  }

  const q = QUESTIONS[index];
  updateProgress(index + 1, QUESTIONS.length);

  agentMessage(
    `<strong>${q.text}</strong>${q.hint ? `<br><span style="font-size:13px;opacity:.7;margin-top:4px;display:block">${q.hint}</span>` : ''}`
  ).then(() => {
    showOptions(q.options, (chosen) => {
      answers[q.id] = chosen.value;
      userMessage(chosen.label);
      clearInput();
      setTimeout(() => askQuestion(index + 1), 400);
    });
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
  agentMessage('Привет! Я <strong>Земельный Штурман</strong> — помогу разобраться, как получить землю от государства по вашей ситуации. 🗺️')
  .then(() => agentMessage('Задам вам 5 коротких вопросов и подберу подходящую стратегию из 11 возможных. Это займёт около 2 минут.'))
  .then(() => {
    setTimeout(() => askQuestion(0), 300);
  });
}

// ===== ЗАПУСК =====
startRouter();
