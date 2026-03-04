import "./styles/base.css";
import "./styles/live.css";
import { getPageConfig } from "./lib/env";
import { getSupabase } from "./lib/supabase";
import { formatGuestTime } from "./lib/format";
import { PdfPageViewer } from "./lib/pdfViewer";

const TABLE_MESSAGES = "guestbook_messages";
const TABLE_EVENT_SETTINGS = "event_settings";
const MESSAGE_LIMIT = 160;
const POLL_INTERVAL_MS = 4000;
const MESSAGE_MAX_CHARS = 240;
const MESSAGE_FONT_MAX_PX = 31;
const MESSAGE_FONT_MIN_PX = 15.5;
const SPLIT_DEFAULT = 38;
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;
const SPLIT_STEP = 2;
const FEED_MIN_PX = 260;
const PDF_MIN_PX = 320;

const feed = document.querySelector("#feed");
const projectorWrap = document.querySelector(".projector-wrap");
const splitter = document.querySelector("#splitter");
const pdfViewerElement = document.querySelector("#pdfViewer");
const pdfPageInfo = document.querySelector("#pdfPageInfo");

const { eventId, pdfUrl, storageBucket } = getPageConfig();
const splitStorageKey = `live:split:${eventId}`;
let supabase = null;
const renderedMessageIds = new Set();
let activePdfPath = null;
let splitRenderScheduled = false;
let nextBubbleFromLeft = true;
const pdfViewer = new PdfPageViewer({
  container: pdfViewerElement,
  pageInfoElement: pdfPageInfo,
  emptyMessage: "선택된 PDF가 없습니다.",
});
setupResizableSplit();

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
        scrollToLatest("smooth");
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
    scrollToLatest("smooth");
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
      await pdfViewer.load(pdfUrl);
      return;
    }

    pdfViewer.clear("선택된 PDF가 없습니다.");
    return;
  }

  const { data } = supabase.storage.from(storageBucket).getPublicUrl(path);
  if (data?.publicUrl) {
    await pdfViewer.load(data.publicUrl);
    return;
  }

  const signed = await supabase.storage.from(storageBucket).createSignedUrl(path, 3600);
  if (signed.error || !signed.data?.signedUrl) {
    pdfViewer.clear("PDF URL을 불러올 수 없습니다.");
    return;
  }

  await pdfViewer.load(signed.data.signedUrl);
}

function appendMessageIfNeeded(row, isNew) {
  const id = row.id;
  if (!id || renderedMessageIds.has(id)) {
    return false;
  }

  renderedMessageIds.add(id);
  const isLeft = nextBubbleFromLeft;
  nextBubbleFromLeft = !nextBubbleFromLeft;
  const item = renderMessage(row, isNew);
  item.classList.add(isLeft ? "is-left" : "is-right");
  if (isNew) {
    item.classList.add(isLeft ? "is-new-left" : "is-new-right");
  }
  feed.append(item);
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

  const message = document.createElement("p");
  message.className = "feed-message";
  const text = row.message || "";
  item.style.setProperty("--msg-size", `${computeMessageFontSize(text)}px`);
  message.textContent = text;

  const meta = document.createElement("div");
  meta.className = "feed-meta";

  const name = document.createElement("span");
  name.className = "feed-name";
  name.textContent = row.name || "익명";

  const dot = document.createElement("span");
  dot.className = "feed-dot";
  dot.textContent = "·";

  const time = document.createElement("span");
  time.className = "feed-time";
  time.textContent = formatGuestTime(row.created_at);

  meta.append(name, dot, time);
  item.append(message, meta);
  return item;
}

