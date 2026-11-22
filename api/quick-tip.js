import { askAI, parseBody, clip, sendAIError } from "../lib/ai.js";

export const config = { maxDuration: 60 }; // cho phép hàm chạy tới 60 giây (mặc định có thể chỉ 10 giây → lỗi 504)

const SYSTEM =
  "Bạn là gia sư luyện thi THPT. Đưa cách làm NHANH cho câu trắc nghiệm bằng tiếng Việt, tối đa khoảng 10 dòng gồm: " +
  "(1) công thức nhớ nhanh, nêu rõ điều kiện áp dụng; (2) mẹo loại trừ hoặc thử đáp án; (3) cách bấm máy Casio nếu phù hợp. " +
  "Không bịa công thức. Nếu không có mẹo thật sự hiệu quả, nói thẳng. " +
  "Dùng LaTeX trong $...$; công thức hóa học dùng \\mathrm, ví dụ $\\mathrm{C_4H_6}$. " +
  "Có thể dùng **in đậm** và gạch đầu dòng, không dùng bảng.";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const body = parseBody(req);
  const question = clip(body.question, 6000);
  const subject = clip(body.subject, 100);
  if (!question.trim()) {
    return res.status(400).json({ error: "empty_input" });
  }

  try {
    const { text, model } = await askAI({
      system: SYSTEM,
      messages: [
        { role: "user", content: `Môn: ${subject}\nCâu hỏi:\n${question}` },
      ],
      temperature: 0.2,
      level: "low",
      maxOutputTokens: 1536,
      perCallMs: 18000,
      totalMs: 45000,
    });
    return res.status(200).json({ text, model });
  } catch (err) {
    return sendAIError(res, err);
  }
}
