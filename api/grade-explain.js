import { askAI, parseBody, clip, sendAIError } from "../lib/ai.js";

const SYSTEM =
  "Bạn là gia sư giỏi, chữa bài từng bước bằng tiếng Việt, trình bày gọn (tối đa khoảng 15 dòng). " +
  "Viết công thức bằng LaTeX trong $...$ (công thức hóa học dùng \\mathrm, ví dụ $\\mathrm{C_4H_6}$). " +
  "Đối chiếu với đáp án chuẩn; nếu đáp án chuẩn có vẻ sai, nói rõ lý do. " +
  "Chỉ nhận xét dựa trên bài làm thật sự của học sinh. Nếu học sinh CHƯA làm câu này thì tuyệt đối không nhận xét năng lực, " +
  "không nói em không biết làm hay không làm được; chỉ ghi một câu ngắn là em chưa làm câu này rồi trình bày lời giải để tham khảo. " +
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
  const answered = body.answered !== false; // client cũ không gửi cờ này thì coi như đã làm
  if (!question.trim()) {
    return res.status(400).json({ error: "empty_input" });
  }

  const task = answered
    ? `Học sinh chọn/trả lời: ${answer}\nHãy giải chi tiết và nhận xét bài làm.`
    : "Học sinh chưa làm câu này. Hãy trình bày lời giải chi tiết để tham khảo, không cần nhận xét bài làm.";

  try {
    const { text, model } = await askAI({
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Môn: ${subject}\nĐề:\n${question}\nĐáp án chuẩn: ${key}\n${task}`,
        },
      ],
      temperature: 0.3,
      level: "low",
      maxOutputTokens: 3072,
      perCallMs: 25000,
      totalMs: 50000,
    });
    return res.status(200).json({ text, model });
  } catch (err) {
    return sendAIError(res, err);
  }
}
