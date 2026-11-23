// app.js — LuyệnĐề THPT (frontend thuần, không đăng nhập, không Firebase)
// Khớp với index.html và các API: /api/extract, /api/grade-explain, /api/quick-tip, /api/chat

const MAX_PAGES = 20; // tối đa số trang nạp vào
const MAX_SEND = 8; // tối đa số trang chọn cùng lúc (chế độ tạo đề mới)
const RECENT_KEY = "recent_exams";
const RECENT_LIMIT = 5;
const LAYOUT_KEY = "layout_mode";
const EXTRACT_CONCURRENCY = 2; // số trang đọc song song (free tier hay bị giới hạn lượt gọi/phút)

// Số câu theo cấu trúc đề THPT (Phần I / II / III)
const SUBJECT_COUNTS = {
  toan: { p1: 12, p2: 4, p3: 6 },
  ly: { p1: 18, p2: 4, p3: 6 },
  hoa: { p1: 18, p2: 4, p3: 6 },
  sinh: { p1: 18, p2: 4, p3: 6 },
  gdktpl: { p1: 18, p2: 4, p3: 6 },
  tin: { p1: 18, p2: 4, p3: 6 },
  congnghe: { p1: 18, p2: 4, p3: 6 },
  su: { p1: 24, p2: 4, p3: 0 },
  dia: { p1: 24, p2: 4, p3: 0 },
  anh: { p1: 40, p2: 0, p3: 0 },
};

const TYPE_ORDER = { mcq: 1, tf: 2, short: 3 };

// Kiểu làm bài
const MODE_LABEL = {
  quick: "Luyện tập nhanh",
  mock: "Thi thử THPT",
  game: "Trò chơi",
};
const RECORD_KEY = "game_records";
// Trò chơi: thời gian mỗi câu theo độ khó (tối đa 5 phút)
const GAME_TIME_SEC = { 1: 60, 2: 150, 3: 300 };
const DIFF_LABEL = { 1: "Dễ", 2: "Vừa", 3: "Khó" };
const GAME_NEXT_DELAY_MS = 1800; // chờ xem kết quả rồi tự sang câu sau

const state = {
  pages: [], // { canvas, selected }
  current: null, // đề đang làm
  idx: 0, // chỉ số câu hiện tại
  tab: "quick", // tab lời giải đang mở: quick (giải nhanh) | essay (chi tiết từng bước)
  explain: {}, // cache lời giải theo chỉ số câu
  quick: {}, // cache mẹo nhanh theo chỉ số câu
  chat: {}, // hội thoại theo chỉ số câu
  extracting: false,
  explaining: false,
  chatting: false,
  quickLoading: {}, // câu đang chờ giải nhanh
  gameNextTimer: null,
  autoTimer: null,
};

/* ============ Tiện ích DOM ============ */

const $ = (id) => document.getElementById(id);

function on(id, evt, fn) {
  const el = $(id);
  if (el) el.addEventListener(evt, fn);
}

function setHidden(el, hidden) {
  if (el) el.classList.toggle("hidden", hidden);
}

function toast(message, type = "info") {
  const box = $("toast-container");
  if (!box) {
    alert(message);
    return;
  }
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function setLoading(on, text = "Đang xử lý...") {
  const overlay = $("loading-overlay");
  if (!overlay) return;
  $("loading-text").textContent = text;
  setHidden(overlay, !on);
}

function typeset(nodes) {
  const M = window.MathJax;
  if (!M) return;
  const list = nodes.filter(Boolean);
  if (!list.length) return;
  const run = () => (M.typesetPromise ? M.typesetPromise(list) : null);
  if (M.typesetPromise) {
    run()?.catch(() => {});
  } else if (M.startup && M.startup.promise) {
    M.startup.promise.then(run).catch(() => {});
  }
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Mã băm ngắn để nhận ra "cùng một đề" (dùng cho kỷ lục)
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++)
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ============ Hiển thị Markdown của AI (không còn ký tự ** thừa) ============ */

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Chuyển Markdown cơ bản (đậm, nghiêng, code, tiêu đề, danh sách) sang HTML an toàn.
// Công thức $...$, $$...$$, \(...\), \[...\] được giữ nguyên cho MathJax.
function renderMarkdown(src) {
  const math = [];
  let s = String(src ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(
    /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\s)[^$\n]+?\$/g,
    (m) => {
      math.push(m);
      return `\uE000${math.length - 1}\uE001`;
    },
  );
  s = escapeHtml(s);

  const inline = (t) =>
    t
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+?)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, "$1<em>$2</em>");

  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join("<br>"))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const openList = (kind) => {
    if (list !== kind) {
      closeList();
      out.push(`<${kind}>`);
      list = kind;
    }
  };

  for (const raw of s.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) {
      flushPara();
      closeList();
    } else if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*)$/))) {
      flushPara();
      closeList();
      out.push(`<h4>${inline(m[1])}</h4>`);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push("<hr>");
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      openList("ul");
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      openList("ol");
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara();
  closeList();

  return out
    .join("")
    .replace(/\uE000(\d+)\uE001/g, (_, n) => escapeHtml(math[Number(n)]));
}

function setMarkdown(el, text) {
  el.style.whiteSpace = "normal";
  el.classList.add("md");
  el.innerHTML = renderMarkdown(text);
}

function setPlain(el, text) {
  el.classList.remove("md");
  el.style.whiteSpace = "";
  el.textContent = text;
}

// Chạy fn(item, index) với tối đa `limit` việc song song
async function runPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const k = next++;
        await fn(items[k], k);
      }
    },
  );
  await Promise.all(workers);
}

/* ============ Gọi API ============ */

async function postJSON(url, body, timeoutMs = 100000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: err.name === "AbortError" ? "timeout" : "network",
      message: err.message,
    };
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: data?.error || `http_${res.status}`,
      data,
    };
  }
  return { ok: true, data };
}

function errorMessage(r) {
  const known = {
    missing_key: "Chưa cấu hình khóa AI trên máy chủ",
    invalid_json: "AI trả về chưa đúng định dạng, thử lại với ít trang hơn",
    empty_input: "Chưa có ảnh hoặc văn bản để xử lý",
    network: "Không kết nối được máy chủ",
    timeout: "AI trả lời quá lâu, hãy thử lại hoặc chọn ít trang hơn",
    ai_failed: "AI đang bận hoặc đã hết lượt miễn phí, hãy thử lại sau ít phút",
    http_429: "AI đang bị giới hạn lượt gọi, hãy đợi một chút rồi thử lại",
    http_503: "AI đang quá tải, hãy thử lại sau ít phút",
    http_413: "Dữ liệu quá lớn, hãy chọn ít trang hơn",
    http_404:
      "Không tìm thấy API, kiểm tra thư mục api/ đã được đẩy lên GitHub",
  };
  let msg = known[r.error];
  if (!msg) {
    msg =
      r.error === "gemini_request_failed"
        ? `Lỗi AI: ${r.data?.message || "không rõ"}`
        : `Lỗi: ${r.error || "không xác định"}`;
  }
  if (r.error === "ai_failed" && r.data?.message) {
    console.warn("[ai_failed]", r.data.message);
    msg += ` (${String(r.data.message).slice(0, 160)})`;
  }
  const hint = r.data?.hint;
  return hint ? `${msg}. ${hint}` : msg;
}

/* ============ Xử lý ảnh ============ */

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

// Thu nhỏ canvas và trả về chuỗi base64 JPEG (không có tiền tố data:)
function compressCanvas(canvas, maxSide = 1400, quality = 0.7) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const out = newCanvas(canvas.width * scale, canvas.height * scale);
  out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", quality).split(",")[1];
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("không đọc được ảnh"));
    };
    img.src = url;
  });
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

// Tách "data:image/jpeg;base64,AAAA" thành chuỗi base64 trần, để gửi lên server
function stripDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:[^;]+;base64,(.+)$/s);
  return m ? m[1] : null;
}

// Cắt hình minh họa theo box [ymin, xmin, ymax, xmax] tọa độ 0–1000 trên trang
function cropFigure(fig, page) {
  if (!fig || typeof fig !== "object" || !Array.isArray(fig.box)) return null;
  if (fig.box.length < 4 || !page) return null;
  const src = page.canvas;
  const [ya, xa, yb, xb] = fig.box.map(Number);
  if ([ya, xa, yb, xb].some((n) => Number.isNaN(n))) return null;

  // Tọa độ chuẩn 0–1000; nếu AI trả 0–1 thì quy đổi, và chừa lề nhỏ để không cắt sát hình
  const k = Math.max(ya, xa, yb, xb) <= 1.5 ? 1000 : 1;
  const pad = 0.015;
  const y0 = (Math.min(ya, yb) * k) / 1000 - pad;
  const y1 = (Math.max(ya, yb) * k) / 1000 + pad;
  const x0 = (Math.min(xa, xb) * k) / 1000 - pad;
  const x1 = (Math.max(xa, xb) * k) / 1000 + pad;

  const sx = clamp01(x0) * src.width;
  const sy = clamp01(y0) * src.height;
  const sw = clamp01(x1) * src.width - sx;
  const sh = clamp01(y1) * src.height - sy;
  if (sw < 24 || sh < 24) return null;

  const out = newCanvas(sw, sh);
  out
    .getContext("2d")
    .drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.8);
}

/* ============ Nạp tài liệu & lưới trang ============ */

async function addPdfPages(file) {
  if (!window.pdfjsLib) {
    throw new Error("thư viện đọc PDF chưa tải xong, hãy tải lại trang");
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await window.pdfjsLib.getDocument({ data }).promise;
  let count = 0;
  for (let n = 1; n <= pdf.numPages && state.pages.length < MAX_PAGES; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1600 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = newCanvas(vp.width, vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp })
      .promise;
    state.pages.push({ canvas, selected: false, source: file.name });
    count++;
  }
  return count;
}

