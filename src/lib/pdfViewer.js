import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const NAV_THROTTLE_MS = 180;
const RESIZE_DEBOUNCE_MS = 90;

export class PdfPageViewer {
  constructor({ container, pageInfoElement = null, emptyMessage = "선택된 PDF가 없습니다." }) {
    if (!container) {
      throw new Error("PDF viewer container가 없습니다.");
    }

    this.container = container;
    this.pageInfoElement = pageInfoElement;
    this.emptyMessage = emptyMessage;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pdf-canvas";
    this.message = document.createElement("p");
    this.message.className = "pdf-placeholder";
    this.message.textContent = emptyMessage;

    this.pdfDoc = null;
    this.pageNumber = 1;
    this.renderTask = null;
    this.loadTask = null;
    this.currentUrl = null;
    this.lastNavAt = 0;
    this.resizeTimer = null;
    this.resizeObserver = null;

    this.container.replaceChildren(this.canvas, this.message);
    if (!this.container.hasAttribute("tabindex")) {
      this.container.setAttribute("tabindex", "0");
    }

    this.bindEvents();
    this.updatePageInfo();
  }

  bindEvents() {
    this.container.addEventListener("click", (event) => {
      if (!this.pdfDoc) {
        return;
      }

      const rect = this.container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (x < rect.width / 2) {
        this.prevPage();
      } else {
        this.nextPage();
      }
    });

    this.container.addEventListener(
      "wheel",
      (event) => {
        if (!this.pdfDoc) {
          return;
        }

        event.preventDefault();
        if (Math.abs(event.deltaY) < 8) {
          return;
        }

        const now = Date.now();
        if (now - this.lastNavAt < NAV_THROTTLE_MS) {
          return;
        }
        this.lastNavAt = now;

        if (event.deltaY > 0) {
          this.nextPage();
        } else {
          this.prevPage();
        }
      },
      { passive: false },
    );

    document.addEventListener("keydown", (event) => {
      if (!this.pdfDoc || shouldSkipKeyboardNavigation(event.target)) {
        return;
      }

      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        this.nextPage();
      }

      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        this.prevPage();
      }
    });

    window.addEventListener("resize", () => {
      this.scheduleResizeRender();
    });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.scheduleResizeRender();
      });
      this.resizeObserver.observe(this.container);
    }
  }

  async load(url) {
    if (!url) {
      this.clear(this.emptyMessage);
      return;
    }

    if (this.currentUrl === url && this.pdfDoc) {
      return;
    }

    this.currentUrl = url;
    this.cancelCurrentRender();
    this.showMessage("PDF 불러오는 중...");
    await this.destroyLoadTask();

    const loadTask = getDocument({ url, withCredentials: false });
    this.loadTask = loadTask;

    try {
      const pdfDoc = await loadTask.promise;
      if (this.loadTask !== loadTask) {
        return;
      }

      this.pdfDoc = pdfDoc;
      this.pageNumber = 1;
      await this.renderCurrentPage();
    } catch (error) {
      if (!isCancelableError(error)) {
        console.error("PDF load failed:", error);
      }
      this.clear("PDF를 불러올 수 없습니다.");
    } finally {
      if (this.loadTask === loadTask) {
        this.loadTask = null;
      }
    }
  }

  clear(message = this.emptyMessage) {
    this.currentUrl = null;
    this.pdfDoc = null;
    this.pageNumber = 1;
    this.cancelCurrentRender();
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.showMessage(message);
    this.updatePageInfo();
  }

  async nextPage() {
    if (!this.pdfDoc || this.pageNumber >= this.pdfDoc.numPages) {
      return;
    }

    this.pageNumber += 1;
    await this.renderCurrentPage();
  }

  async prevPage() {
    if (!this.pdfDoc || this.pageNumber <= 1) {
      return;
    }

    this.pageNumber -= 1;
    await this.renderCurrentPage();
  }

  async renderCurrentPage() {
    if (!this.pdfDoc) {
      return;
    }

    this.cancelCurrentRender();
    const page = await this.pdfDoc.getPage(this.pageNumber);
    const fitScale = this.computeFitScale(page);
    const viewport = page.getViewport({ scale: fitScale });
    const outputScale = window.devicePixelRatio || 1;

    this.canvas.width = Math.floor(viewport.width * outputScale);
    this.canvas.height = Math.floor(viewport.height * outputScale);
    this.canvas.style.width = `${Math.floor(viewport.width)}px`;
    this.canvas.style.height = `${Math.floor(viewport.height)}px`;

    const context = this.canvas.getContext("2d", { alpha: false });
    const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform,
    });
    this.renderTask = renderTask;

    try {
      await renderTask.promise;
      if (this.renderTask !== renderTask) {
        return;
      }
      this.hideMessage();
      this.updatePageInfo();
    } catch (error) {
      if (!isCancelableError(error)) {
        console.error("PDF render failed:", error);
      }
    } finally {
      if (this.renderTask === renderTask) {
        this.renderTask = null;
      }
    }
  }

  computeFitScale(page) {
    const rect = this.container.getBoundingClientRect();
    const raw = page.getViewport({ scale: 1 });
    const maxWidth = Math.max(rect.width - 24, 260);
    const maxHeight = Math.max(rect.height - 24, 260);
    const scale = Math.min(maxWidth / raw.width, maxHeight / raw.height);
    return Math.max(0.1, scale || 1);
  }

  updatePageInfo() {
    if (!this.pageInfoElement) {
      return;
    }

    if (!this.pdfDoc) {
      this.pageInfoElement.textContent = "";
      this.pageInfoElement.classList.add("is-hidden");
      return;
    }

    this.pageInfoElement.classList.remove("is-hidden");
    this.pageInfoElement.textContent = `${this.pageNumber} / ${this.pdfDoc.numPages}`;
  }

  showMessage(text) {
    this.message.textContent = text;
    this.message.classList.remove("is-hidden");
  }

  hideMessage() {
    this.message.classList.add("is-hidden");
  }

  cancelCurrentRender() {
    if (!this.renderTask) {
      return;
    }

    this.renderTask.cancel();
    this.renderTask = null;
  }

  async destroyLoadTask() {
    if (!this.loadTask) {
      return;
    }

    const prevTask = this.loadTask;
    this.loadTask = null;
    try {
      await prevTask.destroy();
    } catch (error) {
      if (!isCancelableError(error)) {
        console.error("Previous PDF loadTask destroy failed:", error);
      }
    }
  }

  scheduleResizeRender() {
    if (!this.pdfDoc) {
      return;
    }

    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.renderCurrentPage().catch((error) => {
        console.error("PDF resize render failed:", error);
      });
    }, RESIZE_DEBOUNCE_MS);
  }
}

function shouldSkipKeyboardNavigation(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON";
}

function isCancelableError(error) {
  const name = error?.name || "";
  return name === "RenderingCancelledException" || name === "AbortException";
}
