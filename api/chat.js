import { GoogleGenAI } from "@google/genai";

function formatContext(context) {
  if (!context) return "";
  if (typeof context === "string") return context;
  return JSON.stringify(context, null, 2);
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
  const contextText = formatContext(body.context);
  const history = Array.isArray(body.history) ? body.history : [];
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!message) {
    return res.status(400).json({ error: "missing_message" });
  }

  const contents = [];

  if (contextText) {
    contents.push({
      role: "user",
      parts: [
        {
          text: [
            "Bạn là trợ giảng luyện thi THPT thân thiện, chính xác. Hãy bám sát ngữ cảnh câu hỏi và hướng dẫn dưới đây khi trả lời học sinh. Dùng LaTeX trong $...$ hoặc $$...$$ cho công thức.",
            contextText,
          ].join("\n\n"),
        },
      ],
    });
    contents.push({
      role: "model",
      parts: [
        {
          text: "Tôi đã nắm rõ hướng dẫn trợ giảng và nội dung câu hỏi. Hãy đặt câu hỏi.",
        },
      ],
    });
  }

  for (const item of history) {
    if (!item || typeof item.content !== "string" || !item.content.trim())
      continue;
    const role =
      item.role === "assistant" || item.role === "model" ? "model" : "user";
    contents.push({
      role,
      parts: [{ text: item.content }],
    });
  }

  contents.push({
    role: "user",
    parts: [{ text: message }],
  });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        temperature: 0.3,
      },
    });

    const text = (response?.text ?? "").trim();
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({
      error: "gemini_request_failed",
      message: err?.message || "Unknown error",
    });
  }
}
