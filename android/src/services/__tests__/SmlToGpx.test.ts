jest.mock('react-native-fs', () => ({ CachesDirectoryPath: '/tmp', readFile: jest.fn(), writeFile: jest.fn() }));
const { smlToGpx } = require('../SmlToGpx') as typeof import('../SmlToGpx');

const sample = (type: string, body: string) => `<Sample>${body}<SampleType>${type}</SampleType></Sample>`;
const XML = `<sml><DeviceLog><Header><Activity>Windsurf IDF</Activity></Header><Samples>` +
  sample('gps-base', '<Latitude>0.8442881886</Latitude><Longitude>0.0506215052</Longitude><GPSAltitude>45.5</GPSAltitude><GPSSpeed>2.03</GPSSpeed><UTC>2026-10-25T12:06:38Z</UTC>') +
  sample('periodic', '<Speed>3.5</Speed><HR>2.5</HR><UTC>2026-10-25T12:06:39.100Z</UTC>') +
  sample('gps-small', '<Latitude>0.84428818</Latitude><Longitude>0.05062150</Longitude><UTC>2026-10-25T12:06:40Z</UTC>') +
  `<Sample><Events><Pause/></Events></Sample></Samples></DeviceLog></sml>`;

describe('smlToGpx', () => {
  it('writes one trackpoint per position sample with UTC, altitude, speed and heart rate', () => {
    const { gpx, points } = smlToGpx(XML);
    expect(points).toBe(2);
    expect(gpx).toContain('<name>Windsurf IDF</name>');
    expect(gpx).toContain('<time>2026-10-25T12:06:38Z</time>');
    expect(gpx).toContain('<ele>45.5</ele>');
    expect(gpx).toContain('<speed>2.03</speed>');
    expect(gpx).toContain('<gpxtpx:hr>150</gpxtpx:hr>');   // 2.5 Hz -> 150 bpm, carried to the next point
    expect(gpx).toContain('<speed>3.50</speed>');          // the periodic speed reaches the gps-small point
  });
  it('converts radians to degrees', () => {
    const { gpx } = smlToGpx(XML);
    expect(gpx).toContain('lat="48.374');                 // 0.8442881886 rad
  });
  it('returns no points for a file without GPS', () => {
    expect(smlToGpx('<sml><Samples></Samples></sml>').points).toBe(0);
  });
});
