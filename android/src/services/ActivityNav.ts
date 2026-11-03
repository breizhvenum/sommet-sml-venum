// Order of the activities as shown in the journal (set when one is opened), so the activity screen can
// move to the previous / next one (arrows in the header, swipe under the map).
import type { ActivityRecord } from '../database/db';

let list: ActivityRecord[] = [];

export function setActivityList(items: ActivityRecord[]): void {
  list = items.slice();
}

export function neighbors(id: string): { prev: ActivityRecord | null; next: ActivityRecord | null } {
  const i = list.findIndex(a => a.id === id);
  if (i < 0) return { prev: null, next: null };
  return { prev: i > 0 ? list[i - 1] : null, next: i < list.length - 1 ? list[i + 1] : null };
}
