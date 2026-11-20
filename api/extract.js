import { GoogleGenAI } from "@google/genai";

// ===== Cấu hình =====
// Khóa lấy từ biến môi trường trên Vercel. Tên model có sẵn mặc định trong code,
// chỉ đặt biến *_MODEL nếu muốn đổi sang model khác.
const GEMINI_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
];
const GEMINI_RETRIES = 2;
const GEMINI_TIMEOUT_MS = 40000;
const OPENAI_COMPAT_TIMEOUT_MS = 40000;

const OPENROUTER_DEFAULT_MODEL = "google/gemma-3-27b-it:free";
const GROQ_DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

/* ===================== Tiện ích ===================== */

function env(name) {
  return (process.env[name] || "").trim();
}

function parseBase64Image(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (match) return { mimeType: match[1], data: match[2] };
  return { mimeType: "image/jpeg", data: raw.trim() };
}

function extractFirstJsonBlock(text) {
  if (typeof text !== "string") return null;
  const cleaned = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

function getResponseText(response) {
  if (!response) return "";
  if (typeof response.text === "function") return response.text() || "";
  if (typeof response.text === "string") return response.text;
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text || "").join("");
  return "";
}

function errStatus(err) {
  return err?.status ?? err?.code ?? err?.error?.code ?? null;
}

function errMessage(err) {
  return String(err?.message || err?.error?.message || "");
}

function isModelNotFound(err) {
  const status = errStatus(err);
  return (
    status === 404 || /not found|not supported|NOT_FOUND/i.test(errMessage(err))
  );
}

