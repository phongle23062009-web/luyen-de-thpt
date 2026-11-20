// app.js — LuyệnĐề THPT (frontend thuần, không đăng nhập, không Firebase)
// Khớp với index.html và các API: /api/extract, /api/grade-explain, /api/quick-tip, /api/chat

const MAX_PAGES = 20; // tối đa số trang nạp vào
const MAX_SEND = 8; // tối đa số trang chọn cùng lúc (chế độ tạo đề mới)
const RECENT_KEY = "recent_exams";
const RECENT_LIMIT = 5;
const LAYOUT_KEY = "layout_mode";

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

const state = {
  pages: [], // { canvas, selected }
  current: null, // đề đang làm
  idx: 0, // chỉ số câu hiện tại
  tab: "essay", // tab lời giải đang mở
  explain: {}, // cache lời giải theo chỉ số câu
  quick: {}, // cache mẹo nhanh theo chỉ số câu
  chat: {}, // hội thoại theo chỉ số câu
  extracting: false,
  explaining: false,
  chatting: false,
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

/* ============ Gọi API ============ */

async function postJSON(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: "network", message: err.message };
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

// Cắt hình minh họa theo box [x0,y0,x1,y1] tọa độ 0–1000 trên trang
function cropFigure(fig, page) {
  if (!fig || typeof fig !== "object" || !Array.isArray(fig.box)) return null;
  if (fig.box.length < 4 || !page) return null;
  const src = page.canvas;
  const [a, b, c, d] = fig.box.map(Number);
  if ([a, b, c, d].some((n) => Number.isNaN(n))) return null;

  const x0 = Math.min(a, c) / 1000;
  const x1 = Math.max(a, c) / 1000;
  const y0 = Math.min(b, d) / 1000;
  const y1 = Math.max(b, d) / 1000;

  const sx = clamp01(x0) * src.width;
  const sy = clamp01(y0) * src.height;
  const sw = clamp01(x1) * src.width - sx;
  const sh = clamp01(y1) * src.height - sy;
  if (sw < 40 || sh < 40) return null;

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
    state.pages.push({ canvas, selected: false });
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
  state.pages.push({ canvas, selected: false });
}

async function loadFiles(files) {
  if (!files.length) return;
  setLoading(true, "Đang đọc tài liệu...");
  let added = 0;
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

  if (added) {
    if (!state.pages.some((p) => p.selected)) {
      state.pages.slice(0, 3).forEach((p) => (p.selected = true));
    }
    setHidden($("page-grid-section"), false);
    renderPageGrid();
  }
}

async function onFilesChosen(e) {
  const input = e.target;
  const files = Array.from(input.files || []);
  input.value = "";
  await loadFiles(files);
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
    if (["true", "đúng", "dung", "d", "t", "yes"].includes(s)) return true;
    if (["false", "sai", "s", "f", "no"].includes(s)) return false;
  }
  return null;
}

function normalizeKey(q, type) {
  const raw = q.answer ?? q.key;
  if (raw === null || raw === undefined || raw === "") return null;

  if (type === "mcq") {
    const letter = String(raw).trim().toUpperCase().charAt(0);
    return /^[ABCD]$/.test(letter) ? letter : null;
  }
  if (type === "tf") {
    const labels = ["a", "b", "c", "d"];
    const vals = labels.map((l, k) =>
      toBool(
        Array.isArray(raw) ? raw[k] : (raw?.[l] ?? raw?.[l.toUpperCase()]),
      ),
    );
    return vals.every((v) => v === null) ? null : vals;
  }
  const s = String(raw).trim();
  return s || null;
}

