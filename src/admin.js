import "./styles/base.css";
import "./styles/admin.css";
import { getPageConfig } from "./lib/env";
import { getSupabase } from "./lib/supabase";

const TABLE_EVENT_SETTINGS = "event_settings";

const authGate = document.querySelector("#authGate");
const adminApp = document.querySelector("#adminApp");
const loginForm = document.querySelector("#loginForm");
const loginButton = document.querySelector("#loginButton");
const authStatus = document.querySelector("#authStatus");
const adminEmailInput = document.querySelector("#adminEmail");
const adminPasswordInput = document.querySelector("#adminPassword");

const eventName = document.querySelector("#eventName");
const openLiveLink = document.querySelector("#openLiveLink");
const logoutButton = document.querySelector("#logoutButton");
const uploadForm = document.querySelector("#uploadForm");
const uploadButton = document.querySelector("#uploadButton");
const pdfInput = document.querySelector("#pdfInput");
const refreshFilesButton = document.querySelector("#refreshFilesButton");
const clearSelectionButton = document.querySelector("#clearSelectionButton");
const pdfStatus = document.querySelector("#pdfStatus");
const pdfList = document.querySelector("#pdfList");
const pdfFrame = document.querySelector("#pdfFrame");

const { eventId, storageBucket } = getPageConfig();
const configuredAdminEmail = (import.meta.env.VITE_ADMIN_EMAIL || "").trim();
let supabase = null;
let activePdfPath = null;
let currentFiles = [];

eventName.textContent = eventId;
openLiveLink.href = `./live.html?event=${encodeURIComponent(eventId)}`;
if (configuredAdminEmail) {
  adminEmailInput.value = configuredAdminEmail;
}

setViewerPlaceholder("선택된 PDF가 없습니다.");
bindEvents();

try {
  supabase = getSupabase();
} catch (error) {
  disableLogin(error.message);
}

if (supabase) {
  initialize().catch((error) => {
    showAuthGate();
    setAuthStatus(`초기화 실패: ${error.message}`, true);
  });
}

async function initialize() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw error;
  }

  if (!data.session) {
    showAuthGate();
    return;
  }

  try {
    await enterAdminMode();
  } catch (modeError) {
    await supabase.auth.signOut();
    showAuthGate();
    setAuthStatus(modeError.message, true);
  }
}

function bindEvents() {
  loginForm.addEventListener("submit", handleLogin);
  logoutButton.addEventListener("click", handleLogout);
  uploadForm.addEventListener("submit", handleUploadPdf);
  refreshFilesButton.addEventListener("click", () => {
    refreshPdfFiles().catch((error) => {
      setPdfStatus(`목록 갱신 실패: ${error.message}`, true);
    });
  });
  clearSelectionButton.addEventListener("click", () => {
    clearActivePdf().catch((error) => {
      setPdfStatus(`선택 해제 실패: ${error.message}`, true);
    });
  });
}

async function handleLogin(event) {
  event.preventDefault();
  setAuthStatus("");

  const email = adminEmailInput.value.trim();
  const password = adminPasswordInput.value;
  if (!email || !password) {
    setAuthStatus("이메일과 비밀번호를 입력해 주세요.", true);
    return;
  }

  loginButton.disabled = true;
  loginButton.textContent = "로그인 중...";

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  loginButton.disabled = false;
  loginButton.textContent = "로그인";

  if (error) {
    setAuthStatus(`로그인 실패: ${error.message}`, true);
    return;
  }

  if (!data.session) {
    setAuthStatus("로그인 세션을 확인할 수 없습니다.", true);
    return;
  }

  try {
    await enterAdminMode();
  } catch (modeError) {
    await supabase.auth.signOut();
    showAuthGate();
    setAuthStatus(modeError.message, true);
  }
}

async function handleLogout() {
  await supabase.auth.signOut();
  pdfList.innerHTML = "";
  setPdfStatus("");
  showAuthGate();
  setAuthStatus("로그아웃되었습니다.");
}

async function enterAdminMode() {
  setAuthStatus("권한 확인 중...");
  const isAdmin = await checkAdmin();
  if (!isAdmin) {
    throw new Error("관리자 권한이 없는 계정입니다.");
  }

  showAdminApp();
  setAuthStatus("");
  await bootstrapAdmin();
}

async function checkAdmin() {
  const { data, error } = await supabase.rpc("is_admin");
  if (error) {
    throw new Error(
      `관리자 확인 RPC 실패(${error.message}). supabase/schema.sql 적용 여부를 확인해 주세요.`,
    );
  }

  return Boolean(data);
}

async function bootstrapAdmin() {
  await refreshPdfFiles();
  await loadActivePdfSetting();
}

async function refreshPdfFiles() {
  const { data, error } = await supabase.storage
    .from(storageBucket)
    .list(eventId, { limit: 200, sortBy: { column: "name", order: "asc" } });

  if (error) {
    throw error;
  }

  currentFiles = (data || [])
    .filter((file) => typeof file.name === "string" && file.name.toLowerCase().endsWith(".pdf"))
    .map((file) => ({
      name: file.name,
      fullPath: `${eventId}/${file.name}`,
    }));

  renderPdfList();
}

async function loadActivePdfSetting() {
  const { data, error } = await supabase
    .from(TABLE_EVENT_SETTINGS)
    .select("event_id, active_pdf_path")
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    await applySelectedPdf(null);
    return;
  }

  await applySelectedPdf(data.active_pdf_path);
}