async function addImagePage(file) {
  const img = await loadImageFile(file);
  const scale = Math.min(
    1,
    1600 / Math.max(img.naturalWidth, img.naturalHeight),
  );
  const canvas = newCanvas(img.naturalWidth * scale, img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  state.pages.push({ canvas, selected: false, source: file.name });
}

// replace = true: tài liệu mới thay hẳn các trang của tài liệu cũ (tránh nhầm trang cũ với đề mới).
// Chụp ảnh nhiều trang (camera) thì thêm vào để ghép thành một tài liệu.
async function loadFiles(files, { replace = false } = {}) {
  if (!files.length) return;
  setLoading(true, "Đang đọc tài liệu...");
  let added = 0;
  const oldPages = state.pages;
  if (replace) state.pages = [];
  try {
    for (const file of files) {
      if (state.pages.length >= MAX_PAGES) {
        toast(`Tối đa ${MAX_PAGES} trang, phần còn lại đã bỏ qua.`, "warn");
        break;
      }
      const isPdf =
        file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (isPdf) {
        added += await addPdfPages(file);
      } else if (file.type.startsWith("image/")) {
        await addImagePage(file);
        added++;
      } else {
        toast(`Không hỗ trợ file: ${file.name}`, "warn");
      }
    }
  } catch (err) {
    toast(`Không đọc được file: ${err.message || err}`, "error");
  } finally {
    setLoading(false);
  }

  if (!added && replace) state.pages = oldPages; // không đọc được file mới thì giữ lại tài liệu cũ
  if (added) {
    if (!state.pages.some((p) => p.selected)) {
      state.pages.slice(0, 3).forEach((p) => (p.selected = true));
    }
    setHidden($("page-grid-section"), false);
    renderPageGrid();
    if (replace && oldPages.length) {
      const names = [...new Set(files.map((f) => f.name))].join(", ");
      toast(`Đã thay tài liệu cũ bằng: ${names} (${added} trang).`, "info");
    }
  }
}

async function onFilesChosen(e) {
  const input = e.target;
  const files = Array.from(input.files || []);
  const append = input.id === "camera-input";
  input.value = "";
  await loadFiles(files, { replace: !append });
}

// Dòng ghi rõ đang dùng tài liệu nào, để không nhầm với tài liệu cũ
function renderPageNote() {
  const grid = $("page-grid");
  if (!grid || !grid.parentNode) return;
  let note = $("page-source-note");
  if (!note) {
    note = document.createElement("div");
    note.id = "page-source-note";
    note.style.cssText = "margin:0 0 8px;font-size:13px;opacity:.85";
    grid.parentNode.insertBefore(note, grid);
  }
  const names = [...new Set(state.pages.map((p) => p.source).filter(Boolean))];
  note.textContent = state.pages.length
    ? `Tài liệu đang dùng: ${names.join(", ") || "ảnh chụp"} · ${state.pages.length} trang`
    : "";
}

function renderPageGrid() {
  const grid = $("page-grid");
  if (!grid) return;
  grid.replaceChildren();
  state.pages.forEach((page, i) => {
    const tile = document.createElement("div");
    tile.className = "page-tile" + (page.selected ? " selected" : "");

    const thumb = document.createElement("canvas");
    const h = 180;
    thumb.height = h;
    thumb.width = Math.round((h * page.canvas.width) / page.canvas.height);
    thumb.getContext("2d").drawImage(page.canvas, 0, 0, thumb.width, h);

    const label = document.createElement("span");
    label.className = "page-label";
    label.textContent = `Trang ${i + 1}`;

    const view = document.createElement("button");
    view.type = "button";
    view.className = "btn btn-sm page-view";
    view.textContent = "Xem";
    view.addEventListener("click", (e) => {
      e.stopPropagation();
      openPreview(page.canvas);
    });

    tile.append(thumb, label, view);
    tile.addEventListener("click", () => togglePage(i));
    grid.appendChild(tile);
  });
  renderPageNote();
}

function selectedCount() {
  return state.pages.filter((p) => p.selected).length;
}

function togglePage(i) {
  const page = state.pages[i];
  if (!page.selected && selectedCount() >= MAX_SEND) {
    toast(`Chỉ chọn tối đa ${MAX_SEND} trang mỗi lần.`, "warn");
    return;
  }
  page.selected = !page.selected;
  renderPageGrid();
}

function selectAllPages() {
  state.pages.forEach((p, i) => (p.selected = i < MAX_SEND));
  renderPageGrid();
  if (state.pages.length > MAX_SEND) {
    toast(
      `Chỉ chọn ${MAX_SEND} trang đầu, mỗi lần tối đa ${MAX_SEND} trang.`,
      "warn",
    );
  }
}

function deselectAllPages() {
  state.pages.forEach((p) => (p.selected = false));
  renderPageGrid();
}

function clearPages() {
  state.pages = [];
  ["file-input", "camera-input"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
  renderPageGrid();
  setHidden($("page-grid-section"), true);
}

function openPreview(canvas) {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;z-index:1000;overflow:auto;";

  const img = document.createElement("img");
  img.src = canvas.toDataURL("image/jpeg", 0.9);
  img.alt = "Xem trang";
  img.style.cssText =
    "max-width:100%;max-height:80vh;background:#fff;border-radius:8px;";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-sm";
  close.textContent = "Đóng";

  const done = () => overlay.remove();
  close.addEventListener("click", done);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) done();
  });
  overlay.append(img, close);
  document.body.appendChild(overlay);
}

/* ============ Chuyển dữ liệu AI thành câu hỏi ============ */

function detectType(q) {
  const p = String(q.part ?? q.type ?? "")
    .trim()
    .toLowerCase();
  if (["mcq", "1", "phần i", "phan i"].includes(p)) return "mcq";
  if (["tf", "2", "phần ii", "phan ii"].includes(p)) return "tf";
  if (["short", "3", "phần iii", "phan iii"].includes(p)) return "short";
  if (q.statements) return "tf";
  return q.options ? "mcq" : "short";
}

function normalizeOptions(opts) {
  const labels = ["A", "B", "C", "D"];
  return labels
    .map((label, k) => {
      let text = "";
      if (Array.isArray(opts)) text = opts[k];
      else if (opts && typeof opts === "object") {
        text = opts[label] ?? opts[label.toLowerCase()] ?? "";
      }
      return { label, text: String(text ?? "").trim() };
    })
    .filter((o) => o.text);
}

function normalizeStatements(st) {
  const labels = ["a", "b", "c", "d"];
  return labels.map((label, k) => {
    let text = "";
    if (Array.isArray(st)) text = st[k];
    else if (st && typeof st === "object") {
      text = st[label] ?? st[label.toUpperCase()] ?? "";
    }
    return { label, text: String(text ?? "").trim() };
  });
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "đúng", "dung", "d", "đ", "t", "yes", "1"].includes(s))
      return true;
    if (["false", "sai", "s", "f", "no", "0"].includes(s)) return false;
  }
  return null;
}

function normalizeKey(q, type) {
  const raw = q.answer ?? q.key;
  if (raw === null || raw === undefined || raw === "") return null;

  if (type === "mcq") {
    // Chấp nhận "B", "B.", "Đáp án: B", "câu B"... (trước đây "Đáp án B" bị coi là không có đáp án)
    const up = String(raw).trim().toUpperCase();
    const m = up.match(/(?:^|[^A-ZÀ-Ỹ])([ABCD])(?![A-ZÀ-Ỹ])/);
    return m ? m[1] : null;
  }
  if (type === "tf") {
    const labels = ["a", "b", "c", "d"];
    const parts =
      typeof raw === "string" ? raw.split(/[\s,;|]+/).filter(Boolean) : null;
    const vals = labels.map((l, k) =>
      toBool(
        parts
          ? parts[k]
          : Array.isArray(raw)
            ? raw[k]
            : (raw?.[l] ?? raw?.[l.toUpperCase()]),
      ),
    );
    return vals.every((v) => v === null) ? null : vals;
  }
  const s = String(raw).trim();
  return s || null;
}

// Câu nhắc tới hình/đồ thị/sơ đồ nên cần có hình đi kèm
function needsFigure(text) {
  return /(hình vẽ|như hình|hình bên|hình sau|hình dưới|đồ thị|sơ đồ|biểu đồ|bảng sau|(đường|hình|đồ thị|sơ đồ|biểu đồ) nào)/i.test(
    text,
  );
}

// Ảnh cả trang (thu nhỏ), dùng khi AI không khoanh được vùng hình; lưu tạm để các câu cùng trang dùng chung
function pageSnapshot(page) {
  if (!page._snap) {
    page._snap =
      "data:image/jpeg;base64," + compressCanvas(page.canvas, 1000, 0.6);
  }
  return page._snap;
}

// Ước lượng độ khó khi AI không cung cấp (1 dễ, 2 vừa, 3 khó)
function estimateDifficulty(item) {
  const len =
    item.text.length +
    (item.options || []).reduce((n, o) => n + o.text.length, 0) +
    (item.statements || []).reduce((n, o) => n + o.text.length, 0);
  const calc = /(tính|giá trị|bao nhiêu|xác định|\$|\d{2,})/i.test(item.text);
  if (item.type === "short") return len > 260 ? 3 : 2;
  if (item.type === "tf") return len > 500 ? 3 : 2;
  if (len > 380) return 3;
  if (len > 160 || (calc && len > 100)) return 2;
  return 1;
}

// Chuyển dữ liệu AI thành câu hỏi. `pages` là danh sách trang tương ứng với figure.page
// allowPageFallback: nếu câu cần hình mà AI không khoanh được thì hiện cả trang gốc (không dùng cho chế độ tạo đề mới)
function buildQuestions(data, format, pages, allowPageFallback = true) {
  const raw = Array.isArray(data?.questions) ? data.questions : [];
  const items = [];

  raw.forEach((q) => {
    if (!q || typeof q !== "object") return;
    let type = detectType(q);
    const text = String(q.prompt ?? q.text ?? "").trim();
    if (!text) return;

    // Câu có lựa chọn thì luôn coi là trắc nghiệm; câu "mcq" thiếu lựa chọn thì chuyển thành trả lời ngắn
    let opts = normalizeOptions(q.options);
    if (type !== "tf" && opts.length >= 2) type = "mcq";
    else if (type === "mcq") {
      // Phương án là hình vẽ (không có chữ): giữ trắc nghiệm A–D, các hình nằm trong ảnh minh họa
      if ((q.figure && typeof q.figure === "object") || needsFigure(text)) {
        opts = ["A", "B", "C", "D"].map((l) => ({
          label: l,
          text: `Hình ${l}`,
        }));
      } else {
        type = "short";
      }
    }
    // Định dạng "Trắc nghiệm ngắn" chỉ nhận câu có lựa chọn
    if (format === "short" && type !== "mcq") return;

    const fig = q.figure && typeof q.figure === "object" ? q.figure : null;
    const page = pages[Number(fig?.page) || 0] || pages[0];
    let figureImage = cropFigure(fig, page);
    let figureIsPage = false;
    if (!figureImage && allowPageFallback && page && needsFigure(text)) {
      figureImage = pageSnapshot(page);
      figureIsPage = true;
    }
    const item = {
      type,
      text,
      options: type === "mcq" ? opts : null,
      statements: type === "tf" ? normalizeStatements(q.statements) : null,
      key: normalizeKey(q, type),
      solved: q.solved === true,
      figure: fig,
      figureImage,
      figureIsPage,
    };
    const d = Number(q.difficulty);
    item.difficulty = [1, 2, 3].includes(d) ? d : estimateDifficulty(item);
    items.push(item);
  });
  console.info(
    `[extract] AI trả ${raw.length} câu, giữ lại ${items.length} câu (định dạng: ${format})`,
  );

  return items;
}

function initialAnswer(q) {
  if (q.type === "tf") return [null, null, null, null];
  if (q.type === "short") return "";
  return null;
}

/* ============ Tạo đề ============ */

// Gộp câu từ nhiều trang: sắp theo loại (giữ thứ tự đọc), đánh số lại từ 1
function mergeAndRenumber(list) {
  return [...list]
    .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type])
    .map((q, i) => ({ ...q, number: i + 1 }));
}

