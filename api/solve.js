// api/solve.js — AI tự giải các câu chưa có đáp án chuẩn (để nộp bài vẫn chấm điểm được)
import {
  askAI,
  parseBody,
  clip,
  parseDataUrl,
  sendAIError,
} from "../lib/ai.js";

export const config = { maxDuration: 60 }; // cho phép hàm chạy tới 60 giây (mặc định có thể chỉ 10 giây → lỗi 504)

const SYSTEM =
  "Bạn là giáo viên giỏi, giải chính xác câu hỏi luyện thi THPT Việt Nam. " +
  "Với mỗi câu, hãy giải cẩn thận từng bước trong đầu rồi chỉ trả về đáp án cuối cùng. " +
  "Nếu câu có ảnh đính kèm (hình vẽ, đồ thị, sơ đồ, bảng...), hãy QUAN SÁT KỸ ảnh trước khi giải; không suy đoán nếu không nhìn rõ. " +
  'Chỉ trả về MỘT đối tượng JSON thuần: {"answers":[{"i":<số thứ tự #>,"answer":"..."}]}. ' +
  'Quy ước answer (luôn là chuỗi): loại mcq = một chữ cái A/B/C/D; loại tf = bốn giá trị theo thứ tự a,b,c,d ngăn cách bởi dấu phẩy, ví dụ "true,false,true,false"; ' +
  'loại short = một số dùng dấu chấm thập phân (ví dụ "12.5") hoặc chữ ngắn. Chỉ ghi null khi thật sự không xác định được. ' +
  "CÂU CÓ CỜ (cần chọn dạng đáp án): đây là câu tự luận, học sinh chỉ có bàn phím thường nên KHÔNG gõ được ký hiệu toán/hóa. " +
  'Hãy tự giải trước. Nếu đáp án là MỘT SỐ duy nhất (số thực, bỏ đơn vị) thì trả {"i":N,"type":"short","answer":"12.5"}. ' +
  "Nếu đáp án là biểu thức, công thức, tên chất, mệnh đề hoặc kết luận thì CHUYỂN thành trắc nghiệm: " +
  '{"i":N,"type":"mcq","options":{"A":"...","B":"...","C":"...","D":"..."},"answer":"B"} gồm 1 phương án đúng + 3 phương án nhiễu hợp lý ' +
  "(lỗi hay gặp: sai dấu, quên hệ số, sai chỉ số, quên hằng số C), đặt phương án đúng ở vị trí NGẪU NHIÊN, công thức viết trong $...$. " +
  "Nếu câu thực ra là một khẳng định cần xét đúng hay sai thì tạo mcq với hai lựa chọn đầu là Đúng/Sai theo ngữ cảnh và hai lựa chọn còn lại hợp lý.";

function formatQuestion(q, withImageNote) {
  const convertFlag =
    q.convert === true && q.type === "short"
      ? " [CÓ CỜ: cần chọn dạng đáp án]"
      : "";
  const lines = [
    `#${q.i} [${q.type}]${convertFlag}${withImageNote ? " (có ảnh đính kèm bên dưới)" : ""} ${clip(q.text, 3000)}`,
  ];
  if (q.type === "mcq" && Array.isArray(q.options)) {
    q.options.forEach((o) =>
      lines.push(`${clip(o?.label, 2)}. ${clip(o?.text, 500)}`),
    );
  }
  if (q.type === "tf" && Array.isArray(q.statements)) {
    q.statements.forEach((s) =>
      lines.push(`${clip(s?.label, 2)}) ${clip(s?.text, 500)}`),
    );
  }
  return lines.join("\n");
}

function parseAnswers(text) {
  const t = String(text || "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return [];
  try {
    const obj = JSON.parse(t.slice(s, e + 1));
    return Array.isArray(obj.answers) ? obj.answers : [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const body = parseBody(req);
  const subject = clip(body.subject, 100);
  const questions = (Array.isArray(body.questions) ? body.questions : [])
    .filter(
      (q) =>
        q &&
        Number.isInteger(q.i) &&
        typeof q.text === "string" &&
        q.text.trim(),
    )
    .slice(0, 12);
  if (!questions.length) {
    return res.status(400).json({ error: "empty_input" });
  }

  // Ảnh chỉ đi kèm khi gửi ĐÚNG MỘT câu (client luôn gọi riêng cho câu có hình,
  // tách khỏi các câu chữ để AI không bị nhầm ảnh sang câu khác)
  const singleImage =
    questions.length === 1 ? parseDataUrl(questions[0].image) : null;

  try {
    const { text, model } = await askAI({
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Môn: ${subject}\n\n${questions.map((q) => formatQuestion(q, !!singleImage)).join("\n\n")}`,
        },
      ],
      images: singleImage ? [singleImage] : undefined,
      temperature: 0.1,
      level: "medium",
      json: true,
      perCallMs: 40000,
      totalMs: 55000,
      openrouterMs: 12000,
    });

    const convertible = new Set(
      questions
        .filter((q) => q.convert === true && q.type === "short")
        .map((q) => q.i),
    );
    const answers = parseAnswers(text)
      .filter((a) => a && Number.isInteger(Number(a.i)))
      .map((a) => {
        const out = {
          i: Number(a.i),
          answer:
            a.answer === null || a.answer === undefined
              ? null
              : String(a.answer),
        };
        // Chỉ chấp nhận chuyển sang trắc nghiệm với câu thật sự được yêu cầu, và phương án phải hợp lệ
        if (
          a.type === "mcq" &&
          convertible.has(out.i) &&
          a.options &&
          typeof a.options === "object"
        ) {
          const options = {};
          for (const L of ["A", "B", "C", "D"]) {
            const v = a.options[L] ?? a.options[L.toLowerCase()];
            if (v !== undefined && v !== null && String(v).trim())
              options[L] = String(v).trim();
          }
          const letter = String(out.answer || "")
            .trim()
            .toUpperCase()
            .charAt(0);
          if (Object.keys(options).length >= 2 && options[letter]) {
            out.type = "mcq";
            out.options = options;
            out.answer = letter;
          }
        }
        return out;
      });
    return res.status(200).json({ answers, model });
  } catch (err) {
    return sendAIError(res, err);
  }
}
