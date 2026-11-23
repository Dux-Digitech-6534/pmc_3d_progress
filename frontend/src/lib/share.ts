import { saveBlob } from './download';

interface AndroidShareBridge {
  share(base64: string, fileName: string, mimeType: string, text: string): void;
}

export const WHATSAPP_WEB = 'https://web.whatsapp.com/';

/**
 * How "Share on WhatsApp" works here:
 * - 'android-app': PMC 3D Android app v1.3+ — its AndroidShare bridge opens the WhatsApp app with the picture;
 * - 'old-app': an older PMC 3D app (no share bridge) — the picture can only be saved;
 * - 'phone': a phone browser — the phone's share list (WhatsApp is in it);
 * - 'computer': the picture is shown and copied; WhatsApp Web opens and the user pastes it (Ctrl+V) —
 *   a web page cannot attach a file in WhatsApp Web itself.
 */
export type ShareMode = 'android-app' | 'old-app' | 'phone' | 'computer';

export function shareMode(): ShareMode {
  const w = window as unknown as { AndroidShare?: AndroidShareBridge; AndroidDownloads?: unknown };
  if (w.AndroidShare) return 'android-app';
  if (w.AndroidDownloads) return 'old-app';
  const touch = window.matchMedia?.('(pointer: coarse)').matches && window.matchMedia?.('(max-width: 1024px)').matches;
  return touch ? 'phone' : 'computer';
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Android app: WhatsApp opens with the picture attached. */
export async function shareInApp(blob: Blob, fileName: string, text: string) {
  const bridge = (window as unknown as { AndroidShare: AndroidShareBridge }).AndroidShare;
  bridge.share(await toBase64(blob), fileName, blob.type || 'image/png', text);
}

/** Phone browser: the system share list with the picture; false when the browser cannot share files. */
export async function shareOnPhone(blob: Blob, fileName: string, text: string): Promise<'shared' | 'cancelled' | 'unsupported'> {
  const file = new File([blob], fileName, { type: blob.type || 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (!nav.share || !nav.canShare?.({ files: [file] })) return 'unsupported';
  try {
    await nav.share({ files: [file], text });
    return 'shared';
  } catch (e) {
    return (e as DOMException)?.name === 'AbortError' ? 'cancelled' : 'unsupported';
  }
}

/** Copies the picture, to paste in WhatsApp Web; false when the browser does not allow it. */
export async function copyImage(blob: Blob): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    return true;
  } catch {
    return false;
  }
}

export const saveImage = (blob: Blob, fileName: string) => saveBlob(fileName, blob);

/** WhatsApp Web in its own tab (the same tab each time). */
export const openWhatsAppWeb = () => window.open(WHATSAPP_WEB, 'whatsapp-web');