async function createExam() {
  if (state.extracting) return;

  const text = $("text-input").value.trim();
  const selected = state.pages.filter((p) => p.selected);
  if (!selected.length && !text) {
    toast("Hãy tải tài liệu hoặc dán văn bản trước.", "warn");
    return;
  }

  const subjectEl = $("subject-select");
  const subjectKey = subjectEl.value;
  const subjectLabel =
    subjectEl.options[subjectEl.selectedIndex]?.text || "Tổng hợp";
  const mode =
    document.querySelector('input[name="process-mode"]:checked')?.value ===
    "generate"
      ? "gen"
      : "extract";
  const playMode =
    document.querySelector('input[name="play-mode"]:checked')?.value || "quick";
  // Luyện tập nhanh / trò chơi: chỉ chép đề (nhanh). Đáp án do AI giải từng câu khi cần.
  const light = mode === "extract" && playMode !== "mock";
  const mockMinutes = Number($("mock-time")?.value) || 0;
  // Cấu trúc chỉ dùng khi AI tạo đề mới; tách đề thì lấy đủ mọi loại câu có trong tài liệu
  const isShort =
    mode === "gen" &&
    document.querySelector('input[name="exam-format"]:checked')?.value ===
      "short-mcq";
  const format = isShort ? "short" : "thpt";

  const shortCount = Math.max(
    1,
    Math.min(60, Number($("short-count")?.value) || 10),
  );
  const totalCounts =
    mode !== "gen"
      ? { p1: 0, p2: 0, p3: 0 }
      : isShort
        ? { p1: shortCount, p2: 0, p3: 0 }
        : SUBJECT_COUNTS[subjectKey] || { p1: 0, p2: 0, p3: 0 };

  state.extracting = true;
  let questions = [];
  const failedPages = [];
  const partialPages = [];
  let lastError = null;

  try {
    if (mode === "gen") {
      // Tạo đề mới: gửi tất cả trang cùng lúc để AI soạn đủ số câu
      setLoading(true, "AI đang soạn đề, có thể mất 30–60 giây...");
      const r = await postJSON("/api/extract", {
        images: selected.map((p) => compressCanvas(p.canvas)),
        text,
        subject: subjectLabel,
        mode,
        format,
        counts: totalCounts,
      });
      if (r.ok) {
        if (r.data?._partial) partialPages.push(0);
        questions = mergeAndRenumber(
          buildQuestions(r.data, format, selected, false),
        );
      } else {
        lastError = r;
      }
    } else {
      // Tách đề có sẵn: mỗi trang một yêu cầu, chạy song song tối đa 3 trang (nhanh gấp ~2–3 lần)
      const jobs = selected.length ? selected : [null];
      const results = new Array(jobs.length).fill(null);
      let done = 0;
      setLoading(true, `Đang đọc ${jobs.length} trang...`);
      await runPool(
        jobs.map((_, i) => i),
        EXTRACT_CONCURRENCY,
        async (i) => {
          const page = jobs[i];
          // Gửi kèm trang kế tiếp (chỉ để đọc phần bị ngắt sang trang sau: phương án, ý a–d, hình)
          const at = page ? state.pages.indexOf(page) : -1;
          const next = at >= 0 ? state.pages[at + 1] : null;
          const r = await postJSON("/api/extract", {
            images: page
              ? [
                  compressCanvas(page.canvas),
                  ...(next ? [compressCanvas(next.canvas)] : []),
                ]
              : [],
            contextPage: !!next,
            light,
            text: i === 0 ? text : "",
            subject: subjectLabel,
            mode,
            format,
            counts: { p1: 0, p2: 0, p3: 0 }, // AI tự lấy hết câu trên trang
          });
          done++;
          setLoading(true, `Đã đọc ${done}/${jobs.length} trang...`);
          if (!r.ok) {
            failedPages.push(page ? state.pages.indexOf(page) + 1 : 1);
            lastError = r;
            return;
          }
          if (r.data?._partial) partialPages.push(i + 1);
          // Mỗi yêu cầu chỉ có 1 trang nên figure.page luôn là 0 → dùng đúng trang đó
          results[i] = buildQuestions(
            r.data,
            format,
            page ? (next ? [page, next] : [page]) : [],
          );
        },
      );
      failedPages.sort((a, b) => a - b);
      // Loại câu trùng (phòng khi AI lấy luôn câu ở trang kế tiếp)
      const seen = new Set();
      questions = results
        .flat()
        .filter(Boolean)
        .filter((q) => {
          const k = [
            q.type,
            q.text,
            ...(q.options || []).map((o) => o.text),
            ...(q.statements || []).map((o) => o.text),
          ]
            .join("|")
            .replace(/\s+/g, " ")
            .toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      questions = mergeAndRenumber(questions);
    }
  } finally {
    state.extracting = false;
    setLoading(false);
  }

  if (!questions.length) {
    toast(
      lastError
        ? errorMessage(lastError)
        : "AI không tìm thấy câu hỏi nào. Thử đổi trang hoặc thêm văn bản.",
      "error",
    );
    return;
  }

  if (failedPages.length) {
    toast(
      `Trang ${failedPages.join(", ")} không đọc được, các trang khác đã xong.`,
      "warn",
    );
  } else if (mode === "extract") {
    toast(
      `Tách được ${questions.length} câu. Nếu thiếu, hãy kiểm tra lại các trang đã chọn.`,
      "info",
    );
  }

  if (partialPages.length) {
    toast(
      "AI trả về chưa đủ (bị cắt giữa chừng) nên có thể thiếu câu. Hãy chọn ít trang hơn rồi tạo lại.",
      "warn",
    );
  }

  const exam = {
    id: makeId(),
    title: "Đề luyện tập " + subjectLabel,
    subject: subjectLabel,
    format,
    mode: playMode,
    timeLimitMin: playMode === "mock" ? mockMinutes : 0,
    recordKey: hashStr(questions.map((q) => q.text).join("|")),
    createdAt: Date.now(),
    questions,
    answers: questions.map(initialAnswer),
    checked: questions.map(() => false),
  };

  // Mở đề ngay, không chờ AI giải. Luyện tập nhanh / trò chơi: giải từng câu khi cần;
  // thi thử: giải ngầm trong lúc làm bài và chờ nốt khi nộp bài.
  openExam(exam);
}

/* ============ Lưu bài gần đây (localStorage) ============ */

function readRecent() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeRecent(list) {
  const trimmed = list.slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed));
    return true;
  } catch {
    // Đầy bộ nhớ: bỏ hình minh họa rồi lưu lại
    try {
      const light = trimmed.map((e) => ({
        ...e,
        questions: e.questions.map((q) => ({ ...q, figureImage: null })),
      }));
      localStorage.setItem(RECENT_KEY, JSON.stringify(light));
      return true;
    } catch {
      return false;
    }
  }
}

// Ghi localStorage tốn thời gian (đề có hình rất nặng), nên gộp nhiều lần chọn đáp án thành một lần ghi
let saveTimer = null;

function saveCurrent(immediate = false) {
  if (!state.current) return;
  const run = () => {
    saveTimer = null;
    if (!state.current) return;
    const list = readRecent().filter((e) => e.id !== state.current.id);
    list.unshift(state.current);
    const ok = writeRecent(list);
    $("save-status").textContent = ok
      ? "Đã lưu tự động"
      : "Không lưu được (bộ nhớ trình duyệt đầy)";
  };
  clearTimeout(saveTimer);
  if (immediate) run();
  else saveTimer = setTimeout(run, 500);
}

window.addEventListener("pagehide", () => {
  if (saveTimer) saveCurrent(true);
});

function progressOf(exam) {
  const done = exam.questions.filter((q, i) =>
    isAnswered(q, exam.answers[i]),
  ).length;
  return `${done}/${exam.questions.length} câu`;
}

function renderRecent() {
  const section = $("recent-section");
  const list = $("recent-list");
  if (!section || !list) return;
  const items = readRecent();
  list.replaceChildren();
  setHidden(section, items.length === 0);

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "recent-item";

    const info = document.createElement("div");
    info.className = "recent-info";
    const title = document.createElement("strong");
    title.textContent = item.title || "Đề luyện tập";
    const meta = document.createElement("span");
    meta.className = "mu";
    meta.textContent = `${MODE_LABEL[modeOf(item)]} · ${item.subject || ""} · ${progressOf(item)}${
      item.result ? ` · ${Number(item.result.score10).toFixed(2)}đ` : ""
    } · ${new Date(item.createdAt).toLocaleString("vi-VN")}`;
    info.append(title, document.createElement("br"), meta);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn btn-sm btn-primary";
    openBtn.textContent = "Mở";
    openBtn.addEventListener("click", () => openExam(item));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-sm btn-danger";
    delBtn.textContent = "Xóa";
    delBtn.addEventListener("click", () => {
      writeRecent(readRecent().filter((e) => e.id !== item.id));
      renderRecent();
    });

    row.append(info, openBtn, delBtn);
    list.appendChild(row);
  });
}

/* ============ Chấm điểm ============ */

function isAnswered(q, ans) {
  if (q.type === "tf") return Array.isArray(ans) && ans.some((v) => v !== null);
  if (q.type === "short") return String(ans ?? "").trim() !== "";
  return !!ans;
}

