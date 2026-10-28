// sml_export.h - Suunto Movescount "SML" log export (the file Moveslink2 writes), built straight
// from a libambit log entry. Header-only so it also compiles on a PC (tools/test_sml_export.sh).
//
// WHERE THE FORMAT COMES FROM: one real Moveslink2 1.5.0.318 file of an Ambit3 Run (SdkVersion
// 2.4.89, a GPS windsurf move), plus Moveslink2's own Devices.xml / ServiceAdapter.xml.
// tools/test_sml_export.sh rebuilds that file from raw-like data and diffs it against the original.
//
// Written down from that file (VERIFIED): element names and order of the header, the device block,
// and of these samples: gps-base (with satellites), gps-small, periodic (VerticalSpeed, Altitude,
// Distance, Speed), the Pause / Activity / Distance-source events; all units (SI: metres, m/s,
// seconds, radians for latitude / longitude / heading); UTC timestamps; numbers written with 17
// significant digits, as Moveslink2 does.
//
// NOT SEEN IN THAT FILE (best knowledge, UNVERIFIED - compare with a real file that has a heart-rate
// belt, temperature, laps or a pool swim before trusting it): HR, Temperature, Cadence, BikePower,
// SeaLevelPressure channels (SI units: Hz, kelvin, Pa), the HR / Temperature header blocks, Lap
// events, gps-tiny samples. NOT WRITTEN AT ALL: the <Apps> block and AppStatus events (the Suunto
// App Zone apps are not in the log stream libambit reads), IBI beats, swimming samples,
// energy, <parsingResume>.
#ifndef SOMMET_SML_EXPORT_H
#define SOMMET_SML_EXPORT_H

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <string>
#include <utility>
#include <vector>

#include "libambit/libambit.h"

// Diagnostics: when 1, build() appends one XML comment (ignored by every SML reader) holding the raw
// bytes / values needed to pin down the header fields that are not yet decoded exactly like
// Moveslink2 does (battery, time to first fix, gps-small UTC). Set to 0 once those are confirmed.
#ifndef SOMMET_SML_DIAG
#define SOMMET_SML_DIAG 1
#endif

