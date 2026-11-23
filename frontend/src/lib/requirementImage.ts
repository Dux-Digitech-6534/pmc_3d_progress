// The material requirement as a picture, to send on WhatsApp (meeting 21-11: "a good formatted image,
// not text"). Drawn on a canvas: a navy title band, the project details, a table of the materials and a
// footer. Width 1080 px (sharp on phones), the height grows with the number of lines.

export interface RequirementImageLine {
  material: string;
  spec: string;
  qty: string;
  unit: string;
}

export interface RequirementImageData {
  project: string;
  date: string;
  location: string;
  elements: string;
  requestNo?: string;
  lines: RequirementImageLine[];
  note?: string;
  by?: string;
}

const W = 1080;
const PAD = 56;
const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Splits text into lines that fit the width. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > width && line) {
      out.push(line);
      line = w;
    } else line = t;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawRequirementImage(d: RequirementImageData): Promise<Blob> {
  const measure = document.createElement('canvas').getContext('2d')!;
  // details block: label / value rows, values wrapped
  const details: [string, string][] = [
    ['Project', d.project],
    ['Location', d.location],
    ['Elements', d.elements],
    ...(d.requestNo ? ([['Request No.', d.requestNo]] as [string, string][]) : []),
  ];
  measure.font = `500 30px ${FONT}`;
  const detailLines = details.map(([k, v]) => [k, wrap(measure, v, W - PAD * 2 - 210)] as const);
  const detailH = detailLines.reduce((h, [, ls]) => h + ls.length * 40 + 14, 0);
  const ROW = 78;
  const tableH = 64 + d.lines.length * ROW;
  measure.font = `400 24px ${FONT}`;
  const noteLines = d.note ? wrap(measure, d.note, W - PAD * 2) : [];
  const H = 190 + 36 + detailH + 30 + tableH + 30 + noteLines.length * 32 + 120;

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f4f7fb';
  ctx.fillRect(0, 0, W, H);

  // title band
  const g = ctx.createLinearGradient(0, 0, W, 190);
  g.addColorStop(0, '#0f2747');
  g.addColorStop(1, '#14507a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, 190);
  ctx.fillStyle = '#2dd4bf';
  ctx.fillRect(0, 186, W, 4);
  ctx.fillStyle = '#99f6e4';
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText('PMC 3D PROGRESS', PAD, 66);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 50px ${FONT}`;
  ctx.fillText('Material Requirement', PAD, 128);
  ctx.font = `500 28px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(d.date, W - PAD, 128);
  ctx.textAlign = 'left';

  // details card
  let y = 190 + 36;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, PAD - 20, y - 8, W - (PAD - 20) * 2, detailH + 16, 18);
  ctx.fill();
  y += 34;
  for (const [k, ls] of detailLines) {
    ctx.fillStyle = '#64748b';
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText(k, PAD, y);
    ctx.fillStyle = '#0f172a';
    ctx.font = `500 30px ${FONT}`;
    ls.forEach((l, i) => ctx.fillText(l, PAD + 210, y + i * 40));
    y += ls.length * 40 + 14;
  }
  y += 30 - 34 + 8;

  // materials table
  const x0 = PAD - 20;
  const tw = W - x0 * 2;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x0, y, tw, tableH, 18);
  ctx.fill();
  ctx.save();
  roundRect(ctx, x0, y, tw, tableH, 18);
  ctx.clip();
  ctx.fillStyle = '#0f2747';
  ctx.fillRect(x0, y, tw, 64);
  ctx.restore();
  const cQty = W - PAD - 150;
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText('MATERIAL', PAD, y + 42);
  ctx.textAlign = 'right';
  ctx.fillText('QUANTITY', W - PAD, y + 42);
  ctx.textAlign = 'left';
  let ry = y + 64;
  d.lines.forEach((l, i) => {
    if (i % 2) {
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(x0, ry, tw, ROW);
    }
    ctx.fillStyle = '#0f172a';
    ctx.font = `700 32px ${FONT}`;
    ctx.fillText(l.material, PAD, ry + (l.spec ? 36 : 49));
    if (l.spec) {
      ctx.fillStyle = '#64748b';
      ctx.font = `500 23px ${FONT}`;
      ctx.fillText(l.spec, PAD, ry + 64);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = '#0f766e';
    ctx.font = `800 36px ${FONT}`;
    ctx.fillText(l.qty, cQty + 70, ry + 50);
    ctx.fillStyle = '#334155';
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText(l.unit, W - PAD, ry + 50);
    ctx.textAlign = 'left';
    ry += ROW;
  });
  y += tableH + 30;

  if (noteLines.length) {
    ctx.fillStyle = '#64748b';
    ctx.font = `400 24px ${FONT}`;
    noteLines.forEach((l, i) => ctx.fillText(l, PAD, y + i * 32));
    y += noteLines.length * 32;
  }

  // footer
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(0, H - 70, W, 70);
  ctx.fillStyle = '#475569';
  ctx.font = `500 22px ${FONT}`;
  ctx.fillText(d.by ? `Sent by ${d.by}` : 'Sent from PMC 3D Progress', PAD, H - 28);
  ctx.textAlign = 'right';
  ctx.fillText('Dux Digitech', W - PAD, H - 28);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the image.'))), 'image/png'));
}