function sameAnswer(a, b) {
  const x = String(a ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(",", ".");
  const y = String(b ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(",", ".");
  if (!x || !y) return false;
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isNaN(nx) && !Number.isNaN(ny)) return Math.abs(nx - ny) < 1e-9;
  return x.toLowerCase() === y.toLowerCase();
}

function maxScore(q) {
  const total = state.current.questions.length;
  const ex = state.current;
  // Đề chỉ có trắc nghiệm: mọi câu bằng điểm nhau; đề hỗn hợp: theo thang THPT
  if (ex.format === "short" || ex.questions.every((x) => x.type === "mcq"))
    return 10 / Math.max(1, total);
  if (q.type === "mcq") return 0.25;
  if (q.type === "tf") return 1;
  // Đề THPT: câu trả lời ngắn môn Toán 0.5đ, các môn khác 0.25đ
  return /toán/i.test(state.current.subject || "") ? 0.5 : 0.25;
}

function gradeQuestion(q, ans) {
  const max = maxScore(q);
  if (q.key === null || q.key === undefined)
    return { status: "nokey", earned: 0, max };

  if (q.type === "mcq") {
    const ok = ans === q.key;
    return { status: ok ? "correct" : "wrong", earned: ok ? max : 0, max };
  }
  if (q.type === "short") {
    const ok = sameAnswer(ans, q.key);
    return { status: ok ? "correct" : "wrong", earned: ok ? max : 0, max };
  }
  // tf: đúng 1/2/3/4 ý = 0.1 / 0.25 / 0.5 / 1 điểm (thang THPT)
  const c = q.key.reduce(
    (n, v, k) => n + (v !== null && ans?.[k] === v ? 1 : 0),
    0,
  );
  const table = [0, 0.1, 0.25, 0.5, 1];
  return {
    status: c === 4 ? "correct" : c > 0 ? "partial" : "wrong",
    earned: table[c] ?? 0,
    max,
    c,
  };
}

function totals() {
  const exam = state.current;
  let earned = 0;
  let max = 0;
  exam.questions.forEach((q, i) => {
    const g = gradeQuestion(q, exam.answers[i]);
    if (g.status === "nokey") return; // câu chưa có đáp án thì không tính vào thang điểm
    max += g.max;
    if (exam.checked[i]) earned += g.earned;
  });
  return { earned, max };
}

function updateTotal() {
  const { earned, max } = totals();
  const score = max ? (earned / max) * 10 : 0;
  $("total-score").textContent = `${score.toFixed(2)} / 10`;
}

/* ============ Hiển thị đề ============ */

function keyText(q) {
  if (q.key === null || q.key === undefined) return "(chưa có)";
  if (q.type === "tf") {
    return q.key
      .map(
        (v, k) =>
          `${q.statements[k].label}) ${v === null ? "?" : v ? "Đúng" : "Sai"}`,
      )
      .join("; ");
  }
  return String(q.key);
}

function answerText(q, ans) {
  if (q.type === "tf") {
    return q.statements
      .map(
        (st, k) =>
          `${st.label}) ${ans?.[k] === null || ans?.[k] === undefined ? "chưa chọn" : ans[k] ? "Đúng" : "Sai"}`,
      )
      .join("; ");
  }
  if (q.type === "mcq") return ans || "chưa chọn";
  return String(ans ?? "").trim() || "chưa trả lời";
}

function questionFull(q) {
  let s = q.text;
  if (q.type === "mcq" && q.options) {
    s += "\n" + q.options.map((o) => `${o.label}. ${o.text}`).join("\n");
  }
  if (q.type === "tf" && q.statements) {
    s += "\n" + q.statements.map((o) => `${o.label}) ${o.text}`).join("\n");
  }
  return s;
}

function openExam(exam) {
  if (
    !Array.isArray(exam.answers) ||
    exam.answers.length !== exam.questions.length
  ) {
    exam.answers = exam.questions.map(initialAnswer);
  }
  if (
    !Array.isArray(exam.checked) ||
    exam.checked.length !== exam.questions.length
  ) {
    exam.checked = exam.questions.map(() => false);
  }
  exam.mode = MODE_LABEL[exam.mode] ? exam.mode : "quick";
  exam.recordKey =
    exam.recordKey || hashStr(exam.questions.map((q) => q.text).join("|"));
  if (exam.mode === "mock" && !exam.submitted) startMock(exam);
  if (exam.mode === "game" && !exam.game) exam.game = newGame();

  clearTimeout(state.gameNextTimer);
  clearTimeout(state.autoTimer);
  autoSubmitId = null;
  state.current = exam;
  state.explain = {};
  state.quick = {};
  state.chat = {};
  state.quickLoading = {};
  state.tab = "quick";

  const finished = isFinished(exam);
  const firstTodo =
    exam.mode === "game"
      ? exam.questions.findIndex((q, i) => !exam.checked[i])
      : exam.questions.findIndex((q, i) => !isAnswered(q, exam.answers[i]));
  state.idx = finished ? 0 : Math.max(0, firstTodo);

  $("exam-title").textContent = exam.title || "Đề luyện tập";
  setHidden($("home-view"), true);
  $("home-view").classList.remove("active");
  setHidden($("exam-view"), false);
  $("exam-view").classList.add("active");
  document.body.dataset.view = "exam";
  setNavOpen(false);

  saveCurrent();
  if (exam.mode === "game" && !finished) gameBegin(state.idx);
  else showQuestion(state.idx);
  window.scrollTo(0, 0);

  if (exam.mode === "mock") solveInBackground(exam);
  if (
    exam.mode === "mock" &&
    !exam.submitted &&
    exam.endsAt &&
    Date.now() >= exam.endsAt
  ) {
    autoSubmitId = exam.id;
    toast("Đã hết giờ làm bài, bài được nộp tự động.", "warn");
    submitExam({ auto: true });
  }
}

function showQuestion(i) {
  const exam = state.current;
  if (!exam || !exam.questions.length) return;
  state.idx = Math.max(0, Math.min(i, exam.questions.length - 1));
  const idx = state.idx;
  const q = exam.questions[idx];
  applyModeUI(exam);

  const partNames = { mcq: "Phần I", tf: "Phần II", short: "Phần III" };
  $("question-part-badge").textContent = exam.questions.every(
    (x) => x.type === "mcq",
  )
    ? "Trắc nghiệm"
    : partNames[q.type];
  if (q.solved) {
    $("question-part-badge").textContent += " · đáp án do AI giải";
  }
  $("question-number-label").textContent =
    `Câu ${idx + 1}/${exam.questions.length}`;

  const content = $("question-content");
  content.textContent = q.text;
  content.style.whiteSpace = "pre-wrap";

  const imgBox = $("question-image-container");
  const img = $("question-image");
  if (q.figureImage) {
    img.src = q.figureImage;
    img.alt = q.figureIsPage
      ? "Trang gốc chứa hình của câu này"
      : "Hình minh họa";
    setHidden(imgBox, false);
  } else {
    img.removeAttribute("src");
    setHidden(imgBox, true);
  }

  renderAnswerArea();
  renderNav();
  renderResult();
  renderExplainPanel();
  renderChat();

  updateNavButtons();
  typeset([content, $("answer-mcq"), $("answer-tf")]);

  warmQuestion(exam, idx);

  const sig = `${exam.id}:${idx}`;
  if (sig !== lastShownSig) {
    lastShownSig = sig;
    scrollToQuestionTop();
  }

  // Sau khi nộp bài thi thử: tự hiện lời giải nhanh khi xem lại. Trò chơi: chỉ với câu làm sai.
  if (modeOf(exam) !== "quick" && isFinished(exam)) {
    const g = gradeQuestion(q, exam.answers[idx]);
    if (modeOf(exam) === "mock" || g.status !== "correct")
      setTab("quick", true);
  }
}

function updateNavButtons() {
  const exam = state.current;
  const idx = state.idx;
  const last = exam.questions.length - 1;
  const playingGame = modeOf(exam) === "game" && !isFinished(exam);
  const prev = $("prev-question-btn");
  const next = $("next-question-btn");
  setHidden(prev, playingGame);
  prev.disabled = idx === 0;
  next.disabled = playingGame ? exam.game.times[idx] == null : idx === last;
  next.textContent = playingGame && idx === last ? "Xem kết quả" : "Câu tiếp";
}

// Chuyển câu do người dùng bấm: cho thử lại việc chuẩn bị đáp án nếu lần trước lỗi
function navigateTo(i) {
  const exam = state.current;
  if (!exam) return;
  const k = Math.max(0, Math.min(i, exam.questions.length - 1));
  prepFailed.delete(prepId(exam, k));
  setNavOpen(false);
  showQuestion(k);
}

function onNextClick() {
  const exam = state.current;
  if (!exam) return;
  if (modeOf(exam) === "game" && !isFinished(exam)) gameNext();
  else navigateTo(state.idx + 1);
}

function renderAnswerArea() {
  const exam = state.current;
  const i = state.idx;
  const q = exam.questions[i];
  const ans = exam.answers[i];
  const checked = exam.checked[i];
  const locked = !canAnswer(exam, i);

  const areas = {
    mcq: $("answer-mcq"),
    tf: $("answer-tf"),
    short: $("answer-short"),
  };
  Object.values(areas).forEach((el) => setHidden(el, true));
  const box = areas[q.type];
  setHidden(box, false);

  if (q.type === "mcq") {
    box.replaceChildren();
    q.options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "opt";
      const letter = document.createElement("b");
      letter.textContent = opt.label;
      const text = document.createElement("span");
      text.textContent = opt.text;
      btn.append(letter, text);

      if (ans === opt.label) btn.classList.add("selected");
      if (checked && q.key) {
        if (opt.label === q.key) btn.classList.add("correct");
        else if (ans === opt.label) btn.classList.add("wrong");
      }
      btn.disabled = locked;
      btn.addEventListener("click", () => chooseMcq(opt.label));
      box.appendChild(btn);
    });
  } else if (q.type === "tf") {
    box.replaceChildren();
    q.statements.forEach((st, k) => {
      const row = document.createElement("div");
      row.className = "tf-row";
      const text = document.createElement("div");
      text.textContent = `${st.label}) ${st.text}`;
      text.style.whiteSpace = "pre-wrap";

      const btns = document.createElement("div");
      btns.className = "tf-btns";
      [
        ["Đúng", true],
        ["Sai", false],
      ].forEach(([label, val]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "opt";
        b.textContent = label;
        if (ans[k] === val) b.classList.add("selected");
        if (checked && q.key && q.key[k] !== null) {
          if (q.key[k] === val) b.classList.add("correct");
          else if (ans[k] === val) b.classList.add("wrong");
        }
        b.disabled = locked;
        b.addEventListener("click", () => chooseTf(k, val));
        btns.appendChild(b);
      });
      row.append(text, btns);
      box.appendChild(row);
    });
  } else {
    const inp = $("short-answer-input");
    const awaiting = awaitingPrep(exam, i);
    if (inp.dataset.ph === undefined) inp.dataset.ph = inp.placeholder || "";
    inp.placeholder = awaiting
      ? "⏳ AI đang chuẩn bị câu trắc nghiệm..."
      : inp.dataset.ph;
    inp.value = ans || "";
    inp.disabled = locked || awaiting;
  }
}

// Thi thử: chỉ ghi đáp án, chưa chấm. Luyện tập / trò chơi: chấm ngay khi chọn xong.
function chooseMcq(label) {
  const exam = state.current;
  const i = state.idx;
  if (!canAnswer(exam, i)) return;
  exam.answers[i] = label;
  if (modeOf(exam) !== "mock") exam.checked[i] = true;
  afterAnswer(i);
  typeset([$("answer-mcq")]);
}

function chooseTf(k, val) {
  const exam = state.current;
  const i = state.idx;
  if (!canAnswer(exam, i)) return;
  exam.answers[i][k] = val;
  if (modeOf(exam) !== "mock") {
    exam.checked[i] = exam.answers[i].every((v) => v !== null);
  }
  afterAnswer(i);
  typeset([$("answer-tf")]);
}

function onShortChange(e) {
  const exam = state.current;
  if (!exam) return;
  const i = state.idx;
  if (!canAnswer(exam, i)) {
    e.target.value = exam.answers[i] || "";
    return;
  }
  exam.answers[i] = e.target.value.trim();
  if (modeOf(exam) !== "mock") exam.checked[i] = exam.answers[i] !== "";
  afterAnswer(i);
}

function afterAnswer(i) {
  const exam = state.current;
  const m = modeOf(exam);
  if (m === "game" && exam.checked[i]) {
    gameLock(i, false);
    return;
  }
  if (m === "quick") {
    // đổi đáp án thì lời giải cũ (có nhận xét bài làm) không còn đúng nữa
    delete state.quick[i];
    delete state.explain[i];
  }
  saveCurrent();
  renderAnswerArea();
  renderNav();
  renderResult();
  if (m === "quick") {
    renderExplainPanel();
    // Chỉ khi làm SAI mới tự hiện giải nhanh (chờ một chút phòng khi bấm đổi liên tục)
    if (exam.checked[i]) maybeAutoExplain(exam, i);
  }
}

function renderNav() {
  const exam = state.current;
  const bar = $("question-nav-bar");
  bar.replaceChildren();

  exam.questions.forEach((q, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = String(i + 1);

    const classes = ["q-chip"];
    if (i === state.idx) classes.push("is-current");
    if (exam.checked[i]) {
      const g = gradeQuestion(q, exam.answers[i]);
      if (g.status === "correct") classes.push("is-correct");
      else if (g.status === "partial") classes.push("is-partial");
      else if (g.status === "wrong") classes.push("is-wrong");
      else classes.push("is-done");
    } else if (isAnswered(q, exam.answers[i])) {
      classes.push("is-done");
    }
    btn.className = classes.join(" ");
    btn.disabled = modeOf(exam) === "game" && !isFinished(exam);
    btn.addEventListener("click", () => navigateTo(i));
    bar.appendChild(btn);
  });

  const pos = $("nav-pos");
  if (pos) pos.textContent = `${state.idx + 1}/${exam.questions.length}`;
  centerCurrentChip();
}

/* ============ Giao diện: thanh số câu, bố cục điện thoại ============ */

function isMobileLayout() {
  const l = document.body.dataset.layout;
  return (
    l === "mobile" ||
    (l !== "desktop" && window.matchMedia("(max-width: 820px)").matches)
  );
}

// Cuộn riêng trong thanh số câu (không dùng scrollIntoView vì nó kéo cả trang)
function centerCurrentChip() {
  const bar = $("question-nav-bar");
  const chip = bar?.querySelector(".is-current");
  if (!bar || !chip) return;
  const b = bar.getBoundingClientRect();
  const c = chip.getBoundingClientRect();
  if (!b.width) return;
  bar.scrollLeft += c.left + c.width / 2 - (b.left + b.width / 2);
  bar.scrollTop += c.top + c.height / 2 - (b.top + b.height / 2);
}

// Đo chiều cao header / thanh trên để các phần dính (sticky) không đè lên nhau
function syncLayoutVars() {
  const root = document.documentElement.style;
  const header = document.querySelector(".app-header");
  if (header && header.offsetHeight) {
    root.setProperty("--header-h", header.offsetHeight + "px");
  }
  const bar = $("exam-topbar");
  if (bar && bar.offsetHeight) {
    root.setProperty("--topbar-h", bar.offsetHeight + "px");
  }
  const strip = $("nav-strip");
  if (strip && strip.offsetHeight && isMobileLayout()) {
    root.setProperty("--strip-h", strip.offsetHeight + "px");
  }
}

// Mở / thu gọn bảng số câu (điện thoại)
function setNavOpen(open) {
  const strip = $("nav-strip");
  const btn = $("nav-toggle-btn");
  if (!strip || !btn) return;
  strip.classList.toggle("nav-open", !!open);
  btn.setAttribute("aria-expanded", String(!!open));
  if (open) centerCurrentChip();
  syncLayoutVars();
}

function toggleChat() {
  const panel = $("chat-panel");
  if (!panel) return;
  const collapsed = panel.classList.toggle("is-collapsed");
  $("chat-header")?.setAttribute("aria-expanded", String(!collapsed));
  if (!collapsed) $("chat-input")?.focus({ preventScroll: false });
}

