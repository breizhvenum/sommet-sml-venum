// Host test for android/.../cpp/sml_export.h: reads the fixture tools/sml_fixture_from_sml.py wrote
// from a real Moveslink2 .sml, rebuilds libambit's raw log entry from it, runs smlexport::build and
// prints the SML. tools/test_sml_export.sh then diffs that against the original file.
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <vector>
#include "sml_export.h"

static std::vector<std::string> split(const std::string &l) {
    std::vector<std::string> v; std::string c; std::stringstream ss(l);
    while (std::getline(ss, c, '\t')) v.push_back(c);
    return v;
}
static ambit_date_time_t dt(const std::vector<std::string> &v, size_t i) {
    ambit_date_time_t d = {};
    d.year = (uint16_t)std::stoi(v[i]); d.month = (uint8_t)std::stoi(v[i + 1]); d.day = (uint8_t)std::stoi(v[i + 2]);
    d.hour = (uint8_t)std::stoi(v[i + 3]); d.minute = (uint8_t)std::stoi(v[i + 4]); d.msec = (uint16_t)std::stoi(v[i + 5]);
    return d;
}

int main(int argc, char **argv) {
    if (argc < 2) { std::cerr << "usage: test_sml_export fixture > out.sml\n"; return 2; }
    std::ifstream in(argv[1]);
    smlexport::DeviceInfo dev;
    ambit_log_entry_t e = {};
    std::string name;
    std::vector<ambit_log_sample_t> samples;
    std::string line;
    bool haveBuild = false;
    while (std::getline(in, line)) {
        auto v = split(line);
        if (v.empty()) continue;
        if (v[0] == "DEV") { dev.name = v[1]; dev.serial = v[2]; dev.sw = v[3]; dev.hw = v[4]; dev.bsl = v[5]; }
        else if (v[0] == "SWBUILD") {
            if (v.size() > 6) {          // the log's own fwinfo sample carries SW + build date
                ambit_log_sample_t s = {}; s.type = ambit_log_sample_type_fwinfo;
                unsigned a, b, c; sscanf(dev.sw.c_str(), "%u.%u.%u", &a, &b, &c);
                s.u.fwinfo.version[0] = (uint8_t)a; s.u.fwinfo.version[1] = (uint8_t)b;
                s.u.fwinfo.version[2] = (uint8_t)(c & 0xff); s.u.fwinfo.version[3] = (uint8_t)(c >> 8);
                s.u.fwinfo.build_date = dt(v, 1);
                samples.push_back(s); haveBuild = true;
            }
        }
        else if (v[0] == "HDR") {
            ambit_log_header_t &h = e.header;
            h.date_time = dt(v, 1);
            size_t i = 7;
            h.duration = std::stoul(v[i++]); h.ascent = std::stoi(v[i++]); h.descent = std::stoi(v[i++]);
            h.ascent_time = std::stoul(v[i++]); h.descent_time = std::stoul(v[i++]); h.recovery_time = std::stoul(v[i++]);
            h.speed_avg = std::stoi(v[i++]); h.speed_max = std::stoi(v[i++]); h.speed_max_time = std::stoul(v[i++]);
            h.altitude_max = std::stoi(v[i++]); h.altitude_min = std::stoi(v[i++]);
            h.altitude_max_time = std::stoul(v[i++]); h.altitude_min_time = std::stoul(v[i++]);
            h.activity_type = (uint8_t)std::stoi(v[i++]); h.distance = std::stoul(v[i++]); h.samples_count = std::stoul(v[i++]);
            h.first_fix_time = std::stoul(v[i++]); h.battery_start = (uint8_t)std::stoi(v[i++]); h.battery_end = (uint8_t)std::stoi(v[i++]);
            h.distance_before_calib = std::stoul(v[i++]); h.cadence_max_time = std::stoul(v[i++]);
        }
        else if (v[0] == "NAME") { name = v.size() > 1 ? v[1] : ""; }
        else if (v[0] == "S") {
            ambit_log_sample_t s = {};
            const std::string &k = v[1];
            s.time = (uint32_t)std::stoul(v[2]); s.utc_time = dt(v, 3);
            size_t i = 9;
            if (k == "gpsbase") {
                auto &g = s.u.gps_base; s.type = ambit_log_sample_type_gps_base;
                g.navtype = (uint16_t)std::stoi(v[i++]); g.navvalid = (uint16_t)std::stoi(v[i++]);
                g.utc_base_time = s.utc_time;
                g.latitude = std::stoi(v[i++]); g.longitude = std::stoi(v[i++]); g.altitude = std::stoi(v[i++]);
                g.speed = (uint16_t)std::stoi(v[i++]); g.heading = (uint16_t)std::stoi(v[i++]); g.ehpe = std::stoul(v[i++]);
                g.noofsatellites = (uint8_t)std::stoi(v[i++]); g.hdop = (uint8_t)std::stoi(v[i++]);
                g.satellites_count = (uint8_t)std::stoi(v[i++]);
                g.satellites = (ambit_log_gps_satellite_t *)calloc(g.satellites_count ? g.satellites_count : 1, sizeof(*g.satellites));
                for (int n = 0; n < g.satellites_count; n++) {
                    g.satellites[n].sv = (uint8_t)std::stoi(v[i++]); g.satellites[n].snr = (uint8_t)std::stoi(v[i++]);
                    g.satellites[n].state = (uint16_t)std::stoi(v[i++]);
                }
            } else if (k == "gpssmall") {
                auto &g = s.u.gps_small; s.type = ambit_log_sample_type_gps_small;
                g.noofsatellites = (uint8_t)std::stoi(v[i++]); g.latitude = std::stoi(v[i++]); g.longitude = std::stoi(v[i++]);
                g.ehpe = std::stoul(v[i++]);
                if (i < v.size()) g.utc_msec = (uint16_t)std::stoul(v[i++]);
            } else if (k == "periodic") {
                s.type = ambit_log_sample_type_periodic;
                int n = std::stoi(v[i++]);
                s.u.periodic.value_count = (uint8_t)n;
                s.u.periodic.values = (ambit_log_sample_periodic_value_t *)calloc(n ? n : 1, sizeof(ambit_log_sample_periodic_value_t));
                for (int m = 0; m < n; m++) {
                    int type = std::stoi(v[i++]); long val = std::stol(v[i++]);
                    auto &pv = s.u.periodic.values[m];
                    pv.type = (ambit_log_sample_periodic_type_t)type;
                    switch (type) {
                        case 0x19: pv.u.verticalspeed = (int16_t)val; break;
                        case 0x0c: pv.u.altitude = (int16_t)val; break;
                        case 0x03: pv.u.distance = (uint32_t)val; break;
                        case 0x04: pv.u.speed = (uint16_t)val; break;
                    }
                }
            } else if (k == "lap") {
                s.type = ambit_log_sample_type_lapinfo;
                s.u.lapinfo.event_type = (uint8_t)std::stoi(v[i++]); s.u.lapinfo.duration = std::stoul(v[i++]);
                s.u.lapinfo.distance = std::stoul(v[i++]);
            } else if (k == "dist") {
                s.type = ambit_log_sample_type_distance_source; s.u.distance_source.value = (uint8_t)std::stoi(v[i++]);
            } else if (k == "activity") {
                s.type = ambit_log_sample_type_activity;
                s.u.activity.activitytype = (uint16_t)std::stoi(v[i++]); s.u.activity.sportmode = std::stoul(v[i++]);
            } else continue;
            samples.push_back(s);
        }
    }
    (void)haveBuild;
    e.header.activity_name = (char *)name.c_str();
    e.samples_count = (uint32_t)samples.size();
    e.samples = samples.data();
    std::string out = smlexport::build(&e, dev);
    std::cout << out;
    return out.empty() ? 1 : 0;
}
