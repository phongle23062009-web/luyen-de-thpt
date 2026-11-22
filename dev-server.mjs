import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Nạp biến môi trường từ .env.local (không ghi đè biến đã có sẵn)
function loadEnvFile(file) {
  if (!fs.existsSync(file)) {
    console.warn(
      `[dev] Không thấy ${path.basename(file)}, chỉ dùng biến môi trường hệ thống`,
    );
    return;
  }
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  console.log("[dev] Đã nạp .env.local");
}
loadEnvFile(path.join(ROOT, ".env.local"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 30 * 1024 * 1024) {
        reject(new Error("Dữ liệu gửi lên quá lớn"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Thêm status() và json() giống đối tượng res của Vercel
function adapt(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  adapt(res);
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // API: /api/<ten> -> api/<ten>.js
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname
        .slice("/api/".length)
        .replace(/[^a-zA-Z0-9-]/g, "");
      const file = path.join(ROOT, "api", `${name}.js`);
      if (!name || !fs.existsSync(file)) {
        return res.status(404).json({ error: "not_found", path: url.pathname });
      }
      const raw = await readBody(req);
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = {};
        }
      }
      req.body = body;
      // Import lại mỗi lần gọi để sửa api/*.js không cần khởi động lại server
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      return await mod.default(req, res);
    }

    // File tĩnh: index.html, app.js, style.css...
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    const file = path.normalize(path.join(ROOT, p));
    const hidden = path.basename(file).startsWith(".");
    if (
      !file.startsWith(ROOT) ||
      hidden ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    ) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    res.setHeader(
      "Content-Type",
      MIME[path.extname(file)] || "application/octet-stream",
    );
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error("[dev] Lỗi:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(
      JSON.stringify({
        error: "dev_server_error",
        message: err?.message || "Unknown",
      }),
    );
  }
});

server.listen(PORT, () => {
  console.log(`[dev] Đang chạy tại http://localhost:${PORT}`);
});
