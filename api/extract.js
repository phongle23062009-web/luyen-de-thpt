import { GoogleGenAI } from "@google/genai";

function parseBase64Image(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
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

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }
  return null;
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
    `Số trang ảnh đính kèm: ${imageCount} (đánh số trang từ 0 đến ${Math.max(0, imageCount - 1)}).`,
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "missing_key" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const images = Array.isArray(body.images) ? body.images : [];
  const text = typeof body.text === "string" ? body.text : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  const format = body.format === "short" ? "short" : "thpt";
  const mode = body.mode === "gen" ? "gen" : "extract";
  const counts =
    body.counts && typeof body.counts === "object" ? body.counts : {};

  const parsedImages = images.map(parseBase64Image).filter(Boolean);
  const prompt = buildPrompt({
    text,
    subject,
    format,
    mode,
    counts,
    imageCount: parsedImages.length,
  });

  const parts = [];
  for (const img of parsedImages) {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.data,
      },
    });
  }
  parts.push({ text: prompt });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    const response = await ai.models.generateContent({
      model,
      contents: parts,
      config: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    });

    const rawText = response?.text ?? "";
    const jsonBlock = extractFirstJsonBlock(rawText);
    if (!jsonBlock) {
      return res.status(422).json({ error: "invalid_json" });
    }

    let parsedExam;
    try {
      parsedExam = JSON.parse(jsonBlock);
    } catch {
      return res.status(422).json({ error: "invalid_json" });
    }

    if (!parsedExam || typeof parsedExam !== "object") {
      return res.status(422).json({ error: "invalid_json" });
    }

    return res.status(200).json(parsedExam);
  } catch (err) {
    return res.status(500).json({
      error: "gemini_request_failed",
      message: err?.message || "Unknown error",
    });
  }
}
