import "./styles/base.css";
import "./styles/live.css";
import { getPageConfig } from "./lib/env";
import { getSupabase } from "./lib/supabase";
import { formatClock, formatGuestTime } from "./lib/format";

const TABLE_MESSAGES = "guestbook_messages";
const TABLE_EVENT_SETTINGS = "event_settings";
const MESSAGE_LIMIT = 120;

const authGate = document.querySelector("#authGate");
const liveApp = document.querySelector("#liveApp");
const loginForm = document.querySelector("#loginForm");
const loginButton = document.querySelector("#loginButton");
const authStatus = document.querySelector("#authStatus");
const adminEmailInput = document.querySelector("#adminEmail");
const adminPasswordInput = document.querySelector("#adminPassword");
const logoutButton = document.querySelector("#logoutButton");

const eventName = document.querySelector("#eventName");
const clock = document.querySelector("#clock");
const messageCount = document.querySelector("#messageCount");
const feed = document.querySelector("#feed");
const pdfFrame = document.querySelector("#pdfFrame");
const uploadForm = document.querySelector("#uploadForm");
const uploadButton = document.querySelector("#uploadButton");
const pdfInput = document.querySelector("#pdfInput");
const refreshFilesButton = document.querySelector("#refreshFilesButton");
const clearSelectionButton = document.querySelector("#clearSelectionButton");
const pdfStatus = document.querySelector("#pdfStatus");
const pdfList = document.querySelector("#pdfList");

const { eventId, pdfUrl, storageBucket, projectorMode } = getPageConfig();
const configuredAdminEmail = (import.meta.env.VITE_ADMIN_EMAIL || "").trim();
let supabase = null;
const channels = [];
let activePdfPath = null;
let hasEventSetting = false;
let currentFiles = [];

eventName.textContent = eventId;
if (configuredAdminEmail) {
  adminEmailInput.value = configuredAdminEmail;
}
if (projectorMode) {
  document.body.classList.add("projector-mode");
}

clock.textContent = formatClock();
setInterval(() => {
  clock.textContent = formatClock();
}, 1000);

setViewerPlaceholder("선택된 PDF가 없습니다.");
attachUIEvents();

try {
  supabase = getSupabase();
} catch (error) {
  disableLogin(error.message);
}

if (supabase) {
  initialize().catch((error) => {
    setAuthStatus(`초기화 실패: ${error.message}`, true);
    showAuthGate();
  });
}

async function initialize() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw error;
  }

  const session = data.session;
  if (!session) {
    showAuthGate();
    return;
  }

  try {
    await enterLiveMode();
  } catch (error) {
    await supabase.auth.signOut();
    showAuthGate();
    setAuthStatus(error.message, true);
  }
}

function attachUIEvents() {
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
      setPdfStatus(`뷰어 비우기 실패: ${error.message}`, true);
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

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

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
    await enterLiveMode();
  } catch (error) {
    await supabase.auth.signOut();
    showAuthGate();
    setAuthStatus(error.message, true);
  }
}

async function handleLogout() {
  await supabase.auth.signOut();
  cleanupChannels();
  feed.innerHTML = "";
  messageCount.textContent = "0";
  showAuthGate();
  setAuthStatus("로그아웃되었습니다.");
  setPdfStatus("");
}

async function enterLiveMode() {
  setAuthStatus("권한 확인 중...");
  const isAdmin = await checkAdmin();
  if (!isAdmin) {
    await supabase.auth.signOut();
    throw new Error("관리자 권한이 없는 계정입니다.");
  }

  showLiveApp();
  setAuthStatus("");
  await bootstrapLive();
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

async function bootstrapLive() {
  cleanupChannels();
  feed.innerHTML = "";
  messageCount.textContent = "0";

  await loadMessages();
  await refreshPdfFiles();
  await loadActivePdfSetting();
  subscribeRealtime();
}

async function loadMessages() {
  const { data, error } = await supabase
    .from(TABLE_MESSAGES)
    .select("id, name, message, created_at, event_id, is_hidden")
    .eq("event_id", eventId)
    .eq("is_hidden", false)
    .order("created_at", { ascending: true })
    .limit(MESSAGE_LIMIT);

  if (error) {
    throw error;
  }

  for (const row of data) {
    feed.append(renderMessage(row));
  }

  messageCount.textContent = String(data.length);
  scrollToLatest();
}

function subscribeRealtime() {
  const messageChannel = supabase
    .channel(`live-feed-${eventId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: TABLE_MESSAGES,
      },
      (payload) => {
        const row = payload.new;
        if (row.event_id !== eventId || row.is_hidden) {
          return;
        }

        feed.append(renderMessage(row, true));
        trimFeed();
        messageCount.textContent = String(feed.children.length);
        scrollToLatest();
      },
    )
    .subscribe();

  channels.push(messageChannel);

  const settingsChannel = supabase
    .channel(`event-settings-${eventId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: TABLE_EVENT_SETTINGS,
      },
      (payload) => {
        const row = payload.new;
        if (!row || row.event_id !== eventId) {
          return;
        }

        hasEventSetting = true;
        applySelectedPdf(row.active_pdf_path, { allowFallback: false }).catch((error) => {
          setPdfStatus(`PDF 반영 실패: ${error.message}`, true);
        });
        renderPdfList();
      },
    )
    .subscribe();

  channels.push(settingsChannel);
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
    hasEventSetting = false;
    await applySelectedPdf(null, { allowFallback: true });
    return;
  }

  hasEventSetting = true;
  await applySelectedPdf(data.active_pdf_path, { allowFallback: false });
}

