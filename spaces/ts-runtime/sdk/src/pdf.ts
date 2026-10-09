// Browser-side PDF viewer for generated Muse web artifacts.
//
// Blob downloads deliberately carry CSP `sandbox` so uploaded HTML and SVG
// cannot execute with the artifact's authority. Navigating an iframe directly
// to a PDF blob also applies that sandbox to Chrome's built-in PDF viewer and
// produces a blocked-page error. This component fetches the inert bytes and
// renders them to canvas with PDF.js instead, keeping the response sandbox in
// place.

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import {
  getDocument,
  version as pdfjsVersion,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import "pdfjs-dist/build/pdf.worker.mjs";

const pdfAssetRoot = `./assets/pdfjs/${pdfjsVersion}/`;

export interface PdfViewerLabels {
  /** Status shown while the PDF bytes and document are loading. */
  loading?: string;
  /** Error shown when the PDF cannot be fetched or opened. */
  loadError?: string;
  /** Error shown when the current page cannot be rendered. */
  pageError?: string;
  /** Label for the previous-page button. */
  previousPage?: string;
  /** Label for the next-page button. */
  nextPage?: string;
  /** Visible page-count text. */
  pageIndicator?: (pageNumber: number, totalPages: number) => string;
  /** Complete accessible name for the page-navigation controls. */
  navigationAriaLabel?: string;
  /** Complete accessible name for the rendered page. */
  pageAriaLabel?: (pageNumber: number, totalPages: number) => string;
}

export interface PdfViewerProps {
  /** A fetchable PDF URL, including a URL returned by `ctx.blobs.getUrl()`. */
  src: string;
  /** Accessible name used for the viewer and English default page labels. */
  ariaLabel?: string;
  /** User-visible and accessible labels. Omitted fields use English defaults. */
  labels?: PdfViewerLabels;
  /** Page shown after loading. Values outside the document are clamped. */
  initialPage?: number;
  className?: string;
  style?: CSSProperties;
}

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  width: "100%",
};

const toolbarStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "0.5rem",
  justifyContent: "center",
};

const pageFrameStyle: CSSProperties = {
  alignItems: "flex-start",
  display: "flex",
  justifyContent: "center",
  minHeight: "8rem",
  overflow: "auto",
  width: "100%",
};

const statusStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "center",
  minHeight: "8rem",
  textAlign: "center",
};

function clampPage(page: number, total: number): number {
  return Math.min(total, Math.max(1, Math.trunc(page) || 1));
}

/**
 * Render a PDF inside a generated Muse web artifact without navigating a
 * nested document to the raw blob URL.
 *
 * The source is fetched as bytes and handed to PDF.js. PDF evaluation is
 * disabled. PDF.js's worker logic is bundled into the SDK so generated clients
 * can use its main-thread fallback in both standard and confidential builds.
 */
export function PdfViewer({
  src,
  ariaLabel = "PDF document",
  labels,
  initialPage = 1,
  className,
  style,
}: PdfViewerProps): ReactElement {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [frameWidth, setFrameWidth] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;

    const measure = () => setFrameWidth(Math.max(1, Math.floor(frame.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let active = true;

    setDocument(null);
    setLoadError(false);
    setPageError(false);
    setRendering(false);

    void (async () => {
      const response = await fetch(src, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`PDF request failed with HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      loadingTask = getDocument({
        data: bytes,
        cMapPacked: true,
        cMapUrl: `${pdfAssetRoot}cmaps/`,
        enableXfa: false,
        isEvalSupported: false,
        standardFontDataUrl: `${pdfAssetRoot}standard_fonts/`,
        useWorkerFetch: true,
        wasmUrl: `${pdfAssetRoot}wasm/`,
      });
      const loaded = await loadingTask.promise;
      if (!active) {
        await loaded.destroy();
        return;
      }
      setPageNumber(clampPage(initialPage, loaded.numPages));
      setDocument(loaded);
    })().catch((error: unknown) => {
      if (active && !(error instanceof DOMException && error.name === "AbortError")) {
        setLoadError(true);
      }
    });

    return () => {
      active = false;
      controller.abort();
      if (loadingTask !== null) {
        void loadingTask.destroy();
      }
    };
  }, [initialPage, src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (document === null || canvas === null || frameWidth <= 0) return;

    let active = true;
    let renderTask: RenderTask | null = null;
    setPageError(false);
    setRendering(true);

    void (async () => {
      const page = await document.getPage(pageNumber);
      if (!active) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const cssScale = frameWidth / baseViewport.width;
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: cssScale * outputScale });

      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      canvas.style.width = `${Math.max(1, Math.floor(baseViewport.width * cssScale))}px`;
      canvas.style.height = `${Math.max(1, Math.floor(baseViewport.height * cssScale))}px`;

      renderTask = page.render({ canvas, viewport });
      await renderTask.promise;
      if (active) setRendering(false);
    })().catch((error: unknown) => {
      if (active && !(error instanceof Error && error.name === "RenderingCancelledException")) {
        setPageError(true);
        setRendering(false);
      }
    });

    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [document, frameWidth, pageNumber]);

  const previousPage = useCallback(() => {
    setPageNumber((page) => Math.max(1, page - 1));
  }, []);
  const nextPage = useCallback(() => {
    setPageNumber((page) =>
      document === null ? page : Math.min(document.numPages, page + 1),
    );
  }, [document]);

  const status = loadError
    ? createElement(
        "div",
        { role: "alert", style: statusStyle },
        labels?.loadError ?? "This PDF couldn’t be loaded.",
      )
    : document === null
      ? createElement(
          "div",
          { role: "status", style: statusStyle },
          labels?.loading ?? "Loading PDF…",
        )
      : pageError
        ? createElement(
            "div",
            { role: "alert", style: statusStyle },
            labels?.pageError ?? "This PDF page couldn’t be rendered.",
          )
        : null;

  return createElement(
    "section",
    {
      "aria-label": ariaLabel,
      className,
      style: { ...rootStyle, ...style },
    },
    document !== null && document.numPages > 1
      ? createElement(
          "nav",
          {
            "aria-label": labels?.navigationAriaLabel ?? `${ariaLabel} pages`,
            style: toolbarStyle,
          },
          createElement(
            "button",
            {
              type: "button",
              disabled: pageNumber <= 1,
              onClick: previousPage,
            },
            labels?.previousPage ?? "Previous",
          ),
          createElement(
            "span",
            null,
            labels?.pageIndicator?.(pageNumber, document.numPages) ??
              `Page ${pageNumber} of ${document.numPages}`,
          ),
          createElement(
            "button",
            {
              type: "button",
              disabled: pageNumber >= document.numPages,
              onClick: nextPage,
            },
            labels?.nextPage ?? "Next",
          ),
        )
      : null,
    createElement(
      "div",
      { ref: frameRef, style: pageFrameStyle },
      status,
      createElement("canvas", {
        ref: canvasRef,
        role: "img",
        "aria-label":
          labels?.pageAriaLabel?.(pageNumber, document?.numPages ?? 1) ??
          `${ariaLabel}, page ${pageNumber}`,
        "aria-busy": rendering,
        hidden: document === null || loadError || pageError,
        style: { display: "block", maxWidth: "100%" },
      }),
    ),
  );
}
