// ===== ЛОГИКА РОУТЕРА =====
// 5 вопросов → одна или две подходящие стратегии

const QUESTIONS = [
  {
    id: "region",
    text: "Где хотите получить землю? 🌍",
    hint: "От этого зависит, какие программы вам доступны",
    options: [
      { label: "🗾 Дальний Восток или Арктика", value: "far_east" },
      { label: "🏙️ Другой регион России",       value: "other"    }
    ]
  },
  {
    id: "goal",
    text: "Что планируете делать с землёй? 🎯",
    hint: "Это определяет вид разрешённого использования (ВРИ)",
    options: [
      { label: "🏡 Построить дом (ИЖС)",         value: "ИЖС"     },
      { label: "🌱 Вести хозяйство (ЛПХ)",        value: "ЛПХ"     },
      { label: "🌻 Садоводство / дача",            value: "Садоводство" },
      { label: "💼 Для бизнеса",                   value: "Бизнес"  }
    ]
  },
  {
    id: "form",
    text: "Что предпочитаете — аренда или сразу в собственность? 📋",
    hint: "Аренда дешевле на старте, собственность — надёжнее",
    options: [
      { label: "🔑 Хочу сразу в собственность", value: "собственность" },
      { label: "📄 Начну с аренды",              value: "аренда"        },
      { label: "🤷 Не знаю, что лучше",          value: "любое"         }
    ]
  },
  {
    id: "adjacent",
    text: "Есть ли у вас уже участок рядом с тем, который хотите получить? 📐",
    hint: "Если есть смежный участок — можно 'прирезать' соседнюю землю дёшево",
    options: [
      { label: "✅ Да, есть смежный участок", value: "yes" },
      { label: "❌ Нет",                       value: "no"  }
    ]
  },
  {
    id: "auctions",
    text: "Готовы ли участвовать в аукционе? 🏆",
    hint: "Торги — это конкуренция, но часто единственный путь для конкретного участка",
    options: [
      { label: "✅ Готов участвовать в торгах", value: "yes" },
      { label: "❌ Хочу без торгов",             value: "no"  },
      { label: "🤷 Зависит от ситуации",         value: "maybe" }
    ]
  }
];

// ===== АЛГОРИТМ ПОДБОРА СТРАТЕГИИ =====
function pickStrategies(answers) {
  const { region, goal, form, adjacent, auctions } = answers;
  const result = [];

  // --- Дальний Восток/Арктика → всегда Стратегия 7 ---
  if (region === "far_east") {
    return [STRATEGIES[7]];
  }

  // --- Прирезка → Стратегия 8 (если есть смежный участок) ---
  if (adjacent === "yes") {
    result.push(STRATEGIES[8]);
    // Если не хочет только прирезку — добавим ещё
  }

  // --- Через торги ---
  if (auctions === "yes" || auctions === "maybe") {
    if (form === "собственность" || form === "любое") {
      result.push(STRATEGIES[9]); // торги в собственность
    }
    if (form === "аренда" || form === "любое") {
      result.push(STRATEGIES[10]); // торги в аренду
    }
  }

  // --- Без торгов ---
  if (auctions === "no" || auctions === "maybe") {
    if (form === "собственность") {
      result.push(STRATEGIES[1]); // без торгов в собственность
    }

    if (form === "аренда" || form === "любое") {
      result.push(STRATEGIES[2]); // без торгов в аренду
    }

    // Безвозмездное / специальные
    if (goal === "ЛПХ" || goal === "ИЖС") {
      if (form !== "собственность") {
        result.push(STRATEGIES[6]); // безвозмездное 6 лет (если льготная категория)
      }
    }
  }

  // Убрать дубли по id
  const seen = new Set();
  const unique = result.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  // Ограничить до 2 рекомендаций
  return unique.slice(0, 2);
}

// ===== ОБЪЯСНЕНИЕ ВЫБОРА =====
function explainChoice(strategies, answers) {
  if (answers.region === "far_east") {
    return "Для Дальнего Востока и Арктики действует специальная программа — вы можете получить 1 гектар бесплатно без торгов и без платы за аренду.";
  }

  const names = strategies.map(s => `«${s.title}»`).join(" или ");
  const parts = [];

  if (answers.form === "собственность") {
    parts.push("вы хотите землю в собственность");
  } else if (answers.form === "аренда") {
    parts.push("начать с аренды — разумно, это снижает первоначальные расходы");
  }

  if (answers.auctions === "no") {
    parts.push("без участия в торгах");
  } else if (answers.auctions === "yes") {
    parts.push("через торги можно найти хорошие варианты по выгодной цене");
  }

  if (answers.adjacent === "yes") {
    parts.push("наличие смежного участка открывает путь к прирезке земли по льготной цене");
  }

  return `Исходя из ваших ответов${parts.length ? " (" + parts.join(", ") + ")" : ""}, вам подходит ${names}.`;
}
