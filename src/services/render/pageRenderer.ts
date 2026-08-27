// §4.1 — screen-only, made structural.
//
// The obvious build is to stream the PDF into a client-side viewer with the
// download button hidden. That is not screen-only; it is a hidden button. The
// complete file lands in the browser and anyone who opens the network panel
// has it. So the server renders one page at a time to a raster, stamps the
// watermark into the pixels, and sends that. The PDF never leaves this process.
import { readFile } from 'node:fs/promises';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import * as mupdf from 'mupdf';
import { config } from '../../config.ts';

let fontFamily: string | null = null;

/**
 * A missing font fails SILENTLY: fillText draws nothing and pages ship
 * unwatermarked, which is the one failure mode that must never reach
 * production quietly. Fail at startup instead.
 */
export function initRenderer(): void {
  if (fontFamily) return;
  const ok = GlobalFonts.registerFromPath(config.render.fontPath, 'SRWatermark');
  if (!ok) {
    throw new Error(
      `Watermark font not found at ${config.render.fontPath}. Pages would render ` +
      `without a watermark, so the renderer refuses to start. Install a TTF ` +
      `(apk add font-dejavu) or set WATERMARK_FONT.`,
    );
  }
  fontFamily = 'SRWatermark';
}

export interface WatermarkFields {
  readerName: string;
  staffCode: string;
  reference: string;
  ip: string;
}

export interface RenderRequest {
  filePath: string;
  /** 1-indexed, as a person counts pages. */
  page: number;
  watermark: WatermarkFields;
  dpi?: number;
  quality?: number;
}

export interface RenderedPage {
  body: Buffer;
  contentType: 'image/webp';
  width: number;
  height: number;
  pageCount: number;
}

export class PageOutOfRangeError extends Error {}

function stamp(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  w: number, h: number, f: WatermarkFields,
): void {
  const text = `${f.readerName} · ${f.staffCode} · ${f.reference} · ${new Date().toISOString()} · ${f.ip}`;
  const size = Math.max(14, Math.round(w / 62));
  ctx.save();
  ctx.globalAlpha = 0.17;
  ctx.fillStyle = '#8a1c1c';
  ctx.font = `${size}px ${fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 6);
  const span = Math.hypot(w, h);
  const step = ctx.measureText(text).width + size * 4;
  for (let y = -span; y < span; y += size * 6.5) {
    for (let x = -span; x < span; x += step) ctx.fillText(text, x, y);
  }
  ctx.restore();
}

/** Renders exactly one page. Never returns, caches, or writes the PDF itself. */
export async function renderPage(req: RenderRequest): Promise<RenderedPage> {
  initRenderer();
  const dpi = req.dpi ?? config.render.dpi;

  const bytes = await readFile(req.filePath);
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const pageCount = doc.countPages();
  if (req.page < 1 || req.page > pageCount) {
    throw new PageOutOfRangeError(`Page ${req.page} of ${pageCount}`);
  }

  const scale = dpi / 72;
  const pix = doc
    .loadPage(req.page - 1)
    .toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);

  const img = await loadImage(Buffer.from(pix.asPNG()));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  stamp(ctx, img.width, img.height, req.watermark);

  return {
    body: await canvas.encode('webp', req.quality ?? config.render.quality),
    contentType: 'image/webp',
    width: img.width,
    height: img.height,
    pageCount,
  };
}

export async function countPages(filePath: string): Promise<number> {
  const doc = mupdf.Document.openDocument(await readFile(filePath), 'application/pdf');
  return doc.countPages();
}
