import { analyseSession, readSmlPoints } from '../SpeedAnalysis';

// A straight 10 min run at 10 m/s (about 19.4 kts) with the watch speed on every point.
function sml(): string {
  const rad = Math.PI / 180;
  let s = '<?xml version="1.0"?><sml><DeviceLog><Header><DateTime>2026-10-25T12:00:00Z</DateTime></Header><Samples>';
  for (let i = 0; i <= 600; i++) {
    const lat = (48 + (i * 10) / 111200) * rad;
    const t = new Date(Date.UTC(2026, 9, 25, 12, 0, i)).toISOString().replace('.000Z', 'Z');
    s += `<Sample><SampleType>gps-base</SampleType><UTC>${t}</UTC><Latitude>${lat}</Latitude><Longitude>${3 * rad}</Longitude></Sample>`;
    s += `<Sample><SampleType>periodic</SampleType><UTC>${t}</UTC><Speed>10</Speed></Sample>`;
  }
  return s + '</Samples></DeviceLog></sml>';
}

describe('SpeedAnalysis', () => {
  it('reads an SML and gives knots like the analyzer', () => {
    const raw = readSmlPoints(sml());
    expect(raw.length).toBe(601);
    const r = analyseSession(raw, null)!;
    expect(r.useDoppler).toBe(true);
    expect(r.vmax).toBeCloseTo(19.44, 1);
    expect(r.v10s).toBeCloseTo(19.44, 1);
    expect(r.v1852m).toBeCloseTo(19.44, 1);
    expect(r.durationMs).toBe(600000);
  });
  it('rejects a file that is not an SML', () => {
    expect(() => readSmlPoints('<gpx></gpx>')).toThrow();
  });
});
