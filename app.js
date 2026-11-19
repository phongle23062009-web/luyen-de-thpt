import {
  auth,
  db,
  storage,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  ref,
  uploadString,
  getDownloadURL,
  loginGoogle,
  loginEmail,
  registerEmail,
  logout,
  onUser,
} from "./firebase.js";

const MAX_PDF_PAGES = 20;
const MAX_SELECTED_PAGES = 8;
const MAX_IMAGE_EDGE = 1600;
const DAILY_LIMIT_DEFAULT = 5;
const LOCAL_DRAFTS_KEY = "luyende_thpt_drafts_v1";

const state = {
  user: null,
  quotaUsed: 0,
  quotaLimit: DAILY_LIMIT_DEFAULT,
  layoutMode: "auto",
  pages: [], // { id, name, dataUrl, selected, width, height }
  exam: null, // { id, title, subject, format, mode, questions: [...], ownerId }
  currentIndex: 0,
  answers: {}, // questionId -> value (mcq: "A", tf: {a,b,c,d}, short: "...")
  submitted: false,
  instantCheck: true,
  activeTab: "essay",
  explanations: {}, // questionId -> { essay, quick, quickWarning }
  chatHistory: {}, // questionId -> [{ role: "user"|"assistant", content }]
  inProgressList: [], // [{ id, title, subject, updatedAt, questionCount, answeredCount, submitted }]
  saveTimer: null,
};

