import { GoogleGenAI, Type } from "@google/genai";

// ===== Cấu hình =====
const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];
const OPENROUTER_DEFAULT_MODEL = "google/gemma-4-26b-a4b-it:free";

// Vercel giới hạn 60 giây cho mỗi lần gọi hàm, nên tổng thời gian phải nhỏ hơn
const TOTAL_BUDGET_MS = 55000;
const GEMINI_MAX_MS = 32000; // mỗi lần gọi Gemini; quá chậm thì sang model nhanh hơn / dự phòng
const OPENROUTER_MAX_MS = 15000;

/* ===================== Tiện ích ===================== */

function env(name) {
  return (process.env[name] || "").trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function errStatus(err) {
  return err?.status ?? err?.code ?? err?.error?.code ?? null;
}

function errMessage(err) {
  return String(err?.message || err?.error?.message || "");
}

// Lỗi tạm thời: đáng thử lại
function isBusy(err) {
  const s = errStatus(err);
  return (
    s === 503 ||
    s === 429 ||
    /high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(
      errMessage(err),
    )
  );
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(
        `${label} không phản hồi sau ${Math.round(ms / 1000)} giây`,
      );
      e.timeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseBase64Image(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (match) return { mimeType: match[1], data: match[2] };
  return { mimeType: "image/jpeg", data: raw.trim() };
}

function extractFirstJsonBlock(text) {
  if (typeof text !== "string") return null;
  const cleaned = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

// Parse JSON; nếu lỗi do dấu \ của LaTeX (ví dụ \frac) thì tự escape rồi thử lại
function parseExamJson(block) {
  try {
    return JSON.parse(block);
  } catch {
    const fixed = block.replace(/\\(?!["\\])/g, "\\\\");
    return JSON.parse(fixed);
  }
}

function getResponseText(response) {
  if (!response) return "";
  if (typeof response.text === "function") return response.text() || "";
  if (typeof response.text === "string") return response.text;
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text || "").join("");
  return "";
}

/* ===================== Schema & cứu JSON ===================== */

// Schema ép Gemini trả JSON đúng cú pháp (không lỗi dấu \ của LaTeX, không thừa chữ)
const EXAM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    subject: { type: Type.STRING },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          part: { type: Type.STRING, enum: ["mcq", "tf", "short"] },
          number: { type: Type.INTEGER },
          prompt: { type: Type.STRING },
          options: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              A: { type: Type.STRING },
              B: { type: Type.STRING },
              C: { type: Type.STRING },
              D: { type: Type.STRING },
            },
          },
          statements: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              a: { type: Type.STRING },
              b: { type: Type.STRING },
              c: { type: Type.STRING },
              d: { type: Type.STRING },
            },
          },
          // mcq: "A".."D" | tf: "true,false,true,false" | short: "12.5"
          answer: { type: Type.STRING, nullable: true },
          // true nếu đáp án/phương án nhiễu do AI tự giải, tự tạo
          solved: { type: Type.BOOLEAN },
          figure: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              page: { type: Type.INTEGER },
              // [ymin, xmin, ymax, xmax], tọa độ 0–1000
              box: { type: Type.ARRAY, items: { type: Type.INTEGER } },
            },
          },
        },
        required: ["part", "prompt"],
      },
    },
  },
  required: ["questions"],
};

// Phản hồi bị cắt giữa chừng (hết token): nhặt lại các câu đã hoàn chỉnh
function salvageQuestions(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "");
  const key = cleaned.indexOf('"questions"');
  if (key === -1) return null;
  const arrStart = cleaned.indexOf("[", key);
  if (arrStart === -1) return null;

  const questions = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;
  for (let i = arrStart + 1; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          questions.push(parseExamJson(cleaned.slice(objStart, i + 1)));
        } catch {
          /* bỏ qua câu hỏng */
        }
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }
  return questions.length ? { questions } : null;
}

/* ===================== Prompt ===================== */

