import { GoogleGenAI } from "@google/genai";

const MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];
const OPENROUTER_MODEL = "google/gemma-4-26b-a4b-it:free";

function env(n) {
  return (process.env[n] || "").trim();
}

function withTimeout(p, ms) {
  let t;
  const to = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error("hết thời gian chờ")), ms);
  });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

// Chuyển messages kiểu OpenAI sang định dạng Gemini
function toGemini(messages) {
  const sys = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const rest = messages.filter((m) => m.role !== "system");
  return rest.map((m, i) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: (i === 0 && sys ? sys + "\n\n" : "") + m.content }],
  }));
}

async function ask(messages) {
  const problems = [];
  const gkey = env("GEMINI_API_KEY");
  if (gkey) {
    const ai = new GoogleGenAI({ apiKey: gkey });
    const models = [
      ...new Set([env("GEMINI_MODEL"), ...MODELS].filter(Boolean)),
    ];
    for (const model of models) {
      try {
        const r = await withTimeout(
          ai.models.generateContent({
            model,
            contents: toGemini(messages),
            config: { temperature: 0.3 },
          }),
          25000,
        );
        const text = typeof r.text === "function" ? r.text() : r.text;
        if (text) return text;
      } catch (e) {
        problems.push(
          `gemini ${model}: ${String(e?.message || e).slice(0, 150)}`,
        );
      }
    }
  } else {
    problems.push("gemini: chưa đặt GEMINI_API_KEY");
  }

  const okey = env("OPENROUTER_API_KEY");
  if (okey) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${okey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env("OPENROUTER_MODEL") || OPENROUTER_MODEL,
          messages,
          temperature: 0.3,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const text = data?.choices?.[0]?.message?.content;
      if (text) return text;
      problems.push("openrouter: phản hồi rỗng");
    } catch (e) {
      problems.push(`openrouter: ${String(e?.message || e).slice(0, 150)}`);
    }
  }
  throw new Error(problems.join(" | "));
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "method_not_allowed" });
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body && typeof body === "object" ? body : {};
  const question = String(body.question || "");
  const answer = String(body.answer || "");
  const key = String(body.key || "");
  const subject = String(body.subject || "");

  try {
    const text = await ask([
      {
        role: "system",
        content:
          "Bạn là gia sư giỏi, chữa bài tự luận từng bước bằng tiếng Việt. Viết công thức bằng LaTeX trong $...$. Đối chiếu với đáp án chuẩn; nếu đáp án chuẩn có vẻ sai, nói rõ lý do.",
      },
      {
        role: "user",
        content: `Môn: ${subject}\nĐề:\n${question}\nĐáp án chuẩn: ${key}\nHọc sinh chọn/trả lời: ${answer}\nHãy giải chi tiết và nhận xét bài làm.`,
      },
    ]);
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(503).json({ error: "ai_failed", message: err.message });
  }
}
