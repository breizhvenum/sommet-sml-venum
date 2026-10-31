// "Générer le SML" (from an activity with no SML): remembers that the next time the watch is connected
// the Home screen must run the full re-read (Re-download), which writes the .sml files.
let pending = false;
export function requestSmlRegen(): void { pending = true; }
export function smlRegenPending(): boolean { return pending; }
export function clearSmlRegen(): void { pending = false; }
