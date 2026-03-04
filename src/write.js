import "./styles/base.css";
import "./styles/write.css";
import { getPageConfig } from "./lib/env";
import { getSupabase } from "./lib/supabase";

const MAX_MESSAGE = 240;
const MIN_INTERVAL_MS = 10_000;
const TABLE_NAME = "guestbook_messages";

const form = document.querySelector("#guestbookForm");
const nameInput = document.querySelector("#name");
const messageInput = document.querySelector("#message");
const submitButton = document.querySelector("#submitButton");
const statusText = document.querySelector("#statusText");
const charCounter = document.querySelector("#charCounter");
const eventLabel = document.querySelector("#eventLabel");

const { eventId } = getPageConfig();
eventLabel.textContent = `행사 코드: ${eventId}`;

const lastSubmittedAtKey = `guestbook:lastSubmittedAt:${eventId}`;
let supabase = null;
try {
  supabase = getSupabase();
} catch (error) {
  nameInput.disabled = true;
  messageInput.disabled = true;
  submitButton.disabled = true;
  setStatus(error.message, true);
}

messageInput.addEventListener("input", () => {
  charCounter.textContent = `${messageInput.value.length} / ${MAX_MESSAGE}`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  if (!supabase) {
    setStatus("Supabase 연결 정보가 없어 등록할 수 없습니다.", true);
    return;
  }

  const name = nameInput.value.trim();
  const message = messageInput.value.trim();
  if (!name || !message) {
    setStatus("이름과 메시지를 모두 입력해 주세요.", true);
    return;
  }

  if (message.length > MAX_MESSAGE) {
    setStatus(`메시지는 ${MAX_MESSAGE}자 이하로 작성해 주세요.`, true);
    return;
  }

  const now = Date.now();
  const lastSubmittedAt = Number(localStorage.getItem(lastSubmittedAtKey) || 0);
  if (now - lastSubmittedAt < MIN_INTERVAL_MS) {
    const sec = Math.ceil((MIN_INTERVAL_MS - (now - lastSubmittedAt)) / 1000);
    setStatus(`${sec}초 뒤에 다시 등록할 수 있습니다.`, true);
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "등록 중...";

  const { error } = await supabase.from(TABLE_NAME).insert({
    event_id: eventId,
    name,
    message,
  });

  submitButton.disabled = false;
  submitButton.textContent = "등록";

  if (error) {
    setStatus(`등록 실패: ${error.message}`, true);
    return;
  }

  localStorage.setItem(lastSubmittedAtKey, String(now));
  form.reset();
  charCounter.textContent = `0 / ${MAX_MESSAGE}`;
  setStatus("등록되었습니다. 감사합니다.");
});

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("is-error", isError);
}

function clearStatus() {
  statusText.textContent = "";
  statusText.classList.remove("is-error");
}
