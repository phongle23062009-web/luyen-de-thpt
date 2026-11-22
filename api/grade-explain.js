import { askAI, parseBody, clip, sendAIError } from "../lib/ai.js";

const SYSTEM =
  "Bạn là gia sư giỏi, chữa bài từng bước bằng tiếng Việt. Viết công thức bằng LaTeX trong $...$ " +
  "(công thức hóa học dùng \\mathrm, ví dụ $\\mathrm{C_4H_6}$). " +
  "Đối chiếu với đáp án chuẩn; nếu đáp án chuẩn có vẻ sai, nói rõ lý do. " +
  "Có thể dùng **in đậm** và gạch đầu dòng, không dùng bảng.";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const body = parseBody(req);
  const question = clip(body.question, 6000);
  const answer = clip(body.answer, 500);
  const key = clip(body.key, 500);
  const subject = clip(body.subject, 100);
  if (!question.trim()) {
    return res.status(400).json({ error: "empty_input" });
  }

  try {
    const { text, model } = await askAI({
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Môn: ${subject}\nĐề:\n${question}\nĐáp án chuẩn: ${key}\nHọc sinh chọn/trả lời: ${answer}\nHãy giải chi tiết và nhận xét bài làm.`,
        },
      ],
      temperature: 0.3,
      level: "medium", // cần suy luận để giải đúng
      perCallMs: 28000,
      totalMs: 50000,
    });
    return res.status(200).json({ text, model });
  } catch (err) {
    return sendAIError(res, err);
  }
}