let lastShownSig = "";
// Chuyển sang câu khác trên điện thoại: đưa phần câu hỏi lên đầu màn hình
function scrollToQuestionTop() {
  if (!isMobileLayout()) return;
  const pane = $("left-pane");
  if (!pane) return;
  const strip = $("nav-strip");
  const offset = (strip ? strip.offsetHeight : 0) + 8;
  const top = pane.getBoundingClientRect().top;
  if (top < offset) {
    window.scrollTo({ top: window.scrollY + top - offset, behavior: "smooth" });
  }
}

function renderResult() {
  const exam = state.current;
  const i = state.idx;
  const q = exam.questions[i];
  const ans = exam.answers[i];
  const m = modeOf(exam);
  const panel = $("score-panel");
  const box = $("question-result-status");

  if (m === "game" && !isFinished(exam)) {
    setHidden(panel, true);
    return;
  }
  if (m === "mock" && !exam.submitted) {
    const done = exam.questions.filter((x, k) =>
      isAnswered(x, exam.answers[k]),
    ).length;
    box.textContent = `Đã làm ${done}/${exam.questions.length} câu. Điểm và lời giải chỉ hiện sau khi nộp bài.`;
    $("total-score").textContent = "— / 10";
    setHidden(panel, false);
    return;
  }

  let text;
  if (awaitingPrep(exam, i)) {
    text = "⏳ AI đang chuẩn bị câu trắc nghiệm...";
  } else if (exam.checked[i] && needsPrep(q) && prepJobs.has(prepId(exam, i))) {
    text = "⏳ AI đang kiểm tra đáp án...";
  } else if (!exam.checked[i]) {
    text = "Chọn đáp án (hoặc nhập rồi nhấn Enter) để chấm câu này.";
  } else if (m === "game") {
    text = gamePointsText(exam, i);
  } else {
    const g = gradeQuestion(q, ans);
    if (g.status === "nokey") {
      text =
        "Câu này chưa có đáp án chuẩn nên chưa được chấm. Hãy xem phần giải nhanh của AI.";
    } else if (g.status === "correct") {
      text = `Chính xác! +${g.earned.toFixed(2)} điểm.`;
    } else if (g.status === "partial") {
      text = `Đúng ${g.c}/4 ý, +${g.earned.toFixed(2)} điểm. Đáp án: ${keyText(q)}`;
    } else {
      text = `Chưa đúng. Đáp án: ${keyText(q)}`;
    }
  }
  box.textContent = text;
  setHidden(panel, false);
  updateTotal();
}

function setTab(name, load = true) {
  state.tab = name;
  const essayOn = name === "essay";
  $("tab-essay").classList.toggle("active", essayOn);
  $("tab-essay").setAttribute("aria-selected", String(essayOn));
  $("tab-quick").classList.toggle("active", !essayOn);
  $("tab-quick").setAttribute("aria-selected", String(!essayOn));

  const essay = $("content-essay");
  const quick = $("content-quick");
  essay.classList.toggle("active", essayOn);
  setHidden(essay, !essayOn);
  quick.classList.toggle("active", !essayOn);
  setHidden(quick, essayOn);

  if (!essayOn && load) loadQuick();
}

function renderExplainPanel() {
  const i = state.idx;
  const essay = $("content-essay");
  const quick = $("quick-detail");
  if (state.explain[i]) setMarkdown(essay, state.explain[i]);
  else {
    setPlain(
      essay,
      'Bấm "Giải chi tiết từng bước" để AI trình bày lời giải tự luận.',
    );
  }
  setHidden($("quick-warning"), true);
  if (state.quick[i]) setMarkdown(quick, state.quick[i]);
  else {
    setPlain(quick, quickHint(state.current, i));
  }
  // Không tự gọi AI khi chuyển câu: tránh tốn lượt và chờ lâu
  setTab(state.tab, false);
  typeset([essay, quick]);
}

function explainPayload(exam, i, style) {
  const q = exam.questions[i];
  return {
    question: questionFull(q),
    answer: answerText(q, exam.answers[i]),
    key: keyText(q),
    answered: isAnswered(q, exam.answers[i]),
    subject: exam.subject,
    style,
    // Câu có hình: gửi kèm ảnh để AI giải thích đúng theo hình, không đoán bằng chữ
    image: q.figureImage ? stripDataUrl(q.figureImage) : undefined,
  };
}

// Giải nhanh: ngắn gọn, có dẫn công thức / khái niệm áp dụng
async function loadQuick() {
  const exam = state.current;
  if (!exam || !aiAllowed(exam)) return;
  const i = state.idx;
  const detail = $("quick-detail");
  const warn = $("quick-warning");

  if (state.quick[i]) {
    setMarkdown(detail, state.quick[i]);
    typeset([detail]);
    return;
  }
  if (state.quickLoading[i]) return;
  state.quickLoading[i] = true;
  setHidden(warn, true);
  setPlain(detail, "AI đang giải nhanh...");

  const sig = JSON.stringify(exam.answers[i]);
  const r = await postJSON(
    "/api/grade-explain",
    explainPayload(exam, i, "quick"),
  );
  state.quickLoading[i] = false;
  if (state.current !== exam) return;

  // Nếu trong lúc chờ học sinh đã đổi đáp án thì bỏ kết quả cũ
  const stale = JSON.stringify(exam.answers[i]) !== sig;
  if (r.ok && !stale)
    state.quick[i] = r.data?.text || "AI không trả về nội dung.";
  if (state.idx !== i) return;
  if (stale) return;
  if (r.ok) {
    setMarkdown(detail, state.quick[i]);
    typeset([detail]);
  } else {
    setPlain(detail, "");
    warn.textContent = errorMessage(r);
    setHidden(warn, false);
  }
}

// Giải chi tiết từng bước (tự luận), chỉ khi học sinh yêu cầu
async function explainCurrent() {
  const exam = state.current;
  if (!exam || !aiAllowed(exam) || state.explaining) return;
  const i = state.idx;

  state.explaining = true;
  setTab("essay", false);
  setPlain($("content-essay"), "AI đang giải chi tiết từng bước...");

  const r = await postJSON(
    "/api/grade-explain",
    explainPayload(exam, i, "detail"),
  );
  state.explaining = false;
  if (state.current !== exam) return;

  if (r.ok) state.explain[i] = r.data?.text || "AI không trả về nội dung.";
  if (state.idx === i) {
    if (r.ok) setMarkdown($("content-essay"), state.explain[i]);
    else setPlain($("content-essay"), errorMessage(r));
    typeset([$("content-essay")]);
  }
}

