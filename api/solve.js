// api/solve.js — AI giải đáp án cho các câu chưa có đáp án chuẩn.
// Frontend gọi từng câu một, đúng lúc cần (không giải trước cả đề khi tạo đề), nên tạo đề nhanh và đỡ quá tải.
// Với câu "short" có cờ convert: nếu kết quả là biểu thức/công thức/tên chất... thì AI dựng luôn
// 4 phương án trắc nghiệm để học sinh chỉ cần bấm chọn thay vì gõ.
import { askAI, parseBody, clip, sendAIError } from "../lib/ai.js";

export const config = { maxDuration: 60 }; // cho phép hàm chạy tới 60 giây (mặc định có thể chỉ 10 giây → lỗi 504)

const SYSTEM =
  "Bạn là giáo viên giỏi, giải chính xác câu hỏi luyện thi THPT Việt Nam. " +
  "Với mỗi câu, hãy giải cẩn thận từng bước trong đầu rồi chỉ trả về kết quả cuối cùng. " +
  'Chỉ trả về MỘT đối tượng JSON thuần: {"answers":[{"i":<số thứ tự #>,"answer":"...","type":"...","options":{"A":"...","B":"...","C":"...","D":"..."}}]}. ' +
  'Quy ước answer (luôn là chuỗi): loại mcq = một chữ cái A/B/C/D; loại tf = bốn giá trị theo thứ tự a,b,c,d ngăn cách bởi dấu phẩy, ví dụ "true,false,true,false"; ' +
  'loại short = một số dùng dấu chấm thập phân (ví dụ "12.5") hoặc chữ ngắn. Chỉ ghi null khi thật sự không xác định được. ' +
  "Hai trường type và options CHỈ dùng cho câu có nhãn [short, chuyển được]: " +
  'nếu đáp án cuối là MỘT SỐ duy nhất thì type = "short" và answer là số (không cần options); ' +
  'nếu đáp án là biểu thức, công thức, phương trình, tên chất hoặc một kết luận thì type = "mcq", options gồm đúng 4 phương án ngắn gọn ' +
  "(1 đúng + 3 nhiễu hợp lý dựa trên lỗi sai thường gặp: sai dấu, quên hệ số, sai chỉ số, quên hằng số C), answer là chữ cái của phương án đúng, " +
  "đặt phương án đúng ở vị trí NGẪU NHIÊN trong A–D. " +
  "Công thức viết trong $...$; công thức hóa học dùng \\mathrm. Trong chuỗi JSON mọi dấu gạch chéo ngược phải viết thành hai dấu \\\\. " +
  "Không viết gì ngoài JSON.";

function formatQuestion(q) {
  const tag = q.convert ? `${q.type}, chuyển được` : q.type;
  const lines = [`#${q.i} [${tag}] ${clip(q.text, 3000)}`];
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

// JSON.parse chấp nhận "\f", "\t", "\b", "\r" nên LaTeX như \frac, \times, \beta, \right bị biến thành
// ký tự điều khiển. Khôi phục lại để công thức trong phương án không bị hỏng.
function fixLatex(s) {
  return String(s ?? "")
    .replace(/\f/g, "\\f")
    .replace(/\t/g, "\\t")
    .replace(/\x08/g, "\\b")
    .replace(/\r/g, "\\r")
    .replace(/\n(?=[a-zA-Z])/g, "\\n")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJsonLoose(t) {
  try {
    return JSON.parse(t);
  } catch {
    try {
      return JSON.parse(t.replace(/\\(?!["\\/bfnrtu])/g, "\\\\"));
    } catch {
      return null;
    }
  }
}

function parseAnswers(text) {
  const t = String(text || "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return [];
  const obj = parseJsonLoose(t.slice(s, e + 1));
  return Array.isArray(obj?.answers) ? obj.answers : [];
}

// Chỉ nhận khi đủ 4 phương án A–D khác nhau, không rỗng
function cleanOptions(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const l of ["A", "B", "C", "D"]) {
    const v = fixLatex(raw[l] ?? raw[l.toLowerCase()]);
    if (!v) return null;
    out[l] = v;
  }
  const uniq = new Set(Object.values(out).map((v) => v.toLowerCase()));
  return uniq.size === 4 ? out : null;
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
    .map((q) => ({ ...q, convert: q.convert === true && q.type === "short" }))
    .slice(0, 12);
  if (!questions.length) {
    return res.status(400).json({ error: "empty_input" });
  }
  const convertIds = new Set(
    questions.filter((q) => q.convert).map((q) => q.i),
  );

  try {
    const { text, model } = await askAI({
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Môn: ${subject}\n\n${questions.map(formatQuestion).join("\n\n")}`,
        },
      ],
      temperature: 0.1,
      level: "medium",
      json: true,
      perCallMs: 40000,
      totalMs: 55000,
      openrouterMs: 12000,
    });

    const answers = parseAnswers(text)
      .filter((a) => a && Number.isInteger(Number(a.i)))
      .map((a) => {
        const i = Number(a.i);
        const out = {
          i,
          answer:
            a.answer === null || a.answer === undefined
              ? null
              : String(a.answer),
        };
        if (convertIds.has(i)) {
          if (String(a.type).toLowerCase() === "mcq") {
            const options = cleanOptions(a.options);
            const letter = (out.answer || "")
              .trim()
              .toUpperCase()
              .match(/^[ABCD]\b/)?.[0];
            if (options && letter) {
              out.type = "mcq";
              out.options = options;
              out.answer = letter;
            } else {
              out.answer = null; // dựng phương án lỗi: không đoán bừa
            }
          } else {
            out.type = "short";
          }
        }
        return out;
      });
    return res.status(200).json({ answers, model });
  } catch (err) {
    return sendAIError(res, err);
  }
}
