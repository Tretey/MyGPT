// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// ── Настройки ─────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

// CORS (для учебы оставим широкий; в проде сузить домены)
app.use(cors());
app.use(bodyParser.json());

// Раздача фронтенда из папки public
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Здоровье сервиса
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Поиск по локальным .txt в папке chats ─────────────────────────────────
app.post('/api/question', (req, res) => {
  const { question } = req.body || {};
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }
  const chatDir = path.join(__dirname, 'chats');
  const result = [];
  try {
    if (!fs.existsSync(chatDir)) {
      return res.json({ matches: [], note: 'Папка chats отсутствует' });
    }
    const files = fs.readdirSync(chatDir);
    files.forEach(file => {
      if (!file.endsWith('.txt')) return;
      const filePath = path.join(chatDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      content.split('\n').forEach((line, idx) => {
        if ((line || '').toLowerCase().includes(question.toLowerCase())) {
          result.push({ file, line: idx + 1, text: (line || '').trim() });
        }
      });
    });
    res.json({ matches: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Search error' });
  }
});

// ── (Опционально) Агент с простыми инструментами ─────────────────────────
// Для курса / будущего роста. Работает без ключа (локально),
// а с OPENAI_API_KEY умеет планировать шаги.
const { create, all } = require('mathjs');
const math = create(all, {});

function tool_searchChats(query) {
  const dir = path.join(__dirname, 'chats');
  const matches = [];
  try {
    if (!fs.existsSync(dir)) return { matches: [] };
    fs.readdirSync(dir).forEach(file => {
      if (!file.endsWith('.txt')) return;
      const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split('\n');
      lines.forEach((ln, i) => {
        if ((ln || '').toLowerCase().includes((query || '').toLowerCase())) {
          matches.push({ file, line: i + 1, text: (ln || '').trim() });
        }
      });
    });
  } catch (e) {
    return { error: 'Ошибка доступа к chats', detail: String(e) };
  }
  return { matches };
}
function tool_calculate(expr) {
  try { return { result: String(math.evaluate(expr)) }; }
  catch (e) { return { error: 'Ошибка вычисления', detail: String(e) }; }
}

async function callOpenAI(messages) {
  if (!process.env.OPENAI_API_KEY) return null; // нет ключа — режим локальный
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.2 })
  });
  if (!resp.ok) return { error: `OpenAI HTTP ${resp.status}` };
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

app.post('/api/agent', async (req, res) => {
  const { goal, maxSteps = 3 } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });

  const transcript = [];
  const toolsDesc = `
Инструменты:
- searchChats: строка поиска
- calculate: математическое выражение (например "2*(3+4)")
- final: завершить и вернуть ответ пользователю
Формат ответа: {"tool":"...","input":"...","notes":""}
`.trim();

  let useLLM = !!process.env.OPENAI_API_KEY;
  let messages = [
    { role: 'system', content: 'Отвечай ТОЛЬКО JSON в формате протокола.' },
    { role: 'user', content: `Цель: ${goal}\n${toolsDesc}` }
  ];

  let answer = null;
  let steps = 0;

  while (steps < Math.max(1, Math.min(5, maxSteps))) {
    steps++;
    let decision;

    if (useLLM) {
      const content = await callOpenAI(messages);
      if (!content || content.error) {
        useLLM = false; // падаем в локальный режим
      } else {
        try { decision = JSON.parse(content); }
        catch { messages.push({ role: 'user', content: 'Верни строго JSON.' }); continue; }
      }
    }

    if (!useLLM) {
      const mathLike = /[0-9][0-9+\-*/().\s]+$/.test(goal);
      if (steps === 1 && mathLike) {
        decision = { tool: 'calculate', input: goal, notes: 'локально: похоже на математику' };
      } else if (steps === 1) {
        decision = { tool: 'searchChats', input: goal, notes: 'локально: ищу в chats' };
      } else {
        decision = { tool: 'final', input: 'Готово. См. результаты выше.', notes: '' };
      }
    }

    transcript.push({ step: steps, decision });

    let observation;
    try {
      switch ((decision.tool || '').toLowerCase()) {
        case 'searchchats': observation = tool_searchChats(decision.input || goal); break;
        case 'calculate':   observation = tool_calculate(decision.input || goal);   break;
        case 'final':       answer = decision.input || 'Готово.'; steps = maxSteps; break;
        default:            observation = { error: 'Неизвестный инструмент' };
      }
    } catch (e) {
      observation = { error: 'Исключение инструмента', detail: String(e) };
    }
    transcript[transcript.length - 1].observation = observation;

    if ((decision.tool || '').toLowerCase() === 'final') break;

    if (useLLM) {
      messages.push({ role: 'assistant', content: JSON.stringify(decision) });
      messages.push({ role: 'user',
        content: `Наблюдение: ${JSON.stringify(observation)}. Если нужно — выбери следующий инструмент, иначе верни {"tool":"final","input":"итог","notes":""}`
      });
    }
  }

  if (!answer) {
    const last = transcript[transcript.length - 1];
    if (last?.observation?.matches?.length) {
      answer = `Найдено совпадений: ${last.observation.matches.length}.`;
    } else if (last?.observation?.result) {
      answer = `Результат вычисления: ${last.observation.result}`;
    } else if (last?.observation?.error) {
      answer = `Ошибка: ${last.observation.error}`;
    } else {
      answer = 'Готово.';
    }
  }

  res.json({ goal, steps: transcript.length, transcript, answer, llm: useLLM ? 'openai' : 'local' });
});

// ── Старт ────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});