// DOM elements
const els = {
  logoBtn: document.getElementById("logo-btn"),
  layoutAuto: document.getElementById("layout-auto"),
  layoutMobile: document.getElementById("layout-mobile"),
  layoutDesktop: document.getElementById("layout-desktop"),
  quotaBadge: document.getElementById("quota-badge"),
  authBtn: document.getElementById("auth-btn"),
  homeView: document.getElementById("home-view"),
  examView: document.getElementById("exam-view"),
  fileInput: document.getElementById("file-input"),
  cameraInput: document.getElementById("camera-input"),
  textInput: document.getElementById("text-input"),
  subjectSelect: document.getElementById("subject-select"),
  createExamBtn: document.getElementById("create-exam-btn"),
  pageGridSection: document.getElementById("page-grid-section"),
  selectAllPagesBtn: document.getElementById("select-all-pages-btn"),
  deselectAllPagesBtn: document.getElementById("deselect-all-pages-btn"),
  clearFilesBtn: document.getElementById("clear-files-btn"),
  pageGrid: document.getElementById("page-grid"),
  backHomeBtn: document.getElementById("back-home-btn"),
  examTitle: document.getElementById("exam-title"),
  saveStatus: document.getElementById("save-status"),
  questionNavBar: document.getElementById("question-nav-bar"),
  shareExamBtn: document.getElementById("share-exam-btn"),
  submitExamBtn: document.getElementById("submit-exam-btn"),
  examWorkspace: document.getElementById("exam-workspace"),
  leftPane: document.getElementById("left-pane"),
  rightPane: document.getElementById("right-pane"),
  questionPartBadge: document.getElementById("question-part-badge"),
  questionNumberLabel: document.getElementById("question-number-label"),
  questionContent: document.getElementById("question-content"),
  questionImageContainer: document.getElementById("question-image-container"),
  questionImage: document.getElementById("question-image"),
  answerMcq: document.getElementById("answer-mcq"),
  answerTf: document.getElementById("answer-tf"),
  answerShort: document.getElementById("answer-short"),
  shortAnswerInput: document.getElementById("short-answer-input"),
  prevQuestionBtn: document.getElementById("prev-question-btn"),
  nextQuestionBtn: document.getElementById("next-question-btn"),
  scorePanel: document.getElementById("score-panel"),
  totalScore: document.getElementById("total-score"),
  questionResultStatus: document.getElementById("question-result-status"),
  explanationPanel: document.getElementById("explanation-panel"),
  tabEssay: document.getElementById("tab-essay"),
  tabQuick: document.getElementById("tab-quick"),
  explainCurrentBtn: document.getElementById("explain-current-btn"),
  contentEssay: document.getElementById("content-essay"),
  contentQuick: document.getElementById("content-quick"),
  quickWarning: document.getElementById("quick-warning"),
  quickDetail: document.getElementById("quick-detail"),
  chatMessages: document.getElementById("chat-messages"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  chatSendBtn: document.getElementById("chat-send-btn"),
  loadingOverlay: document.getElementById("loading-overlay"),
  loadingText: document.getElementById("loading-text"),
  toastContainer: document.getElementById("toast-container"),
};

// Extra dynamic UI elements injected inside existing containers without touching index.html
let resumeSectionEl = null;
let instantModeCheckbox = null;
let previewModalEl = null;
let previewModalImg = null;
let authModalEl = null;

function initExtraUI() {
  // 1. "Bài đang làm" section inside #home-view
  resumeSectionEl = document.createElement("section");
  resumeSectionEl.id = "resume-exams-section";
  resumeSectionEl.className = "page-grid-section";
  resumeSectionEl.innerHTML = `
    <div class="page-grid-header">
      <h2 class="section-title">Bài đang làm</h2>
    </div>
    <div id="resume-exams-list" class="page-grid"></div>
  `;
  els.homeView.appendChild(resumeSectionEl);

  // 2. Instant grading toggle inside .exam-topbar-actions
  const modeLabel = document.createElement("label");
  modeLabel.className = "radio-card";
  modeLabel.style.minHeight = "44px";
  modeLabel.style.padding = "6px 10px";
  instantModeCheckbox = document.createElement("input");
  instantModeCheckbox.type = "checkbox";
  instantModeCheckbox.id = "instant-check-toggle";
  instantModeCheckbox.checked = state.instantCheck;
  const modeText = document.createElement("span");
  modeText.textContent = "Chữa ngay";
  modeLabel.appendChild(instantModeCheckbox);
  modeLabel.appendChild(modeText);
  els.examView.querySelector(".exam-topbar-actions")?.prepend(modeLabel);

  instantModeCheckbox.addEventListener("change", () => {
    state.instantCheck = instantModeCheckbox.checked;
    renderRightPane();
    scheduleAutoSave();
  });

  // 3. Lightbox modal for "Xem phóng to"
  previewModalEl = document.createElement("div");
  previewModalEl.id = "image-preview-modal";
  previewModalEl.className = "loading-overlay hidden";
  previewModalEl.style.zIndex = "80";
  previewModalEl.innerHTML = `
    <div class="loading-box" style="max-width: 90vw; width: auto; max-height: 90vh; display: flex; flex-direction: column; gap: 12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
        <strong id="preview-modal-title">Xem phóng to</strong>
        <button type="button" id="close-preview-modal-btn" class="btn btn-sm btn-danger">Đóng</button>
      </div>
      <img id="preview-modal-img" src="" alt="Xem phóng to" style="max-width: 100%; max-height: 75vh; object-fit: contain; border-radius: 8px;">
    </div>
  `;
  document.body.appendChild(previewModalEl);
  previewModalImg = document.getElementById("preview-modal-img");
  document
    .getElementById("close-preview-modal-btn")
    .addEventListener("click", () => {
      previewModalEl.classList.add("hidden");
    });
  previewModalEl.addEventListener("click", (e) => {
    if (e.target === previewModalEl) previewModalEl.classList.add("hidden");
  });

  // 4. Auth modal for Email/Password or Google sign-in
  authModalEl = document.createElement("div");
  authModalEl.id = "auth-modal";
  authModalEl.className = "loading-overlay hidden";
  authModalEl.style.zIndex = "85";
  authModalEl.innerHTML = `
    <div class="loading-box" style="max-width: 380px; text-align: left;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <strong>Đăng nhập / Đăng ký</strong>
        <button type="button" id="close-auth-modal-btn" class="btn btn-sm">✕</button>
      </div>
      <button type="button" id="google-signin-btn" class="btn btn-primary" style="width:100%; margin-bottom:12px;">Tiếp tục với Google</button>
      <div style="display:flex; flex-direction:column; gap:8px;">
        <input type="email" id="auth-email-input" class="short-answer-input" placeholder="Email">
        <input type="password" id="auth-pass-input" class="short-answer-input" placeholder="Mật khẩu (tối thiểu 6 ký tự)">
        <div style="display:flex; gap:8px; margin-top:4px;">
          <button type="button" id="email-login-btn" class="btn btn-secondary" style="flex:1;">Đăng nhập</button>
          <button type="button" id="email-register-btn" class="btn btn-outline" style="flex:1;">Đăng ký</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(authModalEl);
  document
    .getElementById("close-auth-modal-btn")
    .addEventListener("click", () => {
      authModalEl.classList.add("hidden");
    });
  document
    .getElementById("google-signin-btn")
    .addEventListener("click", async () => {
      try {
        setLoading(true, "Đang đăng nhập Google...");
        await loginGoogle();
        authModalEl.classList.add("hidden");
        showToast("Đăng nhập Google thành công");
      } catch (err) {
        showToast(err?.message || "Lỗi đăng nhập Google", "error");
      } finally {
        setLoading(false);
      }
    });
  document
    .getElementById("email-login-btn")
    .addEventListener("click", async () => {
      const email = document.getElementById("auth-email-input").value.trim();
      const pass = document.getElementById("auth-pass-input").value;
      if (!email || !pass)
        return showToast("Vui lòng nhập email và mật khẩu", "error");
      try {
        setLoading(true, "Đang đăng nhập...");
        await loginEmail(email, pass);
        authModalEl.classList.add("hidden");
        showToast("Đăng nhập thành công");
      } catch (err) {
        showToast(err?.message || "Đăng nhập thất bại", "error");
      } finally {
        setLoading(false);
      }
    });
  document
    .getElementById("email-register-btn")
    .addEventListener("click", async () => {
      const email = document.getElementById("auth-email-input").value.trim();
      const pass = document.getElementById("auth-pass-input").value;
      if (!email || !pass)
        return showToast("Vui lòng nhập email và mật khẩu", "error");
      try {
        setLoading(true, "Đang tạo tài khoản...");
        await registerEmail(email, pass);
        authModalEl.classList.add("hidden");
        showToast("Đăng ký thành công");
      } catch (err) {
        showToast(err?.message || "Đăng ký thất bại", "error");
      } finally {
        setLoading(false);
      }
    });
}

function setLoading(show, text = "Đang xử lý...") {
  els.loadingText.textContent = text;
  els.loadingOverlay.classList.toggle("hidden", !show);
}

function showToast(message, type = "info") {
  const item = document.createElement("div");
  item.className = "btn";
  item.style.cursor = "default";
  item.style.justifyContent = "flex-start";
  if (type === "error") {
    item.style.backgroundColor = "var(--warning-bg)";
    item.style.borderColor = "var(--danger)";
    item.style.color = "var(--danger)";
  } else {
    item.style.backgroundColor = "var(--surface)";
    item.style.borderColor = "var(--primary)";
  }
  item.textContent = message;
  els.toastContainer.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 3600);
}

function openPreviewModal(src, title = "Xem phóng to") {
  if (!src) return;
  document.getElementById("preview-modal-title").textContent = title;
  previewModalImg.src = src;
  previewModalEl.classList.remove("hidden");
}

function typesetMath(targetEl = null) {
  if (window.MathJax && typeof window.MathJax.typesetPromise === "function") {
    const targets = targetEl ? [targetEl] : undefined;
    window.MathJax.typesetPromise(targets).catch(() => {});
  }
}

function getTodayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function updateQuotaBadge() {
  els.quotaBadge.textContent = `Lượt tạo: ${state.quotaUsed}/${state.quotaLimit}`;
}

async function refreshUserQuota() {
  const today = getTodayKey();
  if (!state.user) {
    const raw = localStorage.getItem(`luyende_quota_${today}`);
    state.quotaUsed = Number(raw) || 0;
    state.quotaLimit = DAILY_LIMIT_DEFAULT;
    updateQuotaBadge();
    return;
  }
  try {
    const userDocRef = doc(db, "users", state.user.uid);
    const snap = await getDoc(userDocRef);
    const data = snap.exists() ? snap.data() : {};
    state.quotaLimit = Number(data.dailyLimit) || DAILY_LIMIT_DEFAULT;
    const usage =
      data.usageByDate && data.usageByDate[today]
        ? Number(data.usageByDate[today])
        : 0;
    state.quotaUsed = usage;
  } catch {
    state.quotaUsed = 0;
  }
  updateQuotaBadge();
}

async function incrementQuota() {
  const today = getTodayKey();
  state.quotaUsed += 1;
  updateQuotaBadge();

  if (!state.user) {
    localStorage.setItem(`luyende_quota_${today}`, String(state.quotaUsed));
    return;
  }
  try {
    const userDocRef = doc(db, "users", state.user.uid);
    const snap = await getDoc(userDocRef);
    const prev =
      snap.exists() && snap.data().usageByDate
        ? snap.data().usageByDate[today] || 0
        : 0;
    await setDoc(
      userDocRef,
      {
        updatedAt: Date.now(),
        usageByDate: {
          ...(snap.exists() ? snap.data().usageByDate : {}),
          [today]: Number(prev) + 1,
        },
      },
      { merge: true },
    );
  } catch {
    // Ignore quota write error if offline
  }
}

// Layout switching: Tự động / Điện thoại / Máy tính
function applyLayoutMode(mode) {
  state.layoutMode = mode;
  document.body.setAttribute("data-layout", mode);
  [els.layoutAuto, els.layoutMobile, els.layoutDesktop].forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  if (mode === "mobile") {
    els.examWorkspace.classList.add("stack");
  } else if (mode === "desktop") {
    els.examWorkspace.classList.remove("stack");
  } else {
    if (window.innerWidth <= 820) {
      els.examWorkspace.classList.add("stack");
    } else {
      els.examWorkspace.classList.remove("stack");
    }
  }
}

function initLayoutControls() {
  [els.layoutAuto, els.layoutMobile, els.layoutDesktop].forEach((btn) => {
    btn.addEventListener("click", () => {
      applyLayoutMode(btn.dataset.mode);
    });
  });
  window.addEventListener("resize", () => {
    if (state.layoutMode === "auto") {
      applyLayoutMode("auto");
    }
  });
}

// View switching
function showView(viewName) {
  const isHome = viewName === "home";
  els.homeView.classList.toggle("active", isHome);
  els.homeView.classList.toggle("hidden", !isHome);
  els.examView.classList.toggle("active", !isHome);
  els.examView.classList.toggle("hidden", isHome);
  if (isHome) {
    renderResumeList();
  }
}

// Image resizing helper (max edge 1600px)
function resizeDataUrl(dataUrl, maxEdge = MAX_IMAGE_EDGE, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxEdge || height > maxEdge) {
        if (width >= height) {
          height = Math.round((height * maxEdge) / width);
          width = maxEdge;
        } else {
          width = Math.round((width * maxEdge) / height);
          height = maxEdge;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      resolve({
        dataUrl: canvas.toDataURL("image/jpeg", quality),
        width,
        height,
      });
    };
    img.onerror = () => reject(new Error("Không thể đọc ảnh"));
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Lỗi đọc file"));
    reader.readAsDataURL(file);
  });
}

// PDF rendering via pdfjsLib (max 20 pages)
async function renderPdfToPages(file) {
  if (!window.pdfjsLib) {
    throw new Error("Thư viện pdf.js chưa tải xong");
  }
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = Math.min(pdf.numPages, MAX_PDF_PAGES);
  if (pdf.numPages > MAX_PDF_PAGES) {
    showToast(
      `File PDF có ${pdf.numPages} trang, chỉ lấy tối đa ${MAX_PDF_PAGES} trang đầu.`,
    );
  }

  const rendered = [];
  for (let p = 1; p <= totalPages; p++) {
    setLoading(true, `Đang tách trang PDF ${p}/${totalPages}...`);
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const rawUrl = canvas.toDataURL("image/jpeg", 0.88);
    const resized = await resizeDataUrl(rawUrl, MAX_IMAGE_EDGE, 0.85);
    rendered.push({
      id: `${file.name}-p${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${file.name} (Trang ${p})`,
      dataUrl: resized.dataUrl,
      width: resized.width,
      height: resized.height,
      selected: false,
    });
  }
  return rendered;
}

async function handleFilesSelected(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  try {
    setLoading(true, "Đang xử lý tệp tải lên...");
    const added = [];
    for (const file of files) {
      if (
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf")
      ) {
        const pdfPages = await renderPdfToPages(file);
        added.push(...pdfPages);
      } else if (file.type.startsWith("image/")) {
        const rawUrl = await readFileAsDataUrl(file);
        const resized = await resizeDataUrl(rawUrl, MAX_IMAGE_EDGE, 0.85);
        added.push({
          id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          dataUrl: resized.dataUrl,
          width: resized.width,
          height: resized.height,
          selected: false,
        });
      }
    }

    state.pages.push(...added);
    enforceDefaultSelectedPages();
    renderPageGrid();
  } catch (err) {
    showToast(err?.message || "Không thể xử lý tệp", "error");
  } finally {
    setLoading(false);
  }
}

function enforceDefaultSelectedPages() {
  const selectedCount = state.pages.filter((p) => p.selected).length;
  if (selectedCount === 0) {
    state.pages.forEach((p, idx) => {
      p.selected = idx < MAX_SELECTED_PAGES;
    });
  } else if (selectedCount > MAX_SELECTED_PAGES) {
    let kept = 0;
    state.pages.forEach((p) => {
      if (p.selected && kept < MAX_SELECTED_PAGES) {
        kept++;
      } else {
        p.selected = false;
      }
    });
  }
}

function renderPageGrid() {
  if (!state.pages.length) {
    els.pageGridSection.classList.add("hidden");
    els.pageGrid.innerHTML = "";
    return;
  }
  els.pageGridSection.classList.remove("hidden");
  els.pageGrid.innerHTML = "";

  const selectedCount = state.pages.filter((p) => p.selected).length;

  state.pages.forEach((page, idx) => {
    const card = document.createElement("div");
    card.className = "radio-card";
    card.style.flexDirection = "column";
    card.style.alignItems = "stretch";
    card.style.padding = "8px";
    card.style.borderColor = page.selected ? "var(--primary)" : "var(--border)";

    const topRow = document.createElement("label");
    topRow.style.display = "flex";
    topRow.style.alignItems = "center";
    topRow.style.gap = "6px";
    topRow.style.cursor = "pointer";
    topRow.style.marginBottom = "6px";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = page.selected;
    cb.addEventListener("change", () => {
      if (cb.checked) {
        const currentSel = state.pages.filter((x) => x.selected).length;
        if (currentSel >= MAX_SELECTED_PAGES) {
          cb.checked = false;
          showToast(`Chỉ chọn tối đa ${MAX_SELECTED_PAGES} trang để gửi AI.`);
          return;
        }
        page.selected = true;
      } else {
        page.selected = false;
      }
      renderPageGrid();
    });

    const titleSpan = document.createElement("span");
    titleSpan.textContent = `#${idx + 1} ${page.name}`;
    titleSpan.style.fontSize = "0.82rem";
    titleSpan.style.overflow = "hidden";
    titleSpan.style.textOverflow = "ellipsis";
    titleSpan.style.whiteSpace = "nowrap";

    topRow.appendChild(cb);
    topRow.appendChild(titleSpan);

    const img = document.createElement("img");
    img.src = page.dataUrl;
    img.alt = page.name;
    img.style.width = "100%";
    img.style.height = "120px";
    img.style.objectFit = "cover";
    img.style.borderRadius = "6px";
    img.style.marginBottom = "8px";

    const zoomBtn = document.createElement("button");
    zoomBtn.type = "button";
    zoomBtn.className = "btn btn-sm btn-secondary";
    zoomBtn.textContent = "Xem phóng to";
    zoomBtn.addEventListener("click", () =>
      openPreviewModal(page.dataUrl, page.name),
    );

    card.appendChild(topRow);
    card.appendChild(img);
    card.appendChild(zoomBtn);
    els.pageGrid.appendChild(card);
  });

  els.selectAllPagesBtn.textContent = `Chọn tối đa (${selectedCount}/${MAX_SELECTED_PAGES})`;
}