async function refreshPdfFiles() {
  const { data, error } = await supabase.storage
    .from(storageBucket)
    .list(eventId, { limit: 100, sortBy: { column: "name", order: "asc" } });

  if (error) {
    throw error;
  }

  currentFiles = (data || [])
    .filter((file) => typeof file.name === "string" && file.name.toLowerCase().endsWith(".pdf"))
    .map((file) => ({
      name: file.name,
      fullPath: `${eventId}/${file.name}`,
      updatedAt: file.updated_at || "",
    }));

  renderPdfList();
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
    selectButton.textContent = file.fullPath === activePdfPath ? "표시 중" : "보기";
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

  const { error } = await supabase.storage
    .from(storageBucket)
    .upload(objectPath, file, { contentType: "application/pdf", upsert: false });

  uploadButton.disabled = false;
  uploadButton.textContent = "PDF 업로드";

  if (error) {
    setPdfStatus(`업로드 실패: ${error.message}`, true);
    return;
  }

  await updateActivePdfSetting(objectPath);
  await refreshPdfFiles();
  await applySelectedPdf(objectPath, { allowFallback: false });
  setPdfStatus("업로드 및 뷰어 반영이 완료되었습니다.");
  uploadForm.reset();
}

async function selectPdf(path) {
  await updateActivePdfSetting(path);
  await applySelectedPdf(path, { allowFallback: false });
  renderPdfList();
  setPdfStatus("선택한 PDF를 뷰어에 반영했습니다.");
}

async function deletePdf(path) {
  const { error } = await supabase.storage.from(storageBucket).remove([path]);
  if (error) {
    throw error;
  }

  if (path === activePdfPath) {
    await updateActivePdfSetting(null);
    await applySelectedPdf(null, { allowFallback: false });
  }

  await refreshPdfFiles();
  setPdfStatus("선택한 PDF를 삭제했습니다.");
}

async function clearActivePdf() {
  await updateActivePdfSetting(null);
  await applySelectedPdf(null, { allowFallback: false });
  setPdfStatus("뷰어에서 PDF 선택을 해제했습니다.");
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

  hasEventSetting = true;
}

async function applySelectedPdf(path, options = { allowFallback: false }) {
  activePdfPath = path || null;
  renderPdfList();

  if (!path) {
    if (options.allowFallback && !hasEventSetting && pdfUrl) {
      pdfFrame.src = pdfUrl;
      return;
    }

    setViewerPlaceholder("선택된 PDF가 없습니다.");
    return;
  }

  const { data, error } = await supabase.storage
    .from(storageBucket)
    .createSignedUrl(path, 24 * 60 * 60);

  if (error) {
    throw error;
  }

  pdfFrame.src = data.signedUrl;
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
    p{padding:24px;line-height:1.6;text-align:center;}
  </style>
  <p>${message}</p>
  `;
}

function showAuthGate() {
  authGate.classList.remove("is-hidden");
  liveApp.classList.add("is-hidden");
}

function showLiveApp() {
  authGate.classList.add("is-hidden");
  liveApp.classList.remove("is-hidden");
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

function cleanupChannels() {
  while (channels.length > 0) {
    const channel = channels.pop();
    supabase.removeChannel(channel);
  }
}

window.addEventListener("beforeunload", () => {
  if (supabase) {
    cleanupChannels();
  }
});

function renderMessage(row, isNew = false) {
  const item = document.createElement("article");
  item.className = "feed-item";
  if (isNew) {
    item.classList.add("is-new");
  }

  const top = document.createElement("div");
  top.className = "feed-item-top";

  const name = document.createElement("p");
  name.className = "feed-name";
  name.textContent = row.name || "익명";

  const time = document.createElement("p");
  time.className = "feed-time";
  time.textContent = formatGuestTime(row.created_at);

  top.append(name, time);

  const message = document.createElement("p");
  message.className = "feed-message";
  message.textContent = row.message || "";

  item.append(top, message);
  return item;
}

function trimFeed() {
  while (feed.children.length > MESSAGE_LIMIT) {
    feed.firstElementChild?.remove();
  }
}

function scrollToLatest() {
  feed.scrollTo({
    top: feed.scrollHeight,
    behavior: "smooth",
  });
}
