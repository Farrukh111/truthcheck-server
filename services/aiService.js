const fs = require('fs');
const OpenAI = require('openai');
const axios = require('axios');
const crypto = require('crypto');
const Redis = require('ioredis');
const { redisOptions } = require('../config/redis');
require('dotenv').config();

// 🔥 FIX: Убрали Markdown-ссылки, теперь чистые строки
const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const routerClient = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: { "X-Title": "TruthCheck AI" }
});

// 🔥 FIX: Безопасное подключение. Если Redis нет (Render без URL), переменная будет null.
const redis = redisOptions ? new Redis(redisOptions) : null;

// --- 🛠️ 1. УТИЛИТА: РЕТРАИ (Повторные попытки) ---
// Проверяет, является ли ошибка критической (401/403/Quota)
function isCriticalError(err) {
  const status = err?.response?.status || err?.status || err?.statusCode || 0;
  if ([401, 402, 403].includes(status)) return true;
  
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('quota') || msg.includes('forbidden') || msg.includes('invalid api key');
}

async function callModelWithRetry(fn, retries = 3, baseDelay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (isCriticalError(error)) throw error; // Если нет денег или доступа — падаем сразу
      
      const isLast = i === retries - 1;
      console.warn(`[AI Service] ⚠️ Attempt ${i + 1}/${retries} failed: ${error.message}`);
      
      if (isLast) throw error;
      await new Promise(res => setTimeout(res, baseDelay * Math.pow(2, i)));
    }
  }
}

// --- 🧠 2. SMART TRIM ---
function smartTrim(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;

  const rawSlice = text.slice(0, maxLength);
  const lastSentenceEnd = Math.max(
    rawSlice.lastIndexOf('.'), 
    rawSlice.lastIndexOf('!'), 
    rawSlice.lastIndexOf('?')
  );
  return lastSentenceEnd > maxLength * 0.5 
    ? rawSlice.slice(0, lastSentenceEnd + 1) 
    : rawSlice;
}

