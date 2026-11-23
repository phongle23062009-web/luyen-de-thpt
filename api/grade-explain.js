export const config = { maxDuration: 60 }; // cho phép hàm chạy tới 60 giây (mặc định có thể chỉ 10 giây → lỗi 504)

import {
  askAI,
  parseBody,
  clip,
  parseDataUrl,
  sendAIError,
} from "../lib/ai.js";

const BASE =
  "Bạn là gia sư luyện thi THPT, trả lời bằng tiếng Việt. Viết công thức bằng LaTeX trong $...$ " +
  "(công thức hóa học dùng \\mathrm, ví dụ $\\mathrm{C_4H_6}$). " +
  "Nếu có ảnh đính kèm (hình vẽ, đồ thị, sơ đồ...), hãy QUAN SÁT KỸ ảnh đó trước khi giải thích; " +
  "đáp án chuẩn cho sẵn (nếu có) đã được xác định đúng theo ảnh, đừng tự suy ra đáp án khác mà không dựa vào ảnh. " +
  "Đối chiếu với đáp án chuẩn; nếu đáp án chuẩn có vẻ sai, nói rõ lý do. " +
  "Chỉ nhận xét dựa trên bài làm thật sự của học sinh. Nếu học sinh CHƯA làm câu này thì tuyệt đối không nhận xét năng lực, " +
  "không nói em không biết làm hay không làm được; chỉ ghi một câu ngắn là em chưa làm câu này rồi trình bày lời giải để tham khảo. " +
  "Có thể dùng **in đậm** và gạch đầu dòng, không dùng bảng.";

const QUICK =
  "KIỂU: GIẢI NHANH. Tối đa 6–8 dòng, theo thứ tự: (1) **Đáp án** đúng; " +
  "(2) **Cơ sở:** nêu rõ công thức, định luật, khái niệm hoặc định nghĩa được áp dụng (ghi tên và điều kiện áp dụng), rồi thay số hoặc suy luận thật ngắn; " +
  "(3) nếu học sinh chọn sai: một câu chỉ ra chỗ nhầm; (4) mẹo loại trừ hoặc cách bấm máy chỉ khi thật sự hữu ích. " +
  "Không giải từng bước dài dòng.";

const DETAIL =
  "KIỂU: GIẢI CHI TIẾT TỪNG BƯỚC (tự luận). Trình bày theo thứ tự: phân tích đề → công thức/khái niệm sử dụng → " +
  "các bước giải được đánh số → kết luận và đối chiếu đáp án chuẩn. Tối đa khoảng 25 dòng.";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const body = parseBody(req);
  const question = clip(body.question, 6000);
  const answer = clip(body.answer, 500);
  const key = clip(body.key, 500);
  const subject = clip(body.subject, 100);
  const style =
    body.style === "detail" || body.mode === "essay" ? "detail" : "quick";
  const answered = body.answered !== false; // client cũ không gửi cờ này thì coi như đã làm
  const image = body.image ? parseDataUrl(body.image) : null;
  if (!question.trim()) {
    return res.status(400).json({ error: "empty_input" });
  }

  const how = style === "detail" ? "Giải chi tiết từng bước" : "Giải nhanh";
  const task = answered
    ? `Học sinh chọn/trả lời: ${answer}\n${how}, nói rõ học sinh làm đúng hay sai.`
    : `Học sinh chưa làm câu này. ${how} để tham khảo, không cần nhận xét bài làm.`;

  try {
    const { text, model } = await askAI({
      system: `${BASE}\n\n${style === "detail" ? DETAIL : QUICK}`,
      messages: [
        {
          role: "user",
          content: `Môn: ${subject}\nĐề:\n${question}${image ? "\n(Xem ảnh đính kèm)" : ""}\nĐáp án chuẩn: ${key}\n${task}`,
        },
      ],
      images: image ? [image] : undefined,
      temperature: 0.3,
      level: "low",
      maxOutputTokens: style === "detail" ? 3072 : 1024,
      perCallMs: style === "detail" ? 25000 : 18000,
      totalMs: 50000,
    });
    return res.status(200).json({ text, model });
  } catch (err) {
    return sendAIError(res, err);
  }
}
