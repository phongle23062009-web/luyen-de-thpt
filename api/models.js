import { GoogleGenAI } from "@google/genai";

export default async function handler(req, res) {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({ error: "missing_key" });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    const models = [];
    for await (const m of pager) {
      models.push({
        name: m.name,
        methods: m.supportedActions || m.supportedGenerationMethods || [],
      });
    }
    const usable = models
      .filter((m) => m.methods.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    return res.status(200).json({ usable, all: models });
  } catch (err) {
    return res.status(500).json({
      error: "list_failed",
      message: err?.message || "Unknown error",
    });
  }
}