function renderChat() {
  const box = $("chat-messages");
  box.replaceChildren();
  (state.chat[state.idx] || []).forEach((m) => {
    const d = document.createElement("div");
    d.className = "chat-msg " + (m.role === "user" ? "user" : "assistant");
    if (m.role === "user") d.textContent = m.content;
    else setMarkdown(d, m.content);
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;
  typeset([box]);
}

async function sendChat(e) {
  e.preventDefault();
  const input = $("chat-input");
  const message = input.value.trim();
  const exam = state.current;
  if (!message || !exam || state.chatting || !aiAllowed(exam)) return;

  const i = state.idx;
  const q = exam.questions[i];
  const hist = state.chat[i] || (state.chat[i] = []);
  const history = hist
    .filter((m) => !m.error)
    .slice(-10)
    .map(({ role, content }) => ({ role, content }));

  input.value = "";
  hist.push({ role: "user", content: message });
  renderChat();

  state.chatting = true;
  $("chat-send-btn").disabled = true;

  const context = [
    `Môn: ${exam.subject}.`,
    `Đề câu hỏi:\n${questionFull(q)}`,
    `Đáp án chuẩn: ${keyText(q)}`,
    isAnswered(q, exam.answers[i])
      ? `Học sinh trả lời: ${answerText(q, exam.answers[i])}`
      : "Học sinh chưa làm câu này (không được kết luận là em không biết làm; chỉ cần hướng dẫn).",
  ].join("\n");

  const r = await postJSON("/api/chat", {
    context,
    history,
    message,
    image: q.figureImage ? stripDataUrl(q.figureImage) : undefined,
  });
  state.chatting = false;
  $("chat-send-btn").disabled = false;
  if (state.current !== exam) return;

  hist.push({
    role: "assistant",
    content: r.ok ? r.data?.text || "AI không trả lời." : errorMessage(r),
    error: !r.ok, // tin báo lỗi không gửi lại cho AI ở lượt sau
  });
  if (state.idx === i) renderChat();
}

/* ============ Nộp bài, chia sẻ ============ */

const fillingNow = new Map(); // id đề → Promise đang giải

async function doFillMissingKeys(exam) {
  const missing = exam.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.key === null || q.key === undefined);
  if (!missing.length || exam.solveTried) return 0;

  // Câu có ảnh minh họa: gửi RIÊNG từng câu kèm ảnh (AI cần nhìn hình mới giải đúng).
  // Câu chỉ có chữ: gộp theo lô 10 câu/lần như cũ để đỡ tốn lượt gọi.
  const withImage = missing.filter(({ q }) => q.figureImage);
  const textOnly = missing.filter(({ q }) => !q.figureImage);
  const chunks = [...withImage.map((m) => [m])];
  for (let k = 0; k < textOnly.length; k += 10) {
    chunks.push(textOnly.slice(k, k + 10));
  }

  let filled = 0;
  let allOk = true;
  await runPool(chunks, 2, async (chunk) => {
    const r = await postJSON("/api/solve", {
      subject: exam.subject,
      questions: chunk.map(({ q, i }) => ({
        i,
        type: q.type,
        text: q.text,
        options: q.options,
        statements: q.statements,
        image: q.figureImage ? stripDataUrl(q.figureImage) : undefined,
      })),
    });
    if (!r.ok) {
      allOk = false;
      return;
    }
    (r.data?.answers || []).forEach((a) => {
      const q = exam.questions[Number(a?.i)];
      if (!q || (q.key !== null && q.key !== undefined)) return;
      const key = normalizeKey({ answer: a.answer }, q.type);
      if (key !== null) {
        q.key = key;
        q.solved = true;
        filled++;
      }
    });
  });
  if (allOk) exam.solveTried = true; // lỗi tạm thời thì còn thử lại được khi nộp bài
  return filled;
}

function fillMissingKeys(exam) {
  if (!fillingNow.has(exam.id)) {
    const p = doFillMissingKeys(exam).finally(() => fillingNow.delete(exam.id));
    fillingNow.set(exam.id, p);
  }
  return fillingNow.get(exam.id);
}

// Chạy ngầm khi mở đề: câu nào AI chưa có đáp án thì nhờ AI giải để luyện tập có chấm điểm ngay
function solveInBackground(exam) {
  if (!exam.questions.some((q) => q.key === null || q.key === undefined))
    return;
  fillMissingKeys(exam).then((filled) => {
    if (!filled || state.current !== exam) return;
    saveCurrent();
    renderAnswerArea();
    renderNav();
    renderResult();
  });
}

/* ============ Chuẩn bị câu hỏi theo yêu cầu (luyện tập nhanh / trò chơi) ============ */
// Tạo đề chỉ chép đề, không giải. Khi cần, AI giải RIÊNG TỪNG CÂU (đáp án chuẩn, và dựng 4 phương án
// trắc nghiệm cho câu tự luận) và chuẩn bị sẵn 2 câu kế tiếp trong lúc học sinh đang làm câu hiện tại.

const prepJobs = new Map(); // `${exam.id}:${i}` → Promise<boolean> đang chạy
const prepFailed = new Set(); // câu đã thử mà không có kết quả (vào lại câu thì thử lại)
const pendingLocks = new Map(); // trò chơi: câu đã chốt đang chờ đáp án để tính điểm
const prefetching = new Set(); // id đề đang chuẩn bị trước các câu kế tiếp
let lastPrepToast = 0;

function prepId(exam, i) {
  return `${exam.id}:${i}`;
}

function lazyMode(exam) {
  const m = modeOf(exam);
  return m === "quick" || m === "game";
}

function needsPrep(q) {
  return q.key === null || q.key === undefined;
}

// Câu cần nhìn hình mới giải được NHƯNG không có ảnh nào để gửi kèm thì đành chịu, không đoán bừa.
// Có figureImage (dù là hình cắt riêng hay cả trang) thì vẫn gửi kèm ảnh để AI tự giải.
function needsFigureToSolve(q) {
  return !q.figureImage && !!(q.figure || needsFigure(q.text));
}

// Câu tự luận (kiểu "short" chưa có đáp án) phải chờ AI dựng phương án trước khi làm
function awaitingPrep(exam, i) {
  const q = exam?.questions?.[i];
  return (
    !!q &&
    lazyMode(exam) &&
    q.type === "short" &&
    needsPrep(q) &&
    !needsFigureToSolve(q) &&
    !prepFailed.has(prepId(exam, i))
  );
}

function applyPrepared(exam, i, a) {
  const q = exam.questions[i];
  if (!q || !a) return false;
  if (q.type === "short" && a.type === "mcq" && a.options) {
    const opts = normalizeOptions(a.options);
    const key = normalizeKey({ answer: a.answer }, "mcq");
    if (opts.length >= 2 && key && opts.some((o) => o.label === key)) {
      q.type = "mcq";
      q.options = opts;
      q.key = key;
      q.statements = null;
      q.solved = true;
      q.converted = true;
      if (!isAnswered(q, exam.answers[i])) exam.answers[i] = initialAnswer(q);
      return true;
    }
    return false;
  }
  const key = normalizeKey({ answer: a.answer }, q.type);
  if (key === null) return false;
  q.key = key;
  q.solved = true;
  return true;
}

function prepareQuestion(exam, i) {
  const q = exam.questions[i];
  if (!q || !needsPrep(q)) return Promise.resolve(true);
  const id = prepId(exam, i);
  if (prepJobs.has(id)) return prepJobs.get(id);
  if (needsFigureToSolve(q)) {
    prepFailed.add(id); // không đoán bừa khi chưa nhìn được hình
    return Promise.resolve(false);
  }
  prepFailed.delete(id);

  const job = (async () => {
    const r = await postJSON(
      "/api/solve",
      {
        subject: exam.subject,
        questions: [
          {
            i,
            type: q.type,
            text: q.text,
            options: q.options,
            statements: q.statements,
            convert: q.type === "short",
            // Câu có hình: gửi kèm ảnh để AI nhìn và giải đúng, tránh đoán mò bằng chữ
            image: q.figureImage ? stripDataUrl(q.figureImage) : undefined,
          },
        ],
      },
      65000,
    );
    let ok = false;
    if (r.ok) {
      const a = (r.data?.answers || []).find((x) => Number(x?.i) === i);
      ok = applyPrepared(exam, i, a);
    } else if (Date.now() - lastPrepToast > 20000) {
      lastPrepToast = Date.now();
      toast(
        `${errorMessage(r)}. Câu này tạm thời chưa có đáp án chuẩn.`,
        "warn",
      );
    }
    if (!ok) prepFailed.add(id);
    return ok;
  })().finally(() => prepJobs.delete(id));
  prepJobs.set(id, job);
  return job;
}

function jobsOf(map, exam) {
  return [...map.entries()]
    .filter(([id]) => id.startsWith(exam.id + ":"))
    .map(([, p]) => p);
}

// Chuẩn bị trước tối đa `count` câu kế tiếp, lần lượt từng câu (không dồn dập gây quá tải)
async function prefetchAhead(exam, count = 2) {
  if (!lazyMode(exam) || prefetching.has(exam.id)) return;
  prefetching.add(exam.id);
  try {
    for (;;) {
      if (state.current !== exam || isFinished(exam)) break;
      const base = state.idx;
      const cur = prepJobs.get(prepId(exam, base));
      if (cur) await cur.catch(() => {}); // ưu tiên câu đang làm
      if (state.current !== exam || isFinished(exam)) break;

      let target = -1;
      for (
        let j = state.idx + 1;
        j <= state.idx + count && j < exam.questions.length;
        j++
      ) {
        if (needsPrep(exam.questions[j]) && !prepFailed.has(prepId(exam, j))) {
          target = j;
          break;
        }
      }
      if (target < 0) break;
      await prepareQuestion(exam, target);
      if (state.current === exam) {
        saveCurrent();
        renderNav();
      }
    }
  } finally {
    prefetching.delete(exam.id);
  }
}

// Gọi sau khi hiện một câu: bắt đầu chuẩn bị câu này (nếu cần) và các câu kế tiếp
function warmQuestion(exam, i) {
  const q = exam?.questions?.[i];
  if (!q || !lazyMode(exam) || isFinished(exam)) return;
  const id = prepId(exam, i);
  if (needsPrep(q) && !prepJobs.has(id) && !prepFailed.has(id)) {
    prepareQuestion(exam, i).then(() => afterPrep(exam, i));
  }
  prefetchAhead(exam, 2);
}

// Có kết quả chuẩn bị cho câu i: vẽ lại phần đang hiển thị
function afterPrep(exam, i) {
  if (state.current !== exam) return;
  saveCurrent();
  renderNav();
  if (state.idx !== i) return;
  renderAnswerArea();
  renderResult();
  updateGameBar();
  typeset([$("question-content"), $("answer-mcq"), $("answer-tf")]);
  if (modeOf(exam) === "quick" && exam.checked[i]) maybeAutoExplain(exam, i);
}

// Luyện tập nhanh: chỉ khi làm SAI mới tự hiện giải nhanh. Làm đúng thì không gọi AI.
function maybeAutoExplain(exam, i) {
  clearTimeout(state.autoTimer);
  const sig = JSON.stringify(exam.answers[i]);
  state.autoTimer = setTimeout(async () => {
    if (state.current !== exam || state.idx !== i || !exam.checked[i]) return;
    await prepareQuestion(exam, i); // chờ có đáp án để biết đúng hay sai
    if (state.current !== exam || state.idx !== i) return;
    if (JSON.stringify(exam.answers[i]) !== sig) return; // đã đổi đáp án
    saveCurrent();
    renderAnswerArea();
    renderNav();
    renderResult();
    const g = gradeQuestion(exam.questions[i], exam.answers[i]);
    if (g.status === "wrong" || g.status === "partial") setTab("quick", true);
    else renderExplainPanel();
    typeset([$("answer-mcq"), $("answer-tf")]);
  }, 400);
}

function quickHint(exam, i) {
  if (!exam.checked[i]) {
    return 'Chọn đáp án. Nếu làm sai, AI sẽ tự hiện cách giải nhanh; muốn xem lời giải đầy đủ thì bấm "Giải chi tiết từng bước".';
  }
  const g = gradeQuestion(exam.questions[i], exam.answers[i]);
  if (g.status === "correct") {
    return '✅ Bạn làm đúng rồi! Muốn xem cách làm nhanh thì bấm tab giải nhanh ở trên, hoặc "Giải chi tiết từng bước".';
  }
  if (g.status === "nokey") {
    return "Câu này chưa có đáp án chuẩn. Bấm tab giải nhanh ở trên để AI hướng dẫn cách làm.";
  }
  return "Câu này chưa đúng. Bấm tab giải nhanh ở trên để xem cách làm.";
}

/* ============ Kiểu làm bài: luyện tập nhanh / thi thử / trò chơi ============ */

function modeOf(exam) {
  return MODE_LABEL[exam?.mode] ? exam.mode : "quick";
}

function isFinished(exam) {
  return modeOf(exam) === "game" ? !!exam.game?.finished : !!exam.submitted;
}

// AI hỗ trợ khi luyện tập nhanh, hoặc sau khi nộp bài / kết thúc trò chơi.
// Đang chơi trò chơi: chỉ mở cho câu vừa chốt mà làm sai (hoặc chưa có đáp án chuẩn).
function aiAllowed(exam, i = state.idx) {
  if (modeOf(exam) === "quick" || isFinished(exam)) return true;
  if (modeOf(exam) === "game") {
    const g = exam.game;
    if (!g || g.times[i] == null || pendingLocks.has(prepId(exam, i)))
      return false;
    return (
      gradeQuestion(exam.questions[i], exam.answers[i]).status !== "correct"
    );
  }
  return false;
}

function canAnswer(exam, i) {
  const m = modeOf(exam);
  if (m === "mock") return !exam.submitted;
  if (m === "game") {
    return (
      !exam.game?.finished &&
      exam.game?.times[i] == null &&
      !exam.game?.preparing
    );
  }
  return true;
}

function fmtTime(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/* ---------- Kỷ lục ---------- */

function readRecords() {
  try {
    const obj = JSON.parse(localStorage.getItem(RECORD_KEY) || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// Điểm cao hơn thắng; bằng điểm thì ai làm nhanh hơn thắng
function cmpRun(a, b) {
  // Trò chơi: nhiều điểm hơn thắng; còn lại điểm 10 cao hơn, bằng điểm thì nhanh hơn
  if (a.points != null && b.points != null && a.points !== b.points) {
    return b.points - a.points;
  }
  return b.score10 - a.score10 || a.timeMs - b.timeMs;
}

function recordKeyOf(exam) {
  return `${exam.recordKey || exam.id}:${modeOf(exam)}`;
}

function saveRun(exam, run) {
  const key = recordKeyOf(exam);
  const all = readRecords();
  const list = Array.isArray(all[key]) ? all[key] : [];
  const prevBest = list.length ? [...list].sort(cmpRun)[0] : null;
  const isRecord = !prevBest || cmpRun(run, prevBest) < 0;
  const top = [...list, run].sort(cmpRun).slice(0, 5);
  all[key] = top;
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(all));
  } catch {
    /* bỏ qua nếu không lưu được */
  }
  return { isRecord, prevBest, top };
}

/* ---------- Thi thử có giờ ---------- */

let autoSubmitId = null;

function startMock(exam) {
  if (!exam.startedAt) {
    exam.startedAt = Date.now();
    exam.endsAt = exam.timeLimitMin
      ? exam.startedAt + exam.timeLimitMin * 60000
      : null;
  }
}

function updateTimerChip() {
  const el = $("exam-timer");
  const exam = state.current;
  if (!el) return;
  if (!exam || modeOf(exam) !== "mock" || exam.submitted) {
    setHidden(el, true);
    return;
  }
  setHidden(el, false);
  if (exam.endsAt) {
    const left = exam.endsAt - Date.now();
    el.textContent = `⏱ ${fmtTime(left)}`;
    el.classList.toggle("is-warn", left < 5 * 60000);
  } else {
    el.textContent = `⏱ ${fmtTime(Date.now() - exam.startedAt)}`;
    el.classList.remove("is-warn");
  }
}

/* ---------- Trò chơi: mỗi câu có giờ ---------- */

function newGame() {
  return {
    idx: 0,
    times: [], // thời gian dùng cho từng câu (ms)
    points: [],
    totalPoints: 0,
    streak: 0,
    bestStreak: 0,
    qStart: 0,
    qEndsAt: 0,
    limitMs: 0,
    lastMsg: "",
    finished: false,
    preparing: false, // đang chờ AI dựng phương án: đồng hồ chưa chạy
    breakdown: [], // điểm chi tiết từng câu: { base, speed, streak }
    scored: [], // câu đã tính điểm
  };
}

function questionTimeMs(q) {
  let sec = GAME_TIME_SEC[q.difficulty] || GAME_TIME_SEC[2];
  if (q.type !== "mcq") sec = Math.max(sec, 120); // đúng/sai và trả lời ngắn cần nhiều thời gian hơn
  return Math.min(sec, 300) * 1000; // tối đa 5 phút
}

function gameBegin(i) {
  const exam = state.current;
  const g = exam.game;
  const q = exam.questions[i];
  clearTimeout(state.gameNextTimer);
  g.idx = i;
  g.lastMsg = "";
  if (awaitingPrep(exam, i)) {
    // Câu tự luận cần AI dựng phương án trắc nghiệm: đồng hồ chỉ chạy khi câu đã sẵn sàng
    g.preparing = true;
    g.limitMs = questionTimeMs(q);
    g.qStart = 0;
    g.qEndsAt = 0;
    showQuestion(i);
    prepareQuestion(exam, i).then((ok) => {
      if (state.current !== exam || g.finished || g.idx !== i) return;
      if (!ok) {
        toast(
          "AI đang bận nên câu này chưa có đáp án chuẩn và sẽ không tính điểm.",
          "warn",
        );
      }
      gameStartTimer(i);
    });
  } else {
    gameStartTimer(i);
  }
}

function gameStartTimer(i) {
  const exam = state.current;
  const g = exam.game;
  g.preparing = false;
  g.limitMs = questionTimeMs(exam.questions[i]);
  g.qStart = Date.now();
  g.qEndsAt = g.qStart + g.limitMs;
  showQuestion(i);
}

function refreshGameUI(exam) {
  renderAnswerArea();
  renderNav();
  updateGameBar();
  updateNavButtons();
  applyModeUI(exam);
}

// Điểm trò chơi của một câu (hiện khi xem lại sau khi kết thúc)
function gamePointsText(exam, i) {
  const q = exam.questions[i];
  const g = gradeQuestion(q, exam.answers[i]);
  const pts = exam.game?.points?.[i] ?? 0;
  const bd = exam.game?.breakdown?.[i];
  if (g.status === "nokey") {
    return "Câu này chưa có đáp án chuẩn nên không tính điểm.";
  }
  if (g.status === "correct") {
    const parts = bd
      ? ` (${bd.base} cơ bản${bd.speed ? ` + ${bd.speed} tốc độ` : ""}${bd.streak ? ` + ${bd.streak} chuỗi 🔥` : ""})`
      : "";
    return `✅ Chính xác! ⭐ +${pts} điểm${parts}`;
  }
  if (g.status === "partial") {
    return `⚠️ Đúng ${g.c}/4 ý, ⭐ +${pts} điểm. Đáp án: ${keyText(q)}`;
  }
  return `❌ Chưa đúng (0 điểm). Đáp án: ${keyText(q)}`;
}

function gameLock(i, timedOut) {
  const exam = state.current;
  const g = exam?.game;
  if (!g || g.finished || g.times[i] != null) return;
  const q = exam.questions[i];
  const elapsed = Math.min(g.limitMs, Date.now() - g.qStart);

  // Chốt giờ ngay lúc bấm (không phụ thuộc thời gian AI kiểm tra đáp án)
  exam.checked[i] = true;
  g.times[i] = timedOut ? g.limitMs : elapsed;
  g.points[i] = 0;
  clearTimeout(state.gameNextTimer);

  // Chưa có đáp án chuẩn: chờ AI giải câu này rồi mới chấm điểm
  if (needsPrep(q) && !prepFailed.has(prepId(exam, i))) {
    g.lastMsg = "⏳ AI đang kiểm tra đáp án...";
    refreshGameUI(exam);
    const id = prepId(exam, i);
    const job = prepareQuestion(exam, i).then(() => {
      pendingLocks.delete(id);
      if (state.current === exam && !g.finished) gameScore(i, timedOut);
    });
    pendingLocks.set(id, job);
    return;
  }
  gameScore(i, timedOut);
}

// Điểm = đúng bao nhiêu × (100 cơ bản + tối đa 100 thưởng tốc độ) + thưởng chuỗi đúng (tối đa +50)
function gameScore(i, timedOut) {
  const exam = state.current;
  const g = exam?.game;
  if (!g || g.finished) return;
  if (g.scored[i]) return;
  g.scored[i] = true;

  const q = exam.questions[i];
  const elapsed = g.times[i] ?? g.limitMs;
  const gr = gradeQuestion(q, exam.answers[i]);
  const hasKey = gr.status !== "nokey" && gr.max > 0;
  const ratio = hasKey ? gr.earned / gr.max : 0;
  const remainFrac = timedOut ? 0 : Math.max(0, 1 - elapsed / g.limitMs);

  const base = Math.round(ratio * 100);
  const speed = Math.round(ratio * 100 * remainFrac);
  let bonus = 0;
  if (ratio === 1) {
    g.streak += 1;
    bonus = Math.min(g.streak - 1, 5) * 10;
  } else if (hasKey) {
    g.streak = 0;
  }
  g.bestStreak = Math.max(g.bestStreak, g.streak);
  const pts = base + speed + bonus;
  g.points[i] = pts;
  g.breakdown[i] = { base, speed, streak: bonus };
  g.totalPoints += pts;

  const detail = `${base} cơ bản${speed ? ` + ${speed} tốc độ` : ""}${bonus ? ` + ${bonus} chuỗi 🔥` : ""}`;
  if (!hasKey) g.lastMsg = "Câu này chưa có đáp án nên không tính điểm.";
  else if (gr.status === "correct") {
    g.lastMsg = `✅ Chính xác! +${pts} điểm (${detail})`;
  } else if (gr.status === "partial") {
    g.lastMsg = `⚠️ Đúng ${gr.c}/4 ý, +${pts} điểm. Đáp án: ${keyText(q)}`;
  } else if (timedOut) g.lastMsg = `⏰ Hết giờ! Đáp án: ${keyText(q)}`;
  else g.lastMsg = `❌ Chưa đúng. Đáp án: ${keyText(q)}`;

  const wrong = gr.status === "wrong" || gr.status === "partial";
  if (wrong) g.lastMsg += " · Bấm “Câu tiếp” khi đã xem xong.";

  saveCurrent();
  refreshGameUI(exam);
  typeset([$("answer-mcq"), $("answer-tf"), $("game-feedback")]);

  // Người chơi đã sang câu khác trong lúc chờ chấm: chỉ cập nhật điểm, không đụng giao diện câu mới
  if (state.idx !== i) return;

  clearTimeout(state.gameNextTimer);
  if (wrong) {
    // Làm sai: không tự chuyển câu. Hiện giải nhanh để học ngay; có thể bấm giải chi tiết
    renderExplainPanel();
    setTab("quick", true);
  } else {
    state.gameNextTimer = setTimeout(gameNext, GAME_NEXT_DELAY_MS);
  }
}

function gameNext() {
  const exam = state.current;
  if (!exam || modeOf(exam) !== "game" || exam.game.finished) return;
  clearTimeout(state.gameNextTimer);
  const i = exam.game.idx;
  if (exam.game.times[i] == null) return; // chưa chốt câu hiện tại
  if (i >= exam.questions.length - 1) finishGame();
  else gameBegin(i + 1);
}

let finishingGame = false;

async function finishGame() {
  const exam = state.current;
  if (!exam || exam.game?.finished || finishingGame) return;
  clearTimeout(state.gameNextTimer);
  const waiting = jobsOf(pendingLocks, exam);
  if (waiting.length) {
    finishingGame = true;
    setLoading(true, "AI đang chấm điểm các câu cuối...");
    try {
      await Promise.allSettled(waiting);
    } finally {
      setLoading(false);
      finishingGame = false;
    }
    if (state.current !== exam) return;
  }
  const g = exam.game;
  exam.questions.forEach((q, i) => {
    exam.checked[i] = true;
    if (g.times[i] == null) g.times[i] = 0;
    if (g.points[i] == null) g.points[i] = 0;
  });
  g.finished = true;
  g.finishedAt = Date.now();

  const timeMs = g.times.reduce((n, t) => n + (t || 0), 0);
  const { earned, max } = totals();
  const score10 = max ? Math.round((earned / max) * 1000) / 100 : 0;
  const rec = saveRun(exam, {
    score10,
    timeMs,
    points: g.totalPoints,
    at: Date.now(),
  });
  exam.result = {
    score10,
    timeMs,
    points: g.totalPoints,
    bestStreak: g.bestStreak,
    isRecord: rec.isRecord,
    prevBest: rec.prevBest,
    top: rec.top,
  };
  saveCurrent(true);
  showQuestion(0);
}

function updateGameBar() {
  const exam = state.current;
  const bar = $("game-bar");
  if (!bar) return;
  const show = exam && modeOf(exam) === "game" && !exam.game.finished;
  setHidden(bar, !show);
  if (!show) return;

  const g = exam.game;
  const q = exam.questions[g.idx];
  const locked = g.times[g.idx] != null;
  const remain = locked
    ? Math.max(0, g.limitMs - g.times[g.idx])
    : g.preparing
      ? g.limitMs
      : Math.max(0, g.qEndsAt - Date.now());
  const frac = g.limitMs ? remain / g.limitMs : 0;

  $("game-q-time").textContent = fmtTime(remain);
  $("game-q-time").classList.toggle(
    "is-warn",
    !locked && (frac < 0.2 || remain < 10000),
  );
  $("game-diff").textContent =
    `${DIFF_LABEL[q.difficulty] || "Vừa"} · tối đa ${fmtTime(g.limitMs)}`;
  $("game-score").textContent = `⭐ ${g.totalPoints}`;
  $("game-streak").textContent = g.streak >= 2 ? `🔥 ${g.streak}` : "";
  $("game-progress-fill").style.width = `${Math.round(frac * 100)}%`;
  $("game-progress-fill").classList.toggle("is-warn", !locked && frac < 0.2);
  $("game-feedback").textContent = locked
    ? g.lastMsg || ""
    : g.preparing
      ? "⏳ AI đang chuẩn bị câu trắc nghiệm... (đồng hồ chạy khi câu sẵn sàng)"
      : "";
}

/* ---------- Đồng hồ chung ---------- */

function tick() {
  const exam = state.current;
  const view = $("exam-view");
  if (!exam || !view || view.classList.contains("hidden")) return;
  const m = modeOf(exam);
  if (m === "mock" && !exam.submitted) {
    updateTimerChip();
    if (exam.endsAt && Date.now() >= exam.endsAt && autoSubmitId !== exam.id) {
      autoSubmitId = exam.id;
      toast("Hết giờ! Bài làm được nộp tự động.", "warn");
      submitExam({ auto: true });
    }
  } else if (m === "game" && !exam.game.finished) {
    const i = exam.game.idx;
    if (exam.game.times[i] == null && !exam.game.preparing) {
      if (Date.now() >= exam.game.qEndsAt) gameLock(i, true);
      else updateGameBar();
    }
  }
}

/* ---------- Giao diện theo kiểu làm bài ---------- */

function applyModeUI(exam) {
  const m = modeOf(exam);
  const finished = isFinished(exam);
  const playingGame = m === "game" && !finished;
  const ai = aiAllowed(exam);

  setHidden($("explanation-panel"), !ai);
  setHidden($("chat-panel"), !ai);
  setHidden($("score-panel"), playingGame);
  setHidden($("share-exam-btn"), m !== "quick" && !finished);

  const submit = $("submit-exam-btn");
  submit.textContent = playingGame ? "Kết thúc" : "Nộp bài";
  setHidden(submit, m !== "quick" && finished);

  const badge = $("exam-mode-badge");
  if (badge) badge.textContent = MODE_LABEL[m];

  const view = $("exam-view");
  if (view) {
    view.dataset.mode = m;
    view.dataset.playing = String(playingGame);
  }

  renderSummary(exam);
  updateTimerChip();
  updateGameBar();
}

function renderSummary(exam) {
  const box = $("summary-panel");
  if (!box) return;
  const m = modeOf(exam);
  if (!isFinished(exam) || !exam.result) {
    box.replaceChildren();
    setHidden(box, true);
    return;
  }
  const r = exam.result;
  let right = 0;
  let wrong = 0;
  let skipped = 0;
  let nokey = 0;
  exam.questions.forEach((q, i) => {
    const answered = isAnswered(q, exam.answers[i]);
    const g = gradeQuestion(q, exam.answers[i]);
    if (!answered) skipped++;
    if (g.status === "nokey") nokey++;
    else if (g.status === "correct") right++;
    else if (answered) wrong++;
  });

  const title =
    m === "game"
      ? "🏁 Hoàn thành trò chơi"
      : m === "mock"
        ? "📝 Kết quả thi thử"
        : "📊 Kết quả luyện tập";
  const stat = (v, label) =>
    `<div class="sum-stat"><b>${v}</b><span>${label}</span></div>`;

  let html = `<details class="summary-card" open><summary>${title}</summary>`;
  html += `<div class="summary-score">${Number(r.score10).toFixed(2)}<small> / 10</small></div>`;
  html += `<div class="summary-stats">${stat(right, "đúng")}${stat(wrong, "sai")}${stat(skipped, "chưa làm")}${
    m !== "quick" ? stat(fmtTime(r.timeMs), "thời gian") : ""
  }</div>`;
  const fmtRun = (x) =>
    m === "game"
      ? `⭐ ${x.points ?? 0} điểm · ${Number(x.score10).toFixed(2)}đ · ${fmtTime(x.timeMs)}`
      : `${Number(x.score10).toFixed(2)}đ · ${fmtTime(x.timeMs)}`;
  if (m === "game") {
    const scored = exam.questions.filter(
      (q) => q.key !== null && q.key !== undefined,
    ).length;
    html += `<div class="summary-line">⭐ ${r.points} điểm · 🔥 chuỗi đúng dài nhất: ${r.bestStreak} · 🎯 ${right}/${scored || exam.questions.length} câu đúng</div>`;
  }
  if (m !== "quick") {
    const best = r.top?.[0];
    if (r.isRecord) {
      html += `<div class="record-box is-new">🏆 Kỷ lục mới!${
        r.prevBest ? ` (kỷ lục cũ: ${fmtRun(r.prevBest)})` : ""
      }</div>`;
    } else if (best) {
      html += `<div class="record-box">🏅 Kỷ lục hiện tại: ${fmtRun(best)}</div>`;
    }
    if (r.top?.length) {
      html += `<ol class="record-list">${r.top
        .map(
          (x) =>
            `<li>${fmtRun(x)} · ${new Date(x.at).toLocaleDateString("vi-VN")}</li>`,
        )
        .join("")}</ol>`;
    }
  }
  if (nokey) {
    html += `<div class="summary-note">${nokey} câu chưa có đáp án nên không tính điểm.</div>`;
  }
  html += `<div class="summary-actions"><button type="button" class="btn btn-sm btn-primary" id="summary-retry">Làm lại</button>${
    m !== "quick"
      ? '<button type="button" class="btn btn-sm btn-outline" id="summary-practice">Luyện tập lại cùng AI</button>'
      : ""
  }</div></details>`;
  box.innerHTML = html;
  setHidden(box, false);
  box
    .querySelector("#summary-retry")
    ?.addEventListener("click", () => restartExam());
  box
    .querySelector("#summary-practice")
    ?.addEventListener("click", () => restartExam("quick"));
}

// Làm lại cùng đề (có thể đổi sang kiểu làm bài khác)
function restartExam(newMode) {
  const old = state.current;
  if (!old) return;
  const mode = newMode || modeOf(old);
  openExam({
    ...old,
    id: makeId(),
    mode,
    timeLimitMin:
      mode === "mock" ? (modeOf(old) === "mock" ? old.timeLimitMin : 60) : 0,
    createdAt: Date.now(),
    answers: old.questions.map(initialAnswer),
    checked: old.questions.map(() => false),
    submitted: false,
    result: null,
    game: null,
    startedAt: null,
    endsAt: null,
    finishedAt: null,
  });
}

let submitting = false;

async function submitExam(opts = {}) {
  const exam = state.current;
  if (!exam || submitting) return;
  const m = modeOf(exam);

  if (m === "game") {
    if (exam.game.finished) return;
    if (
      !opts.auto &&
      !window.confirm(
        "Kết thúc trò chơi ngay? Các câu chưa làm sẽ tính là sai.",
      )
    ) {
      return;
    }
    finishGame();
    return;
  }

  const left = exam.questions.filter(
    (q, i) => !isAnswered(q, exam.answers[i]),
  ).length;
  if (
    !opts.auto &&
    m === "mock" &&
    left &&
    !window.confirm(`Còn ${left} câu chưa làm. Bạn chắc chắn muốn nộp bài?`)
  ) {
    return;
  }

  submitting = true;
  try {
    // Thi thử: giải nốt các câu thiếu đáp án. Luyện tập nhanh: chỉ chờ các câu đang được kiểm tra.
    const needSolve =
      m === "mock" &&
      (fillingNow.has(exam.id) ||
        (!exam.solveTried &&
          exam.questions.some((q) => q.key === null || q.key === undefined)));
    if (needSolve) {
      setLoading(true, "AI đang giải các câu chưa có đáp án để chấm điểm...");
      await fillMissingKeys(exam);
      setLoading(false);
    } else if (m === "quick") {
      const waiting = jobsOf(prepJobs, exam);
      if (waiting.length) {
        setLoading(true, "AI đang kiểm tra các đáp án cuối...");
        await Promise.allSettled(waiting);
        setLoading(false);
      }
    }
    if (state.current !== exam) return;

    exam.checked = exam.questions.map(() => true);
    exam.submitted = true;
    exam.finishedAt = Date.now();

    const { earned, max } = totals();
    const score10 = max ? Math.round((earned / max) * 1000) / 100 : 0;
    let timeMs = 0;
    if (m === "mock" && exam.startedAt) {
      timeMs = exam.finishedAt - exam.startedAt;
      if (exam.endsAt) timeMs = Math.min(timeMs, exam.timeLimitMin * 60000);
    }
    exam.result = { score10, timeMs, isRecord: false };
    if (m === "mock") {
      const rec = saveRun(exam, { score10, timeMs, at: Date.now() });
      Object.assign(exam.result, {
        isRecord: rec.isRecord,
        prevBest: rec.prevBest,
        top: rec.top,
      });
    }
    saveCurrent(true);
    showQuestion(state.idx);

    const noKey = exam.questions.filter(
      (q) => q.key === null || q.key === undefined,
    ).length;
    const aiSolved = exam.questions.filter((q) => q.solved).length;
    let msg = `Đã nộp bài: ${score10.toFixed(2)}/10`;
    if (aiSolved)
      msg += `. ${aiSolved} câu chấm theo đáp án do AI giải (tham khảo)`;
    if (noKey) msg += `. ${noKey} câu chưa có đáp án nên không tính điểm`;
    toast(msg, noKey ? "warn" : "success");
  } finally {
    submitting = false;
    setLoading(false);
  }
}

function encodeShare(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

async function shareExam() {
  const exam = state.current;
  if (!exam) return;
  const payload = {
    v: 1,
    title: exam.title,
    subject: exam.subject,
    format: exam.format,
    questions: exam.questions.map(({ figureImage, ...rest }) => rest),
  };
  const url = `${location.origin}${location.pathname}#de=${encodeShare(payload)}`;
  if (url.length > 60000) {
    toast("Đề quá lớn để chia sẻ bằng liên kết. Hãy giảm số câu.", "warn");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(
      "Đã sao chép liên kết đề. Hình minh họa không được chia sẻ kèm.",
      "success",
    );
  } catch {
    window.prompt("Sao chép liên kết này:", url);
  }
}

function openSharedFromHash() {
  const m = location.hash.match(/^#de=(.+)$/);
  if (!m) return false;
  try {
    const bin = atob(m[1]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(payload.questions)) throw new Error("sai định dạng");
    openExam({
      id: makeId(),
      title: payload.title || "Đề chia sẻ",
      subject: payload.subject || "",
      format: payload.format || "thpt",
      createdAt: Date.now(),
      questions: payload.questions,
      answers: payload.questions.map(initialAnswer),
      checked: payload.questions.map(() => false),
    });
    history.replaceState(null, "", location.pathname);
    return true;
  } catch {
    toast("Liên kết chia sẻ không hợp lệ.", "error");
    return false;
  }
}

/* ============ Điều hướng & giao diện ============ */

function goHome() {
  clearTimeout(state.gameNextTimer);
  if (saveTimer) saveCurrent(true);
  setHidden($("exam-view"), true);
  $("exam-view").classList.remove("active");
  setHidden($("home-view"), false);
  $("home-view").classList.add("active");
  document.body.dataset.view = "home";
  setNavOpen(false);
  renderRecent();
  window.scrollTo(0, 0);
}

function applyLayout(mode) {
  document.body.dataset.layout = mode;
  document.querySelectorAll(".layout-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  try {
    localStorage.setItem(LAYOUT_KEY, mode);
  } catch {
    /* bỏ qua nếu không lưu được */
  }
  requestAnimationFrame(syncLayoutVars);
}

/* ============ Khởi động ============ */

function init() {
  let saved = "auto";
  try {
    saved = localStorage.getItem(LAYOUT_KEY) || "auto";
  } catch {
    /* bỏ qua */
  }
  applyLayout(["auto", "mobile", "desktop"].includes(saved) ? saved : "auto");

  document.querySelectorAll(".layout-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyLayout(btn.dataset.mode));
  });

  on("logo-btn", "click", (e) => {
    e.preventDefault();
    goHome();
  });
  on("file-input", "change", onFilesChosen);
  on("camera-input", "change", onFilesChosen);
  on("select-all-pages-btn", "click", selectAllPages);
  on("deselect-all-pages-btn", "click", deselectAllPages);
  on("clear-files-btn", "click", clearPages);
  on("create-exam-btn", "click", createExam);
  on("back-home-btn", "click", goHome);
  on("prev-question-btn", "click", () => navigateTo(state.idx - 1));
  on("next-question-btn", "click", onNextClick);
  on("submit-exam-btn", "click", () => submitExam());
  on("share-exam-btn", "click", shareExam);
  document.body.dataset.view = "home";

  // Thanh số câu (điện thoại): nút mở/thu gọn, bấm ra ngoài hoặc Esc để đóng
  on("nav-toggle-btn", "click", () =>
    setNavOpen(!$("nav-strip").classList.contains("nav-open")),
  );
  $("nav-strip")?.addEventListener("click", (e) => {
    if (e.target.closest(".exam-topbar-actions .btn")) setNavOpen(false);
  });
  document.addEventListener("click", (e) => {
    const strip = $("nav-strip");
    if (strip?.classList.contains("nav-open") && !strip.contains(e.target)) {
      setNavOpen(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setNavOpen(false);
  });

  // Khung chat: thu gọn mặc định để không chiếm chỗ (chỉ có tác dụng trên điện thoại)
  $("chat-panel")?.classList.add("is-collapsed");
  $("chat-header")?.setAttribute("aria-expanded", String(!isMobileLayout()));
  on("chat-header", "click", toggleChat);
  $("chat-header")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleChat();
    }
  });

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => syncLayoutVars());
    [".app-header", "#exam-topbar", "#nav-strip"].forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) ro.observe(el);
    });
  }
  window.addEventListener("resize", syncLayoutVars);
  syncLayoutVars();

  on("explain-current-btn", "click", explainCurrent);
  on("tab-essay", "click", () => setTab("essay"));
  on("tab-quick", "click", () => setTab("quick"));
  on("chat-form", "submit", sendChat);
  on("short-answer-input", "change", onShortChange);

  // Ẩn/hiện các tùy chọn ở trang chủ theo kiểu làm bài và chế độ xử lý
  document
    .querySelectorAll(
      'input[name="play-mode"], input[name="process-mode"], input[name="exam-format"]',
    )
    .forEach((el) => el.addEventListener("change", syncHomeOptions));
  syncHomeOptions();

  setInterval(tick, 500); // đồng hồ thi thử và trò chơi

  renderRecent();
  openSharedFromHash();
}

function syncHomeOptions() {
  const val = (name) =>
    document.querySelector(`input[name="${name}"]:checked`)?.value;
  const gen = val("process-mode") === "generate";
  setHidden($("mock-time-item"), val("play-mode") !== "mock");
  setHidden($("gen-structure-item"), !gen);
  setHidden(
    $("short-count-wrap"),
    !(gen && val("exam-format") === "short-mcq"),
  );
}

init();
