// api/_ai.js — phần dùng chung cho chat, quick-tip, grade-explain, solve.
// Tên file bắt đầu bằng "_" nên Vercel không coi nó là một API riêng.
import { GoogleGenAI } from "@google/genai";

// Thứ tự thử: model mới nhất trước. Đặt GEMINI_MODEL trên Vercel để ép model ưu tiên.
export const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];
// Dự phòng OpenRouter (miễn phí), thử lần lượt: nhìn được ảnh + ngữ cảnh 1M → Gemma 4 → router ngẫu nhiên.
// Có thể đổi bằng biến OPENROUTER_MODEL (nhiều model cách nhau dấu phẩy).
export const OPENROUTER_DEFAULT_MODELS = [
  "nvidia/nemotron-3.5-super-vl:free",
  "google/gemma-4-26b-a4b-it:free",
  "openrouter/free",
];
export function openrouterModels() {
  const raw = env("OPENROUTER_MODEL");
  const list = raw ? raw.split(",") : OPENROUTER_DEFAULT_MODELS;
  return [...new Set(list.map((m) => m.trim()).filter(Boolean))];
}

export const env = (n) => (process.env[n] || "").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tách "data:image/png;base64,AAAA" thành { mimeType, data }. Nhận cả chuỗi base64 trần.
export function parseDataUrl(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const m = s.match(/^data:([^;]+);base64,(.+)$/s);
  if (m) return { mimeType: m[1], data: m[2] };
  return { mimeType: "image/jpeg", data: s };
}

export function clip(v, max) {
  return String(v ?? "").slice(0, max);
}

export function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  return body && typeof body === "object" ? body : {};
}

const errStatus = (e) => e?.status ?? e?.code ?? e?.error?.code ?? null;
const errMessage = (e) => String(e?.message || e?.error?.message || e || "");

function isBusy(e) {
  const s = errStatus(e);
  return (
    s === 503 ||
    s === 429 ||
    /high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|quota/i.test(
      errMessage(e),
    )
  );
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const e = new Error(
        `${label} không phản hồi sau ${Math.round(ms / 1000)}s`,
      );
      e.timeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function readText(r) {
  const t = typeof r?.text === "function" ? r.text() : r?.text;
  return typeof t === "string" ? t.trim() : "";
}

// Gemini 2.5 dùng thinkingBudget, Gemini 3.x dùng thinkingLevel.
// Hạ mức "suy nghĩ" là cách giảm thời gian chờ hiệu quả nhất.
function thinkingFor(model, level) {
  if (!level) return null;
  if (model.startsWith("gemini-2.5")) {
    const budget = { minimal: 0, low: 512, medium: 2048, high: 8192 }[level];
    // 2.5-pro không cho tắt hẳn
    return {
      thinkingBudget: model.includes("pro")
        ? Math.max(budget ?? 512, 512)
        : (budget ?? 512),
    };
  }
  if (model.startsWith("gemini-3")) {
    return { thinkingLevel: String(level).toUpperCase() };
  }
  return null;
}

// Gộp các lượt liên tiếp cùng vai trò, bắt đầu bằng lượt "user" (Gemini yêu cầu vậy).
// `images` (nếu có) là ảnh đính kèm của LƯỢT CUỐI CÙNG (câu hỏi/tin nhắn hiện tại).
function toGeminiContents(messages, images) {
  const out = [];
  for (const m of messages) {
    const text = String(m?.content ?? "");
    if (!text.trim()) continue;
    const role =
      m.role === "assistant" || m.role === "model" ? "model" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n\n" + text;
    else out.push({ role, parts: [{ text }] });
  }
  while (out.length && out[0].role === "model") out.shift();
  if (Array.isArray(images) && images.length && out.length) {
    const lastTurn = out[out.length - 1];
    if (lastTurn.role === "user") {
      images.forEach((img) => {
        if (img?.data) {
          lastTurn.parts.push({
            inlineData: {
              mimeType: img.mimeType || "image/jpeg",
              data: img.data,
            },
          });
        }
      });
    }
  }
  return out;
}

async function askGemini({
  system,
  messages,
  images,
  temperature,
  level,
  json,
  maxOutputTokens,
  perCallMs,
  deadline,
  problems,
}) {
  const key = env("GEMINI_API_KEY");
  if (!key) {
    problems.push("gemini: chưa đặt GEMINI_API_KEY");
    return null;
  }
  const ai = new GoogleGenAI({ apiKey: key });
  const contents = toGeminiContents(messages, images);
  const models = [
    ...new Set([env("GEMINI_MODEL"), ...GEMINI_MODELS].filter(Boolean)),
  ];

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 4000) {
        problems.push("gemini: hết thời gian cho phép");
        return null;
      }
      const config = { temperature };
      if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens;
      if (system) config.systemInstruction = system;
      if (json) config.responseMimeType = "application/json";
      const th = thinkingFor(model, level);
      if (th && attempt === 0) config.thinkingConfig = th;

      try {
        const r = await withTimeout(
          ai.models.generateContent({ model, contents, config }),
          Math.min(perCallMs, left),
          `gemini ${model}`,
        );
        const text = readText(r);
        if (text) return { text, model: `gemini:${model}` };
        problems.push(`gemini ${model}: phản hồi rỗng`);
        break;
      } catch (e) {
        problems.push(`gemini ${model}: ${errMessage(e).slice(0, 150)}`);
        // Model không nhận cấu hình suy nghĩ → thử lại cùng model, bỏ cấu hình đó
        if (
          attempt === 0 &&
          th &&
          (errStatus(e) === 400 || /thinking/i.test(errMessage(e)))
        )
          continue;
        // Bận / quá tải: thử lại 1 lần nếu còn thời gian
        if (
          attempt === 0 &&
          !e.timeout &&
          isBusy(e) &&
          deadline - Date.now() > 12000
        ) {
          await sleep(1500);
          continue;
        }
        break; // sang model kế tiếp
      }
    }
  }
  return null;
}