function buildPrompt({ text, subject, format, mode, counts, imageCount }) {
  const safeSubject = subject || "Tổng hợp THPT";
  const isShort = format === "short";
  const isGen = mode === "gen";
  const p1 = Number(counts?.p1) || 0;
  const p2 = Number(counts?.p2) || 0;
  const p3 = Number(counts?.p3) || 0;

  let countLine;
  if (isShort) {
    countLine =
      p1 > 0
        ? `Số câu trắc nghiệm cần: ${p1} (loại mcq).`
        : "Lấy TẤT CẢ các câu có thể đưa về trắc nghiệm 4 lựa chọn (loại mcq).";
  } else if (p1 || p2 || p3) {
    countLine = `Số câu gợi ý: Phần I (mcq) = ${p1}, Phần II (tf) = ${p2}, Phần III (short) = ${p3}.`;
  } else {
    countLine =
      "Lấy TẤT CẢ các câu có thể đưa về trắc nghiệm, tự phân loại hợp lý theo các loại bên dưới.";
  }

  const head = [
    "Bạn là giáo viên giàu kinh nghiệm biên soạn và bóc tách đề thi THPT Việt Nam (chương trình 2018).",
    `Môn học: ${safeSubject}.`,
    isGen
      ? "Chế độ: TẠO ĐỀ MỚI dựa trên nội dung tài liệu/chủ đề đầu vào."
      : "Chế độ: TÁCH ĐỀ TỪ TÀI LIỆU. Giữ nguyên nội dung, số liệu, dữ kiện của đề gốc. Được phép chuyển bài tập tự luận thành câu trắc nghiệm theo quy tắc bên dưới, nhưng không tự sáng tác bài mới.",
    imageCount > 0
      ? `Có ${imageCount} trang ảnh đính kèm, đánh số từ 0 đến ${imageCount - 1}.`
      : "Không có ảnh đính kèm.",
    countLine,
    text ? `Văn bản bổ sung từ người dùng:\n${text}` : "",
    "",
    "CÁC LOẠI CÂU (trường part):",
    '- "mcq": có 4 lựa chọn A, B, C, D, chỉ 1 đáp án đúng. Điền options = {A, B, C, D}.',
    isShort
      ? "- Định dạng đề này CHỈ gồm trắc nghiệm: mọi câu đều phải là mcq (không dùng tf hay short)."
      : '- "tf": có 4 ý a, b, c, d, mỗi ý Đúng hoặc Sai. Điền statements = {a, b, c, d} (thiếu ý thì để chuỗi rỗng).',
    isShort
      ? ""
      : '- "short": yêu cầu điền kết quả (số hoặc chữ ngắn), KHÔNG có lựa chọn A–D, không điền options.',
    "",
  ];

  const extractTask = [
    "NHIỆM VỤ (tách đề):",
    "1. Đọc kỹ TOÀN BỘ trang ảnh và văn bản. Lấy mọi câu hỏi/bài tập có thể làm thành câu luyện tập, không bỏ sót câu ở cuối trang hay câu có nhiều ý con.",
    "2. Câu ĐÃ có dạng trắc nghiệm trong tài liệu: giữ nguyên nội dung và phân loại đúng mcq / tf / short.",
    "3. Câu CHƯA có dạng trắc nghiệm (bài tập tự luận: Tìm, Tính, Giải, Rút gọn, Hoàn thành phương trình phản ứng, ...) thì TỰ CHUYỂN thành câu luyện tập:",
    '   - Bài có nhiều ý a), b), c), ...: tách MỖI Ý thành một câu riêng. Phần prompt phải đủ ngữ cảnh để hiểu độc lập, ví dụ: "Bài 1a. Tìm nguyên hàm của hàm số $f(x) = x^4$."',
    isShort
      ? "   - Tự giải rồi viết 4 phương án: 1 đúng + 3 nhiễu hợp lý (dựa trên lỗi sai thường gặp như sai dấu, quên hệ số, sai chỉ số, quên hằng số C). Đặt đáp án đúng ở vị trí NGẪU NHIÊN trong A–D."
      : "   - Kết quả là MỘT SỐ duy nhất: dùng short (answer là số).",
    isShort
      ? ""
      : "   - Kết quả là biểu thức, công thức, tên chất hoặc một kết luận: dùng mcq. Tự giải rồi viết 4 phương án: 1 đúng + 3 nhiễu hợp lý (lỗi sai thường gặp: sai dấu, quên hệ số, sai chỉ số, quên hằng số C). Đặt đáp án đúng ở vị trí NGẪU NHIÊN trong A–D.",
    "   - Bài yêu cầu hoàn thành phương trình hóa học: hỏi sản phẩm hoặc chất còn thiếu dưới dạng mcq.",
    "4. BỎ QUA: phần lý thuyết/công thức cần nhớ, tiêu đề, bảng cần điền, lời dẫn, và yêu cầu không rút ra được đáp án ngắn (chứng minh, vẽ đồ thị, giải thích dài). Nếu một câu lặp lại y nguyên trên cùng trang thì chỉ lấy một lần.",
  ];

  const genTask = [
    "NHIỆM VỤ (tạo đề mới):",
    "1. Đọc kỹ TOÀN BỘ trang ảnh và văn bản làm cơ sở kiến thức.",
    "2. Soạn đủ số câu gợi ý, đúng cấu trúc các loại ở trên, bám sát nội dung tài liệu. Phương án nhiễu phải hợp lý, đáp án đúng đặt ở vị trí ngẫu nhiên.",
    "3. Nếu tài liệu có sẵn câu hỏi, có thể dùng lại và biến đổi số liệu.",
  ];

  const common = [
    `${isGen ? "4" : "5"}. ĐÁP ÁN (trường answer, luôn là chuỗi): mcq = một chữ cái A/B/C/D; tf = bốn giá trị true/false theo thứ tự a,b,c,d ngăn cách bởi dấu phẩy (ví dụ "true,false,true,false"); short = số dùng dấu chấm thập phân (ví dụ 12.5) hoặc chữ ngắn. Ưu tiên đáp án có trong tài liệu; nếu không có thì TỰ GIẢI cẩn thận từng bước rồi mới chọn; chỉ ghi null khi thật sự không xác định được.`,
    `${isGen ? "5" : "6"}. solved = true khi đáp án do bạn tự giải hoặc phương án nhiễu do bạn tự tạo; solved = false khi câu hỏi và đáp án lấy nguyên từ tài liệu.`,
    `${isGen ? "6" : "7"}. Công thức toán, lý, hóa đặt trong $...$ (ví dụ $\\frac{1}{2}$; hóa học: $\\mathrm{CH_3NH_2}$, $\\mathrm{H_2SO_4}$). Trong chuỗi JSON, mọi dấu gạch chéo ngược phải viết thành hai dấu \\\\.`,
    `${isGen ? "7" : "8"}. HÌNH MINH HỌA: nếu câu có hình đi kèm (công thức cấu tạo, đồ thị, hình học, sơ đồ, thí nghiệm, bảng dạng ảnh) nằm dưới hoặc bên cạnh câu hỏi, hoặc các lựa chọn là hình vẽ, hãy đặt figure = {"page": số trang, "box": [ymin, xmin, ymax, xmax]} với tọa độ nguyên 0–1000 (gốc ở góc trên trái của trang, ymin/ymax theo chiều cao, xmin/xmax theo chiều rộng). Box chỉ bao phần hình (chừa lề nhỏ), không bao chữ của câu hỏi. Chữ của câu vẫn phải gõ đầy đủ trong prompt, giữ cả lời dẫn như "có công thức như sau" hoặc "như hình vẽ". Câu không có hình thì figure = null.`,
    `${isGen ? "8" : "9"}. Chỉ trả về MỘT đối tượng JSON thuần túy, không lời dẫn, không markdown.`,
    "",
    "Mẫu JSON (chỉ là ví dụ về cấu trúc):",
    JSON.stringify(
      {
        title: "Đề luyện tập THPT",
        subject: safeSubject,
        questions: [
          {
            part: "mcq",
            number: 1,
            prompt: "Nội dung câu trắc nghiệm...",
            options: { A: "...", B: "...", C: "...", D: "..." },
            answer: "A",
            solved: false,
            figure: null,
          },
          {
            part: "tf",
            number: 2,
            prompt: "Nội dung câu đúng/sai...",
            statements: { a: "Ý a...", b: "Ý b...", c: "Ý c...", d: "Ý d..." },
            answer: "true,false,true,false",
            solved: true,
            figure: { page: 0, box: [80, 120, 520, 450] },
          },
          {
            part: "short",
            number: 3,
            prompt: "Nội dung câu trả lời ngắn...",
            answer: "12.5",
            solved: true,
            figure: null,
          },
        ],
      },
      null,
      2,
    ),
  ];

  return [...head, ...(isGen ? genTask : extractTask), ...common]
    .filter((line) => line !== "")
    .join("\n");
}

