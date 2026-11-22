// api/solve.js — AI tự giải các câu chưa có đáp án chuẩn (để nộp bài vẫn chấm điểm được)
import { askAI, parseBody, clip, sendAIError } from "../lib/ai.js";

export const config = { maxDuration: 60 }; // cho phép hàm chạy tới 60 giây (mặc định có thể chỉ 10 giây → lỗi 504)

const SYSTEM =
  "Bạn là giáo viên giỏi, giải chính xác câu hỏi luyện thi THPT Việt Nam. " +
  "Với mỗi câu, hãy giải cẩn thận từng bước trong đầu rồi chỉ trả về đáp án cuối cùng. " +
  'Chỉ trả về MỘT đối tượng JSON thuần: {"answers":[{"i":<số thứ tự #>,"answer":"..."}]}. ' +
  'Quy ước answer (luôn là chuỗi): loại mcq = một chữ cái A/B/C/D; loại tf = bốn giá trị theo thứ tự a,b,c,d ngăn cách bởi dấu phẩy, ví dụ "true,false,true,false"; ' +
  'loại short = một số dùng dấu chấm thập phân (ví dụ "12.5") hoặc chữ ngắn. Chỉ ghi null khi thật sự không xác định được. Không viết gì ngoài JSON.';

function formatQuestion(q) {
  const lines = [`#${q.i} [${q.type}] ${clip(q.text, 3000)}`];
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
      .map((a) => ({
        i: Number(a.i),
        answer:
          a.answer === null || a.answer === undefined ? null : String(a.answer),
      }));
    return res.status(200).json({ answers, model });
  } catch (err) {
    return sendAIError(res, err);
  }
}
