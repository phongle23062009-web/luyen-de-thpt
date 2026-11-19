const MAX_PDF_PAGES = 20;
const MAX_SELECTED_PAGES = 8;
const MAX_IMAGE_EDGE = 1600;
const RECENT_EXAMS_KEY = "recent_exams";
const LAYOUT_MODE_KEY = "layout_mode";
const MAX_RECENT_EXAMS = 5;

const state = {
  layoutMode: "auto",
  pages: [],
  exam: null,
  currentIndex: 0,
  answers: {},
  checkedMap: {},
  submitted: false,
  instantCheck: false,
  activeTab: "essay",
  explanations: {},
  chatHistory: {},
};

const els = {
  logoBtn: document.getElementById("logo-btn"),
  layoutAuto: document.getElementById("layout-auto"),
  layoutMobile: document.getElementById("layout-mobile"),
  layoutDesktop: document.getElementById("layout-desktop"),
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
  recentSection: document.getElementById("recent-section"),
  recentList: document.getElementById("recent-list"),
  loadingOverlay: document.getElementById("loading-overlay"),
  loadingText: document.getElementById("loading-text"),
  toastContainer: document.getElementById("toast-container"),
};

let zoomModal = null;
let zoomModalImg = null;
let zoomModalTitle = null;
let instantCheckInput = null;

function showToast(message, isError = false) {
  if (!els.toastContainer) return;
  const toast = document.createElement("div");
  toast.className = "btn";
  toast.style.cursor = "default";
  toast.style.justifyContent = "flex-start";
  toast.style.backgroundColor = isError
    ? "var(--warning-bg)"
    : "var(--surface)";
  toast.style.borderColor = isError ? "var(--danger)" : "var(--primary)";
  toast.style.color = isError ? "var(--danger)" : "var(--text)";
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3800);
}

function setLoading(show, text = "Đang xử lý...") {
  if (!els.loadingOverlay) return;
  if (els.loadingText) els.loadingText.textContent = text;
  els.loadingOverlay.classList.toggle("hidden", !show);
}

function typesetMath() {
  if (!window.MathJax || typeof window.MathJax.typesetPromise !== "function")
    return;
  const targets = [
    els.questionContent,
    els.contentEssay,
    els.quickDetail,
  ].filter(Boolean);
  if (!targets.length) return;
  window.MathJax.typesetPromise(targets).catch(() => {});
}

function createZoomModal() {
  if (zoomModal) return;
  zoomModal = document.createElement("div");
  zoomModal.id = "page-zoom-modal";
  zoomModal.className = "loading-overlay hidden";
  zoomModal.style.zIndex = "80";

  const box = document.createElement("div");
  box.className = "loading-box";
  box.style.maxWidth = "92vw";
  box.style.width = "auto";
  box.style.maxHeight = "92vh";
  box.style.display = "flex";
  box.style.flexDirection = "column";
  box.style.gap = "10px";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.gap = "12px";

  zoomModalTitle = document.createElement("strong");
  zoomModalTitle.textContent = "Xem phóng to";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn btn-sm btn-danger";
  closeBtn.textContent = "Đóng";
  closeBtn.addEventListener("click", () => {
    zoomModal.classList.add("hidden");
  });

  zoomModalImg = document.createElement("img");
  zoomModalImg.alt = "Ảnh phóng to";
  zoomModalImg.style.maxWidth = "100%";
  zoomModalImg.style.maxHeight = "76vh";
  zoomModalImg.style.objectFit = "contain";
  zoomModalImg.style.borderRadius = "8px";

  header.appendChild(zoomModalTitle);
  header.appendChild(closeBtn);
  box.appendChild(header);
  box.appendChild(zoomModalImg);
  zoomModal.appendChild(box);
  document.body.appendChild(zoomModal);

  zoomModal.addEventListener("click", (e) => {
    if (e.target === zoomModal) {
      zoomModal.classList.add("hidden");
    }
  });
}

function openZoomModal(src, title = "Xem phóng to") {
  createZoomModal();
  if (!src || !zoomModal || !zoomModalImg) return;
  if (zoomModalTitle) zoomModalTitle.textContent = title;
  zoomModalImg.src = src;
  zoomModal.classList.remove("hidden");
}

function createInstantToggle() {
  if (!els.examView || instantCheckInput) return;
  const actionsEl = els.examView.querySelector(".exam-topbar-actions");
  if (!actionsEl) return;

  const wrapper = document.createElement("label");
  wrapper.className = "radio-card";
  wrapper.style.minHeight = "44px";
  wrapper.style.padding = "6px 10px";

  instantCheckInput = document.createElement("input");
  instantCheckInput.type = "checkbox";
  instantCheckInput.id = "instant-check-input";
  instantCheckInput.checked = state.instantCheck;

  const span = document.createElement("span");
  span.textContent = "Chữa ngay";

  instantCheckInput.addEventListener("change", () => {
    state.instantCheck = instantCheckInput.checked;
    if (state.instantCheck && state.exam) {
      state.exam.questions.forEach((_, idx) => {
        if (hasAnsweredQuestion(idx)) {
          state.checkedMap[idx] = true;
        }
      });
    }
    updateSaveStatusLabel();
    renderQuestionNav();
    renderCurrentQuestion();
    renderRightPane();
    saveRecentExam();
  });

  wrapper.appendChild(instantCheckInput);
  wrapper.appendChild(span);
  actionsEl.prepend(wrapper);
}

function updateSaveStatusLabel() {
  if (!els.saveStatus) return;
  els.saveStatus.textContent = state.instantCheck
    ? "Đã lưu tự động • Chữa ngay: Bật"
    : "Đã lưu tự động • Chữa ngay: Tắt";
}