/* ===================== Gemini ===================== */

async function runGemini(parts, apiKey, deadline) {
  const ai = new GoogleGenAI({ apiKey });
  const models = [
    ...new Set([env("GEMINI_MODEL"), ...GEMINI_MODELS].filter(Boolean)),
  ];
  const tried = [];
  let lastErr = null;
  let useSchema = true; // nếu Gemini từ chối schema (lỗi 400) thì thử lại không schema
  let useThinking = true; // nếu model từ chối cấu hình suy nghĩ thì bỏ đi
  const thinkingEnv = env("GEMINI_THINKING");
  const thinkingBudget =
    thinkingEnv !== "" && !Number.isNaN(Number(thinkingEnv))
      ? Number(thinkingEnv)
      : 512; // Gemini 2.5: ngân sách suy nghĩ nhỏ cho nhanh (việc tự giải đã có /api/solve lo)
  // Gemini 3.x dùng thinkingLevel (low/medium/high), mặc định low để giảm độ trễ
  const thinkingLevel = (env("GEMINI_THINKING_LEVEL") || "low").toUpperCase();

  for (const model of models) {
    tried.push(model);
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 5000) {
        throw Object.assign(new Error("Gemini hết thời gian cho phép"), {
          timeout: true,
          tried,
        });
      }

      const config = {
        responseMimeType: "application/json",
        temperature: 0.2,
        maxOutputTokens: 16000,
      };
      if (useSchema) config.responseSchema = EXAM_SCHEMA;
      // 2.5 dùng thinkingBudget, 3.x dùng thinkingLevel
      if (useThinking) {
        if (model.startsWith("gemini-2.5")) {
          config.thinkingConfig = { thinkingBudget };
        } else if (model.startsWith("gemini-3")) {
          config.thinkingConfig = { thinkingLevel };
        }
      }

      try {
        const response = await withTimeout(
          ai.models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config,
          }),
          Math.min(GEMINI_MAX_MS, left),
          "Gemini",
        );
        const finish = response?.candidates?.[0]?.finishReason;
        if (finish && finish !== "STOP") {
          console.warn("[extract] Gemini finishReason:", finish);
        }
        return { text: getResponseText(response), model: `gemini:${model}` };
      } catch (err) {
        lastErr = err;
        // Cấu hình suy nghĩ bị từ chối: thử lại cùng model, không gửi cấu hình đó
        if (useThinking && /thinking/i.test(errMessage(err))) {
          console.warn(
            "[extract] Bỏ thinkingConfig:",
            errMessage(err).slice(0, 200),
          );
          useThinking = false;
          continue;
        }
        // Schema bị từ chối: thử lại cùng model nhưng không dùng schema
        if (
          useSchema &&
          (errStatus(err) === 400 || /schema/i.test(errMessage(err)))
        ) {
          console.warn(
            "[extract] Bỏ responseSchema:",
            errMessage(err).slice(0, 200),
          );
          useSchema = false;
          continue;
        }
        // Quá chậm: chỉ thử model kế tiếp nếu còn đủ thời gian, nếu không chuyển sang AI dự phòng
        if (err.timeout) {
          if (deadline - Date.now() < 15000)
            throw Object.assign(err, { tried });
          break;
        }
        // Lỗi tạm thời: thử lại đúng 1 lần nếu còn thời gian
        if (isBusy(err) && attempt === 0 && deadline - Date.now() > 15000) {
          await sleep(2000);
          continue;
        }
        // Lỗi khác (model không còn, khóa sai...): sang model kế tiếp
        break;
      }
    }
  }
  throw Object.assign(lastErr || new Error("Gemini thất bại"), { tried });
}

