import { GoogleGenAI } from "@google/genai";

// ===== Cấu hình =====
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const GEMINI_TIMEOUT_MS = 25000;
const OTHER_TIMEOUT_MS = 30000;

/* ===================== Tiện ích ===================== */

function env(name) {
  return (process.env[name] || "").trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function errStatus(err) {
  return err?.status ?? err?.code ?? err?.error?.code ?? null;
}

function errMessage(err) {
  return String(err?.message || err?.error?.message || "");
}

// Lỗi tạm thời: đáng thử lại
function isBusy(err) {
  const s = errStatus(err);
  return (
    s === 503 ||
    s === 429 ||
    /high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(
      errMessage(err),
    )
  );
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} không phản hồi sau ${ms / 1000} giây`);
      e.timeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

/* ===================== Gemini ===================== */

async function runGemini(parts, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const models = [
    ...new Set([env("GEMINI_MODEL"), ...GEMINI_MODELS].filter(Boolean)),
  ];
  const tried = [];
  let lastErr = null;

  for (const model of models) {
    tried.push(model);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await withTimeout(
          ai.models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config: {
              responseMimeType: "application/json",
              temperature: 0.2,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
          GEMINI_TIMEOUT_MS,
          "Gemini",
        );
        return { text: getResponseText(response), model: `gemini:${model}` };
      } catch (err) {
        lastErr = err;
        // Quá chậm: không thử tiếp, chuyển sang AI dự phòng ngay
        if (err.timeout) throw Object.assign(err, { tried });
        // Lỗi tạm thời: thử lại đúng 1 lần
        if (isBusy(err) && attempt === 0) {
          await sleep(2000);
          continue;
        }
        // Lỗi khác (model không có, khóa sai...): sang model kế tiếp
        break;
      }
    }
  }
  throw Object.assign(lastErr || new Error("Gemini thất bại"), { tried });
}

/* ===================== OpenRouter / Groq (OpenAI-compatible) ===================== */

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
  const timer = setTimeout(() => controller.abort(), OTHER_TIMEOUT_MS);
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
    throw new Error(
      `${name}: ${err.name === "AbortError" ? "hết thời gian chờ" : err.message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${name} ${res.status}: ${data?.error?.message || "lỗi không rõ"}`,
    );
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${name}: phản hồi rỗng`);
  return text;
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

  const problems = [];
  let rawText = "";
  let usedModel = "";

  // 1) Gemini
  const geminiKey = env("GEMINI_API_KEY");
  if (!geminiKey) {
    problems.push("gemini: chưa đặt GEMINI_API_KEY");
  } else {
    try {
      const r = await runGemini(parts, geminiKey);
      rawText = r.text;
      usedModel = r.model;
    } catch (err) {
      problems.push(
        `gemini: ${errMessage(err).slice(0, 200) || "lỗi không rõ"}`,
      );
    }
  }

  // 2) OpenRouter
  if (!usedModel) {
    const key = env("OPENROUTER_API_KEY");
    const model = env("OPENROUTER_MODEL");
    if (!key) problems.push("openrouter: chưa đặt OPENROUTER_API_KEY");
    else if (!model)
      problems.push(
        "openrouter: chưa đặt OPENROUTER_MODEL (chọn model có Image input trên openrouter.ai/models)",
      );
    else {
      try {
        rawText = await callOpenAICompatible({
          name: "OpenRouter",
          url: "https://openrouter.ai/api/v1/chat/completions",
          key,
          model,
          images: parsedImages,
          prompt,
          jsonMode: false,
        });
        usedModel = `openrouter:${model}`;
      } catch (err) {
        problems.push(errMessage(err).slice(0, 200));
      }
    }
  }

  // 3) Groq
  if (!usedModel) {
    const key = env("GROQ_API_KEY");
    const model = env("GROQ_MODEL");
    if (!key) problems.push("groq: chưa đặt GROQ_API_KEY");
    else if (!model)
      problems.push(
        "groq: chưa đặt GROQ_MODEL (chọn model vision trên console.groq.com/docs/models)",
      );
    else {
      try {
        rawText = await callOpenAICompatible({
          name: "Groq",
          url: "https://api.groq.com/openai/v1/chat/completions",
          key,
          model,
          images: parsedImages,
          prompt,
          jsonMode: true,
        });
        usedModel = `groq:${model}`;
      } catch (err) {
        problems.push(errMessage(err).slice(0, 200));
      }
    }
  }

  if (!usedModel) {
    const busy = problems.some((p) =>
      /quá tải|high demand|UNAVAILABLE|429|503|hết thời gian|không phản hồi/i.test(
        p,
      ),
    );
    return res.status(busy ? 503 : 500).json({
      error: "gemini_request_failed",
      message: problems.join(" | "),
      hint: busy
        ? "Có AI đang chậm hoặc quá tải. Thử lại sau vài phút, hoặc chọn 1 trang."
        : "Xem message: sửa khóa hoặc tên model tương ứng trên Vercel, rồi Redeploy.",
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