function readSavedLayoutMode() {
  try {
    const saved = localStorage.getItem(LAYOUT_MODE_KEY);
    if (saved === "auto" || saved === "mobile" || saved === "desktop") {
      return saved;
    }
  } catch {
    // Ignore storage error
  }
  return "auto";
}

function writeSavedLayoutMode(mode) {
  try {
    localStorage.setItem(LAYOUT_MODE_KEY, mode);
  } catch {
    // Ignore storage error
  }
}

function applyLayoutMode(mode, persist = true) {
  const validMode = mode === "mobile" || mode === "desktop" ? mode : "auto";
  state.layoutMode = validMode;
  document.body.setAttribute("data-layout", validMode);

  const buttons = [
    { btn: els.layoutAuto, mode: "auto" },
    { btn: els.layoutMobile, mode: "mobile" },
    { btn: els.layoutDesktop, mode: "desktop" },
  ];
  buttons.forEach(({ btn, mode: m }) => {
    if (btn) btn.classList.toggle("active", m === validMode);
  });

  if (els.examWorkspace) {
    if (validMode === "mobile") {
      els.examWorkspace.classList.add("stack");
    } else if (validMode === "desktop") {
      els.examWorkspace.classList.remove("stack");
    } else {
      els.examWorkspace.classList.toggle("stack", window.innerWidth <= 820);
    }
  }

  if (persist) {
    writeSavedLayoutMode(validMode);
  }
}

function showView(view) {
  const isHome = view === "home";
  if (els.homeView) {
    els.homeView.classList.toggle("active", isHome);
    els.homeView.classList.toggle("hidden", !isHome);
  }
  if (els.examView) {
    els.examView.classList.toggle("active", !isHome);
    els.examView.classList.toggle("hidden", isHome);
  }
  if (isHome) {
    renderRecentExams();
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () =>
      reject(new Error(`Không đọc được file "${file.name}"`));
    reader.readAsDataURL(file);
  });
}

function renderDataUrlToScaledCanvas(
  dataUrl,
  maxEdge = MAX_IMAGE_EDGE,
  quality = 0.8,
) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let width = img.naturalWidth || img.width;
      let height = img.naturalHeight || img.height;
      if (width <= 0 || height <= 0) {
        reject(new Error("Kích thước ảnh không hợp lệ"));
        return;
      }
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
        canvas,
        width,
        height,
        dataUrl: canvas.toDataURL("image/jpeg", quality),
      });
    };
    img.onerror = () => reject(new Error("Không thể tải ảnh vào bộ nhớ"));
    img.src = dataUrl;
  });
}