function computeMessageFontSize(text) {
  const len = Math.max(0, (text || "").trim().length);
  if (len === 0) {
    return MESSAGE_FONT_MAX_PX;
  }

  const normalized = Math.min(len, MESSAGE_MAX_CHARS) / MESSAGE_MAX_CHARS;
  // Continuous easing curve for gradual size reduction across the full length range.
  const eased = 1 - Math.pow(1 - normalized, 1.35);
  const size = MESSAGE_FONT_MAX_PX - (MESSAGE_FONT_MAX_PX - MESSAGE_FONT_MIN_PX) * eased;
  return Number(size.toFixed(2));
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

function setupResizableSplit() {
  if (!projectorWrap || !splitter) {
    return;
  }

  const saved = Number.parseFloat(localStorage.getItem(splitStorageKey) || "");
  const initial = Number.isFinite(saved) ? saved : SPLIT_DEFAULT;
  applySplitPercent(initial, false);

  splitter.addEventListener("pointerdown", onSplitPointerDown);
  splitter.addEventListener("keydown", onSplitKeydown);

  window.addEventListener("resize", () => {
    if (isStackedLayout()) {
      return;
    }

    const current = getCurrentSplitPercent();
    applySplitPercent(current ?? SPLIT_DEFAULT, false);
  });
}

function onSplitPointerDown(event) {
  if (!splitter || isStackedLayout()) {
    return;
  }

  event.preventDefault();
  splitter.focus();
  splitter.classList.add("is-dragging");
  document.body.classList.add("is-resizing");
  splitter.setPointerCapture(event.pointerId);
  updateSplitFromClientX(event.clientX, false);

  const handleMove = (moveEvent) => {
    updateSplitFromClientX(moveEvent.clientX, false);
  };

  const handleStop = (stopEvent) => {
    splitter.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing");
    if (splitter.hasPointerCapture(stopEvent.pointerId)) {
      splitter.releasePointerCapture(stopEvent.pointerId);
    }

    splitter.removeEventListener("pointermove", handleMove);
    splitter.removeEventListener("pointerup", handleStop);
    splitter.removeEventListener("pointercancel", handleStop);
    const current = getCurrentSplitPercent();
    if (current !== null) {
      localStorage.setItem(splitStorageKey, current.toFixed(2));
    }
    schedulePdfRerender();
  };

  splitter.addEventListener("pointermove", handleMove);
  splitter.addEventListener("pointerup", handleStop);
  splitter.addEventListener("pointercancel", handleStop);
}

function onSplitKeydown(event) {
  if (isStackedLayout()) {
    return;
  }

  const current = getCurrentSplitPercent() ?? SPLIT_DEFAULT;
  let next = current;

  if (event.key === "ArrowLeft") {
    next = current - SPLIT_STEP;
  }
  if (event.key === "ArrowRight") {
    next = current + SPLIT_STEP;
  }
  if (event.key === "Home") {
    next = SPLIT_MIN;
  }
  if (event.key === "End") {
    next = SPLIT_MAX;
  }

  if (next === current) {
    return;
  }

  event.preventDefault();
  applySplitPercent(next, true);
}

function updateSplitFromClientX(clientX, persist) {
  if (!projectorWrap || !splitter) {
    return;
  }

  const rect = projectorWrap.getBoundingClientRect();
  const splitterWidth = splitter.getBoundingClientRect().width || 14;
  const gap = getWrapColumnGap();
  const available = rect.width - splitterWidth - gap * 2;

  if (available <= 0) {
    return;
  }

  const feedPx = clientX - rect.left - gap - splitterWidth / 2;
  const nextPercent = (feedPx / available) * 100;
  applySplitPercent(nextPercent, persist);
}

function applySplitPercent(percent, persist) {
  if (!projectorWrap || !splitter) {
    return;
  }

  const clamped = clampSplitPercent(percent);
  projectorWrap.style.setProperty("--feed-pane", `${clamped}%`);
  splitter.setAttribute("aria-valuenow", String(Math.round(clamped)));

  if (persist) {
    localStorage.setItem(splitStorageKey, clamped.toFixed(2));
  }
}

function clampSplitPercent(percent) {
  const bounded = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, percent));
  if (!projectorWrap || !splitter || isStackedLayout()) {
    return bounded;
  }

  const rect = projectorWrap.getBoundingClientRect();
  const splitterWidth = splitter.getBoundingClientRect().width || 14;
  const gap = getWrapColumnGap();
  const available = rect.width - splitterWidth - gap * 2;
  if (available <= 0) {
    return bounded;
  }

  const dynamicMin = Math.max(SPLIT_MIN, (FEED_MIN_PX / available) * 100);
  const dynamicMax = Math.min(SPLIT_MAX, ((available - PDF_MIN_PX) / available) * 100);
  if (dynamicMin > dynamicMax) {
    return bounded;
  }

  return Math.min(dynamicMax, Math.max(dynamicMin, bounded));
}

function getCurrentSplitPercent() {
  if (!projectorWrap) {
    return null;
  }

  const value = getComputedStyle(projectorWrap).getPropertyValue("--feed-pane");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getWrapColumnGap() {
  if (!projectorWrap) {
    return 0;
  }

  const style = getComputedStyle(projectorWrap);
  const gap = Number.parseFloat(style.columnGap || style.gap || "0");
  return Number.isFinite(gap) ? gap : 0;
}

function isStackedLayout() {
  return window.matchMedia("(max-width: 1120px)").matches;
}

function schedulePdfRerender() {
  if (splitRenderScheduled) {
    return;
  }

  splitRenderScheduled = true;
  requestAnimationFrame(() => {
    splitRenderScheduled = false;
    pdfViewer.renderCurrentPage().catch((error) => {
      console.error("PDF rerender after split failed:", error);
    });
  });
}

function scrollToLatest(behavior = "auto") {
  requestAnimationFrame(() => {
    feed.scrollTo({
      top: feed.scrollHeight,
      behavior,
    });
  });
}
