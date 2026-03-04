import "./styles/base.css";
import "./styles/live.css";
import { getPageConfig } from "./lib/env";
import { getSupabase } from "./lib/supabase";
import { formatGuestTime } from "./lib/format";

const TABLE_MESSAGES = "guestbook_messages";
const TABLE_EVENT_SETTINGS = "event_settings";
const MESSAGE_LIMIT = 160;
const POLL_INTERVAL_MS = 4000;

const feed = document.querySelector("#feed");
const pdfFrame = document.querySelector("#pdfFrame");

const { eventId, pdfUrl, storageBucket } = getPageConfig();
let supabase = null;
const renderedMessageIds = new Set();
let activePdfPath = null;

setViewerPlaceholder("선택된 PDF가 없습니다.");

try {
  supabase = getSupabase();
  bootstrap().catch((error) => {
    const failItem = renderMessage({
      name: "SYSTEM",
      message: `초기 로딩 실패: ${error.message}`,
      created_at: new Date().toISOString(),
    });
    feed.append(failItem);
  });
} catch (error) {
  const failItem = renderMessage({
    name: "SYSTEM",
    message: error.message,
    created_at: new Date().toISOString(),
  });
  feed.append(failItem);
}

async function bootstrap() {
  await loadInitialMessages();
  subscribeRealtime();
  startPollingFallback();
  await safeLoadActivePdfSetting();
}

async function loadInitialMessages() {
  const { data, error } = await supabase
    .from(TABLE_MESSAGES)
    .select("id, name, message, created_at, event_id, is_hidden")
    .eq("event_id", eventId)
    .eq("is_hidden", false)
    .order("created_at", { ascending: false })
    .limit(MESSAGE_LIMIT);

  if (error) {
    throw error;
  }

  for (const row of (data || []).reverse()) {
    appendMessageIfNeeded(row, false);
  }

  trimFeed();
  scrollToLatest();
}

function subscribeRealtime() {
  supabase
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
        if (!row || row.event_id !== eventId || row.is_hidden) {
          return;
        }

        const inserted = appendMessageIfNeeded(row, true);
        if (!inserted) {
          return;
        }

        trimFeed();
        scrollToLatest();
      },
    )
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

        applySelectedPdf(row.active_pdf_path).catch((error) => {
          console.error("PDF realtime update failed:", error);
        });
      },
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") {
        console.warn("Realtime subscription error. Polling fallback remains active.");
      }
    });
}

function startPollingFallback() {
  setInterval(() => {
    pollNewMessages().catch((error) => {
      console.error("Message polling failed:", error);
    });

    safeLoadActivePdfSetting();
  }, POLL_INTERVAL_MS);
}

async function safeLoadActivePdfSetting() {
  try {
    await loadActivePdfSetting();
  } catch (error) {
    console.error("PDF setting load failed:", error);
  }
}

async function pollNewMessages() {
  const { data, error } = await supabase
    .from(TABLE_MESSAGES)
    .select("id, name, message, created_at, event_id, is_hidden")
    .eq("event_id", eventId)
    .eq("is_hidden", false)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    throw error;
  }

  let changed = false;
  for (const row of (data || []).reverse()) {
    if (appendMessageIfNeeded(row, true)) {
      changed = true;
    }
  }

  if (changed) {
    trimFeed();
    scrollToLatest();
  }
}

async function loadActivePdfSetting() {
  const { data, error } = await supabase
    .from(TABLE_EVENT_SETTINGS)
    .select("active_pdf_path")
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const path = data?.active_pdf_path || null;
  await applySelectedPdf(path);
}

async function applySelectedPdf(path) {
  if (activePdfPath === path) {
    return;
  }

  activePdfPath = path;

  if (!path) {
    if (pdfUrl) {
      pdfFrame.src = pdfUrl;
      return;
    }

    setViewerPlaceholder("선택된 PDF가 없습니다.");
    return;
  }

  const { data } = supabase.storage.from(storageBucket).getPublicUrl(path);
  if (data?.publicUrl) {
    pdfFrame.src = data.publicUrl;
    return;
  }

  const signed = await supabase.storage.from(storageBucket).createSignedUrl(path, 3600);
  if (signed.error) {
    setViewerPlaceholder("PDF URL을 불러올 수 없습니다.");
    return;
  }

  pdfFrame.src = signed.data.signedUrl;
}

function appendMessageIfNeeded(row, isNew) {
  const id = row.id;
  if (!id || renderedMessageIds.has(id)) {
    return false;
  }

  renderedMessageIds.add(id);
  feed.append(renderMessage(row, isNew));
  return true;
}

function renderMessage(row, isNew = false) {
  const item = document.createElement("article");
  item.className = "feed-item";
  if (row.id) {
    item.dataset.id = row.id;
  }
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
    const first = feed.firstElementChild;
    if (!first) {
      break;
    }

    const removedId = first.getAttribute("data-id");
    if (removedId) {
      renderedMessageIds.delete(removedId);
    }
    first.remove();
  }
}

function scrollToLatest() {
  feed.scrollTo({
    top: feed.scrollHeight,
    behavior: "smooth",
  });
}

function setViewerPlaceholder(message) {
  pdfFrame.removeAttribute("src");
  pdfFrame.srcdoc = `
    <style>
      body{font-family:"Noto Sans KR",sans-serif;margin:0;display:grid;place-items:center;height:100%;background:#f5f5f4;color:#1f2937;}
      p{padding:20px;line-height:1.6;text-align:center;}
    </style>
    <p>${message}</p>
  `;
}
