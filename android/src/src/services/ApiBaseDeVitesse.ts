import * as Keychain from 'react-native-keychain';
import RNFS from 'react-native-fs';
import { BDV_API_KEY } from '../config/bdvKey';

// basedevitesse.com. The API key belongs to the APP (it is baked in at build time from a GitHub secret and
// users never see it). Each user logs in with their own identifier + password ONCE: the app keeps only
// their IDuser (never the password) and sends sessions with IDuser + the app key.

const KEYCHAIN_SERVICE = 'ambitvenum_basedevitesse';   // kept as-is so an existing install keeps working
const LOGIN_URL = 'https://traitementbdv.com/api/login.php';
const SUPPORTS_URL = 'https://traitementbdv.com/api/listeSupports.php';
const ADD_URL = 'https://traitementbdv.com/api/ajoutSession.php';

export interface BdvAccount { idUser: string; name: string; key: string }
export interface BdvSupport { id: number; name: string }

/** True when this build carries the app key (a release built with the BDV_API_KEY secret). */
export const bdvHasBuildKey = (): boolean => !!BDV_API_KEY;

async function readStored(): Promise<any | null> {
  const c = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  if (!c) return null;
  try { return JSON.parse(c.password); } catch { return null; }
}

/** The logged-in account, with the key to use (the build's, else the one typed in Settings). null = not logged in. */
export async function getBdvAccount(): Promise<BdvAccount | null> {
  const o = await readStored();
  if (!o || !o.idUser) return null;
  const key = BDV_API_KEY || o.key || '';
  return { idUser: String(o.idUser), name: String(o.name || ''), key };
}

export async function removeBdvAccount(): Promise<void> {
  await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
}

function form(params: Record<string, string>): string {
  return Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
}
async function post(url: string, params: Record<string, string>): Promise<{ status: number; text: string }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(params) });
  return { status: r.status, text: await r.text() };
}

/**
 * Logs the user in on basedevitesse.com and keeps their IDuser (not the password). `typedKey` is only
 * used when the build has no key of its own. Throws an Error with a readable message.
 */
export async function bdvLogin(login: string, password: string, typedKey = ''): Promise<BdvAccount> {
  const key = BDV_API_KEY || typedKey.trim();
  if (!key) throw new Error('Clé de l\'appli absente de cette version : renseigne-la ci-dessous, ou utilise une version compilée avec le secret BDV_API_KEY.');
  if (!login.trim() || !password) throw new Error('Renseigne ton identifiant et ton mot de passe basedevitesse.');
  const r = await post(LOGIN_URL, { login: login.trim(), password, key });
  let o: any = null;
  try { o = JSON.parse(r.text); } catch { /* not JSON */ }
  if (!o || Number(o.login) !== 1 || !o.IDuser) {
    throw new Error(r.status !== 200 ? `basedevitesse a répondu HTTP ${r.status}.` : 'Identifiant ou mot de passe refusé par basedevitesse.');
  }
  const name = [o.Prenom, o.Nom].filter(Boolean).join(' ').trim();
  await Keychain.setGenericPassword('basedevitesse', JSON.stringify({ idUser: String(o.IDuser), name, key: BDV_API_KEY ? '' : key }), { service: KEYCHAIN_SERVICE });
  return { idUser: String(o.IDuser), name, key };
}

/** The user's most practised supports (Windsurf, Windfoil...). */
export async function fetchBdvSupports(key: string, idUser: string): Promise<BdvSupport[]> {
  const r = await fetch(`${SUPPORTS_URL}?IDuser=${encodeURIComponent(idUser)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ key: key.trim() }),
  });
  const txt = await r.text();
  let arr: any[] = [];
  try { arr = JSON.parse(txt); } catch { throw new Error(`Liste des supports illisible : ${txt.slice(0, 200)}`); }
  return arr.filter(x => x && x.IDsupport != null && x.NomSupport).map(x => ({ id: Number(x.IDsupport), name: String(x.NomSupport).trim() }));
}

/** The site checks the file extension (it answered "extension non sml"): name the upload .sml / .gpx
 *  from the real content, whatever the picked copy was called (a.sml.xml, no extension...). */
async function uploadName(filePath: string): Promise<string> {
  // The file picker copies whatever the user chooses to "picked_route_<n>.gpx" (any content), so the
  // name's own extension proves nothing: decide from the content first.
  let head = '';
  try { head = (await RNFS.read(filePath.replace(/^file:\/\//, ''), 600, 0, 'utf8')).toLowerCase(); } catch {}
  let base = (filePath.split('/').pop() ?? 'session').replace(/\.(xml|txt)$/i, '').replace(/\.(sml|gpx|fit)$/i, '');
  base = base.replace(/^picked_route_/, 'session_') || 'session';
  if (/<sml[\s>]/.test(head)) return `${base}.sml`;
  if (head.includes('<gpx')) return `${base}.gpx`;
  const ext = (filePath.match(/\.(sml|gpx|fit)$/i) ?? [])[1];
  return `${base}.${(ext ?? 'sml').toLowerCase()}`;
}

/** Send one session file (.sml) as the multipart field "gps". Returns the raw server answer. */
export async function uploadSessionToBdv(
  key: string,
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
  fd.append('key', key.trim());
  const name = await uploadName(filePath);
  fd.append('gps', { uri: filePath.startsWith('file://') ? filePath : `file://${filePath}`, name, type: 'application/octet-stream' } as any);
  const r = await fetch(ADD_URL, { method: 'POST', body: fd });
  const text = await r.text();
  return { status: r.status, text, summary: `Fichier envoyé : ${name}\n` + summarizeBdvAnswer(r.status, r.url, text) };
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