// Crop figure using normalized box [x0, y0, x1, y1] in 0..1000
function cropFigureDataUrl(sourceDataUrl, box) {
  return new Promise((resolve) => {
    if (!sourceDataUrl || !Array.isArray(box) || box.length < 4) {
      resolve(null);
      return;
    }
    const [x0Raw, y0Raw, x1Raw, y1Raw] = box.map((n) => Number(n));
    if ([x0Raw, y0Raw, x1Raw, y1Raw].some((n) => Number.isNaN(n))) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const clamp = (v) => Math.max(0, Math.min(1000, v));
      const nx0 = clamp(Math.min(x0Raw, x1Raw)) / 1000;
      const ny0 = clamp(Math.min(y0Raw, y1Raw)) / 1000;
      const nx1 = clamp(Math.max(x0Raw, x1Raw)) / 1000;
      const ny1 = clamp(Math.max(y0Raw, y1Raw)) / 1000;

      const sx = Math.round(nx0 * img.width);
      const sy = Math.round(ny0 * img.height);
      const sw = Math.max(1, Math.round((nx1 - nx0) * img.width));
      const sh = Math.max(1, Math.round((ny1 - ny0) * img.height));

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = () => resolve(null);
    img.src = sourceDataUrl;
  });
}

async function uploadCroppedFigureIfLoggedIn(examId, qId, dataUrl) {
  if (!state.user || !dataUrl) return dataUrl;
  try {
    const storageRef = ref(storage, `exams/${examId}/${qId}.jpg`);
    await uploadString(storageRef, dataUrl, "data_url");
    return await getDownloadURL(storageRef);
  } catch {
    return dataUrl;
  }
}

