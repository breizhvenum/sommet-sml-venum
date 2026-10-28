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
#include <ctime>
#include <string>

#include "libambit/libambit.h"

namespace smlexport {

// What the file's <Device> block needs besides the log itself (from the connected watch).
struct DeviceInfo {
    std::string name;     // "Suunto Ambit3 Run"
    std::string serial;   // "ACEB1A5114001900"
    std::string sw;       // "2.4.17"   (the log's own fwinfo sample wins when it has one)
    std::string hw;       // "69.4.17414"
    std::string bsl;      // "1.6.13" - empty when unknown (then no <BSL> is written)
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
    if (h.temperature_max != 0 || h.temperature_min != 0) {      // UNVERIFIED (not in the sample file): kelvin
        open(o, 3, "Temperature");
        tagNum(o, 4, "Max", h.temperature_max / 10.0 + 273.15);
        tagNum(o, 4, "Min", h.temperature_min / 10.0 + 273.15);
        tagNum(o, 4, "MaxTime", h.temperature_max_time / 1000.0);
        tagNum(o, 4, "MinTime", h.temperature_min_time / 1000.0);
        close(o, 3, "Temperature");
    }
    tagInt(o, 3, "ActivityType", h.activity_type);
    tagStr(o, 3, "Activity", h.activity_name ? h.activity_name : "");
    tagInt(o, 3, "Distance", h.distance);
    tagInt(o, 3, "LogItemCount", h.samples_count);
    tagNum(o, 3, "TimeToFirstFix", h.first_fix_time / 1000.0);
    tagNum(o, 3, "BatteryChargeAtStart", h.battery_start / 100.0);
    tagNum(o, 3, "BatteryCharge", h.battery_end / 100.0);
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
    for (uint32_t i = 0; i < entry->samples_count; i++) {
        const ambit_log_sample_t &s = entry->samples[i];
        const double t = s.time / 1000.0;
        const std::string when = sampleUtc(entry, s, start_epoch);

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
            tagStr(o, 4, "UTC", s.utc_time.year ? utcCeilSecond(when, s.utc_time) : when);
            tagStr(o, 4, "SampleType", "gps-small");
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
            tagStr(o, 4, "UTC", s.utc_time.year ? utcCeilSecond(when, s.utc_time) : when);
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
    }
    close(o, 2, "Samples");
    close(o, 1, "DeviceLog");
    o += "</sml>\n";
    return o;
}

}  // namespace smlexport

#endif  // SOMMET_SML_EXPORT_H
