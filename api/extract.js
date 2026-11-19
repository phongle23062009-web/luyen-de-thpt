import { GoogleGenAI } from "@google/genai";

// Thứ tự thử model: nếu model đầu lỗi 404 thì thử model tiếp theo
const FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
];

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

function isModelNotFound(err) {
  const status = err?.status ?? err?.code;
  const msg = String(err?.message || "");
  return status === 404 || /not found|not supported|NOT_FOUND/i.test(msg);
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
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json", temperature: 0.2 },
      });
      rawText = getResponseText(response);
      usedModel = model;
      break;
    } catch (err) {
      lastErr = err;
      console.error(
        `[extract] model ${model} failed:`,
        err?.status,
        err?.message,
      );
      if (!isModelNotFound(err)) break; // lỗi khác (khóa sai, quota...) thì dừng ngay
    }
  }

  if (!usedModel) {
    return res.status(500).json({
      error: "gemini_request_failed",
      message: lastErr?.message || "Unknown error",
      tried,
      hint: "Model không khả dụng với khóa này. Vào Google AI Studio kiểm tra khóa và model, rồi cập nhật GEMINI_MODEL trên Vercel.",
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