// Chuyển dữ liệu AI thành câu hỏi. `pages` là danh sách trang tương ứng với figure.page
function buildQuestions(data, format, pages) {
  const raw = Array.isArray(data?.questions) ? data.questions : [];
  const items = [];

  raw.forEach((q) => {
    if (!q || typeof q !== "object") return;
    const type = detectType(q);
    if (format === "short" && type !== "mcq") return;
    const text = String(q.prompt ?? q.text ?? "").trim();
    if (!text) return;

    const fig = q.figure && typeof q.figure === "object" ? q.figure : null;
    const page = pages[Number(fig?.page) || 0] || pages[0];
    items.push({
      type,
      text,
      options: type === "mcq" ? normalizeOptions(q.options) : null,
      statements: type === "tf" ? normalizeStatements(q.statements) : null,
      key: normalizeKey(q, type),
      figure: fig,
      figureImage: cropFigure(fig, page),
    });
  });

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
  const isShort =
    document.querySelector('input[name="exam-format"]:checked')?.value ===
    "short-mcq";
  const format = isShort ? "short" : "thpt";

  const shortCount = Math.max(
    1,
    Math.min(60, Number($("short-count")?.value) || 10),
  );
  const totalCounts = isShort
    ? { p1: shortCount, p2: 0, p3: 0 }
    : SUBJECT_COUNTS[subjectKey] || { p1: 0, p2: 0, p3: 0 };

  state.extracting = true;
  let questions = [];
  const failedPages = [];
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
        questions = mergeAndRenumber(buildQuestions(r.data, format, selected));
      } else {
        lastError = r;
      }
    } else {
      // Tách đề có sẵn: gửi TỪNG trang để AI đọc kỹ và không bỏ sót câu
      const jobs = selected.length ? selected : [null];
      for (let i = 0; i < jobs.length; i++) {
        const page = jobs[i];
        setLoading(true, `Đang đọc trang ${i + 1}/${jobs.length}...`);
        const r = await postJSON("/api/extract", {
          images: page ? [compressCanvas(page.canvas)] : [],
          text: i === 0 ? text : "",
          subject: subjectLabel,
          mode,
          format,
          counts: { p1: 0, p2: 0, p3: 0 }, // AI tự lấy hết câu trên trang
        });
        if (!r.ok) {
          failedPages.push(i + 1);
          lastError = r;
          continue;
        }
        // Mỗi yêu cầu chỉ có 1 trang nên figure.page luôn là 0 → dùng đúng trang đó
        questions.push(...buildQuestions(r.data, format, page ? [page] : []));
      }
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
  } else if (
    mode === "extract" &&
    questions.length < totalCounts.p1 + totalCounts.p2 + totalCounts.p3
  ) {
    toast(
      `Tách được ${questions.length} câu. Nếu thiếu, hãy chọn thêm trang có đề.`,
      "warn",
    );
  }

  openExam({
    id: makeId(),
    title: "Đề luyện tập " + subjectLabel,
    subject: subjectLabel,
    format,
    createdAt: Date.now(),
    questions,
    answers: questions.map(initialAnswer),
    checked: questions.map(() => false),
  });
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

function saveCurrent() {
  if (!state.current) return;
  const list = readRecent().filter((e) => e.id !== state.current.id);
  list.unshift(state.current);
  const ok = writeRecent(list);
  $("save-status").textContent = ok
    ? "Đã lưu tự động"
    : "Không lưu được (bộ nhớ trình duyệt đầy)";
}

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
    meta.textContent = `${item.subject || ""} · ${progressOf(item)} · ${new Date(
      item.createdAt,
    ).toLocaleString("vi-VN")}`;
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
  if (state.current.format === "short") return 10 / Math.max(1, total);
  if (q.type === "mcq") return 0.25;
  if (q.type === "tf") return 1;
  return 0.5;
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
  state.current = exam;
  state.explain = {};
  state.quick = {};
  state.chat = {};
  state.idx = Math.max(
    0,
    exam.questions.findIndex((q, i) => !isAnswered(q, exam.answers[i])),
  );

  $("exam-title").textContent = exam.title || "Đề luyện tập";
  setHidden($("home-view"), true);
  $("home-view").classList.remove("active");
  setHidden($("exam-view"), false);
  $("exam-view").classList.add("active");

  saveCurrent();
  showQuestion(state.idx);
  window.scrollTo(0, 0);
}

