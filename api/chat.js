import {
  askAI,
  parseBody,
  clip,
  parseDataUrl,
  sendAIError,
} from "../lib/ai.js";

export const config = { maxDuration: 60 }; // cho phép hàm chạy tới 60 giây (mặc định có thể chỉ 10 giây → lỗi 504)

const SYSTEM =
  "Bạn là trợ giảng luyện thi THPT thân thiện, chính xác. Bám sát ngữ cảnh câu hỏi bên dưới khi trả lời học sinh. " +
  "Mặc định trả lời NGẮN GỌN bằng tiếng Việt (tối đa khoảng 8 dòng) và dẫn công thức hoặc khái niệm/định nghĩa liên quan; chỉ giải từng bước chi tiết khi học sinh yêu cầu (ví dụ: giải chi tiết, tự luận, từng bước). Nếu ngữ cảnh ghi học sinh chưa làm câu này thì chỉ hướng dẫn, không suy diễn rằng em không biết làm. Có thể dùng Markdown nhẹ (**in đậm**, gạch đầu dòng), không dùng bảng. Nếu có ảnh đính kèm (hình vẽ, đồ thị, sơ đồ...), hãy quan sát kỹ ảnh đó trước khi trả lời, đừng đoán mò. " +
  "Công thức viết trong $...$ hoặc $$...$$; công thức hóa học dùng \\mathrm, ví dụ $\\mathrm{C_4H_6}$. " +
  "Nếu đáp án chuẩn trong ngữ cảnh có vẻ sai, nói rõ lý do thay vì làm theo.";

function formatContext(context) {
  if (!context) return "";
  if (typeof context === "string") return context;
  return JSON.stringify(context, null, 2);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = parseBody(req);
  const message = clip(
    typeof body.message === "string" ? body.message.trim() : "",
    4000,
  );
  if (!message) {
    return res.status(400).json({ error: "missing_message" });
  }

  const contextText = clip(formatContext(body.context), 8000);
  const image = body.image ? parseDataUrl(body.image) : null;
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((h) => h && typeof h.content === "string" && h.content.trim())
    .slice(-10)
    .map((h) => ({
      role: h.role === "assistant" || h.role === "model" ? "assistant" : "user",
      content: clip(h.content, 3000),
    }));

  const system = contextText
    ? `${SYSTEM}\n\nNGỮ CẢNH CÂU HỎI:\n${contextText}`
    : SYSTEM;

  try {
    const { text, model } = await askAI({
      system,
      messages: [...history, { role: "user", content: message }],
      images: image ? [image] : undefined,
      temperature: 0.3,
      level: "low",
      maxOutputTokens: 2048,
      perCallMs: 20000,
      totalMs: 45000,
    });
    return res.status(200).json({ text, model });
  } catch (err) {
    return sendAIError(res, err);
  }
}
