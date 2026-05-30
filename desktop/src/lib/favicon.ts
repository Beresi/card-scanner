/**
 * Dynamic favicon — paints the white Card Broker glyph (public/app-icon.png)
 * in the current accent color on a dark rounded tile, and sets it as the
 * browser tab icon. Called from useApplyAppearance whenever the accent changes,
 * so the tab icon follows the in-app accent live.
 *
 * The source glyph is white line-art on transparent (a tintable mask); we
 * recolor it via canvas `source-in` compositing. A static fallback favicon
 * (public/favicon.png) covers first paint before this runs.
 */

const TILE = '#0a0f17'; // --rail / dark panel
let glyph: HTMLImageElement | null = null;

function loadGlyph(): Promise<HTMLImageElement> {
  if (glyph && glyph.complete && glyph.naturalWidth > 0) {
    return Promise.resolve(glyph);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      glyph = img;
      resolve(img);
    };
    img.onerror = reject;
    img.src = '/app-icon.png';
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Repaint the favicon in `accent` (any CSS color string). No-ops on failure. */
export async function paintFavicon(accent: string): Promise<void> {
  try {
    const img = await loadGlyph();
    const S = 64;
    const pad = Math.round(S * 0.13);

    // 1) tint the white glyph to the accent on its own (transparent) canvas
    const gc = document.createElement('canvas');
    gc.width = S;
    gc.height = S;
    const gx = gc.getContext('2d');
    if (!gx) return;
    gx.drawImage(img, pad, pad, S - 2 * pad, S - 2 * pad);
    gx.globalCompositeOperation = 'source-in';
    gx.fillStyle = accent;
    gx.fillRect(0, 0, S, S);

    // 2) compose the tinted glyph over a dark rounded tile
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = TILE;
    roundRect(ctx, 0, 0, S, S, Math.round(S * 0.19));
    ctx.fill();
    ctx.drawImage(gc, 0, 0);

    // 3) set as the tab favicon
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/png';
    link.href = c.toDataURL('image/png');
  } catch {
    // keep the static public/favicon.png
  }
}
