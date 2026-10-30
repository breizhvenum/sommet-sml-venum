import * as Keychain from 'react-native-keychain';
import RNFS from 'react-native-fs';

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

/** The site checks the file extension (it answered "extension non sml"): name the upload .sml / .gpx
 *  from the real content, whatever the picked copy was called (a.sml.xml, no extension...). */
async function uploadName(filePath: string): Promise<string> {
  let base = (filePath.split('/').pop() ?? 'session').replace(/\.(xml|txt)$/i, '');
  if (/\.(sml|gpx|fit)$/i.test(base)) return base.replace(/\.(sml|gpx|fit)$/i, m => m.toLowerCase());
  base = base.replace(/\.[^.]*$/, '') || 'session';
  let head = '';
  try { head = (await RNFS.read(filePath.replace(/^file:\/\//, ''), 400, 0, 'utf8')).toLowerCase(); } catch {}
  if (head.includes('<gpx')) return `${base}.gpx`;
  return `${base}.sml`;
}

const ADD_URL = 'https://traitementbdv.com/api/ajoutSession.php';

export interface BdvSupport { id: number; name: string }

/** Login then supports list (for the picker). Throws a readable Error on failure. */
export async function loginAndListSupports(c: BdvCredentials): Promise<{ idUser: string; supports: BdvSupport[] }> {
  const l = await post(LOGIN_URL, { login: c.login.trim(), password: c.password, key: c.key.trim() });
  const idUser = extractIdUser(l.text);
  if (!idUser) throw new Error(`Connexion refusée (HTTP ${l.status}) : ${l.text.slice(0, 200)}`);
  const r = await fetch(`${SUPPORTS_URL}?IDuser=${encodeURIComponent(idUser)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ key: c.key.trim() }),
  });
  const txt = await r.text();
  let arr: any[] = [];
  try { arr = JSON.parse(txt); } catch { throw new Error(`Liste des supports illisible : ${txt.slice(0, 200)}`); }
  const supports = arr
    .filter(x => x && x.IDsupport != null && x.NomSupport)
    .map(x => ({ id: Number(x.IDsupport), name: String(x.NomSupport).trim() }));
  return { idUser, supports };
}

/** Send one session file (.sml/.gpx/...) as the multipart field "gps". Returns the raw server answer. */
export async function uploadSessionToBdv(
  c: BdvCredentials,
  idUser: string,
  supportId: number,
  filePath: string,
  comment = '',
): Promise<{ status: number; text: string; summary: string }> {
  const fd = new FormData();
  fd.append('action', 'ajoutSessionDirect');
  fd.append('IDuser', String(idUser));
  fd.append('equipage', '0');
  fd.append('support', String(supportId));
  fd.append('Commentaires', comment);
  fd.append('key', c.key.trim());
  const name = await uploadName(filePath);
  fd.append('gps', { uri: filePath.startsWith('file://') ? filePath : `file://${filePath}`, name, type: 'application/octet-stream' } as any);
  const r = await fetch(ADD_URL, { method: 'POST', body: fd });
  const text = await r.text();
  return { status: r.status, text, summary: summarizeBdvAnswer(r.status, r.url, text) };
}

/** Readable digest of the server answer: final URL, session id if any, then the page text without tags. */
export function summarizeBdvAnswer(status: number, url: string | undefined, html: string): string {
  const id = (html.match(/IDresultat=(\d+)/) || (url || '').match(/IDresultat=(\d+)/) || [])[1];
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `HTTP ${status}\nURL finale : ${url ?? '?'}\nIDresultat : ${id ?? 'aucun'}\n\n${plain.slice(0, 700)}`;
}