async function handleUploadPdf(event) {
  event.preventDefault();
  setPdfStatus("");

  const file = pdfInput.files?.[0];
  if (!file) {
    setPdfStatus("업로드할 PDF 파일을 선택해 주세요.", true);
    return;
  }

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    setPdfStatus("PDF 파일만 업로드할 수 있습니다.", true);
    return;
  }

  const objectPath = `${eventId}/${Date.now()}-${sanitizeFileName(file.name)}`;
  uploadButton.disabled = true;
  uploadButton.textContent = "업로드 중...";

  try {
    const { error } = await supabase.storage
      .from(storageBucket)
      .upload(objectPath, file, { contentType: "application/pdf", upsert: false });

    if (error) {
      throw error;
    }

    await updateActivePdfSetting(objectPath);
    await refreshPdfFiles();
    await applySelectedPdf(objectPath);
    uploadForm.reset();
    setPdfStatus("업로드 후 즉시 적용되었습니다.");
  } catch (error) {
    setPdfStatus(`업로드 실패: ${error.message}`, true);
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = "PDF 업로드";
  }
}

async function selectPdf(path) {
  await updateActivePdfSetting(path);
  await applySelectedPdf(path);
  renderPdfList();
  setPdfStatus("선택한 PDF를 라이브 화면에 적용했습니다.");
}

async function deletePdf(path) {
  const { error } = await supabase.storage.from(storageBucket).remove([path]);
  if (error) {
    throw error;
  }

  if (path === activePdfPath) {
    await updateActivePdfSetting(null);
    await applySelectedPdf(null);
  }

  await refreshPdfFiles();
  setPdfStatus("PDF를 삭제했습니다.");
}

async function clearActivePdf() {
  await updateActivePdfSetting(null);
  await applySelectedPdf(null);
  renderPdfList();
  setPdfStatus("PDF 선택을 해제했습니다.");
}

async function updateActivePdfSetting(path) {
  const { error } = await supabase.from(TABLE_EVENT_SETTINGS).upsert(
    {
      event_id: eventId,
      active_pdf_path: path,
    },
    { onConflict: "event_id" },
  );

  if (error) {
    throw error;
  }
}

async function applySelectedPdf(path) {
  activePdfPath = path || null;
  renderPdfList();

  if (!path) {
    setViewerPlaceholder("선택된 PDF가 없습니다.");
    return;
  }

  const { data: publicData } = supabase.storage.from(storageBucket).getPublicUrl(path);
  if (publicData?.publicUrl) {
    pdfFrame.src = publicData.publicUrl;
    return;
  }

  const signed = await supabase.storage.from(storageBucket).createSignedUrl(path, 86400);
  if (signed.error || !signed.data?.signedUrl) {
    setViewerPlaceholder("PDF 미리보기를 불러올 수 없습니다.");
    return;
  }

  pdfFrame.src = signed.data.signedUrl;
}

function renderPdfList() {
  pdfList.innerHTML = "";

  if (currentFiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "pdf-empty";
    empty.textContent = "업로드된 PDF가 없습니다.";
    pdfList.append(empty);
    return;
  }

  for (const file of currentFiles) {
    const row = document.createElement("div");
    row.className = "pdf-file";
    if (file.fullPath === activePdfPath) {
      row.classList.add("is-active");
    }

    const name = document.createElement("p");
    name.className = "pdf-file-name";
    name.textContent = file.name;

    const actions = document.createElement("div");
    actions.className = "pdf-file-actions";

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "select-btn";
    selectButton.textContent = file.fullPath === activePdfPath ? "선택됨" : "선택";
    selectButton.disabled = file.fullPath === activePdfPath;
    selectButton.addEventListener("click", () => {
      selectPdf(file.fullPath).catch((error) => {
        setPdfStatus(`파일 선택 실패: ${error.message}`, true);
      });
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-btn";
    deleteButton.textContent = "삭제";
    deleteButton.addEventListener("click", () => {
      deletePdf(file.fullPath).catch((error) => {
        setPdfStatus(`파일 삭제 실패: ${error.message}`, true);
      });
    });

    actions.append(selectButton, deleteButton);
    row.append(name, actions);
    pdfList.append(row);
  }
}

function sanitizeFileName(fileName) {
  const cleaned = fileName.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return cleaned.replace(/-+/g, "-");
}

function setViewerPlaceholder(message) {
  pdfFrame.removeAttribute("src");
  pdfFrame.srcdoc = `
    <style>
      body{font-family:"Noto Sans KR",sans-serif;margin:0;display:grid;place-items:center;height:100%;background:#f5f5f4;color:#1f2937;}
      p{padding:18px;line-height:1.6;text-align:center;}
    </style>
    <p>${message}</p>
  `;
}

function showAuthGate() {
  authGate.classList.remove("is-hidden");
  adminApp.classList.add("is-hidden");
}

function showAdminApp() {
  authGate.classList.add("is-hidden");
  adminApp.classList.remove("is-hidden");
}

function disableLogin(message) {
  adminEmailInput.disabled = true;
  adminPasswordInput.disabled = true;
  loginButton.disabled = true;
  setAuthStatus(message, true);
  showAuthGate();
}

function setAuthStatus(message, isError = false) {
  authStatus.textContent = message;
  authStatus.classList.toggle("is-error", isError);
  authStatus.classList.toggle("is-ok", Boolean(message) && !isError);
}

function setPdfStatus(message, isError = false) {
  pdfStatus.textContent = message;
  pdfStatus.classList.toggle("is-error", isError);
  pdfStatus.classList.toggle("is-ok", Boolean(message) && !isError);
}