function isRetryable(err) {
  const status = errStatus(err);
  return (
    status === 503 ||
    status === 429 ||
    status === 500 ||
    status === 504 ||
    /high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|timeout/i.test(
      errMessage(err),
    )
  );
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} không phản hồi sau ${ms / 1000} giây`);
      e.code = 504;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ===================== Prompt ===================== */

function buildPrompt({ text, subject, format, mode, counts, imageCount }) {
  const safeSubject = subject || "Tổng hợp THPT";
  const safeFormat = format === "short" ? "short" : "thpt";
  const safeMode = mode === "gen" ? "gen" : "extract";
  const p1 = Number(counts?.p1) || 0;
  const p2 = Number(counts?.p2) || 0;
  const p3 = Number(counts?.p3) || 0;

  return [
    "Bạn là chuyên gia ra đề và bóc tách đề thi THPT Việt Nam.",
    `Môn học: ${safeSubject}.`,
    `Chế độ: ${safeMode === "gen" ? "Tạo đề mới dựa trên tài liệu/chủ đề đầu vào" : "Tách đề có sẵn từ ảnh/văn bản đầu vào"}.`,
    `Định dạng: ${safeFormat === "short" ? "Trắc nghiệm ngắn" : "Cấu trúc đề THPT (mcq, tf, short)"}.`,
    imageCount > 0
      ? `Số trang ảnh đính kèm: ${imageCount} (đánh số trang từ 0 đến ${imageCount - 1}).`
      : "Không có ảnh đính kèm.",
    p1 || p2 || p3
      ? `Số lượng câu gợi ý: Phần I (mcq) = ${p1}, Phần II (tf) = ${p2}, Phần III (short) = ${p3}.`
      : "Tự động phân bổ hợp lý theo nội dung đề.",
    text ? `Văn bản đầu vào bổ sung:\n${text}` : "",
    "Quy tắc bắt buộc:",
    "1. Mọi công thức toán, lý, hóa, ký hiệu khoa học phải viết bằng LaTeX đặt trong cặp dấu $...$ (ví dụ: $x^2 + 2x + 1 = 0$).",
    '2. Nếu câu hỏi có hình minh họa trên ảnh trang, đặt figure là {"page": <chỉ số trang 0..N-1>, "box": [x0, y0, x1, y1]} với tọa độ chuẩn hóa 0–1000 (x0, y0 là góc trên trái; x1, y1 là góc dưới phải). Nếu không có hình, đặt figure là null.',
    "3. Chỉ trả về MỘT đối tượng JSON thuần túy, không có lời dẫn, không giải thích ngoài JSON.",
    "4. Cấu trúc JSON mẫu:",
    JSON.stringify(
      {
        title: "Đề luyện tập THPT",
        subject: safeSubject,
        questions: [
          {
            id: "q1",
            part: "mcq",
            number: 1,
            prompt: "Nội dung câu hỏi trắc nghiệm...",
            options: { A: "...", B: "...", C: "...", D: "..." },
            answer: "A",
            figure: null,
          },
          {
            id: "q2",
            part: "tf",
            number: 2,
            prompt: "Nội dung câu hỏi Đúng/Sai...",
            statements: { a: "Ý a...", b: "Ý b...", c: "Ý c...", d: "Ý d..." },
            answer: { a: true, b: false, c: true, d: false },
            figure: { page: 0, box: [120, 80, 450, 520] },
          },
          {
            id: "q3",
            part: "short",
            number: 3,
            prompt: "Nội dung câu hỏi trả lời ngắn...",
            answer: "12.5",
            figure: null,
          },
        ],
      },
      null,
      2,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* ===================== Nhà cung cấp 1: Gemini ===================== */

function getGeminiModelList() {
  const preferred = env("GEMINI_MODEL");
  const list = preferred
    ? [preferred, ...GEMINI_FALLBACK_MODELS]
    : [...GEMINI_FALLBACK_MODELS];
  return [...new Set(list)];
}

async function callGeminiWithRetry(ai, params) {
  let lastErr = null;
  for (let attempt = 0; attempt <= GEMINI_RETRIES; attempt++) {
    try {
      return await withTimeout(
        ai.models.generateContent(params),
        GEMINI_TIMEOUT_MS,
        "Gemini",
      );
    } catch (err) {
      lastErr = err;
      console.error(
        `[extract] gemini ${params.model} lần ${attempt + 1}:`,
        errStatus(err),
        errMessage(err).slice(0, 200),
      );
      if (!isRetryable(err) || attempt === GEMINI_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function runGemini(parts, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const tried = [];
  let lastErr = null;

  for (const model of getGeminiModelList()) {
    tried.push(model);
    try {
      const response = await callGeminiWithRetry(ai, {
        model,
        contents: [{ role: "user", parts }],
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      return {
        text: getResponseText(response),
        model: `gemini:${model}`,
        tried,
      };
    } catch (err) {
      lastErr = err;
      if (!isModelNotFound(err) && !isRetryable(err)) break;
    }
  }
  const e = lastErr || new Error("Gemini thất bại");
  e.tried = tried;
  throw e;
}

/* ===================== Nhà cung cấp 2 & 3: OpenAI-compatible ===================== */

async function callOpenAICompatible({
  name,
  url,
  key,
  model,
  images,
  prompt,
  jsonMode,
}) {
  const content = [
    ...images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.data}` },
    })),
    { type: "text", text: prompt },
  ];

  const body = {
    model,
    messages: [{ role: "user", content }],
    temperature: 0.2,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_COMPAT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const e = new Error(
      `${name}: ${err.name === "AbortError" ? "hết thời gian chờ" : err.message}`,
    );
    e.code = 504;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(
      `${name} ${res.status}: ${data?.error?.message || "lỗi không rõ"}`,
    );
    e.code = res.status;
    throw e;
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${name}: phản hồi rỗng`);
  return text;
}

function runOpenRouter(images, prompt) {
  const key = env("OPENROUTER_API_KEY");
  if (!key)
    return Promise.reject(
      Object.assign(new Error("Chưa đặt OPENROUTER_API_KEY"), { skip: true }),
    );
  return callOpenAICompatible({
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    key,
    model: env("OPENROUTER_MODEL") || OPENROUTER_DEFAULT_MODEL,
    images,
    prompt,
    jsonMode: false,
  }).then((text) => ({ text, model: "openrouter" }));
}

function runGroq(images, prompt) {
  const key = env("GROQ_API_KEY");
  if (!key)
    return Promise.reject(
      Object.assign(new Error("Chưa đặt GROQ_API_KEY"), { skip: true }),
    );
  return callOpenAICompatible({
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key,
    model: env("GROQ_MODEL") || GROQ_DEFAULT_MODEL,
    images,
    prompt,
    jsonMode: true,
  }).then((text) => ({ text, model: "groq" }));
}

/* ===================== Handler ===================== */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== "object") body = {};

  const images = Array.isArray(body.images) ? body.images : [];
  const text = typeof body.text === "string" ? body.text : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  const format = body.format === "short" ? "short" : "thpt";
  const mode = body.mode === "gen" ? "gen" : "extract";
  const counts =
    body.counts && typeof body.counts === "object" ? body.counts : {};

  const parsedImages = images.map(parseBase64Image).filter(Boolean);
  if (parsedImages.length === 0 && !text.trim()) {
    return res.status(400).json({
      error: "empty_input",
      hint: "Không có ảnh hoặc văn bản nào được gửi lên.",
    });
  }

  const prompt = buildPrompt({
    text,
    subject,
    format,
    mode,
    counts,
    imageCount: parsedImages.length,
  });
  const parts = parsedImages.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
  }));
  parts.push({ text: prompt });

  const providerErrors = [];
  let rawText = "";
  let usedModel = "";
  let tried = [];

  // 1) Gemini
  const geminiKey = env("GEMINI_API_KEY");
  if (geminiKey) {
    try {
      const r = await runGemini(parts, geminiKey);
      rawText = r.text;
      usedModel = r.model;
      tried = r.tried;
    } catch (err) {
      tried = err.tried || [];
      providerErrors.push({
        provider: "gemini",
        status: errStatus(err),
        message: errMessage(err).slice(0, 300),
      });
    }
  } else {
    providerErrors.push({
      provider: "gemini",
      message: "Chưa đặt GEMINI_API_KEY",
    });
  }

  // 2) OpenRouter, rồi 3) Groq (chỉ khi Gemini chưa được)
  if (!usedModel) {
    for (const [provider, run] of [
      ["openrouter", () => runOpenRouter(parsedImages, prompt)],
      ["groq", () => runGroq(parsedImages, prompt)],
    ]) {
      try {
        const r = await run();
        rawText = r.text;
        usedModel = r.model;
        break;
      } catch (err) {
        if (err.skip) {
          providerErrors.push({ provider, message: err.message });
        } else {
          console.error(`[extract] ${provider} lỗi:`, errMessage(err));
          providerErrors.push({
            provider,
            status: errStatus(err),
            message: errMessage(err).slice(0, 300),
          });
        }
      }
    }
  }

  if (!usedModel) {
    const allOverloaded = providerErrors.some(
      (p) => p.status === 503 || p.status === 429 || p.status === 504,
    );
    return res.status(allOverloaded ? 503 : 500).json({
      error: "gemini_request_failed",
      message: providerErrors
        .map((p) => `${p.provider}: ${p.message}`)
        .join(" | "),
      tried,
      hint: allOverloaded
        ? "Các AI đang quá tải hoặc hết lượt. Đợi vài phút rồi thử lại, hoặc giảm số trang."
        : "Kiểm tra các khóa API trên Vercel (GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY), rồi Redeploy.",
    });
  }

  const jsonBlock = extractFirstJsonBlock(rawText);
  if (!jsonBlock) {
    console.error("[extract] No JSON. Head:", rawText.slice(0, 300));
    return res.status(422).json({
      error: "invalid_json",
      model: usedModel,
      hint: "AI không trả về JSON. Thử lại với ít trang hơn.",
    });
  }

  let parsedExam;
  try {
    parsedExam = JSON.parse(jsonBlock);
  } catch (err) {
    console.error("[extract] JSON parse failed:", err?.message);
    return res.status(422).json({
      error: "invalid_json",
      model: usedModel,
      hint: "JSON từ AI lỗi cú pháp. Thử lại.",
    });
  }

  if (!parsedExam || typeof parsedExam !== "object") {
    return res.status(422).json({ error: "invalid_json", model: usedModel });
  }

  return res.status(200).json({ ...parsedExam, _model: usedModel });
}
