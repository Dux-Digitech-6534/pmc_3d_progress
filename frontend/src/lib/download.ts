interface AndroidDownloadsBridge {
  save(base64: string, fileName: string, mimeType: string): void;
}

/**
 * Saves a file made in the page. In the PMC 3D Android app (a WebView of this page) a download link does
 * nothing, so the file goes to the app's AndroidDownloads bridge (saved to Downloads/PMC 3D and opened).
 */
export function saveBlob(fileName: string, blob: Blob) {
  const android = (window as unknown as { AndroidDownloads?: AndroidDownloadsBridge }).AndroidDownloads;
  if (android) {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result);
      android.save(data.slice(data.indexOf(',') + 1), fileName, blob.type || 'application/octet-stream');
    };
    reader.readAsDataURL(blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(fileName: string, text: string, mime: string) {
  saveBlob(fileName, new Blob([text], { type: mime }));
}

/** RFC 4180 CSV with formula-injection protection for spreadsheet apps. */
export function toCsv(rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