function showQuestion(i) {
  const exam = state.current;
  if (!exam || !exam.questions.length) return;
  state.idx = Math.max(0, Math.min(i, exam.questions.length - 1));
  const idx = state.idx;
  const q = exam.questions[idx];

  const partNames = { mcq: "Phần I", tf: "Phần II", short: "Phần III" };
  $("question-part-badge").textContent =
    exam.format === "short" ? "Trắc nghiệm" : partNames[q.type];
  $("question-number-label").textContent =
    `Câu ${idx + 1}/${exam.questions.length}`;

  const content = $("question-content");
  content.textContent = q.text;
  content.style.whiteSpace = "pre-wrap";

  const imgBox = $("question-image-container");
  const img = $("question-image");
  if (q.figureImage) {
    img.src = q.figureImage;
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

  $("prev-question-btn").disabled = idx === 0;
  $("next-question-btn").disabled = idx === exam.questions.length - 1;
  typeset([content, $("answer-mcq"), $("answer-tf")]);
}

function renderAnswerArea() {
  const exam = state.current;
  const i = state.idx;
  const q = exam.questions[i];
  const ans = exam.answers[i];
  const checked = exam.checked[i];

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
        b.addEventListener("click", () => chooseTf(k, val));
        btns.appendChild(b);
      });
      row.append(text, btns);
      box.appendChild(row);
    });
  } else {
    $("short-answer-input").value = ans || "";
  }
}

function chooseMcq(label) {
  const exam = state.current;
  const i = state.idx;
  exam.answers[i] = label;
  exam.checked[i] = true;
  saveCurrent();
  renderAnswerArea();
  renderNav();
  renderResult();
  typeset([$("answer-mcq")]);
}

function chooseTf(k, val) {
  const exam = state.current;
  const i = state.idx;
  exam.answers[i][k] = val;
  exam.checked[i] = exam.answers[i].every((v) => v !== null);
  saveCurrent();
  renderAnswerArea();
  renderNav();
  renderResult();
  typeset([$("answer-tf")]);
}

function onShortChange(e) {
  const exam = state.current;
  if (!exam) return;
  const i = state.idx;
  exam.answers[i] = e.target.value.trim();
  exam.checked[i] = exam.answers[i] !== "";
  saveCurrent();
  renderNav();
  renderResult();
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
    btn.addEventListener("click", () => showQuestion(i));
    bar.appendChild(btn);
  });

  bar
    .querySelector(".is-current")
    ?.scrollIntoView({ block: "nearest", inline: "center" });
}

function renderResult() {
  const exam = state.current;
  const i = state.idx;
  const q = exam.questions[i];
  const ans = exam.answers[i];
  const box = $("question-result-status");
  let text;

  if (!exam.checked[i]) {
    text = "Chọn đáp án (hoặc nhập rồi nhấn Enter) để chấm câu này.";
  } else {
    const g = gradeQuestion(q, ans);
    if (g.status === "nokey") {
      text =
        'Câu này chưa có đáp án chuẩn. Bấm "Xem lời giải câu này" để AI hỗ trợ.';
    } else if (g.status === "correct") {
      text = `Chính xác! +${g.earned.toFixed(2)} điểm.`;
    } else if (g.status === "partial") {
      text = `Đúng ${g.c}/4 ý, +${g.earned.toFixed(2)} điểm. Đáp án: ${keyText(q)}`;
    } else {
      text = `Chưa đúng. Đáp án: ${keyText(q)}`;
    }
  }
  box.textContent = text;
  setHidden($("score-panel"), false);
  updateTotal();
}

function setTab(name) {
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

  if (!essayOn) loadQuick();
}

function renderExplainPanel() {
  const i = state.idx;
  $("content-essay").textContent =
    state.explain[i] || 'Bấm "Xem lời giải câu này" để AI chữa bài.';
  setHidden($("quick-warning"), true);
  $("quick-detail").textContent = state.quick[i] || "";
  setTab(state.tab);
  typeset([$("content-essay")]);
}