async function renderPdfPages(file) {
  if (!window.pdfjsLib || typeof window.pdfjsLib.getDocument !== "function") {
    throw new Error("Thư viện PDF.js chưa sẵn sàng");
  }
  const buffer = await file.arrayBuffer();
  const pdfDoc = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const pageCount = Math.min(pdfDoc.numPages || 0, MAX_PDF_PAGES);
  if (pdfDoc.numPages > MAX_PDF_PAGES) {
    showToast(
      `File "${file.name}" có ${pdfDoc.numPages} trang, chỉ lấy ${MAX_PDF_PAGES} trang đầu.`,
    );
  }

  const results = [];
  for (let p = 1; p <= pageCount; p++) {
    setLoading(true, `Đang render trang PDF ${p}/${pageCount}...`);
    const pdfPage = await pdfDoc.getPage(p);
    const baseViewport = pdfPage.getViewport({ scale: 1.5 });
    let scale = 1.5;
    const maxDim = Math.max(baseViewport.width, baseViewport.height);
    if (maxDim > MAX_IMAGE_EDGE) {
      scale = (1.5 * MAX_IMAGE_EDGE) / maxDim;
    }
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    const rawUrl = canvas.toDataURL("image/jpeg", 0.8);
    results.push({
      id: `${file.name}-p${p}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      dataUrl: rawUrl,
      width: canvas.width,
      height: canvas.height,
      selected: false,
    });
  }
  return results;
}

function enforcePageSelectionCap() {
  const currentlySelected = state.pages.filter((p) => p.selected);
  if (currentlySelected.length === 0) {
    state.pages.forEach((p, idx) => {
      p.selected = idx < MAX_SELECTED_PAGES;
    });
    return;
  }
  if (currentlySelected.length > MAX_SELECTED_PAGES) {
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

async function handleFilesChange(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  try {
    setLoading(true, "Đang nạp tài liệu...");
    const newlyAdded = [];
    for (const file of files) {
      const isPdf =
        file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const isImage =
        file.type.startsWith("image/") ||
        /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name);
      if (isPdf) {
        const pdfPages = await renderPdfPages(file);
        newlyAdded.push(...pdfPages);
      } else if (isImage) {
        setLoading(true, `Đang xử lý ảnh "${file.name}"...`);
        const rawUrl = await readFileAsDataUrl(file);
        const scaled = await renderDataUrlToScaledCanvas(
          rawUrl,
          MAX_IMAGE_EDGE,
          0.8,
        );
        newlyAdded.push({
          id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          dataUrl: scaled.dataUrl,
          width: scaled.width,
          height: scaled.height,
          selected: false,
        });
      } else {
        throw new Error(`Không hỗ trợ định dạng file "${file.name}"`);
      }
    }

    state.pages = [...state.pages, ...newlyAdded].map((p, idx) => ({
      ...p,
      index: idx + 1,
    }));
    enforcePageSelectionCap();
    renderPageGrid();
    if (els.pageGridSection) els.pageGridSection.classList.remove("hidden");
  } catch (err) {
    showToast(err?.message || "Không đọc được file", true);
  } finally {
    setLoading(false);
  }
}

function renderPageGrid() {
  if (!els.pageGrid) return;
  els.pageGrid.innerHTML = "";

  if (!state.pages.length) {
    if (els.pageGridSection) els.pageGridSection.classList.add("hidden");
    return;
  }

  if (els.pageGridSection) els.pageGridSection.classList.remove("hidden");

  state.pages.forEach((page, idx) => {
    const card = document.createElement("div");
    card.className = "page-card radio-card";
    if (page.selected) card.classList.add("selected");
    card.style.flexDirection = "column";
    card.style.alignItems = "stretch";
    card.style.gap = "8px";
    card.style.padding = "8px";
    card.style.borderColor = page.selected ? "var(--primary)" : "var(--border)";
    card.style.backgroundColor = page.selected
      ? "var(--surface)"
      : "var(--surface-alt)";

    const numLabel = document.createElement("div");
    numLabel.style.display = "flex";
    numLabel.style.justifyContent = "space-between";
    numLabel.style.alignItems = "center";
    numLabel.style.fontWeight = "700";
    numLabel.style.fontSize = "0.88rem";
    numLabel.innerHTML = `<span>Trang ${idx + 1}</span><span>${page.selected ? "Đã chọn" : "Bỏ chọn"}</span>`;

    const thumb = document.createElement("img");
    thumb.src = page.dataUrl;
    thumb.alt = `Trang ${idx + 1}`;
    thumb.style.width = "100%";
    thumb.style.height = "130px";
    thumb.style.objectFit = "cover";
    thumb.style.borderRadius = "6px";

    const zoomBtn = document.createElement("button");
    zoomBtn.type = "button";
    zoomBtn.className = "btn btn-sm btn-secondary";
    zoomBtn.textContent = "Xem phóng to";
    zoomBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openZoomModal(page.dataUrl, `Trang ${idx + 1}`);
    });

    let pressTimer = null;
    let longPressed = false;

    const startLongPress = () => {
      longPressed = false;
      pressTimer = setTimeout(() => {
        longPressed = true;
        openZoomModal(page.dataUrl, `Trang ${idx + 1}`);
      }, 500);
    };

    const cancelLongPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    card.addEventListener("pointerdown", startLongPress);
    card.addEventListener("pointerup", cancelLongPress);
    card.addEventListener("pointerleave", cancelLongPress);
    card.addEventListener("pointercancel", cancelLongPress);

    card.addEventListener("click", () => {
      if (longPressed) {
        longPressed = false;
        return;
      }
      if (!page.selected) {
        const selectedCount = state.pages.filter((p) => p.selected).length;
        if (selectedCount >= MAX_SELECTED_PAGES) {
          showToast(
            `Chỉ được chọn tối đa ${MAX_SELECTED_PAGES} trang để gửi AI.`,
          );
          return;
        }
        page.selected = true;
      } else {
        page.selected = false;
      }
      renderPageGrid();
    });

    card.appendChild(numLabel);
    card.appendChild(thumb);
    card.appendChild(zoomBtn);
    els.pageGrid.appendChild(card);
  });
}

async function cropFigureFromSelectedPage(selectedPage, box) {
  if (!selectedPage?.dataUrl || !Array.isArray(box) || box.length < 4)
    return null;
  const nums = box.map((v) => Number(v));
  if (nums.some((n) => Number.isNaN(n))) return null;

  const clamp = (v) => Math.max(0, Math.min(1000, v));
  const x0 = clamp(Math.min(nums[0], nums[2])) / 1000;
  const y0 = clamp(Math.min(nums[1], nums[3])) / 1000;
  const x1 = clamp(Math.max(nums[0], nums[2])) / 1000;
  const y1 = clamp(Math.max(nums[1], nums[3])) / 1000;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const sx = Math.round(x0 * img.width);
      const sy = Math.round(y0 * img.height);
      const sw = Math.max(1, Math.round((x1 - x0) * img.width));
      const sh = Math.max(1, Math.round((y1 - y0) * img.height));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(null);
    img.src = selectedPage.dataUrl;
  });
}

function stripDataUrlPrefix(dataUrl) {
  if (typeof dataUrl !== "string") return "";
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

function normalizeExam(raw, subject, mode, format) {
  const rawQuestions = Array.isArray(raw?.questions) ? raw.questions : [];
  const questions = rawQuestions.map((q, i) => {
    const rawType = q?.type || q?.part || "mcq";
    let type = "mcq";
    if (rawType === "tf" || rawType === "true_false") type = "tf";
    else if (rawType === "short" || rawType === "short_answer") type = "short";

    let part = q?.part;
    if (!part) {
      if (format === "short-mcq") {
        part = "Trắc nghiệm";
      } else if (type === "tf") {
        part = "Phần II";
      } else if (type === "short") {
        part = "Phần III";
      } else {
        part = "Phần I";
      }
    }

    const text = String(q?.text ?? q?.prompt ?? q?.question ?? `Câu ${i + 1}`);
    const options =
      q?.options && typeof q.options === "object"
        ? q.options
        : { A: "", B: "", C: "", D: "" };
    const statements =
      q?.statements && typeof q.statements === "object"
        ? q.statements
        : { a: "", b: "", c: "", d: "" };

    return {
      number: Number(q?.number) || i + 1,
      part,
      type,
      text,
      options,
      statements,
      key: q?.key ?? q?.answer ?? null,
      figure: q?.figure && typeof q.figure === "object" ? q.figure : null,
      imageDataUrl: q?.imageDataUrl || null,
    };
  });

  return {
    id:
      raw?.id || `exam_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: String(
      raw?.title || `Đề luyện tập (${String(subject || "").toUpperCase()})`,
    ),
    subject: String(raw?.subject || subject || ""),
    mode,
    format,
    createdAt: Number(raw?.createdAt) || Date.now(),
    questions,
  };
}

function mapExtractError(code, message) {
  if (code === "missing_key") return "Chưa cấu hình khóa AI trên máy chủ";
  if (code === "invalid_json")
    return "AI trả về chưa đúng định dạng, thử lại với ít trang hơn";
  return `Lỗi: ${message || code || "Không thể tạo đề"}`;
}

async function handleCreateExam() {
  const selectedPages = state.pages
    .filter((p) => p.selected)
    .slice(0, MAX_SELECTED_PAGES);
  const text = els.textInput ? els.textInput.value.trim() : "";

  if (!selectedPages.length && !text) {
    showToast(
      "Vui lòng chọn ít nhất 1 trang hoặc nhập nội dung văn bản.",
      true,
    );
    return;
  }

  const subject = els.subjectSelect ? els.subjectSelect.value : "toan";
  const checkedMode = document.querySelector(
    'input[name="process-mode"]:checked',
  );
  const checkedFormat = document.querySelector(
    'input[name="exam-format"]:checked',
  );
  const mode = checkedMode?.value === "generate" ? "generate" : "extract";
  const format = checkedFormat?.value === "short-mcq" ? "short-mcq" : "thpt";

  try {
    setLoading(true, "Đang gửi dữ liệu tới AI để tạo đề...");
    const compressedImages = [];
    for (const sp of selectedPages) {
      const scaled = await renderDataUrlToScaledCanvas(
        sp.dataUrl,
        MAX_IMAGE_EDGE,
        0.8,
      );
      compressedImages.push(stripDataUrlPrefix(scaled.dataUrl));
    }

    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: compressedImages,
        text,
        subject,
        mode,
        format,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(mapExtractError(data?.error, data?.message));
    }

    const exam = normalizeExam(data, subject, mode, format);

    setLoading(true, "Đang cắt hình minh họa...");
    for (const q of exam.questions) {
      if (q.figure && Array.isArray(q.figure.box) && q.figure.box.length >= 4) {
        const pageNum = Number(q.figure.page);
        if (
          !Number.isNaN(pageNum) &&
          pageNum >= 1 &&
          pageNum <= selectedPages.length
        ) {
          q.imageDataUrl = await cropFigureFromSelectedPage(
            selectedPages[pageNum - 1],
            q.figure.box,
          );
        }
      }
    }

    openExam(exam, {}, {}, false);
    saveRecentExam();
    showView("exam");
  } catch (err) {
    const msg = String(err?.message || "Lỗi không xác định");
    const displayMsg =
      msg.startsWith("Lỗi:") ||
      msg.startsWith("Chưa cấu hình") ||
      msg.startsWith("AI trả về")
        ? msg
        : `Lỗi: ${msg}`;
    showToast(displayMsg, true);
  } finally {
    setLoading(false);
  }
}

function hasAnsweredQuestion(idx) {
  if (!state.exam) return false;
  const q = state.exam.questions[idx];
  const ans = state.answers[idx];
  if (!q || ans === undefined || ans === null) return false;

  if (q.type === "tf") {
    return (
      typeof ans === "object" &&
      ["a", "b", "c", "d"].some((k) => typeof ans[k] === "boolean")
    );
  }
  if (q.type === "mcq") {
    return String(ans).trim() !== "";
  }
  return String(ans).trim() !== "";
}

function gradeQuestion(idx) {
  if (!state.exam)
    return { score: 0, maxScore: 0, status: "unanswered", detail: "" };
  const q = state.exam.questions[idx];
  const ans = state.answers[idx];
  const isShortFormat = state.exam.format === "short-mcq";
  const totalQ = Math.max(1, state.exam.questions.length);

  if (q.type === "mcq") {
    const maxScore = isShortFormat ? 10 / totalQ : 0.25;
    const chosen = String(ans ?? "")
      .trim()
      .toUpperCase();
    const key = String(q.key ?? "")
      .trim()
      .toUpperCase();
    if (!chosen)
      return {
        score: 0,
        maxScore,
        status: "unanswered",
        detail: "Chưa chọn đáp án",
      };
    const isCorrect = key && chosen === key;
    return {
      score: isCorrect ? maxScore : 0,
      maxScore,
      status: isCorrect ? "correct" : "wrong",
      detail: isCorrect
        ? `Đúng (+${maxScore.toFixed(2).replace(".", ",")})`
        : `Sai (Đáp án: ${key || "?"})`,
    };
  }

  if (q.type === "tf") {
    const maxScore = isShortFormat ? 10 / totalQ : 1.0;
    const keyObj = q.key && typeof q.key === "object" ? q.key : {};
    const ansObj = ans && typeof ans === "object" ? ans : {};
    const subKeys = ["a", "b", "c", "d"];
    const anyAnswered = subKeys.some((k) => typeof ansObj[k] === "boolean");
    if (!anyAnswered)
      return {
        score: 0,
        maxScore,
        status: "unanswered",
        detail: "Chưa trả lời",
      };

    let correctCount = 0;
    subKeys.forEach((k) => {
      if (typeof keyObj[k] === "boolean" && ansObj[k] === keyObj[k]) {
        correctCount++;
      }
    });

    const thptPoints = { 0: 0, 1: 0.1, 2: 0.25, 3: 0.5, 4: 1.0 };
    const score = isShortFormat
      ? (correctCount / 4) * maxScore
      : (thptPoints[correctCount] ?? 0);
    return {
      score,
      maxScore,
      status: correctCount === 4 ? "correct" : "wrong",
      detail: `Đúng ${correctCount}/4 ý (${score.toFixed(2).replace(".", ",")}/${maxScore.toFixed(2).replace(".", ",")})`,
    };
  }

  const maxScore = isShortFormat ? 10 / totalQ : 0.5;
  const rawAns = String(ans ?? "").trim();
  if (!rawAns)
    return {
      score: 0,
      maxScore,
      status: "unanswered",
      detail: "Chưa nhập đáp án",
    };

  const norm = (s) => s.replace(",", ".").replace(/\s+/g, "").toLowerCase();
  const uNorm = norm(rawAns);
  const kNorm = norm(String(q.key ?? ""));
  const uNum = Number(uNorm);
  const kNum = Number(kNorm);

  const isCorrect =
    (!Number.isNaN(uNum) &&
      !Number.isNaN(kNum) &&
      Math.abs(uNum - kNum) < 1e-6) ||
    (kNorm.length > 0 && uNorm === kNorm);

  return {
    score: isCorrect ? maxScore : 0,
    maxScore,
    status: isCorrect ? "correct" : "wrong",
    detail: isCorrect
      ? `Đúng (+${maxScore.toFixed(2).replace(".", ",")})`
      : `Sai (Đáp án: ${q.key ?? "?"})`,
  };
}

function calculateExamTotalOutOf10() {
  if (!state.exam || !state.exam.questions.length) return 0;
  if (state.exam.format === "short-mcq") {
    let sum = 0;
    state.exam.questions.forEach((_, idx) => {
      sum += gradeQuestion(idx).score;
    });
    return Math.round(sum * 100) / 100;
  }
  let earned = 0;
  let possible = 0;
  state.exam.questions.forEach((_, idx) => {
    const r = gradeQuestion(idx);
    earned += r.score;
    possible += r.maxScore;
  });
  if (possible <= 0) return 0;
  const scaled = (earned / possible) * 10;
  return Math.round(scaled * 100) / 100;
}

function openExam(examObj, answers = {}, checkedMap = {}, submitted = false) {
  state.exam = examObj;
  state.answers = { ...answers };
  state.checkedMap = { ...checkedMap };
  state.submitted = Boolean(submitted);
  state.currentIndex = 0;
  state.activeTab = "essay";
  state.explanations = {};
  state.chatHistory = {};

  if (els.examTitle) els.examTitle.textContent = examObj.title;
  updateSaveStatusLabel();
  renderQuestionNav();
  renderCurrentQuestion();
  renderRightPane();
}

function renderQuestionNav() {
  if (!els.questionNavBar || !state.exam) return;
  els.questionNavBar.innerHTML = "";

  state.exam.questions.forEach((q, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm";
    btn.style.minWidth = "44px";
    btn.textContent = String(q.number || idx + 1);

    const showResult =
      state.submitted || state.checkedMap[idx] || state.instantCheck;
    if (idx === state.currentIndex) {
      btn.classList.add("btn-primary");
    } else if (showResult && hasAnsweredQuestion(idx)) {
      const r = gradeQuestion(idx);
      if (r.status === "correct") {
        btn.style.backgroundColor = "var(--success-bg)";
        btn.style.borderColor = "var(--success-text)";
        btn.style.color = "var(--success-text)";
      } else {
        btn.style.backgroundColor = "var(--warning-bg)";
        btn.style.borderColor = "var(--danger)";
        btn.style.color = "var(--danger)";
      }
    } else if (hasAnsweredQuestion(idx)) {
      btn.classList.add("btn-outline");
    }

    btn.addEventListener("click", () => {
      state.currentIndex = idx;
      renderQuestionNav();
      renderCurrentQuestion();
      renderRightPane();
    });

    els.questionNavBar.appendChild(btn);
  });
}

function renderCurrentQuestion() {
  if (!state.exam || !state.exam.questions.length) return;
  const idx = state.currentIndex;
  const q = state.exam.questions[idx];

  if (els.questionPartBadge) {
    els.questionPartBadge.textContent = q.part || "Phần I";
  }
  if (els.questionNumberLabel) {
    els.questionNumberLabel.textContent = `Câu ${q.number || idx + 1}`;
  }
  if (els.questionContent) {
    els.questionContent.textContent = q.text || "";
  }

  if (els.questionImageContainer && els.questionImage) {
    if (q.imageDataUrl) {
      els.questionImage.src = q.imageDataUrl;
      els.questionImageContainer.classList.remove("hidden");
    } else {
      els.questionImage.removeAttribute("src");
      els.questionImageContainer.classList.add("hidden");
    }
  }

  if (els.answerMcq) els.answerMcq.classList.add("hidden");
  if (els.answerTf) els.answerTf.classList.add("hidden");
  if (els.answerShort) els.answerShort.classList.add("hidden");

  const showAnswerFeedback =
    state.submitted || state.checkedMap[idx] || state.instantCheck;
  const key = q.key;

  if (q.type === "mcq" && els.answerMcq) {
    els.answerMcq.classList.remove("hidden");
    els.answerMcq.innerHTML = "";
    const currentChoice = String(state.answers[idx] || "").toUpperCase();
    const correctKey = String(key || "").toUpperCase();

    ["A", "B", "C", "D"].forEach((letter) => {
      const optVal = q.options?.[letter] ?? "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.style.justifyContent = "flex-start";
      btn.style.textAlign = "left";
      btn.innerHTML = `<strong>${letter}.</strong>&nbsp;<span>${escapeHtml(String(optVal))}</span>`;

      if (currentChoice === letter) {
        btn.classList.add("btn-primary");
      }
      if (showAnswerFeedback && correctKey) {
        if (letter === correctKey) {
          btn.style.borderColor = "var(--success-text)";
          btn.style.backgroundColor = "var(--success-bg)";
          btn.style.color = "var(--success-text)";
        } else if (currentChoice === letter && letter !== correctKey) {
          btn.style.borderColor = "var(--danger)";
          btn.style.backgroundColor = "var(--warning-bg)";
          btn.style.color = "var(--danger)";
        }
      }

      btn.addEventListener("click", () => {
        state.answers[idx] = letter;
        if (state.instantCheck) {
          state.checkedMap[idx] = true;
        }
        saveRecentExam();
        renderQuestionNav();
        renderCurrentQuestion();
        renderRightPane();
      });

      els.answerMcq.appendChild(btn);
    });
  } else if (q.type === "tf" && els.answerTf) {
    els.answerTf.classList.remove("hidden");
    els.answerTf.innerHTML = "";
    const currentTf =
      state.answers[idx] && typeof state.answers[idx] === "object"
        ? state.answers[idx]
        : {};
    const keyTf = key && typeof key === "object" ? key : {};

    ["a", "b", "c", "d"].forEach((sub) => {
      const stmtText = q.statements?.[sub] ?? "";
      const row = document.createElement("div");
      row.className = "radio-card";
      row.style.justifyContent = "space-between";
      row.style.gap = "10px";

      const labelSpan = document.createElement("span");
      labelSpan.style.flex = "1";
      labelSpan.innerHTML = `<strong>${sub})</strong> ${escapeHtml(String(stmtText))}`;

      if (showAnswerFeedback && typeof keyTf[sub] === "boolean") {
        const mark = document.createElement("span");
        mark.style.fontWeight = "700";
        mark.style.marginLeft = "6px";
        mark.textContent = `[Đáp án: ${keyTf[sub] ? "Đúng" : "Sai"}]`;
        labelSpan.appendChild(mark);
      }

      const group = document.createElement("div");
      group.style.display = "flex";
      group.style.gap = "6px";

      [
        { text: "Đúng", val: true },
        { text: "Sai", val: false },
      ].forEach(({ text, val }) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-sm";
        b.textContent = text;
        if (currentTf[sub] === val) {
          b.classList.add("btn-primary");
        }
        b.addEventListener("click", () => {
          state.answers[idx] = {
            ...(state.answers[idx] && typeof state.answers[idx] === "object"
              ? state.answers[idx]
              : {}),
            [sub]: val,
          };
          if (state.instantCheck) {
            state.checkedMap[idx] = true;
          }
          saveRecentExam();
          renderQuestionNav();
          renderCurrentQuestion();
          renderRightPane();
        });
        group.appendChild(b);
      });

      row.appendChild(labelSpan);
      row.appendChild(group);
      els.answerTf.appendChild(row);
    });
  } else if (els.answerShort) {
    els.answerShort.classList.remove("hidden");
    if (els.shortAnswerInput) {
      els.shortAnswerInput.value = state.answers[idx] ?? "";
      els.shortAnswerInput.oninput = () => {
        state.answers[idx] = els.shortAnswerInput.value;
        if (state.instantCheck) {
          state.checkedMap[idx] = true;
        }
        saveRecentExam();
        renderQuestionNav();
        renderRightPane();
      };
    }
  }

  if (els.prevQuestionBtn) {
    els.prevQuestionBtn.disabled = idx <= 0;
  }
  if (els.nextQuestionBtn) {
    els.nextQuestionBtn.disabled = idx >= state.exam.questions.length - 1;
  }

  typesetMath();
}

