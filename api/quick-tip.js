import { GoogleGenAI } from "@google/genai";

function buildQuickTipPrompt({ question, subject }) {
  const safeSubject = subject || "Tổng hợp THPT";

  return [
    "Bạn là giáo viên luyện thi THPT chuyên giải nhanh trắc nghiệm.",
    `Môn học: ${safeSubject}.`,
    "Nhiệm vụ: Đưa ra hướng xử lý nhanh cho câu hỏi trắc nghiệm: công thức nhớ nhanh (kèm điều kiện áp dụng rõ ràng), mẹo loại trừ đáp án, hoặc cách bấm máy tính Casio nếu phù hợp.",
    "Quy tắc bắt buộc:",
    "- Tuyệt đối không bịa công thức, mẹo hay phím bấm Casio.",
    "- Nếu câu hỏi không có mẹo/công thức nhanh thực sự hiệu quả, hãy nói thẳng và hướng dẫn cách giải chuẩn ngắn gọn.",
    "- Độ dài tối đa khoảng 10 dòng, súc tích, rõ ý.",
    "- Mọi công thức toán, lý, hóa, ký hiệu khoa học viết bằng LaTeX trong cặp dấu $...$.",
    "- Chỉ trả về nội dung dạng văn bản thuần túy/Markdown, không bọc trong khối JSON.",
    `Dữ liệu câu hỏi:\n${typeof question === "string" ? question : JSON.stringify(question ?? "", null, 2)}`,
  ].join("\n\n");
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
  const prompt = buildQuickTipPrompt({
    question: body.question,
    subject: body.subject,
  });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.25,
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