namespace smlexport {

// What the file's <Device> block needs besides the log itself (from the connected watch).
struct DeviceInfo {
    std::string name;     // "Suunto Ambit3 Run"
    std::string serial;   // "ACEB1A5114001900"
    std::string sw;       // "2.4.17"   (the log's own fwinfo sample wins when it has one)
    std::string hw;       // "69.4.17414"
    std::string bsl;      // "1.6.13" - empty when unknown (then no <BSL> is written)
    std::string diag;     // diagnostics only: raw device-info bytes, appended to the SOMMET_SML_DIAG comment
};

namespace detail {

static const double PI = 3.14159265358979323846;

static inline void num(std::string &o, double v) {          // 17 significant digits, like Moveslink2
    char b[48];
    snprintf(b, sizeof b, "%.17g", v);
    o += b;
}
static inline void integer(std::string &o, long long v) {
    char b[32];
    snprintf(b, sizeof b, "%lld", v);
    o += b;
}
static inline void esc(std::string &o, const char *s) {
    if (!s) return;
    for (const char *p = s; *p; p++) {
        switch (*p) {
            case '&': o += "&amp;"; break;
            case '<': o += "&lt;"; break;
            case '>': o += "&gt;"; break;
            case '"': o += "&quot;"; break;
            default:
                if ((unsigned char)*p >= 0x20 || *p == '\t' || *p == '\n') o += *p;   // drop control chars
        }
    }
}
static inline void indent(std::string &o, int d) { o.append((size_t)d, '\t'); }

// <Tag>number</Tag> on its own line.
static inline void tagNum(std::string &o, int d, const char *tag, double v) {
    indent(o, d); o += '<'; o += tag; o += '>'; num(o, v); o += "</"; o += tag; o += ">\n";
}
static inline void tagInt(std::string &o, int d, const char *tag, long long v) {
    indent(o, d); o += '<'; o += tag; o += '>'; integer(o, v); o += "</"; o += tag; o += ">\n";
}
static inline void tagStr(std::string &o, int d, const char *tag, const std::string &v) {
    indent(o, d); o += '<'; o += tag; o += '>'; esc(o, v.c_str()); o += "</"; o += tag; o += ">\n";
}
static inline void open(std::string &o, int d, const char *tag) { indent(o, d); o += '<'; o += tag; o += ">\n"; }
static inline void close(std::string &o, int d, const char *tag) { indent(o, d); o += "</"; o += tag; o += ">\n"; }

static inline double rad(double degrees) { return degrees * PI / 180.0; }

// "2026-10-25T12:06:37Z" or, when there are milliseconds, "2026-10-25T12:06:38.050Z".
static inline std::string utc(const ambit_date_time_t &t) {
    char b[48];
    unsigned ms = t.msec % 1000;
    if (ms) snprintf(b, sizeof b, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", t.year, t.month, t.day, t.hour, t.minute, t.msec / 1000, ms);
    else    snprintf(b, sizeof b, "%04u-%02u-%02uT%02u:%02u:%02uZ", t.year, t.month, t.day, t.hour, t.minute, t.msec / 1000);
    return b;
}
// Local header time: "2026-10-25T13:06:38" (no zone, no fraction), exactly as the watch stored it.
static inline std::string localTime(const ambit_date_time_t &t) {
    char b[40];
    snprintf(b, sizeof b, "%04u-%02u-%02uT%02u:%02u:%02u", t.year, t.month, t.day, t.hour, t.minute, t.msec / 1000);
    return b;
}

// UTC of a sample. libambit fills sample.utc_time from the first GPS fix (the true UTC); a move
// with no GPS has none (year 0), so fall back to the header's local start time + the sample time,
// read in the phone's zone - the same assumption the GPX export makes.
static inline std::string sampleUtc(const ambit_log_entry_t *e, const ambit_log_sample_t &s, time_t start_epoch) {
    if (s.utc_time.year != 0) return utc(s.utc_time);
    time_t t = start_epoch + (time_t)(s.time / 1000);
    struct tm g = {};
    gmtime_r(&t, &g);
    ambit_date_time_t d = {};
    d.year = (uint16_t)(g.tm_year + 1900); d.month = (uint8_t)(g.tm_mon + 1); d.day = (uint8_t)g.tm_mday;
    d.hour = (uint8_t)g.tm_hour; d.minute = (uint8_t)g.tm_min;
    d.msec = (uint16_t)(g.tm_sec * 1000 + (s.time % 1000));
    (void)e;
    return utc(d);
}

// Epoch milliseconds of a libambit date-time (msec holds seconds * 1000 + milliseconds).
static inline long long utcEpochMs(const ambit_date_time_t &t) {
    struct tm g = {};
    g.tm_year = t.year - 1900; g.tm_mon = t.month - 1; g.tm_mday = t.day;
    g.tm_hour = t.hour; g.tm_min = t.minute; g.tm_sec = 0;
    return (long long)timegm(&g) * 1000LL + (long long)t.msec;
}
// "2026-10-25T12:07:42.328Z" (".mmm" only when non-zero) from epoch milliseconds.
static inline std::string utcFromEpochMs(long long ms) {
    long long sec = ms / 1000; long long frac = ms % 1000;
    if (frac < 0) { frac += 1000; sec -= 1; }
    time_t e = (time_t)sec;
    struct tm g = {};
    gmtime_r(&e, &g);
    char b[48];
    if (frac) snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02d.%03lldZ", g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec, frac);
    else      snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02dZ", g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec);
    return b;
}
static inline std::string hexOf(const uint8_t *p, size_t n) {
    static const char *H = "0123456789abcdef";
    std::string s; s.reserve(n * 2);
    for (size_t i = 0; i < n; i++) { s += H[p[i] >> 4]; s += H[p[i] & 15]; }
    return s;
}

// A GPS fix is stamped by the watch with its own whole-second UTC, which libambit does not keep for
// gps-small / gps-tiny samples. Rounding the sample's UTC UP to the next whole second reproduces the
// Moveslink2 value for 96 % of the points of the sample file and is 1 s later than it for the other 4 %.
static inline std::string utcCeilSecond(const std::string &utcStr, const ambit_date_time_t &t) {
    if (t.msec % 1000 == 0) return utcStr;
    struct tm g = {};
    g.tm_year = t.year - 1900; g.tm_mon = t.month - 1; g.tm_mday = t.day;
    g.tm_hour = t.hour; g.tm_min = t.minute; g.tm_sec = t.msec / 1000 + 1;
    time_t e = timegm(&g);
    struct tm r = {};
    gmtime_r(&e, &r);
    ambit_date_time_t d = {};
    d.year = (uint16_t)(r.tm_year + 1900); d.month = (uint8_t)(r.tm_mon + 1); d.day = (uint8_t)r.tm_mday;
    d.hour = (uint8_t)r.tm_hour; d.minute = (uint8_t)r.tm_min; d.msec = (uint16_t)(r.tm_sec * 1000);
    return utc(d);
}

// UTC of a gps-small / gps-tiny sample: a whole second, taken as the sample's time rounded UP to the
// next second after allowing 140 ms for the fix's processing delay. Fitted on the reference move
// (7 440 of 7 507 points identical, vs 7 195 for plain rounding up); the exact source is the record's
// own 16-bit time field (gps_small.utc_msec), dumped in the diagnostics until it is decoded.
static inline std::string utcGpsSmall(long long t0ms, double t) {
    long long s = t0ms + (long long)(t * 1000.0) - 140;
    long long sec = (s >= 0) ? (s + 999) / 1000 : -((-s) / 1000);
    return utcFromEpochMs(sec * 1000);
}

// The gps-small record carries the UTC second-of-minute (utc_msec, 0..59999) - Moveslink2 prints exactly
// that second (checked on all 7507 points of a real move). The minute is not in the record: take the
// one that lands nearest the time-base estimate above.
static inline std::string utcGpsSmallExact(long long t0ms, double t, unsigned utcMsec) {
    long long s = t0ms + (long long)(t * 1000.0) - 140;
    long long est = (s >= 0) ? (s + 999) / 1000 : -((-s) / 1000);
    long long base = est - ((est % 60) + 60) % 60 + (long long)(utcMsec / 1000);
    long long best = base;
    for (long long c = base - 60; c <= base + 60; c += 60)
        if (llabs(c - est) < llabs(best - est)) best = c;
    return utcFromEpochMs(best * 1000);
}

// Satellite state word -> the booleans Moveslink2 prints. Read off the sample file: across its 2340
// satellite records "Ephemeris" is exactly bit 0x0080 and "CodeLocked" exactly bit 0x0020 of the state.
static inline const char *boolStr(bool b) { return b ? "true" : "false"; }

// SiRF navigation type -> the text Moveslink2 writes (only "4 or more SV KF solution" is in the sample;
// the others follow the SiRF binary protocol's nav-type wording - UNVERIFIED).
static inline const char *navTypeText(uint16_t navtype) {
    switch (navtype & 0x7) {
        case 1: return "1 SV KF solution";
        case 2: return "2 SV KF solution";
        case 3: return "3 SV KF solution";
        case 4: return "4 or more SV KF solution";
        case 5: return "2D least squares solution";
        case 6: return "3D least squares solution";
        case 7: return "Dead reckoning";
        default: return "No navigation fix";
    }
}

static inline const char *distanceSourceName(uint8_t v) {   // names from Devices.xml <distancesources>
    switch (v) {
        case 0: return "Bikepod";
        case 1: return "Footpod";
        case 2: return "Gps";
        case 3: return "Wrist";
        case 4: return "Indoorswimming";
        case 5: return "Outdoorswimming";
        default: return "Unknown";
    }
}

static inline std::string versionString(const uint8_t v[4]) {   // major.minor.(build16) as the device info does
    char b[32];
    snprintf(b, sizeof b, "%d.%d.%d", v[0], v[1], v[2] | (v[3] << 8));
    return b;
}

}  // namespace detail

// Returns the whole SML document (UTF-8), or "" when the entry has no samples at all.
static inline std::string build(const ambit_log_entry_t *entry, const DeviceInfo &dev) {
    using namespace detail;
    if (!entry || entry->samples_count == 0 || !entry->samples) return std::string();
    const ambit_log_header_t &h = entry->header;

    struct tm st = {};
    st.tm_year = h.date_time.year - 1900; st.tm_mon = h.date_time.month - 1; st.tm_mday = h.date_time.day;
    st.tm_hour = h.date_time.hour; st.tm_min = h.date_time.minute; st.tm_sec = (int)(h.date_time.msec / 1000);
    st.tm_isdst = -1;
    time_t start_epoch = mktime(&st);

    // Firmware that recorded the move (fwinfo sample) beats the connected watch's current firmware.
    std::string sw = dev.sw, swBuild;
    for (uint32_t i = 0; i < entry->samples_count; i++) {
        const ambit_log_sample_t &s = entry->samples[i];
        if (s.type == ambit_log_sample_type_fwinfo) {
            sw = versionString(s.u.fwinfo.version);
            const ambit_date_time_t &b = s.u.fwinfo.build_date;
            if (b.year) swBuild = localTime(b);
            break;
        }
    }

    std::string o;
    o.reserve((size_t)entry->samples_count * 300 + 4096);
    o += "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n";
    o += "<sml SdkVersion=\"2.4.89\" Modified=\"2012-09-22T10:39:51\" "
         "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" "
         "xmlns=\"http://www.suunto.com/schemas/sml\">\n";
    open(o, 1, "DeviceLog");

    // One pass over the stream for what the header needs (ttff sample, first / last battery charge)
    // and for the time base the sample UTCs are derived from.
    int ttffSample = -1, chgFirst = -1, chgLast = -1;
    long long t0ms = 0; bool haveT0 = false;
    for (uint32_t i = 0; i < entry->samples_count; i++) {
        const ambit_log_sample_t &s = entry->samples[i];
        if (!haveT0 && s.utc_time.year != 0) { t0ms = utcEpochMs(s.utc_time) - (long long)s.time; haveT0 = true; }
        if (s.type == ambit_log_sample_type_ttff && ttffSample < 0) ttffSample = s.u.ttff.value;
        if (s.type == ambit_log_sample_type_periodic) {
            for (uint8_t k = 0; k < s.u.periodic.value_count; k++) {
                const ambit_log_sample_periodic_value_t &pv = s.u.periodic.values[k];
                if (pv.type == ambit_log_sample_periodic_type_charge) {
                    if (chgFirst < 0) chgFirst = pv.u.charge;
                    chgLast = pv.u.charge;
                }
            }
        }
    }

    // ── Header ───────────────────────────────────────────────────────────────
    open(o, 2, "Header");
    tagNum(o, 3, "Duration", h.duration / 1000.0);
    tagNum(o, 3, "Ascent", h.ascent);
    tagNum(o, 3, "Descent", h.descent);
    tagNum(o, 3, "AscentTime", h.ascent_time / 1000.0);
    tagNum(o, 3, "DescentTime", h.descent_time / 1000.0);
    tagNum(o, 3, "RecoveryTime", h.recovery_time / 1000.0);
    if (h.heartrate_max > 0) {                                   // UNVERIFIED (not in the sample file): Hz
        open(o, 3, "HR");
        tagNum(o, 4, "Avg", h.heartrate_avg / 60.0);
        tagNum(o, 4, "Max", h.heartrate_max / 60.0);
        tagNum(o, 4, "Min", h.heartrate_min / 60.0);
        tagNum(o, 4, "MaxTime", h.heartrate_max_time / 1000.0);
        tagNum(o, 4, "MinTime", h.heartrate_min_time / 1000.0);
        close(o, 3, "HR");
    }
    open(o, 3, "Speed");
    tagNum(o, 4, "Avg", h.speed_avg / 3600.0);                   // m/h -> m/s
    tagNum(o, 4, "Max", h.speed_max / 3600.0);
    tagNum(o, 4, "MaxTime", h.speed_max_time / 1000.0);
    close(o, 3, "Speed");
    open(o, 3, "Cadence");
    if (h.cadence_max > 0) {                                     // UNVERIFIED (sample has none): Hz
        tagNum(o, 4, "Avg", h.cadence_avg / 60.0);
        tagNum(o, 4, "Max", h.cadence_max / 60.0);
    }
    tagNum(o, 4, "MaxTime", h.cadence_max_time / 1000.0);
    close(o, 3, "Cadence");
    open(o, 3, "Altitude");
    tagNum(o, 4, "Max", h.altitude_max);
    tagNum(o, 4, "Min", h.altitude_min);
    tagNum(o, 4, "MaxTime", h.altitude_max_time / 1000.0);
    tagNum(o, 4, "MinTime", h.altitude_min_time / 1000.0);
    close(o, 3, "Altitude");
    // 0x7fff / 0x8000 are the watch's "no temperature sensor reading" markers (a real Ambit3 file
    // without a temperature log has no <Temperature> block at all).
    if ((h.temperature_max != 0 || h.temperature_min != 0) &&
        h.temperature_max != 0x7fff && h.temperature_min != (int16_t)0x8000) {   // UNVERIFIED shape: kelvin
        open(o, 3, "Temperature");
        tagNum(o, 4, "Max", h.temperature_max / 10.0 + 273.15);
        tagNum(o, 4, "Min", h.temperature_min / 10.0 + 273.15);
        tagNum(o, 4, "MaxTime", h.temperature_max_time / 1000.0);
        tagNum(o, 4, "MinTime", h.temperature_min_time / 1000.0);
        close(o, 3, "Temperature");
    }
    tagInt(o, 3, "ActivityType", h.activity_type);
    // Name of the sport mode: libambit leaves it empty for these logs, but the raw PMEM header holds
    // it (NUL-padded, 16 bytes at offset 43 on the Ambit3 - checked against a Moveslink2 file).
    std::string actName = h.activity_name ? h.activity_name : "";
    if (actName.empty() && h.raw_header_len >= 59) {
        const char *rp = (const char *)h.raw_header + 43;
        size_t n = 0; while (n < 16 && rp[n] != '\0') n++;
        actName.assign(rp, n);
    }
    tagStr(o, 3, "Activity", actName);
    tagInt(o, 3, "Distance", h.distance);
    tagInt(o, 3, "LogItemCount", h.samples_count);
    // Time to first fix and battery: Moveslink2's values are NOT the ones at the generic PMEM header
    // offsets (those gave 108 s / 1 % / 129 % on the sample move; Moveslink2 wrote 131 s / 87 % / 51 %).
    // Best evidence: they come from the log's own stream - the ttff sample and the first / last
    // periodic "charge" value. Falls back to the header fields only when they look sane.
    // The PMEM header of the Ambit3 holds them at fixed raw offsets that libambit's field walk misses
    // (it reads 4 bytes too early): ttff u16 @169, battery start @171, battery end @172. Verified on
    // a real move against Moveslink2 (131 s, 0.87, 0.51).
    double ttffOut = ttffSample >= 0 ? (double)ttffSample : h.first_fix_time / 1000.0;
    double chgStartOut = (chgFirst >= 0 ? chgFirst : (h.battery_start <= 100 ? h.battery_start : 0)) / 100.0;
    double chgEndOut = (chgLast >= 0 ? chgLast : (h.battery_end <= 100 ? h.battery_end : 0)) / 100.0;
    if (h.raw_header_len >= 173 && h.raw_header[171] <= 100 && h.raw_header[172] <= 100) {
        ttffOut = (double)(h.raw_header[169] | (h.raw_header[170] << 8));
        chgStartOut = h.raw_header[171] / 100.0;
        chgEndOut = h.raw_header[172] / 100.0;
    }
    tagNum(o, 3, "TimeToFirstFix", ttffOut);
    tagNum(o, 3, "BatteryChargeAtStart", chgStartOut);
    tagNum(o, 3, "BatteryCharge", chgEndOut);
    tagInt(o, 3, "DistanceBeforeCalibrationChange", h.distance_before_calib);
    tagStr(o, 3, "DateTime", localTime(h.date_time));
    close(o, 2, "Header");

    // ── Device ───────────────────────────────────────────────────────────────
    open(o, 2, "Device");
    tagStr(o, 3, "Name", dev.name);
    tagStr(o, 3, "SerialNumber", dev.serial);
    open(o, 3, "Info");
    tagStr(o, 4, "SW", sw);
    tagStr(o, 4, "HW", dev.hw);
    if (!dev.bsl.empty()) tagStr(o, 4, "BSL", dev.bsl);          // libambit does not read the bootloader version
    if (!swBuild.empty()) tagStr(o, 4, "SWBuildDateTime", swBuild);
    close(o, 3, "Info");
    close(o, 2, "Device");

    // ── Samples ──────────────────────────────────────────────────────────────
    open(o, 2, "Samples");
    std::vector<std::pair<size_t, size_t>> spans;      // output range of each input sample
    std::string smallRaw;                               // diagnostics: gps-small "time ms:raw field"
    for (uint32_t i = 0; i < entry->samples_count; i++) {
        const ambit_log_sample_t &s = entry->samples[i];
        const size_t spanBegin = o.size();
        const double t = s.time / 1000.0;
        // UTC of a non-GPS sample, as Moveslink2 computes it: the log's UTC origin plus the sample time
        // in milliseconds with the double product TRUNCATED (matches all 11 620 periodic samples of
        // the reference file, where plain rounding was 1 ms late on 53 of them).
        const std::string when = haveT0
            ? utcFromEpochMs(t0ms + (long long)(t * 1000.0))
            : sampleUtc(entry, s, start_epoch);

        switch (s.type) {
        case ambit_log_sample_type_gps_base: {
            const auto &g = s.u.gps_base;
            open(o, 3, "Sample");
            char hex[16]; snprintf(hex, sizeof hex, "0x%04x", g.navtype);
            tagStr(o, 4, "NavType", hex);
            tagStr(o, 4, "NavValid", g.navvalid == 0 ? "validated" : "not validated");
            tagStr(o, 4, "NavTypeExplanation", navTypeText(g.navtype));
            open(o, 4, "Satellites");
            for (uint8_t k = 0; k < g.satellites_count && g.satellites; k++) {
                const ambit_log_gps_satellite_t &sat = g.satellites[k];
                open(o, 5, "Satellite");
                tagInt(o, 6, "SV", sat.sv);
                tagInt(o, 6, "SNR", sat.snr);
                tagStr(o, 6, "CodeLocked", boolStr((sat.state & 0x0020) != 0));
                tagStr(o, 6, "Ephemeris", boolStr((sat.state & 0x0080) != 0));
                char c[32];
                if (sat.state) snprintf(c, sizeof c, "State 0x%x", sat.state); else snprintf(c, sizeof c, "State 0");
                tagStr(o, 6, "Custom", c);
                close(o, 5, "Satellite");
            }
            close(o, 4, "Satellites");
            tagNum(o, 4, "GPSAltitude", g.altitude * 0.01);
            tagNum(o, 4, "GPSHeading", rad(g.heading * 0.01));
            tagNum(o, 4, "GPSSpeed", g.speed * 0.01);
            tagNum(o, 4, "GpsHDOP", g.hdop * 0.2);
            tagInt(o, 4, "NumberOfSatellites", g.noofsatellites);
            tagNum(o, 4, "Latitude", rad(g.latitude * 1e-7));
            tagNum(o, 4, "Longitude", rad(g.longitude * 1e-7));
            tagNum(o, 4, "EHPE", g.ehpe * 0.01);
            tagNum(o, 4, "Time", t);
            tagStr(o, 4, "UTC", g.utc_base_time.year ? utc(g.utc_base_time) : when);   // the fix's own UTC
            tagStr(o, 4, "SampleType", "gps-base");
            close(o, 3, "Sample");
            break;
        }
        case ambit_log_sample_type_gps_small: {
            const auto &g = s.u.gps_small;
            open(o, 3, "Sample");
            tagInt(o, 4, "NumberOfSatellites", g.noofsatellites);
            tagNum(o, 4, "Latitude", rad(g.latitude * 1e-7));
            tagNum(o, 4, "Longitude", rad(g.longitude * 1e-7));
            tagNum(o, 4, "EHPE", g.ehpe * 0.01);
            tagNum(o, 4, "Time", t);
            tagStr(o, 4, "UTC", haveT0 ? utcGpsSmallExact(t0ms, t, (unsigned)g.utc_msec) : when);
            tagStr(o, 4, "SampleType", "gps-small");
#if SOMMET_SML_DIAG
            { char b[40]; snprintf(b, sizeof b, "%u:%u ", (unsigned)s.time, (unsigned)g.utc_msec); smallRaw += b; }
#endif
            close(o, 3, "Sample");
            break;
        }
        case ambit_log_sample_type_gps_tiny: {                   // UNVERIFIED shape (none in the sample file)
            const auto &g = s.u.gps_tiny;
            open(o, 3, "Sample");
            tagNum(o, 4, "Latitude", rad(g.latitude * 1e-7));
            tagNum(o, 4, "Longitude", rad(g.longitude * 1e-7));
            tagNum(o, 4, "EHPE", g.ehpe * 0.01);
            tagNum(o, 4, "Time", t);
            tagStr(o, 4, "UTC", haveT0 ? utcGpsSmall(t0ms, t) : when);
            tagStr(o, 4, "SampleType", "gps-tiny");
            close(o, 3, "Sample");
            break;
        }
        case ambit_log_sample_type_periodic: {
            // Only the channels this very sample carries, in Moveslink2's order. A channel the watch
            // marks "no value" (0xFF / 0xFFFF) is left out, as Moveslink2 leaves it out.
            bool has[0x80] = {false};
            double v[0x80] = {0};
            for (uint8_t k = 0; k < s.u.periodic.value_count; k++) {
                const ambit_log_sample_periodic_value_t &pv = s.u.periodic.values[k];
                if ((unsigned)pv.type >= 0x80) continue;
                switch (pv.type) {
                    case ambit_log_sample_periodic_type_verticalspeed: v[pv.type] = pv.u.verticalspeed * 0.01; has[pv.type] = true; break;
                    case ambit_log_sample_periodic_type_altitude:      v[pv.type] = pv.u.altitude; has[pv.type] = true; break;
                    case ambit_log_sample_periodic_type_distance:      v[pv.type] = pv.u.distance; has[pv.type] = true; break;
                    case ambit_log_sample_periodic_type_speed:
                        if (pv.u.speed != 0xFFFF) { v[pv.type] = pv.u.speed * 0.01; has[pv.type] = true; } break;
                    case ambit_log_sample_periodic_type_hr:            // UNVERIFIED: Hz
                        if (pv.u.hr != 0xFF) { v[pv.type] = pv.u.hr / 60.0; has[pv.type] = true; } break;
                    case ambit_log_sample_periodic_type_temperature:   // UNVERIFIED: kelvin
                        v[pv.type] = pv.u.temperature / 10.0 + 273.15; has[pv.type] = true; break;
                    case ambit_log_sample_periodic_type_cadence:       // UNVERIFIED: Hz
                        if (pv.u.cadence != 0xFF) { v[pv.type] = pv.u.cadence / 60.0; has[pv.type] = true; } break;
                    case ambit_log_sample_periodic_type_wristcadence:  // UNVERIFIED: Hz
                        if (pv.u.wristcadence != 0xFFFF && !has[ambit_log_sample_periodic_type_cadence]) {
                            v[ambit_log_sample_periodic_type_cadence] = pv.u.wristcadence / 60.0;
                            has[ambit_log_sample_periodic_type_cadence] = true;
                        }
                        break;
                    case ambit_log_sample_periodic_type_sealevelpressure:  // UNVERIFIED: Pa
                        v[pv.type] = pv.u.sealevelpressure * 10.0; has[pv.type] = true; break;
                    case ambit_log_sample_periodic_type_bikepower:     // UNVERIFIED: W
                        if (pv.u.bikepower != 0xFFFF) { v[pv.type] = pv.u.bikepower; has[pv.type] = true; } break;
                    default: break;
                }
            }
            open(o, 3, "Sample");
            if (has[ambit_log_sample_periodic_type_verticalspeed]) tagNum(o, 4, "VerticalSpeed", v[ambit_log_sample_periodic_type_verticalspeed]);
            if (has[ambit_log_sample_periodic_type_temperature])   tagNum(o, 4, "Temperature", v[ambit_log_sample_periodic_type_temperature]);
            if (has[ambit_log_sample_periodic_type_hr])            tagNum(o, 4, "HR", v[ambit_log_sample_periodic_type_hr]);
            if (has[ambit_log_sample_periodic_type_altitude])      tagNum(o, 4, "Altitude", v[ambit_log_sample_periodic_type_altitude]);
            if (has[ambit_log_sample_periodic_type_distance])      tagNum(o, 4, "Distance", v[ambit_log_sample_periodic_type_distance]);
            if (has[ambit_log_sample_periodic_type_speed])         tagNum(o, 4, "Speed", v[ambit_log_sample_periodic_type_speed]);
            if (has[ambit_log_sample_periodic_type_cadence])       tagNum(o, 4, "Cadence", v[ambit_log_sample_periodic_type_cadence]);
            if (has[ambit_log_sample_periodic_type_sealevelpressure]) tagNum(o, 4, "SeaLevelPressure", v[ambit_log_sample_periodic_type_sealevelpressure]);
            if (has[ambit_log_sample_periodic_type_bikepower])     tagNum(o, 4, "BikePower", v[ambit_log_sample_periodic_type_bikepower]);
            tagNum(o, 4, "Time", t);
            tagStr(o, 4, "SampleType", "periodic");
            tagStr(o, 4, "UTC", when);
            close(o, 3, "Sample");
            break;
        }
        case ambit_log_sample_type_lapinfo: {
            const auto &l = s.u.lapinfo;
            if (l.event_type == 0x1e || l.event_type == 0x1f) {  // pause / start - layout read off the sample file
                open(o, 3, "Sample");
                tagStr(o, 4, "UTC", when);
                tagNum(o, 4, "Time", t);
                open(o, 4, "Events");
                open(o, 5, "Pause");
                tagInt(o, 6, "Type", l.event_type);
                tagNum(o, 6, "Duration", l.duration / 1000.0);
                tagInt(o, 6, "Distance", l.distance);
                tagStr(o, 6, "State", l.event_type == 0x1e ? "True" : "False");
                close(o, 5, "Pause");
                close(o, 4, "Events");
                close(o, 3, "Sample");
            } else if (s.time > h.duration + 1000) {
                // A lap stamped after the move's own end (the watch's closing "Manual" lap when the
                // move is saved long after it was stopped): Moveslink2 does not write it.
                break;
            } else {                                              // laps: UNVERIFIED shape
                const char *name = l.event_type == 0x01 ? "Manual" : l.event_type == 0x14 ? "High interval"
                                 : l.event_type == 0x15 ? "Low interval" : l.event_type == 0x16 ? "Interval" : "Other";
                open(o, 3, "Sample");
                tagNum(o, 4, "Time", t);
                open(o, 4, "Events");
                open(o, 5, "Lap");
                tagStr(o, 6, "Type", name);
                tagNum(o, 6, "Duration", l.duration / 1000.0);
                tagInt(o, 6, "Distance", l.distance);
                close(o, 5, "Lap");
                close(o, 4, "Events");
                tagStr(o, 4, "UTC", when);
                close(o, 3, "Sample");
            }
            break;
        }
        case ambit_log_sample_type_distance_source: {
            open(o, 3, "Sample");
            tagNum(o, 4, "Time", t);
            open(o, 4, "Events");
            open(o, 5, "Distance");
            tagStr(o, 6, "Source", distanceSourceName(s.u.distance_source.value));
            tagStr(o, 6, "UTC", when);
            close(o, 5, "Distance");
            close(o, 4, "Events");
            tagStr(o, 4, "UTC", when);
            close(o, 3, "Sample");
            break;
        }
        case ambit_log_sample_type_activity: {
            open(o, 3, "Sample");
            tagNum(o, 4, "Time", t);
            open(o, 4, "Events");
            open(o, 5, "Activity");
            tagInt(o, 6, "CustomModeId", s.u.activity.sportmode);
            char ty[32]; snprintf(ty, sizeof ty, "UNDEFINED%u", s.u.activity.activitytype);
            tagStr(o, 6, "Type", ty);
            close(o, 5, "Activity");
            close(o, 4, "Events");
            tagStr(o, 4, "UTC", when);
            close(o, 3, "Sample");
            break;
        }
        default:
            break;   // ibi, ttff, altitude/cadence source, time, swimming, position, fwinfo, unknown: not written
        }
        spans.emplace_back(spanBegin, o.size());
    }

    // Moveslink2 writes the samples that share the very first timestamp (time 0: start events, first
    // periodic and first GPS fix) in the REVERSE of the order the watch logged them. Seen on the
    // reference move: log order Activity, Pause, periodic, gps-base -> file order gps-base, periodic,
    // Pause, Activity. Every later tie keeps the log order.
    {
        size_t n = 0;
        while (n < spans.size() && entry->samples[n].time == 0) n++;
        if (n > 1) {
            std::string head = o.substr(0, spans[0].first);
            std::string lead;
            for (size_t k = n; k-- > 0;) lead += o.substr(spans[k].first, spans[k].second - spans[k].first);
            std::string tail = o.substr(spans[n - 1].second);
            o = head + lead + tail;
        }
    }

    close(o, 2, "Samples");
    // raw_log_size counts 12 bytes more than Moveslink2's binarySize (340517 vs 340505 on a real move).
    if (h.raw_log_size > 12) {
        const uint32_t binSize = h.raw_log_size - 12;
        open(o, 2, "parsingResume");
        tagInt(o, 3, "binarySize", binSize);
        tagInt(o, 3, "parsedSize", binSize);
        close(o, 2, "parsingResume");
    }
    close(o, 1, "DeviceLog");
    o += "</sml>\n";
#if SOMMET_SML_DIAG
    {
        char b[200];
        o += "<!-- sommet-diag\n";
        snprintf(b, sizeof b, "raw_log_size=%u ttff_sample=%d charge_first=%d charge_last=%d temp_raw=%d,%d header_ttff_s=%u batt_hdr=%u,%u\n",
                 (unsigned)h.raw_log_size, ttffSample, chgFirst, chgLast, (int)h.temperature_max, (int)h.temperature_min,
                 (unsigned)(h.first_fix_time / 1000), (unsigned)h.battery_start, (unsigned)h.battery_end);
        o += b;
        o += "device_info " + dev.diag + "\n";
        o += "raw_header=" + hexOf(h.raw_header, h.raw_header_len) + "\n";
        o += "raw_list=" + hexOf(h.raw_list, h.raw_list_len) + "\n";
        o += "gps_small_time_ms:raw_field=" + smallRaw + "\n-->\n";
    }
#endif
    return o;
}

}  // namespace smlexport

#endif  // SOMMET_SML_EXPORT_H