// Ảnh (nếu có) chỉ đính kèm vào NỘI DUNG CUỐI CÙNG (câu hỏi/tin nhắn hiện tại)
function toOpenRouterMessages(system, messages, images) {
  const mapped = messages.map((m) => ({
    role: m.role === "assistant" || m.role === "model" ? "assistant" : "user",
    content: String(m.content ?? ""),
  }));
  if (Array.isArray(images) && images.length && mapped.length) {
    const last = mapped[mapped.length - 1];
    if (last.role === "user") {
      last.content = [
        { type: "text", text: last.content },
        ...images
          .filter((img) => img?.data)
          .map((img) => ({
            type: "image_url",
            image_url: {
              url: `data:${img.mimeType || "image/jpeg"};base64,${img.data}`,
            },
          })),
      ];
    }
  }
  return [...(system ? [{ role: "system", content: system }] : []), ...mapped];
}

async function callOpenRouterOnce({
  model,
  system,
  messages,
  images,
  temperature,
  maxOutputTokens,
  timeoutMs,
}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("OPENROUTER_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
        reasoning: { effort: "low" }, // model có chế độ suy luận thì giữ ở mức thấp cho nhanh
        messages: toOpenRouterMessages(system, messages, images),
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("phản hồi rỗng");
    return { text: String(text).trim(), model: `openrouter:${model}` };
  } catch (e) {
    throw new Error(
      e?.name === "AbortError" ? "hết thời gian chờ" : errMessage(e),
    );
  } finally {
    clearTimeout(timer);
  }
}

async function askOpenRouter({
  system,
  messages,
  images,
  temperature,
  maxOutputTokens,
  deadline,
  problems,
}) {
  for (const model of openrouterModels()) {
    const left = deadline - Date.now();
    if (left < 4000) {
      problems.push("openrouter: hết thời gian cho phép");
      break;
    }
    try {
      return await callOpenRouterOnce({
        model,
        system,
        messages,
        images,
        temperature,
        maxOutputTokens,
        timeoutMs: Math.min(12000, left - 300),
      });
    } catch (e) {
      problems.push(`openrouter ${model}: ${errMessage(e).slice(0, 120)}`);
    }
  }
  return null;
}

/**
 * Hỏi AI: Gemini trước (nhiều model), nếu hết lượt/bận thì lần lượt thử các model OpenRouter.
 * Tổng thời gian ≤ totalMs (phải nhỏ hơn maxDuration của Vercel).
 */
export async function askAI({
  system = "",
  messages,
  images, // tùy chọn: [{ mimeType, data(base64, không tiền tố data:) }], đính kèm vào tin nhắn cuối
  temperature = 0.3,
  level = "low",
  json = false,
  maxOutputTokens = 0,
  perCallMs = 20000,
  totalMs = 50000,
  openrouterMs = 20000,
}) {
  const deadline = Date.now() + totalMs;
  const hasOR = !!env("OPENROUTER_API_KEY");
  const problems = [];

  // Chừa sẵn thời gian cho OpenRouter để dự phòng thật sự chạy được
  const geminiDeadline = hasOR ? deadline - openrouterMs : deadline;
  const g = await askGemini({
    system,
    messages,
    images,
    temperature,
    level,
    json,
    maxOutputTokens,
    perCallMs,
    deadline: geminiDeadline,
    problems,
  });
  if (g) return g;

  if (!hasOR) {
    problems.push("openrouter: chưa đặt OPENROUTER_API_KEY");
  } else {
    const o = await askOpenRouter({
      system,
      messages,
      images,
      temperature,
      maxOutputTokens,
      deadline,
      problems,
    });
    if (o) return o;
  }
  const err = new Error(problems.join(" | "));
  err.problems = problems;
  throw err;
}

export function sendAIError(res, err) {
  console.error("[ai] thất bại:", err?.message);
  return res
    .status(503)
    .json({ error: "ai_failed", message: String(err?.message || "") });
}