function renderRightPane() {
  if (!state.exam || !state.exam.questions.length) return;
  const idx = state.currentIndex;
  const q = state.exam.questions[idx];
  const showScore =
    state.submitted ||
    state.instantCheck ||
    Object.keys(state.checkedMap).length > 0;

  if (els.scorePanel) {
    els.scorePanel.classList.toggle("hidden", !showScore);
  }
  if (showScore) {
    const total10 = calculateExamTotalOutOf10();
    if (els.totalScore) {
      els.totalScore.textContent = `${total10.toFixed(2).replace(".", ",")} / 10`;
    }
    const qRes = gradeQuestion(idx);
    if (els.questionResultStatus) {
      if (state.submitted || state.checkedMap[idx] || state.instantCheck) {
        els.questionResultStatus.textContent = qRes.detail;
      } else {
        els.questionResultStatus.textContent = "";
      }
    }
  }

  const isEssay = state.activeTab === "essay";
  if (els.tabEssay) {
    els.tabEssay.classList.toggle("active", isEssay);
    els.tabEssay.setAttribute("aria-selected", String(isEssay));
  }
  if (els.tabQuick) {
    els.tabQuick.classList.toggle("active", !isEssay);
    els.tabQuick.setAttribute("aria-selected", String(!isEssay));
  }
  if (els.contentEssay) {
    els.contentEssay.classList.toggle("hidden", !isEssay);
    els.contentEssay.classList.toggle("active", isEssay);
  }
  if (els.contentQuick) {
    els.contentQuick.classList.toggle("hidden", isEssay);
    els.contentQuick.classList.toggle("active", !isEssay);
  }

  const exp = state.explanations[idx] || {};
  if (els.contentEssay) {
    els.contentEssay.innerHTML = exp.essay
      ? formatTextBlocks(exp.essay)
      : `<p style="color: var(--text-muted); margin: 0;">Bấm "Xem lời giải câu này" để xem lời giải tự luận từng bước.</p>`;
  }

  if (els.quickWarning) {
    if (!exp.quick) {
      els.quickWarning.textContent =
        'Chưa có mẹo trắc nghiệm nhanh cho câu này. Bấm "Xem lời giải câu này" để tải.';
      els.quickWarning.classList.remove("hidden");
    } else {
      els.quickWarning.textContent =
        "Lưu ý: Mẹo và công thức nhanh chỉ áp dụng khi thỏa mãn điều kiện bài toán.";
      els.quickWarning.classList.remove("hidden");
    }
  }

  if (els.quickDetail) {
    els.quickDetail.innerHTML = exp.quick
      ? formatTextBlocks(exp.quick)
      : `<p style="color: var(--text-muted); margin: 0;">Chưa có nội dung trắc nghiệm nhanh.</p>`;
  }

  renderChatMessages(idx);
  typesetMath();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTextBlocks(str) {
  return escapeHtml(str).replace(/\n/g, "<br>");
}

function renderChatMessages(idx) {
  if (!els.chatMessages) return;
  els.chatMessages.innerHTML = "";
  const msgs = state.chatHistory[idx] || [];
  msgs.forEach((m) => {
    const bubble = document.createElement("div");
    bubble.style.padding = "8px 10px";
    bubble.style.borderRadius = "8px";
    bubble.style.border = "1px solid var(--border)";
    bubble.style.backgroundColor =
      m.role === "user" ? "var(--primary)" : "var(--surface)";
    bubble.style.color =
      m.role === "user" ? "var(--primary-contrast)" : "var(--text)";
    bubble.innerHTML = formatTextBlocks(m.content);
    els.chatMessages.appendChild(bubble);
  });
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function handleExplainCurrent() {
  if (!state.exam || !state.exam.questions.length) return;
  const idx = state.currentIndex;
  const q = state.exam.questions[idx];
  const answer = state.answers[idx] ?? null;
  const prevExp = state.explanations[idx] || {};

  try {
    setLoading(
      true,
      state.activeTab === "essay"
        ? "Đang giải tự luận..."
        : "Đang tìm mẹo trắc nghiệm nhanh...",
    );
    if (state.activeTab === "essay") {
      const res = await fetch("/api/grade-explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          answer,
          key: q.key ?? null,
          subject: state.exam.subject,
          mode: "essay",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data?.error || data?.message || "Lỗi lấy lời giải tự luận",
        );
      }
      state.explanations[idx] = {
        ...prevExp,
        essay: String(data?.text || ""),
      };
    } else {
      const res = await fetch("/api/quick-tip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          subject: state.exam.subject,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data?.error || data?.message || "Lỗi lấy mẹo trắc nghiệm nhanh",
        );
      }
      state.explanations[idx] = {
        ...prevExp,
        quick: String(data?.text || ""),
      };
    }
    renderRightPane();
  } catch (err) {
    showToast(`Lỗi: ${err?.message || "Không thể lấy lời giải"}`, true);
  } finally {
    setLoading(false);
  }
}