async function loadQuick() {
  const exam = state.current;
  const i = state.idx;
  const q = exam.questions[i];
  const detail = $("quick-detail");
  const warn = $("quick-warning");

  if (state.quick[i]) {
    detail.textContent = state.quick[i];
    typeset([detail]);
    return;
  }
  setHidden(warn, true);
  detail.textContent = "AI đang tìm cách làm nhanh...";

  const r = await postJSON("/api/quick-tip", {
    question: questionFull(q),
    subject: exam.subject,
  });
  if (state.current !== exam) return;

  if (r.ok) {
    state.quick[i] = r.data?.text || "Chưa có mẹo cho câu này.";
    if (state.idx === i) {
      detail.textContent = state.quick[i];
      typeset([detail]);
    }
  } else if (state.idx === i) {
    detail.textContent = "";
    warn.textContent = errorMessage(r);
    setHidden(warn, false);
  }
}

async function explainCurrent() {
  const exam = state.current;
  if (!exam || state.explaining) return;
  const i = state.idx;
  const q = exam.questions[i];

  state.explaining = true;
  setTab("essay");
  $("content-essay").textContent = "AI đang chữa bài...";

  const r = await postJSON("/api/grade-explain", {
    question: questionFull(q),
    answer: answerText(q, exam.answers[i]),
    key: keyText(q),
    subject: exam.subject,
    mode: "essay",
  });
  state.explaining = false;
  if (state.current !== exam) return;

  state.explain[i] = r.ok
    ? r.data?.text || "AI không trả về nội dung."
    : errorMessage(r);
  if (state.idx === i) {
    $("content-essay").textContent = state.explain[i];
    typeset([$("content-essay")]);
  }
}

function renderChat() {
  const box = $("chat-messages");
  box.replaceChildren();
  (state.chat[state.idx] || []).forEach((m) => {
    const d = document.createElement("div");
    d.className = "chat-msg " + (m.role === "user" ? "user" : "assistant");
    d.textContent = m.content;
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
  if (!message || !exam || state.chatting) return;

  const i = state.idx;
  const q = exam.questions[i];
  const hist = state.chat[i] || (state.chat[i] = []);
  const history = hist.slice(-10);

  input.value = "";
  hist.push({ role: "user", content: message });
  renderChat();

  state.chatting = true;
  $("chat-send-btn").disabled = true;

  const context = [
    `Môn: ${exam.subject}.`,
    `Đề câu hỏi:\n${questionFull(q)}`,
    `Đáp án chuẩn: ${keyText(q)}`,
    `Học sinh trả lời: ${answerText(q, exam.answers[i])}`,
  ].join("\n");

  const r = await postJSON("/api/chat", { context, history, message });
  state.chatting = false;
  $("chat-send-btn").disabled = false;
  if (state.current !== exam) return;

  hist.push({
    role: "assistant",
    content: r.ok ? r.data?.text || "AI không trả lời." : errorMessage(r),
  });
  if (state.idx === i) renderChat();
}

/* ============ Nộp bài, chia sẻ ============ */

function submitExam() {
  const exam = state.current;
  if (!exam) return;
  exam.checked = exam.questions.map(() => true);
  saveCurrent();
  showQuestion(state.idx);
  const { earned, max } = totals();
  const score = max ? (earned / max) * 10 : 0;
  toast(`Đã nộp bài: ${score.toFixed(2)}/10`, "success");
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
  setHidden($("exam-view"), true);
  $("exam-view").classList.remove("active");
  setHidden($("home-view"), false);
  $("home-view").classList.add("active");
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
  on("prev-question-btn", "click", () => showQuestion(state.idx - 1));
  on("next-question-btn", "click", () => showQuestion(state.idx + 1));
  on("submit-exam-btn", "click", submitExam);
  on("share-exam-btn", "click", shareExam);
  on("explain-current-btn", "click", explainCurrent);
  on("tab-essay", "click", () => setTab("essay"));
  on("tab-quick", "click", () => setTab("quick"));
  on("chat-form", "submit", sendChat);
  on("short-answer-input", "change", onShortChange);

  renderRecent();
  openSharedFromHash();
}

init();