// --- 🛡️ 3. SUPER PARSER (Версия из аудита) ---
function extractJSONSafe(text) {
  try {
    if (!text || typeof text !== 'string') return null;
    // 1. Удаляем <think>, code fences и \r
    let s = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/```(?:json)?/gi, '')
                .replace(/\r/g, '');
    // 2. Находим границы JSON
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    let candidate = s.slice(first, last + 1);

    // 3. Убираем trailing commas: ,} и ,]
    candidate = candidate.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    // 4. Убираем невидимые управляющие символы
    candidate = candidate.replace(/[\u0000-\u001F]+/g, ' ');

    return JSON.parse(candidate);
  } catch (err) {
    console.warn('[Parser] JSON extraction failed:', err.message);
    return null;
  }
}

// --- 4. ТРАНСКРИБАЦИЯ ---
async function transcribeAudio(filePath) {
  console.log('[AI Service] 🎤 Sending to Groq Whisper...');
  try {
    const transcription = await groqClient.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3-turbo",
      response_format: "json",
    });
    return transcription.text;
  } catch (error) {
    console.error('[AI Service] Whisper failed:', error.message);
    return "";
  }
}

// --- 5. ПОИСК ---
async function searchTavily(query) {
  const safeQuery = smartTrim(query, 400); 
  const queryHash = crypto.createHash('md5').update(safeQuery.toLowerCase().trim()).digest('hex');
  const cacheKey = `tavily:${queryHash}`;

  try {
    // 🔥 FIX: Читаем кэш только если Redis подключен
    if (redis) {
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);
    }

    const res = await axios.post("[https://api.tavily.com/search](https://api.tavily.com/search)", {
      api_key: process.env.TAVILY_API_KEY,
      query: safeQuery,
      search_depth: "basic",
      include_answer: false,
      max_results: 5
    }, { 
      timeout: 10000 // 🔥 FIX: Таймаут 10 сек, чтобы не висеть вечно
    });

    if (!res.data?.results?.length) return null;

    const cleanedResults = res.data.results
      .filter(r => r.content && r.content.length > 50)
      .map(r => ({ 
        title: r.title, 
        url: r.url, 
        content: r.content.slice(0, 350) 
      }));

    // 🔥 FIX: Пишем в кэш только если Redis подключен
    if (cleanedResults.length > 0 && redis) {
        await redis.set(cacheKey, JSON.stringify(cleanedResults), 'EX', 86400);
    }
    return cleanedResults;
  } catch (e) {
    console.error("[Tavily] Error:", e.message);
    return null;
  }
}

// --- 6. GATEKEEPER ---
async function analyzeContentType(text) {
  if (!text || text.length < 10) return { type: 'noise', summary: "Речь не обнаружена." };

  console.log('[AI Gatekeeper] 🛡️ Analyzing content structure...');
  const safeText = smartTrim(text, 1500);
  const prompt = `
    You are a highly accurate MEDIA-TYPE CLASSIFIER.
    INPUT: """${safeText}"""
    Determine type: "movie", "series", "anime", "song", "entertainment", "claims", "noise".
    EXAMPLES:
    1. "Harry used magic..." -> {"type": "movie"}
    2. "Inflation is 5%..." -> {"type": "claims"}
    OUTPUT STRICT JSON:
    { "type": "...", "title": null, "media_confidence": 0.0-1.0, "summary": "max 10 words" }
  `;
  try {
    const completion = await callModelWithRetry(() => routerClient.chat.completions.create({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      response_format: { type: "json_object" }
    }));
    const raw = JSON.parse(completion.choices[0].message.content);
    
    // Safety mapping
    const ALLOWED = ['movie', 'series', 'song', 'anime', 'entertainment', 'noise', 'claims'];
    let safeType = (raw.type || '').toLowerCase().trim();
    if (!ALLOWED.includes(safeType)) safeType = 'claims';
    
    if (safeText.includes('♪') || safeText.toLowerCase().includes('куплет')) {
        if (safeType === 'claims') safeType = 'song';
    }

    return {
        type: safeType,
        title: raw.title || null,
        media_confidence: Number(raw.media_confidence) || 0,
        summary: (raw.summary || "Описание недоступно.").substring(0, 150)
    };
  } catch (e) {
    console.error('[AI Gatekeeper] Error:', e.message);
    return { type: "claims", summary: "Ошибка классификации" };
  }
}

// --- 7. FACT CHECKER (С АТРИБУЦИЕЙ ИСТОЧНИКОВ) ---
async function verifyClaim(text) {
  console.log(`[AI] Checking: "${text.substring(0, 40)}..."`);
  let searchContext = ""; // Строка для промпта
  let sourcesList = []; // Массив для JSON результата

  if (process.env.TAVILY_API_KEY) {
    const search = await searchTavily(text);
    if (search) {
      sourcesList = search; // Сохраняем оригинальные объекты
      
      // 🔥 FIX 1: Нумеруем источники для ИИ ([ID: 1], [ID: 2]...)
      searchContext = search.map((r, i) => 
        `[SOURCE ID: ${i + 1}]\nTITLE: ${r.title}\nURL: ${r.url}\nCONTENT: ${r.content}`
      ).join("\n\n");
    }
  }

  const deepSeekPrompt = `
    ROLE: Professional Fact-Checker AI.
    LANGUAGE: RUSSIAN.
    INPUT: "${text}"
    EVIDENCE: 
    ${searchContext || "No external evidence found."}

    CONSTRAINTS:
    - If FICTION (movie/game) -> Verdict "INFO".
    - Analyze distinct factual claims.
    - Be concise.

    IMPORTANT: For each breakdown item, specify "source_id" (number) from EVIDENCE that best proves/disproves it.
    If no source, use 0.

    OUTPUT JSON ONLY:
    {
      "verdict": "CONFIRMED" | "CONTRADICTED" | "DISPUTED" | "UNCERTAIN" | "INFO",
      "summary": "Headline (max 15 words).",
      "confidence": 0.0-1.0,
      "breakdown": [
        { 
          "claim": "Atomic claim", 
          "status": "TRUE"|"FALSE"|"UNPROVEN", 
          "reason": "Reasoning",
          "source_id": 1 
        }
      ]
    }
  `;

  try {
      const completion = await callModelWithRetry(() => routerClient.chat.completions.create({
          model: "deepseek/deepseek-r1",
          messages: [{ role: "user", content: deepSeekPrompt }],
          temperature: 0.1 
      }), 3, 2000);

      const rawContent = completion.choices[0].message.content;
      const json = extractJSONSafe(rawContent);
      
      if (json) {
          return {
              verdict: (json.verdict || "UNCERTAIN").toUpperCase(),
              summary: (json.summary || "Анализ завершен.").toString().substring(0, 200),
              confidence: Number(json.confidence) || 0,
              
              // 🔥 FIX 2: Пробрасываем source_id
              breakdown: Array.isArray(json.breakdown) 
                  ? json.breakdown.slice(0, 6).map(b => ({
                      claim: (b.claim || "").toString().substring(0, 120),
                      status: (b.status || "UNPROVEN").toString().toUpperCase(),
                      reason: (b.reason || "").toString().substring(0, 150),
                      source_id: Number(b.source_id) || 0 // Получаем ID источника
                    }))
                  : [],
              
              sources: sourcesList // Возвращаем полный список ссылок
          };
      }
      
      throw new Error("Failed to parse JSON");
  } catch (e) { 
      console.error("[AI] Verification failed:", e.message);
      return { 
          verdict: "UNCERTAIN", 
          summary: "Сервис временно перегружен.", 
          confidence: 0, 
          breakdown: [],
          sources: []
      };
  }
}

module.exports = { transcribeAudio, verifyClaim, analyzeContentType };