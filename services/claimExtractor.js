// server/services/claimExtractor.js

function normalizeText(text) {
  if (!text || typeof text !== "string") return "";
  return text.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function splitToSentences(text) {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").split(/(?<=[.!?])\s+|\n+/g).map(s => normalizeText(s)).filter(Boolean);
}

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(w => w.length > 2);
}

function simpleTF(words) {
  const tf = {};
  for (const w of words) tf[w] = (tf[w] || 0) + 1;
  return tf;
}

// === Лингвистические паттерны ===
const SYNTAX_PATTERNS = {
  causal: [/\b(в результате|приводит к|поэтому|следовательно|из-за|because of|leads to|as a result)\b/i],
  quant: [/\b\d+%|\b\d+\s*(?:раз|times|x)\b/i, /\b(большинство|majority|меньшинство|minority)\b/i],
  temporal: [/\b(в\s+\d{4}|in\s+\d{4}|за последние|over the last)\b/i],
  specificRef: [/\b(университет|институт|исследование|study|research|профессор|professor|доктор|doctor)\b/i]
};

function scoreSyntactic(sentence) {
  let score = 0;
  try {
    if (SYNTAX_PATTERNS.causal.some(p => p.test(sentence))) score += 0.18;
    if (SYNTAX_PATTERNS.quant.some(p => p.test(sentence))) score += 0.18;
    if (SYNTAX_PATTERNS.temporal.some(p => p.test(sentence))) score += 0.12;
    if (SYNTAX_PATTERNS.specificRef.some(p => p.test(sentence))) score += 0.15;
    score = Math.min(1, score);
  } catch (e) { score = 0; }
  return score;
}

const SEMANTIC_INDICATORS = {
  high: ["исследование", "study", "доказано", "показало", "проведено", "established", "proven"],
  medium: ["показывает", "results", "результаты", "analysis", "свидетельствует", "indicates"],
  low: ["может", "could", "возможно", "may", "might"]
};

function scoreSemantic(sentence) {
  const s = sentence.toLowerCase();
  let score = 0;
  for (const h of SEMANTIC_INDICATORS.high) if (s.includes(h)) score += 0.45;
  for (const m of SEMANTIC_INDICATORS.medium) if (s.includes(m)) score += 0.25;
  for (const l of SEMANTIC_INDICATORS.low) if (s.includes(l)) score += 0.08;
  
  const wc = tokenize(sentence).length;
  if (wc >= 5 && wc <= 40) score += 0.22;
  return Math.min(1, score);
}

// === MAIN EXTRACTOR ===
const ClaimExtractor = {
  extract(text) {
    try {
      if (!text) return null;
      
      let sentences = splitToSentences(text);
      sentences = sentences.filter(s => s.length >= 10 && s.length <= 400);
      
      if (!sentences.length) return null;
      
      // Ограничиваем анализ 50 предложениями для скорости
      if (sentences.length > 50) sentences = sentences.slice(0, 50);

      const candidates = sentences.map((text) => {
        const syntactic = scoreSyntactic(text);
        const semantic = scoreSemantic(text);
        // Упрощенный скоринг
        const confidence = (syntactic * 0.4) + (semantic * 0.6);
        return { text, confidence };
      }).sort((a, b) => b.confidence - a.confidence);

      const best = candidates[0];
      
      // Возвращаем результат
      return {
        bestClaim: best ? best.text : null,
        confidence: best ? best.confidence : 0,
        allCandidates: candidates.slice(0, 3)
      };

    } catch (err) {
      console.error("ClaimExtractor Error:", err.message);
      return null;
    }
  }
};

module.exports = ClaimExtractor;