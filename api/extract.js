import { GoogleGenAI } from "@google/genai";

// Model ưu tiên lấy từ GEMINI_MODEL, sau đó thử các model dự phòng này
const FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
];

// Số lần thử lại cho mỗi model khi bị quá tải (503, 429)
const RETRIES_PER_MODEL = 2;

// Thời gian tối đa cho mỗi lần gọi Gemini (ms), để trả lỗi rõ ràng trước khi Vercel cắt kết nối
const CALL_TIMEOUT_MS = 45000;

function getModelList() {
  const env = (process.env.GEMINI_MODEL || "").trim();
  const list = env ? [env, ...FALLBACK_MODELS] : [...FALLBACK_MODELS];
  return [...new Set(list)];
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
    /high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(
      errMessage(err),
    )
  );
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`Gemini không phản hồi sau ${ms / 1000} giây`);
      e.code = 504;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callWithRetry(ai, params) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
    try {
      return await withTimeout(
        ai.models.generateContent(params),
        CALL_TIMEOUT_MS,
      );
    } catch (err) {
      lastErr = err;
      console.error(
        `[extract] ${params.model} lần ${attempt + 1} lỗi:`,
        errStatus(err),
        errMessage(err).slice(0, 200),
      );
      if (!isRetryable(err) || attempt === RETRIES_PER_MODEL) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({
      error: "missing_key",
      hint: "Chưa đặt GEMINI_API_KEY trên Vercel (Settings → Environment Variables), rồi Redeploy.",
    });
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

  const ai = new GoogleGenAI({ apiKey });
  const tried = [];
  let lastErr = null;
  let rawText = "";
  let usedModel = "";

  for (const model of getModelList()) {
    tried.push(model);
    try {
      const response = await callWithRetry(ai, {
        model,
        contents: [{ role: "user", parts }],
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      rawText = getResponseText(response);
      usedModel = model;
      break;
    } catch (err) {
      lastErr = err;
      if (!isModelNotFound(err) && !isRetryable(err)) break;
    }
  }

  if (!usedModel) {
    const status = errStatus(lastErr);
    return res
      .status(status === 503 || status === 429 || status === 504 ? 503 : 500)
      .json({
        error: "gemini_request_failed",
        message: errMessage(lastErr) || "Unknown error",
        tried,
        hint:
          status === 503 || /high demand|UNAVAILABLE/i.test(errMessage(lastErr))
            ? "Google đang quá tải. Đợi vài phút rồi thử lại, hoặc giảm số trang."
            : "Kiểm tra GEMINI_API_KEY và GEMINI_MODEL trên Vercel, rồi Redeploy.",
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
