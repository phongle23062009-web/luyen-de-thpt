import { GoogleGenAI } from "@google/genai";

function buildEssayPrompt({ question, answer, key, subject, mode }) {
  const safeSubject = subject || "Tổng hợp THPT";
  const safeMode = mode || "essay";

  return [
    "Bạn là giáo viên luyện thi THPT tận tâm và chính xác.",
    `Môn học: ${safeSubject}. Chế độ chữa bài: ${safeMode}.`,
    "Nhiệm vụ: Giải chi tiết từng bước theo phong cách tự luận rõ ràng, dễ hiểu cho học sinh THPT; đối chiếu bài làm của học sinh với đáp án chuẩn; kiểm tra tính đúng đắn của đáp án chuẩn và nói rõ nếu đáp án chuẩn có dấu hiệu sai hoặc thiếu chặt chẽ.",
    "Quy tắc trình bày:",
    "- Trình bày từng bước logic, đánh số rõ ràng.",
    "- Mọi công thức toán, lý, hóa, ký hiệu khoa học viết bằng LaTeX trong cặp dấu $...$ hoặc $$...$$.",
    "- Chỉ trả về nội dung lời giải dạng văn bản thuần túy/Markdown, không bọc trong khối JSON.",
    `Dữ liệu câu hỏi:\n${typeof question === "string" ? question : JSON.stringify(question ?? "", null, 2)}`,
    `Đáp án / bài làm của học sinh:\n${typeof answer === "string" ? answer : JSON.stringify(answer ?? "Chưa trả lời", null, 2)}`,
    `Đáp án chuẩn:\n${typeof key === "string" ? key : JSON.stringify(key ?? "Không có", null, 2)}`,
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
  const prompt = buildEssayPrompt({
    question: body.question,
    answer: body.answer,
    key: body.key,
    subject: body.subject,
    mode: body.mode,
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