/* ===================== OpenRouter (dự phòng) ===================== */

async function callOpenRouter(images, prompt, model, key, timeoutMs) {
  const content = [
    ...images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.data}` },
    })),
    { type: "text", text: prompt },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      `OpenRouter: ${err.name === "AbortError" ? "hết thời gian chờ" : err.message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `OpenRouter ${res.status}: ${data?.error?.message || "lỗi không rõ"}`,
    );
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter: phản hồi rỗng");
  return text;
}

/* ===================== Handler ===================== */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== "object") body = {};

  const images = Array.isArray(body.images) ? body.images : [];
  const text = typeof body.text === "string" ? body.text : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  const format = body.format === "short" ? "short" : "thpt";
  const mode = body.mode === "gen" ? "gen" : "extract";
  const counts =
    body.counts && typeof body.counts === "object" ? body.counts : {};

  const parsedImages = images.map(parseBase64Image).filter(Boolean);
  if (parsedImages.length === 0 && !text.trim()) {
    return res.status(400).json({
      error: "empty_input",
      hint: "Không có ảnh hoặc văn bản nào được gửi lên.",
    });
  }

  const prompt = buildPrompt({
    text,
    subject,
    format,
    mode,
    counts,
    imageCount: parsedImages.length,
  });
  const parts = parsedImages.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
  }));
  parts.push({ text: prompt });

  const problems = [];
  let rawText = "";
  let usedModel = "";

  // 1) Gemini (ưu tiên)
  const geminiKey = env("GEMINI_API_KEY");
  if (!geminiKey) {
    problems.push("gemini: chưa đặt GEMINI_API_KEY");
  } else {
    try {
      const r = await runGemini(parts, geminiKey, deadline);
      rawText = r.text;
      usedModel = r.model;
    } catch (err) {
      problems.push(
        `gemini: ${errMessage(err).slice(0, 200) || "lỗi không rõ"}`,
      );
    }
  }

  // 2) OpenRouter: chỉ thử khi còn đủ thời gian
  if (!usedModel) {
    const key = env("OPENROUTER_API_KEY");
    const model = env("OPENROUTER_MODEL") || OPENROUTER_DEFAULT_MODEL;
    const left = deadline - Date.now();
    if (!key) {
      problems.push("openrouter: chưa đặt OPENROUTER_API_KEY");
    } else if (left < 8000) {
      problems.push("openrouter: bỏ qua vì đã hết thời gian chờ");
    } else {
      try {
        rawText = await callOpenRouter(
          parsedImages,
          prompt,
          model,
          key,
          Math.min(OPENROUTER_MAX_MS, left - 2000),
        );
        usedModel = `openrouter:${model}`;
      } catch (err) {
        problems.push(errMessage(err).slice(0, 200));
      }
    }
  }

  if (!usedModel) {
    const busy = problems.some((p) =>
      /quá tải|high demand|UNAVAILABLE|429|503|hết thời gian|không phản hồi|chưa kịp|hết thời gian cho phép/i.test(
        p,
      ),
    );
    console.error("[extract] Thất bại:", problems);
    return res.status(busy ? 503 : 500).json({
      error: "gemini_request_failed",
      message: problems.join(" | "),
      hint: busy
        ? "AI đang chậm hoặc quá tải. Thử lại sau vài phút, hoặc chọn ít trang hơn."
        : "Xem message: sửa khóa hoặc tên model tương ứng trên Vercel, rồi Redeploy.",
    });
  }

  let parsedExam = null;
  const jsonBlock = extractFirstJsonBlock(rawText);
  if (jsonBlock) {
    try {
      parsedExam = parseExamJson(jsonBlock);
    } catch (err) {
      console.error("[extract] Lỗi parse JSON:", err?.message);
    }
  }
  // JSON bị cắt giữa chừng: giữ lại các câu đã hoàn chỉnh thay vì báo lỗi
  if (!parsedExam) {
    const salvaged = salvageQuestions(rawText);
    if (salvaged) {
      console.warn(
        `[extract] Cứu được ${salvaged.questions.length} câu từ JSON bị cắt`,
      );
      parsedExam = { ...salvaged, _partial: true };
    }
  }
  if (!parsedExam) {
    console.error(
      "[extract] Không có JSON. Đầu phản hồi:",
      rawText.slice(0, 300),
    );
    return res.status(422).json({
      error: "invalid_json",
      model: usedModel,
      hint: "AI không trả về JSON đầy đủ (có thể bị cắt). Thử lại hoặc chọn ít trang hơn.",
    });
  }

  if (!parsedExam || typeof parsedExam !== "object") {
    return res.status(422).json({ error: "invalid_json", model: usedModel });
  }

  return res.status(200).json({ ...parsedExam, _model: usedModel });
}