function normalizeExamData(
  rawExam,
  fallbackSubject,
  fallbackFormat,
  fallbackMode,
) {
  const questionsRaw = Array.isArray(rawExam?.questions)
    ? rawExam.questions
    : [];
  const questions = questionsRaw.map((q, idx) => {
    const part = ["mcq", "tf", "short"].includes(q?.part) ? q.part : "mcq";
    return {
      id: String(q?.id || `q${idx + 1}`),
      part,
      number: Number(q?.number) || idx + 1,
      prompt: String(q?.prompt || q?.question || ""),
      options:
        q?.options && typeof q.options === "object"
          ? q.options
          : { A: "", B: "", C: "", D: "" },
      statements:
        q?.statements && typeof q.statements === "object"
          ? q.statements
          : { a: "", b: "", c: "", d: "" },
      answer: q?.answer ?? null,
      figure: q?.figure && typeof q.figure === "object" ? q.figure : null,
      imageUrl: q?.imageUrl || null,
    };
  });

  return {
    id:
      rawExam?.id ||
      `exam_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: String(rawExam?.title || `Đề ${fallbackSubject.toUpperCase()} THPT`),
    subject: String(rawExam?.subject || fallbackSubject),
    format: fallbackFormat,
    mode: fallbackMode,
    ownerId: state.user ? state.user.uid : null,
    createdAt: Date.now(),
    questions,
  };
}

// Create exam via /api/extract
async function handleCreateExam() {
  if (state.quotaUsed >= state.quotaLimit) {
    showToast(
      `Bạn đã hết lượt tạo đề hôm nay (${state.quotaUsed}/${state.quotaLimit}).`,
      "error",
    );
    return;
  }

  const selectedPages = state.pages
    .filter((p) => p.selected)
    .slice(0, MAX_SELECTED_PAGES);
  const text = els.textInput.value.trim();

  if (!selectedPages.length && !text) {
    showToast("Vui lòng chọn trang PDF/ảnh hoặc nhập văn bản đề.", "error");
    return;
  }

  const subject = els.subjectSelect.value;
  const modeRadio = document.querySelector(
    'input[name="process-mode"]:checked',
  );
  const formatRadio = document.querySelector(
    'input[name="exam-format"]:checked',
  );
  const mode = modeRadio?.value === "generate" ? "gen" : "extract";
  const format = formatRadio?.value === "short-mcq" ? "short" : "thpt";

  try {
    setLoading(true, "Đang gửi dữ liệu tới AI để tách/tạo đề...");
    const resp = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: selectedPages.map((p) => p.dataUrl),
        text,
        subject,
        format,
        mode,
        counts:
          format === "short"
            ? { p1: 12, p2: 0, p3: 0 }
            : { p1: 6, p2: 2, p3: 2 },
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.error || "Lỗi gọi /api/extract");
    }

    const exam = normalizeExamData(data, subject, format, mode);

    // Crop figures from selectedPages
    setLoading(true, "Đang cắt hình minh họa...");
    for (const q of exam.questions) {
      if (
        q.figure &&
        typeof q.figure.page === "number" &&
        Array.isArray(q.figure.box)
      ) {
        const srcPage = selectedPages[q.figure.page];
        if (srcPage) {
          const cropped = await cropFigureDataUrl(
            srcPage.dataUrl,
            q.figure.box,
          );
          if (cropped) {
            q.imageUrl = await uploadCroppedFigureIfLoggedIn(
              exam.id,
              q.id,
              cropped,
            );
          }
        }
      }
    }

    await incrementQuota();
    await loadExamIntoWorkspace(exam, {}, false);
    showView("exam");
  } catch (err) {
    showToast(err?.message || "Không thể tạo đề", "error");
  } finally {
    setLoading(false);
  }
}

// THPT grading rules:
// mcq: 0.25 if exact match
// tf: 1/2/3/4 correct statements -> 0.1 / 0.25 / 0.5 / 1.0
// short: 0.5 if match
function scoreQuestion(question, userAnswer) {
  if (!question) return { points: 0, maxPoints: 0, status: "unanswered" };

  if (question.part === "mcq") {
    const maxPoints = 0.25;
    if (!userAnswer) return { points: 0, maxPoints, status: "unanswered" };
    const correct = String(question.answer ?? "")
      .trim()
      .toUpperCase();
    const chosen = String(userAnswer).trim().toUpperCase();
    return {
      points: correct && chosen === correct ? 0.25 : 0,
      maxPoints,
      status: correct && chosen === correct ? "correct" : "wrong",
    };
  }

  if (question.part === "tf") {
    const maxPoints = 1.0;
    const keyObj =
      question.answer && typeof question.answer === "object"
        ? question.answer
        : {};
    const ansObj =
      userAnswer && typeof userAnswer === "object" ? userAnswer : {};
    const keys = ["a", "b", "c", "d"];
    let matchedCount = 0;
    let answeredCount = 0;

    for (const k of keys) {
      if (typeof ansObj[k] === "boolean") answeredCount++;
      if (typeof keyObj[k] === "boolean" && ansObj[k] === keyObj[k]) {
        matchedCount++;
      }
    }

    if (answeredCount === 0)
      return { points: 0, maxPoints, status: "unanswered" };

    const tfTable = { 0: 0, 1: 0.1, 2: 0.25, 3: 0.5, 4: 1.0 };
    const points = tfTable[matchedCount] ?? 0;
    return {
      points,
      maxPoints,
      status: matchedCount === 4 ? "correct" : points > 0 ? "partial" : "wrong",
    };
  }

  // short answer
  const maxPoints = 0.5;
  const rawUser = String(userAnswer ?? "").trim();
  if (!rawUser) return { points: 0, maxPoints, status: "unanswered" };

  const normalizeNum = (s) =>
    s.replace(",", ".").replace(/\s+/g, "").toLowerCase();
  const uNorm = normalizeNum(rawUser);
  const kNorm = normalizeNum(String(question.answer ?? ""));

  const uNum = Number(uNorm);
  const kNum = Number(kNorm);
  const isMatch =
    (!Number.isNaN(uNum) &&
      !Number.isNaN(kNum) &&
      Math.abs(uNum - kNum) < 1e-6) ||
    (kNorm.length > 0 && uNorm === kNorm);

  return {
    points: isMatch ? 0.5 : 0,
    maxPoints,
    status: isMatch ? "correct" : "wrong",
  };
}

function calculateTotalScore() {
  if (!state.exam || !Array.isArray(state.exam.questions)) {
    return { total: 0, max: 0 };
  }
  let total = 0;
  let max = 0;
  for (const q of state.exam.questions) {
    const res = scoreQuestion(q, state.answers[q.id]);
    total += res.points;
    max += res.maxPoints;
  }
  return {
    total: Math.round(total * 100) / 100,
    max: Math.round(max * 100) / 100,
  };
}

// Persistence: localStorage (guest) & Firestore (logged-in)
function getLocalDrafts() {
  try {
    const raw = localStorage.getItem(LOCAL_DRAFTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalDrafts(list) {
  try {
    localStorage.setItem(LOCAL_DRAFTS_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage quota errors
  }
}

function buildDraftPayload() {
  if (!state.exam) return null;
  const answeredCount = state.exam.questions.filter((q) => {
    const ans = state.answers[q.id];
    if (q.part === "tf") {
      return (
        ans &&
        typeof ans === "object" &&
        Object.values(ans).some((v) => typeof v === "boolean")
      );
    }
    return ans !== undefined && ans !== null && String(ans).trim() !== "";
  }).length;

  return {
    id: state.exam.id,
    title: state.exam.title,
    subject: state.exam.subject,
    updatedAt: Date.now(),
    questionCount: state.exam.questions.length,
    answeredCount,
    submitted: state.submitted,
    currentIndex: state.currentIndex,
    answers: state.answers,
    explanations: state.explanations,
    chatHistory: state.chatHistory,
    exam: state.exam,
  };
}

function scheduleAutoSave() {
  if (!state.exam) return;
  els.saveStatus.textContent = "Đang lưu...";
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    persistProgressNow();
  }, 400);
}

async function persistProgressNow() {
  const payload = buildDraftPayload();
  if (!payload) return;

  // Always update local drafts for fast offline/guest access
  const drafts = getLocalDrafts().filter((d) => d.id !== payload.id);
  drafts.unshift(payload);
  saveLocalDrafts(drafts.slice(0, 20));
  state.inProgressList = drafts.slice(0, 20);

  if (state.user) {
    try {
      await setDoc(doc(db, "exams", payload.id), payload.exam, { merge: true });
      await setDoc(
        doc(db, "users", state.user.uid, "progress", payload.id),
        {
          examId: payload.id,
          title: payload.title,
          subject: payload.subject,
          updatedAt: payload.updatedAt,
          questionCount: payload.questionCount,
          answeredCount: payload.answeredCount,
          submitted: payload.submitted,
          currentIndex: payload.currentIndex,
          answers: payload.answers,
          explanations: payload.explanations,
          chatHistory: payload.chatHistory,
        },
        { merge: true },
      );
      els.saveStatus.textContent = "Đã lưu Firestore";
      return;
    } catch {
      els.saveStatus.textContent = "Đã lưu cục bộ";
      return;
    }
  }
  els.saveStatus.textContent = "Đã lưu tự động";
}

async function loadInProgressList() {
  const localList = getLocalDrafts();
  if (!state.user) {
    state.inProgressList = localList;
    renderResumeList();
    return;
  }

  try {
    const colRef = collection(db, "users", state.user.uid, "progress");
    const snap = await getDocs(colRef);
    const remoteList = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      remoteList.push({
        id: d.examId || docSnap.id,
        title: d.title || "Đề luyện tập",
        subject: d.subject || "",
        updatedAt: d.updatedAt || 0,
        questionCount: d.questionCount || 0,
        answeredCount: d.answeredCount || 0,
        submitted: Boolean(d.submitted),
      });
    });

    const mergedMap = new Map();
    for (const item of [...remoteList, ...localList]) {
      const existing = mergedMap.get(item.id);
      if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
        mergedMap.set(item.id, item);
      }
    }
    state.inProgressList = Array.from(mergedMap.values()).sort(
      (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    );
  } catch {
    state.inProgressList = localList;
  }
  renderResumeList();
}

function renderResumeList() {
  const listEl = document.getElementById("resume-exams-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!state.inProgressList.length) {
    listEl.innerHTML = `<p style="color: var(--text-muted); margin: 0;">Chưa có bài làm nào đang lưu.</p>`;
    return;
  }

  for (const item of state.inProgressList) {
    const card = document.createElement("div");
    card.className = "radio-card";
    card.style.flexDirection = "column";
    card.style.alignItems = "stretch";
    card.style.justifyContent = "space-between";
    card.style.gap = "8px";

    const title = document.createElement("strong");
    title.textContent = item.title;
    title.style.fontSize = "0.95rem";

    const meta = document.createElement("span");
    meta.textContent = `Đã làm ${item.answeredCount}/${item.questionCount} câu${item.submitted ? " • Đã nộp" : ""}`;
    meta.style.fontSize = "0.82rem";
    meta.style.color = "var(--text-muted)";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm btn-primary";
    btn.textContent = "Tiếp tục";
    btn.addEventListener("click", () => openSavedExam(item.id));

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(btn);
    listEl.appendChild(card);
  }
}

async function openSavedExam(examId) {
  try {
    setLoading(true, "Đang tải bài làm...");
    let examData = null;
    let progressData = null;

    if (state.user) {
      const pSnap = await getDoc(
        doc(db, "users", state.user.uid, "progress", examId),
      );
      if (pSnap.exists()) progressData = pSnap.data();

      const eSnap = await getDoc(doc(db, "exams", examId));
      if (eSnap.exists()) examData = eSnap.data();
    }

    const localDraft = getLocalDrafts().find((d) => d.id === examId);
    if (!examData && localDraft?.exam) examData = localDraft.exam;
    if (!progressData && localDraft) progressData = localDraft;

    if (!examData) {
      showToast("Không tìm thấy dữ liệu đề thi.", "error");
      return;
    }

    await loadExamIntoWorkspace(
      examData,
      progressData?.answers || {},
      Boolean(progressData?.submitted),
      progressData?.currentIndex || 0,
      progressData?.explanations || {},
      progressData?.chatHistory || {},
    );
    showView("exam");
  } catch (err) {
    showToast(err?.message || "Lỗi mở bài làm", "error");
  } finally {
    setLoading(false);
  }
}

// Shared link loading (?exam=...)
async function checkSharedExamFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const sharedId = params.get("exam");
  if (!sharedId) return;

  try {
    setLoading(true, "Đang tải đề chia sẻ...");
    const snap = await getDoc(doc(db, "exams", sharedId));
    if (!snap.exists()) {
      showToast("Đề chia sẻ không tồn tại hoặc đã bị xóa.", "error");
      return;
    }
    const examData = snap.data();
    const localDraft = getLocalDrafts().find((d) => d.id === sharedId);
    await loadExamIntoWorkspace(
      examData,
      localDraft?.answers || {},
      Boolean(localDraft?.submitted),
      localDraft?.currentIndex || 0,
      localDraft?.explanations || {},
      localDraft?.chatHistory || {},
    );
    showView("exam");
  } catch (err) {
    showToast(err?.message || "Không thể mở liên kết chia sẻ", "error");
  } finally {
    setLoading(false);
  }
}

async function loadExamIntoWorkspace(
  examData,
  answers = {},
  submitted = false,
  currentIndex = 0,
  explanations = {},
  chatHistory = {},
) {
  state.exam = normalizeExamData(
    examData,
    examData.subject || "toan",
    examData.format || "thpt",
    examData.mode || "extract",
  );
  state.answers = { ...answers };
  state.submitted = submitted;
  state.currentIndex = Math.max(
    0,
    Math.min(currentIndex, state.exam.questions.length - 1),
  );
  state.explanations = { ...explanations };
  state.chatHistory = { ...chatHistory };

  els.examTitle.textContent = state.exam.title;
  renderQuestionNav();
  renderCurrentQuestion();
  renderRightPane();
  await persistProgressNow();
}

function renderQuestionNav() {
  els.questionNavBar.innerHTML = "";
  if (!state.exam) return;

  state.exam.questions.forEach((q, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm";
    btn.textContent = `${q.number}`;
    btn.style.minWidth = "44px";
    if (idx === state.currentIndex) {
      btn.classList.add("btn-primary");
    } else if (state.submitted || state.instantCheck) {
      const res = scoreQuestion(q, state.answers[q.id]);
      if (res.status === "correct") {
        btn.style.borderColor = "var(--success-text)";
        btn.style.backgroundColor = "var(--success-bg)";
        btn.style.color = "var(--success-text)";
      } else if (res.status === "wrong" || res.status === "partial") {
        btn.style.borderColor = "var(--danger)";
      }
    }
    btn.addEventListener("click", () => {
      state.currentIndex = idx;
      renderQuestionNav();
      renderCurrentQuestion();
      renderRightPane();
      scheduleAutoSave();
    });
    els.questionNavBar.appendChild(btn);
  });
}

function renderCurrentQuestion() {
  if (!state.exam || !state.exam.questions.length) return;
  const q = state.exam.questions[state.currentIndex];

  const partLabels = {
    mcq: "Phần I • Trắc nghiệm",
    tf: "Phần II • Đúng/Sai",
    short: "Phần III • Trả lời ngắn",
  };
  els.questionPartBadge.textContent = partLabels[q.part] || "Câu hỏi";
  els.questionNumberLabel.textContent = `Câu ${q.number}`;
  els.questionContent.innerHTML = q.prompt;

  if (q.imageUrl) {
    els.questionImage.src = q.imageUrl;
    els.questionImageContainer.classList.remove("hidden");
  } else {
    els.questionImage.src = "";
    els.questionImageContainer.classList.add("hidden");
  }

  els.answerMcq.classList.add("hidden");
  els.answerTf.classList.add("hidden");
  els.answerShort.classList.add("hidden");

  if (q.part === "mcq") {
    els.answerMcq.classList.remove("hidden");
    els.answerMcq.innerHTML = "";
    const currentChoice = state.answers[q.id] || "";
    ["A", "B", "C", "D"].forEach((optKey) => {
      const optText = q.options?.[optKey] ?? "";
      const row = document.createElement("label");
      row.className = "radio-card";
      row.style.justifyContent = "flex-start";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `mcq_${q.id}`;
      radio.value = optKey;
      radio.checked = currentChoice === optKey;
      radio.addEventListener("change", () => {
        state.answers[q.id] = optKey;
        renderQuestionNav();
        renderRightPane();
        scheduleAutoSave();
      });

      const span = document.createElement("span");
      span.innerHTML = `<strong>${optKey}.</strong> ${optText}`;

      row.appendChild(radio);
      row.appendChild(span);
      els.answerMcq.appendChild(row);
    });
  } else if (q.part === "tf") {
    els.answerTf.classList.remove("hidden");
    els.answerTf.innerHTML = "";
    const currentTf =
      state.answers[q.id] && typeof state.answers[q.id] === "object"
        ? state.answers[q.id]
        : {};

    ["a", "b", "c", "d"].forEach((subKey) => {
      const stmtText = q.statements?.[subKey] ?? "";
      const row = document.createElement("div");
      row.className = "radio-card";
      row.style.justifyContent = "space-between";
      row.style.gap = "12px";

      const textSpan = document.createElement("span");
      textSpan.innerHTML = `<strong>${subKey})</strong> ${stmtText}`;
      textSpan.style.flex = "1";

      const btnGroup = document.createElement("div");
      btnGroup.style.display = "flex";
      btnGroup.style.gap = "6px";

      [
        { label: "Đúng", val: true },
        { label: "Sai", val: false },
      ].forEach((choice) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-sm";
        b.textContent = choice.label;
        if (currentTf[subKey] === choice.val) {
          b.classList.add("btn-primary");
        }
        b.addEventListener("click", () => {
          state.answers[q.id] = {
            ...(state.answers[q.id] && typeof state.answers[q.id] === "object"
              ? state.answers[q.id]
              : {}),
            [subKey]: choice.val,
          };
          renderCurrentQuestion();
          renderQuestionNav();
          renderRightPane();
          scheduleAutoSave();
        });
        btnGroup.appendChild(b);
      });

      row.appendChild(textSpan);
      row.appendChild(btnGroup);
      els.answerTf.appendChild(row);
    });
  } else {
    els.answerShort.classList.remove("hidden");
    els.shortAnswerInput.value = state.answers[q.id] || "";
    els.shortAnswerInput.oninput = () => {
      state.answers[q.id] = els.shortAnswerInput.value;
      renderQuestionNav();
      renderRightPane();
      scheduleAutoSave();
    };
  }

  els.prevQuestionBtn.disabled = state.currentIndex === 0;
  els.nextQuestionBtn.disabled =
    state.currentIndex >= state.exam.questions.length - 1;

  typesetMath(els.leftPane);
}

function renderRightPane() {
  if (!state.exam || !state.exam.questions.length) return;
  const q = state.exam.questions[state.currentIndex];

  const showScore = state.submitted || state.instantCheck;
  els.scorePanel.classList.toggle("hidden", !showScore);

  if (showScore) {
    const { total, max } = calculateTotalScore();
    els.totalScore.textContent = `${total} / ${max}`;
    const qRes = scoreQuestion(q, state.answers[q.id]);
    if (qRes.status === "unanswered") {
      els.questionResultStatus.textContent = `Câu này: Chưa trả lời (0 / ${qRes.maxPoints}đ)`;
    } else if (qRes.status === "correct") {
      els.questionResultStatus.textContent = `Đúng (${qRes.points} / ${qRes.maxPoints}đ)`;
    } else {
      const ansDisplay =
        typeof q.answer === "object" && q.answer !== null
          ? JSON.stringify(q.answer)
          : String(q.answer ?? "");
      els.questionResultStatus.textContent = `Chưa đạt tối đa (${qRes.points} / ${qRes.maxPoints}đ) • Đáp án: ${ansDisplay}`;
    }
  }

  // Tabs
  const isEssay = state.activeTab === "essay";
  els.tabEssay.classList.toggle("active", isEssay);
  els.tabEssay.setAttribute("aria-selected", String(isEssay));
  els.tabQuick.classList.toggle("active", !isEssay);
  els.tabQuick.setAttribute("aria-selected", String(!isEssay));

  els.contentEssay.classList.toggle("hidden", !isEssay);
  els.contentEssay.classList.toggle("active", isEssay);
  els.contentQuick.classList.toggle("hidden", isEssay);
  els.contentQuick.classList.toggle("active", !isEssay);

  const exp = state.explanations[q.id] || {};
  els.contentEssay.innerHTML = exp.essay
    ? formatPlainTextToHtml(exp.essay)
    : `<p style="color: var(--text-muted);">Bấm "Xem lời giải câu này" để AI giải chi tiết từng bước.</p>`;

  if (exp.quickWarning) {
    els.quickWarning.textContent = exp.quickWarning;
    els.quickWarning.classList.remove("hidden");
  } else {
    els.quickWarning.classList.add("hidden");
  }

  els.quickDetail.innerHTML = exp.quick
    ? formatPlainTextToHtml(exp.quick)
    : `<p style="color: var(--text-muted);">Chuyển sang tab này hoặc bấm "Xem lời giải câu này" để xem mẹo làm nhanh / Casio.</p>`;

  renderChatMessages(q.id);
  typesetMath(els.rightPane);
}

function formatPlainTextToHtml(str) {
  const escaped = String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\n/g, "<br>");
}

function renderChatMessages(questionId) {
  els.chatMessages.innerHTML = "";
  const msgs = state.chatHistory[questionId] || [];
  for (const m of msgs) {
    const bubble = document.createElement("div");
    bubble.style.padding = "8px 10px";
    bubble.style.borderRadius = "8px";
    bubble.style.backgroundColor =
      m.role === "user" ? "var(--primary)" : "var(--surface)";
    bubble.style.color =
      m.role === "user" ? "var(--primary-contrast)" : "var(--text)";
    bubble.style.border = "1px solid var(--border)";
    bubble.innerHTML = formatPlainTextToHtml(m.content);
    els.chatMessages.appendChild(bubble);
  }
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function handleExplainCurrentQuestion() {
  if (!state.exam || !state.exam.questions.length) return;
  const q = state.exam.questions[state.currentIndex];
  const currentExp = state.explanations[q.id] || {};

  try {
    setLoading(true, "Đang sinh lời giải...");
    if (state.activeTab === "essay") {
      const resp = await fetch("/api/grade-explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          answer: state.answers[q.id] ?? null,
          key: q.answer ?? null,
          subject: state.exam.subject,
          mode: "essay",
        }),
      });
      const data = await resp.json();
      if (!resp.ok)
        throw new Error(data?.error || "Lỗi gọi /api/grade-explain");
      state.explanations[q.id] = {
        ...currentExp,
        essay: data.text || "",
      };
    } else {
      const resp = await fetch("/api/quick-tip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          subject: state.exam.subject,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || "Lỗi gọi /api/quick-tip");
      const textVal = data.text || "";
      const hasWarning =
        /không áp dụng|không đúng mọi|cảnh báo|điều kiện/i.test(textVal);
      state.explanations[q.id] = {
        ...currentExp,
        quick: textVal,
        quickWarning: hasWarning
          ? "Lưu ý: Mẹo/công thức nhanh có điều kiện áp dụng, hãy kiểm tra kỹ giả thiết."
          : "",
      };
    }

    renderRightPane();
    scheduleAutoSave();
  } catch (err) {
    showToast(err?.message || "Không thể lấy lời giải", "error");
  } finally {
    setLoading(false);
  }
}

async function handleChatSubmit(e) {
  e.preventDefault();
  if (!state.exam || !state.exam.questions.length) return;
  const message = els.chatInput.value.trim();
  if (!message) return;

  const q = state.exam.questions[state.currentIndex];
  const history = state.chatHistory[q.id] || [];
  const nextHistory = [...history, { role: "user", content: message }];
  state.chatHistory[q.id] = nextHistory;
  els.chatInput.value = "";
  renderChatMessages(q.id);

  try {
    els.chatSendBtn.disabled = true;
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: {
          subject: state.exam.subject,
          question: q,
          studentAnswer: state.answers[q.id] ?? null,
          key: q.answer ?? null,
        },
        history,
        message,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "Lỗi gọi /api/chat");

    state.chatHistory[q.id] = [
      ...nextHistory,
      { role: "assistant", content: data.text || "" },
    ];
    renderChatMessages(q.id);
    typesetMath(els.chatMessages);
    scheduleAutoSave();
  } catch (err) {
    showToast(err?.message || "Không gửi được tin nhắn", "error");
  } finally {
    els.chatSendBtn.disabled = false;
  }
}

async function handleShareExam() {
  if (!state.exam) return;
  try {
    setLoading(true, "Đang tạo liên kết chia sẻ...");
    await setDoc(doc(db, "exams", state.exam.id), state.exam, { merge: true });
    const shareUrl = `${window.location.origin}${window.location.pathname}?exam=${encodeURIComponent(state.exam.id)}`;
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(shareUrl);
      showToast("Đã sao chép liên kết chia sẻ đề!");
    } else {
      showToast(`Link chia sẻ: ${shareUrl}`);
    }
  } catch (err) {
    showToast(err?.message || "Cần lưu đề lên Firestore để chia sẻ", "error");
  } finally {
    setLoading(false);
  }
}

function bindEvents() {
  els.logoBtn.addEventListener("click", (e) => {
    e.preventDefault();
    showView("home");
  });

  els.backHomeBtn.addEventListener("click", () => {
    persistProgressNow();
    showView("home");
  });

  els.authBtn.addEventListener("click", async () => {
    if (state.user) {
      await logout();
      showToast("Đã đăng xuất");
    } else {
      authModalEl.classList.remove("hidden");
    }
  });

  els.fileInput.addEventListener("change", (e) => {
    handleFilesSelected(e.target.files);
    e.target.value = "";
  });

  els.cameraInput.addEventListener("change", (e) => {
    handleFilesSelected(e.target.files);
    e.target.value = "";
  });

  els.selectAllPagesBtn.addEventListener("click", () => {
    state.pages.forEach((p, idx) => {
      p.selected = idx < MAX_SELECTED_PAGES;
    });
    renderPageGrid();
  });

  els.deselectAllPagesBtn.addEventListener("click", () => {
    state.pages.forEach((p) => {
      p.selected = false;
    });
    renderPageGrid();
  });

  els.clearFilesBtn.addEventListener("click", () => {
    state.pages = [];
    renderPageGrid();
  });

  els.createExamBtn.addEventListener("click", handleCreateExam);

  els.prevQuestionBtn.addEventListener("click", () => {
    if (state.currentIndex > 0) {
      state.currentIndex--;
      renderQuestionNav();
      renderCurrentQuestion();
      renderRightPane();
      scheduleAutoSave();
    }
  });

  els.nextQuestionBtn.addEventListener("click", () => {
    if (state.exam && state.currentIndex < state.exam.questions.length - 1) {
      state.currentIndex++;
      renderQuestionNav();
      renderCurrentQuestion();
      renderRightPane();
      scheduleAutoSave();
    }
  });

  els.submitExamBtn.addEventListener("click", async () => {
    state.submitted = true;
    renderQuestionNav();
    renderRightPane();
    await persistProgressNow();
    const { total, max } = calculateTotalScore();
    showToast(`Đã nộp bài! Điểm của bạn: ${total} / ${max}`);
  });

  els.shareExamBtn.addEventListener("click", handleShareExam);

  els.tabEssay.addEventListener("click", () => {
    state.activeTab = "essay";
    renderRightPane();
  });

  els.tabQuick.addEventListener("click", () => {
    state.activeTab = "quick";
    renderRightPane();
  });

  els.explainCurrentBtn.addEventListener("click", handleExplainCurrentQuestion);
  els.chatForm.addEventListener("submit", handleChatSubmit);
}

// Boot
initExtraUI();
initLayoutControls();
applyLayoutMode("auto");
bindEvents();
refreshUserQuota();
loadInProgressList();

onUser(async (user) => {
  state.user = user || null;
  els.authBtn.textContent = state.user ? "Đăng xuất" : "Đăng nhập";
  await refreshUserQuota();
  await loadInProgressList();
  if (state.exam) {
    await persistProgressNow();
  }
});

checkSharedExamFromUrl();
