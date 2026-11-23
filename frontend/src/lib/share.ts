import { saveBlob } from './download';

interface AndroidShareBridge {
  share(base64: string, fileName: string, mimeType: string, text: string): void;
}

export type ShareResult = 'shared' | 'cancelled' | 'copied' | 'downloaded';

const WHATSAPP_WEB = 'https://web.whatsapp.com/';

/** A phone or tablet (touch screen), not a computer. */
const isPhone = () => window.matchMedia?.('(pointer: coarse)').matches && window.matchMedia?.('(max-width: 1024px)').matches;

/**
 * "Share on WhatsApp" for a file made in the page (the requirement picture):
 * - PMC 3D Android app: the app's AndroidShare bridge opens the WhatsApp app with the picture;
 * - computer: the picture is copied and WhatsApp Web opens — pick the chat and press Ctrl+V
 *   (a web page cannot attach a file in WhatsApp Web itself); if copying is not allowed, it is downloaded;
 * - phone browser: the phone's share list (WhatsApp is in it; a web page cannot open WhatsApp with a file directly).
 */
export async function shareToWhatsApp(blob: Blob, fileName: string, text: string): Promise<ShareResult> {
  const android = (window as unknown as { AndroidShare?: AndroidShareBridge }).AndroidShare;
  if (android) {
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    android.share(data.slice(data.indexOf(',') + 1), fileName, blob.type || 'image/png', text);
    return 'shared';
  }

  if (isPhone()) {
    const file = new File([blob], fileName, { type: blob.type || 'image/png' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], text });
        return 'shared';
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
      }
    }
  }

  // computer: copy the picture, then open WhatsApp Web (in the same tab each time)
  let result: ShareResult = 'downloaded';
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    result = 'copied';
  } catch {
    saveBlob(fileName, blob);
  }
  window.open(WHATSAPP_WEB, 'whatsapp-web');
  return result;
}
