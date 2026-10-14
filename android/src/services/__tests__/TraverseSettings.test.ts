import { decodeSettings } from '../AmbitSettingsReader';
import { AMBIT3_FIELDS, TRAVERSE_FIELDS, WRITE_TEMPLATES, KEY_SCREEN } from '../AmbitSettingsTemplates';

// What SuuntoLink was captured writing to a real Traverse (fw 2.0.22): its General Settings
// screen carries six entries the Ambit3's does not, and no screen carries the Pods group.
// tools/test_settings_templates.py replays the captures; this pins the mobile copy.
const EXTRA = ['vibration', 'backlight_color', 'sunrise_alert', 'sunrise_alert_minutes',
  'sunset_alert', 'sunset_alert_minutes'];

// Jest's node environment provides Buffer at runtime; the RN tsconfig has no @types/node.
declare const Buffer: { from(data: number[] | string): { toString(encoding: string): string } };
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
const field = (key: string) => TRAVERSE_FIELDS.find(f => f.key === key)!;

function reply(values: Record<string, number>): string {
  const out = [0, 0, 0, 0, 0, 0, ...Array.from('SBEM0102', c => c.charCodeAt(0))];
  for (const [key, value] of Object.entries(values)) out.push(field(key).entryId, 1, value);
  return b64(out);
}

describe('Traverse / Traverse Alpha settings', () => {
  it('lists the Ambit3 settings plus its own six, each on the general screen', () => {
    const ambit3 = AMBIT3_FIELDS.map(f => f.key);
    const traverse = TRAVERSE_FIELDS.map(f => f.key);
    expect(traverse.filter(k => !ambit3.includes(k))).toEqual(EXTRA);
    expect(traverse.filter(k => ambit3.includes(k))).toEqual(ambit3);
    for (const key of EXTRA) {
      expect(KEY_SCREEN.traverse[key]).toBe('general');
      expect(WRITE_TEMPLATES.traverse.general).toContain(field(key).entryId);
    }
    for (const key of EXTRA) expect(KEY_SCREEN.ambit3[key]).toBeUndefined();
  });

  it('sends 20 entries on the general screen and never the Pods group', () => {
    expect(WRITE_TEMPLATES.traverse.general).toHaveLength(20);
    expect(WRITE_TEMPLATES.traverse.units).toHaveLength(12);
    expect(WRITE_TEMPLATES.traverse.personal).toHaveLength(8);
    const pods = WRITE_TEMPLATES.ambit3.general.filter(id => WRITE_TEMPLATES.ambit3.units.includes(id)
      && WRITE_TEMPLATES.ambit3.personal.includes(id));
    expect(pods).toHaveLength(2);   // Pods group + Sports.Plans.Source ride in every Ambit3 screen
    const shared = WRITE_TEMPLATES.traverse.general.filter(id => WRITE_TEMPLATES.traverse.units.includes(id)
      && WRITE_TEMPLATES.traverse.personal.includes(id));
    expect(shared).toHaveLength(1); // only Sports.Plans.Source on a Traverse
  });

  it('decodes the six rows with the choices and limits SuuntoLink shows', () => {
    const rows = decodeSettings(reply({
      vibration: 2, backlight_color: 1, sunrise_alert: 1, sunrise_alert_minutes: 60,
      sunset_alert: 0, sunset_alert_minutes: 120,
    }), TRAVERSE_FIELDS);
    const row = (key: string) => rows.find(r => r.key === key)!;
    expect(row('vibration').choices!.map(c => c.label)).toEqual(['Buttons off', 'All on', 'All off']);
    expect(row('vibration').value).toBe(2);
    expect(row('backlight_color').choices!.map(c => c.label)).toEqual(['White', 'Red']);
    expect(row('backlight_color').value).toBe(1);
    expect(row('sunrise_alert')).toMatchObject({ kind: 'bool', value: 1 });
    expect(row('sunrise_alert_minutes')).toMatchObject({ value: 60, min: 0, max: 120, unit: 'min',
      showWhen: { field: 'sunrise_alert', notValue: 0 } });
    expect(row('sunset_alert')).toMatchObject({ kind: 'bool', value: 0 });
    expect(row('sunset_alert_minutes').showWhen).toEqual({ field: 'sunset_alert', notValue: 0 });
  });
});