async function handleChatSubmit(e) {
  e.preventDefault();
  if (!state.exam || !state.exam.questions.length || !els.chatInput) return;
  const message = els.chatInput.value.trim();
  if (!message) return;

  const idx = state.currentIndex;
  const q = state.exam.questions[idx];
  const history = state.chatHistory[idx] || [];
  const nextHistory = [...history, { role: "user", content: message }];
  state.chatHistory[idx] = nextHistory;
  els.chatInput.value = "";
  renderChatMessages(idx);

  try {
    if (els.chatSendBtn) els.chatSendBtn.disabled = true;
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: {
          subject: state.exam.subject,
          question: q,
          answer: state.answers[idx] ?? null,
          key: q.key ?? null,
        },
        history,
        message,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || data?.message || "Lỗi gửi tin nhắn");
    }
    state.chatHistory[idx] = [
      ...nextHistory,
      { role: "assistant", content: String(data?.text || "") },
    ];
    renderChatMessages(idx);
    typesetMath();
  } catch (err) {
    showToast(`Lỗi: ${err?.message || "Không thể trò chuyện với AI"}`, true);
  } finally {
    if (els.chatSendBtn) els.chatSendBtn.disabled = false;
  }
}

function getRecentExams() {
  try {
    const raw = localStorage.getItem(RECENT_EXAMS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setRecentExams(list) {
  try {
    localStorage.setItem(
      RECENT_EXAMS_KEY,
      JSON.stringify(list.slice(0, MAX_RECENT_EXAMS)),
    );
  } catch {
    // Ignore storage error if full
  }
}

function saveRecentExam() {
  if (!state.exam) return;
  const entry = {
    id: state.exam.id,
    title: state.exam.title,
    subject: state.exam.subject,
    createdAt: state.exam.createdAt || Date.now(),
    questions: state.exam.questions,
    answers: state.answers,
    checked: state.checkedMap,
    format: state.exam.format,
    mode: state.exam.mode,
    submitted: state.submitted,
  };
  const existing = getRecentExams().filter(
    (item) => item && item.id !== entry.id,
  );
  setRecentExams([entry, ...existing]);
  renderRecentExams();
}

function deleteRecentExam(examId) {
  const filtered = getRecentExams().filter(
    (item) => item && item.id !== examId,
  );
  setRecentExams(filtered);
  renderRecentExams();
}

function renderRecentExams() {
  if (!els.recentSection || !els.recentList) return;
  const list = getRecentExams();
  els.recentList.innerHTML = "";

  if (!list.length) {
    els.recentSection.classList.add("hidden");
    return;
  }

  els.recentSection.classList.remove("hidden");
  list.slice(0, MAX_RECENT_EXAMS).forEach((item) => {
    const card = document.createElement("div");
    card.className = "radio-card";
    card.style.flexDirection = "column";
    card.style.alignItems = "stretch";
    card.style.gap = "8px";

    const title = document.createElement("strong");
    title.textContent = item.title || "Đề luyện tập";
    title.style.fontSize = "0.95rem";

    const meta = document.createElement("span");
    const qLen = Array.isArray(item.questions) ? item.questions.length : 0;
    meta.textContent = `Môn: ${item.subject || "—"} • ${qLen} câu`;
    meta.style.fontSize = "0.82rem";
    meta.style.color = "var(--text-muted)";

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn btn-sm btn-primary";
    openBtn.style.flex = "1";
    openBtn.textContent = "Mở";
    openBtn.addEventListener("click", () => {
      const restored = normalizeExam(
        item,
        item.subject,
        item.mode,
        item.format,
      );
      openExam(
        restored,
        item.answers || {},
        item.checked || {},
        Boolean(item.submitted),
      );
      showView("exam");
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-sm btn-danger";
    delBtn.textContent = "Xóa";
    delBtn.addEventListener("click", () => {
      deleteRecentExam(item.id);
    });

    btnRow.appendChild(openBtn);
    btnRow.appendChild(delBtn);
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(btnRow);
    els.recentList.appendChild(card);
  });
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeBase64Utf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function handleShareExam() {
  if (!state.exam) return;
  try {
    const payload = JSON.stringify(state.exam);
    const encoded = encodeBase64Utf8(payload);
    const shareUrl = `${window.location.origin}${window.location.pathname}#de=${encoded}`;
    window.location.hash = `de=${encoded}`;
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(shareUrl);
      showToast("Đã tạo và sao chép liên kết chia sẻ đề!");
    } else {
      showToast("Đã cập nhật liên kết chia sẻ trên thanh địa chỉ.");
    }
  } catch (err) {
    showToast(`Lỗi: ${err?.message || "Không thể tạo liên kết chia sẻ"}`, true);
  }
}

function loadExamFromHashIfPresent() {
  const hash = window.location.hash || "";
  const match = hash.match(/#de=(.+)$/);
  if (!match || !match[1]) return false;
  try {
    const jsonStr = decodeBase64Utf8(decodeURIComponent(match[1]));
    const parsed = JSON.parse(jsonStr);
    const exam = normalizeExam(
      parsed,
      parsed?.subject || "",
      parsed?.mode || "extract",
      parsed?.format || "thpt",
    );
    if (!exam.questions.length) return false;
    openExam(exam, {}, {}, false);
    saveRecentExam();
    showView("exam");
    return true;
  } catch {
    return false;
  }
}

function bindEvents() {
  if (els.logoBtn) {
    els.logoBtn.addEventListener("click", (e) => {
      e.preventDefault();
      showView("home");
    });
  }

  if (els.layoutAuto) {
    els.layoutAuto.addEventListener("click", () =>
      applyLayoutMode("auto", true),
    );
  }
  if (els.layoutMobile) {
    els.layoutMobile.addEventListener("click", () =>
      applyLayoutMode("mobile", true),
    );
  }
  if (els.layoutDesktop) {
    els.layoutDesktop.addEventListener("click", () =>
      applyLayoutMode("desktop", true),
    );
  }

  window.addEventListener("resize", () => {
    if (state.layoutMode === "auto") {
      applyLayoutMode("auto", false);
    }
  });

  if (els.fileInput) {
    els.fileInput.addEventListener("change", (e) => {
      handleFilesChange(e.target.files);
      e.target.value = "";
    });
  }

  if (els.cameraInput) {
    els.cameraInput.addEventListener("change", (e) => {
      handleFilesChange(e.target.files);
      e.target.value = "";
    });
  }

  if (els.selectAllPagesBtn) {
    els.selectAllPagesBtn.addEventListener("click", () => {
      state.pages.forEach((p, idx) => {
        p.selected = idx < MAX_SELECTED_PAGES;
      });
      renderPageGrid();
    });
  }

  if (els.deselectAllPagesBtn) {
    els.deselectAllPagesBtn.addEventListener("click", () => {
      state.pages.forEach((p) => {
        p.selected = false;
      });
      renderPageGrid();
    });
  }

  if (els.clearFilesBtn) {
    els.clearFilesBtn.addEventListener("click", () => {
      state.pages = [];
      renderPageGrid();
    });
  }

  if (els.createExamBtn) {
    els.createExamBtn.addEventListener("click", handleCreateExam);
  }

  if (els.backHomeBtn) {
    els.backHomeBtn.addEventListener("click", () => {
      saveRecentExam();
      showView("home");
    });
  }

  if (els.prevQuestionBtn) {
    els.prevQuestionBtn.addEventListener("click", () => {
      if (state.currentIndex > 0) {
        state.currentIndex--;
        renderQuestionNav();
        renderCurrentQuestion();
        renderRightPane();
      }
    });
  }

  if (els.nextQuestionBtn) {
    els.nextQuestionBtn.addEventListener("click", () => {
      if (state.exam && state.currentIndex < state.exam.questions.length - 1) {
        state.currentIndex++;
        renderQuestionNav();
        renderCurrentQuestion();
        renderRightPane();
      }
    });
  }

  if (els.submitExamBtn) {
    els.submitExamBtn.addEventListener("click", () => {
      if (!state.exam) return;
      state.submitted = true;
      state.exam.questions.forEach((_, idx) => {
        state.checkedMap[idx] = true;
      });
      saveRecentExam();
      renderQuestionNav();
      renderCurrentQuestion();
      renderRightPane();
      const score10 = calculateExamTotalOutOf10();
      showToast(
        `Đã nộp bài! Tổng điểm: ${score10.toFixed(2).replace(".", ",")} / 10`,
      );
    });
  }

  if (els.shareExamBtn) {
    els.shareExamBtn.addEventListener("click", handleShareExam);
  }

  if (els.tabEssay) {
    els.tabEssay.addEventListener("click", () => {
      state.activeTab = "essay";
      renderRightPane();
    });
  }

  if (els.tabQuick) {
    els.tabQuick.addEventListener("click", () => {
      state.activeTab = "quick";
      renderRightPane();
    });
  }

  if (els.explainCurrentBtn) {
    els.explainCurrentBtn.addEventListener("click", handleExplainCurrent);
  }

  if (els.chatForm) {
    els.chatForm.addEventListener("submit", handleChatSubmit);
  }

  window.addEventListener("hashchange", () => {
    loadExamFromHashIfPresent();
  });
}

createZoomModal();
createInstantToggle();
applyLayoutMode(readSavedLayoutMode(), false);
bindEvents();
renderRecentExams();
if (!loadExamFromHashIfPresent()) {
  showView("home");
}
