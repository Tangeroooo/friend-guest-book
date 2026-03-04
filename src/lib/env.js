const REQUIRED_ENV_KEYS = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];

export function getPageConfig() {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  return {
    eventId: params.get("event") || import.meta.env.VITE_DEFAULT_EVENT_ID || "general",
    pdfUrl: params.get("pdf") || import.meta.env.VITE_DEFAULT_PDF_URL || "",
    storageBucket: import.meta.env.VITE_PDF_STORAGE_BUCKET || "event-pdfs",
  };
}

export function assertSupabaseEnv() {
  const missingKeys = REQUIRED_ENV_KEYS.filter((key) => !import.meta.env[key]);
  if (missingKeys.length > 0) {
    throw new Error(
      `환경변수 누락: ${missingKeys.join(", ")}. .env 파일을 확인해 주세요.`,
    );
  }
}
