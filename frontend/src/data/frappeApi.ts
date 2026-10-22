import { RepositoryError, type RepositoryErrorCode } from './repository';

/**
 * Calls the pmc_3d_progress whitelisted methods on the Frappe site that serves this page.
 * Same-origin session cookie + CSRF token (set by the /pmc-3d page); no API keys in the browser.
 */
declare global {
  interface Window {
    csrf_token?: string;
  }
}

const EXC_CODES: Record<string, RepositoryErrorCode> = {
  PMCPossibleDuplicate: 'possible-duplicate',
  PMCConflictError: 'conflict',
  PermissionError: 'forbidden',
  AuthenticationError: 'forbidden',
  DoesNotExistError: 'not-found',
};

function headers(json = true): HeadersInit {
  return {
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'X-Frappe-CSRF-Token': window.csrf_token ?? '',
  };
}

/** Turn a Frappe error response into the same RepositoryError the local repository throws. */
async function toError(res: Response): Promise<RepositoryError> {
  let body: { exc_type?: string; _server_messages?: string; message?: string; exception?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON (proxy / timeout page) */
  }
  const messages: string[] = [];
  if (body._server_messages) {
    try {
      for (const m of JSON.parse(body._server_messages) as string[]) {
        const parsed = JSON.parse(m) as { message?: string };
        if (parsed.message) messages.push(...String(parsed.message).split('\n'));
      }
    } catch {
      /* ignore malformed messages */
    }
  }
  if (!messages.length) {
    if (res.status === 403) messages.push('You are not allowed to do this. Log in again, or ask for the right PMC role.');
    else if (res.status === 0 || res.status >= 500) messages.push(`The server had a problem (${res.status || 'network'}). Try again.`);
    else messages.push(body.exception?.split('\n')[0] ?? `Request failed (${res.status}).`);
  }
  const code = EXC_CODES[body.exc_type ?? ''] ?? (res.status === 403 ? 'forbidden' : 'validation');
  return new RepositoryError(code, messages);
}

export async function call<T>(method: string, args: Record<string, unknown> = {}, httpMethod: 'GET' | 'POST' = 'POST'): Promise<T> {
  const url = `/api/method/pmc_3d_progress.${method}`;
  let res: Response;
  try {
    res =
      httpMethod === 'GET'
        ? await fetch(`${url}?${new URLSearchParams(Object.entries(args).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))}`, {
            headers: headers(false),
            credentials: 'same-origin',
          })
        : await fetch(url, { method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify(args) });
  } catch {
    throw new RepositoryError('storage', 'Could not reach the server. Check the connection and try again.');
  }
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { message: T };
  return body.message;
}

export interface UploadedFile {
  file_url: string;
  file_name: string;
  name: string;
  file_size?: number;
}

/** Upload a private file with Frappe's standard upload endpoint. */
export async function uploadFile(file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('is_private', '1');
  form.append('folder', 'Home/Attachments');
  let res: Response;
  try {
    res = await fetch('/api/method/upload_file', { method: 'POST', headers: headers(false), credentials: 'same-origin', body: form });
  } catch {
    throw new RepositoryError('storage', `${file.name} could not be uploaded (no connection).`);
  }
  if (!res.ok) throw await toError(res);
  return ((await res.json()) as { message: UploadedFile }).message;
}

/** Download a (private) file the user may see; null when it is gone. */
export async function fetchFile(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}
