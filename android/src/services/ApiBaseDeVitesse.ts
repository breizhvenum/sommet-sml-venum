import * as Keychain from 'react-native-keychain';

const KEYCHAIN_SERVICE = 'ambitvenum_basedevitesse';
const LOGIN_URL = 'https://traitementbdv.com/api/login.php';
const SUPPORTS_URL = 'https://traitementbdv.com/api/listeSupports.php';

export interface BdvCredentials {
  login: string;
  password: string;
  key: string;
}

export async function getBdvCredentials(): Promise<BdvCredentials | null> {
  const c = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  if (!c) return null;
  try {
    const o = JSON.parse(c.password);
    if (o && o.login && o.password && o.key) return o as BdvCredentials;
  } catch {}
  return null;
}

export async function saveBdvCredentials(c: BdvCredentials): Promise<void> {
  await Keychain.setGenericPassword(
    'basedevitesse',
    JSON.stringify({ login: c.login.trim(), password: c.password, key: c.key.trim() }),
    { service: KEYCHAIN_SERVICE },
  );
}

export async function removeBdvCredentials(): Promise<void> {
  await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
}

function form(params: Record<string, string>): string {
  return Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

async function post(url: string, params: Record<string, string>): Promise<{ status: number; text: string }> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });
  return { status: r.status, text: await r.text() };
}

export interface BdvTestResult {
  loginStatus: number;
  loginRaw: string;
  idUser: string | null;
  supportsStatus?: number;
  supportsRaw?: string;
}

/** Try to find the user id in the login response (JSON or plain text). Raw text is always returned too. */
function extractIdUser(raw: string): string | null {
  try {
    const o = JSON.parse(raw);
    const find = (x: any): string | null => {
      if (x == null) return null;
      if (typeof x === 'number' || (typeof x === 'string' && /^\d+$/.test(x))) return String(x);
      if (typeof x === 'object') {
        for (const k of Object.keys(x)) {
          if (/^id_?user$/i.test(k) || /^iduser$/i.test(k) || /^id$/i.test(k)) {
            const v = find(x[k]);
            if (v) return v;
          }
        }
        for (const k of Object.keys(x)) {
          const v = typeof x[k] === 'object' ? find(x[k]) : null;
          if (v) return v;
        }
      }
      return null;
    };
    return find(o);
  } catch {
    const m = raw.trim().match(/^\d+$/);
    return m ? m[0] : null;
  }
}

/** Login, then fetch the supports list. Never throws: errors are returned as text. */
export async function testBdvConnection(c: BdvCredentials): Promise<BdvTestResult> {
  const l = await post(LOGIN_URL, { login: c.login.trim(), password: c.password, key: c.key.trim() });
  const res: BdvTestResult = { loginStatus: l.status, loginRaw: l.text, idUser: extractIdUser(l.text) };
  if (res.idUser) {
    const r = await fetch(`${SUPPORTS_URL}?IDuser=${encodeURIComponent(res.idUser)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ key: c.key.trim() }),
    });
    res.supportsStatus = r.status;
    res.supportsRaw = await r.text();
  }
  return res;
}
