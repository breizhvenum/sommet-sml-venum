#!/usr/bin/env python3
"""Check for Connect IQ app updates on a connected Garmin device — no Garmin login required.

How it works (all from data already on the device + the PUBLIC store API):
  1. The device's Garmin/GarminDevice.xml has an <IQAppExt><Apps> manifest: every installed CIQ app with
     its <AppName>, <StoreId> (the store UUID) and installed <Version> (an integer = the store's
     "internalVersion").
  2. The public store metadata endpoint
        https://apps.garmin.com/api/appsLibraryExternalServices/api/asw/apps/<StoreId>
     returns latestInternalVersion / latestExternalVersion / whatsNew — unauthenticated.
  3. installed Version < latestInternalVersion  =>  an update is available.

This only DETECTS updates. Downloading the new .prg is behind Garmin auth (the Connect IQ Store app's
authenticated endpoint) — not implemented here. The .prg files live (accessible over USB on the
Edge 1040) in Garmin/Apps/Media/<id>.PRG, so a downloaded update could be dropped in there once a
download path is implemented.

  ciq_updates.py --xml <GarminDevice.xml>     # check a pulled manifest
  ciq_updates.py                              # find the Edge over USB and check it
Prints one JSON object (for the desktop) unless --text."""

import argparse
import json
import os
import re
import sys
import urllib.request

STORE_API = "https://apps.garmin.com/api/appsLibraryExternalServices/api/asw/apps/"


def parse_manifest(xml_text):
    """Installed CIQ apps from GarminDevice.xml: [{name, storeid, version, type}] (deduped by storeid)."""
    out, seen = [], set()
    for block in re.findall(r"<App>(.*?)</App>", xml_text, re.S):
        def g(tag):
            m = re.search(r"<%s>(.*?)</%s>" % (tag, tag), block)
            return m.group(1) if m else ""
        sid = g("StoreId")
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append({"name": g("AppName") or "(system)", "storeid": sid,
                    "version": g("Version"), "type": g("AppType")})
    return out


def store_latest(storeid):
    req = urllib.request.Request(STORE_API + storeid, headers={"User-Agent": "Mozilla/5.0"})
    d = json.load(urllib.request.urlopen(req, timeout=20))
    return d.get("latestInternalVersion"), d.get("latestExternalVersion"), d.get("whatsNew")


def _find_edge_xml():
    """Locate GarminDevice.xml on a USB-mounted Garmin device via gvfs (returns path or None)."""
    root = "/run/user/%d/gvfs" % (os.getuid() if hasattr(os, "getuid") else 1000)
    if not os.path.isdir(root):
        return None
    for entry in os.listdir(root):
        if not entry.startswith("mtp:"):
            continue
        for dp, _dn, fn in os.walk(os.path.join(root, entry)):
            if "GarminDevice.xml" in fn:
                return os.path.join(dp, "GarminDevice.xml")
            if dp.count("/") - root.count("/") > 3:
                _dn[:] = []  # don't descend too deep
    return None


def check(xml_path):
    xml_text = open(xml_path, encoding="utf-8", errors="replace").read()
    apps = parse_manifest(xml_text)
    results = []
    for a in apps:
        cur = int(a["version"]) if a["version"].isdigit() else None
        try:
            latest, ext, whats = store_latest(a["storeid"])
        except Exception as e:
            results.append({**a, "error": str(e)})
            continue
        update = isinstance(latest, int) and isinstance(cur, int) and latest > cur
        results.append({"name": a["name"], "type": a["type"], "storeid": a["storeid"],
                        "installed": cur, "latest": latest, "latestVersion": ext,
                        "updateAvailable": update})
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--xml", help="path to GarminDevice.xml (default: find the Edge over USB)")
    ap.add_argument("--text", action="store_true", help="human-readable output instead of JSON")
    a = ap.parse_args()
    xml_path = a.xml or _find_edge_xml()
    if not xml_path or not os.path.exists(xml_path):
        print(json.dumps({"ok": False, "error": "GarminDevice.xml not found (plug in the Edge over USB)"}))
        sys.exit(0)
    results = check(xml_path)
    if a.text:
        for r in results:
            if r.get("error"):
                print("  %-22s  ? (%s)" % (r["name"], r["error"]))
            else:
                tag = "UPDATE -> %s" % r["latestVersion"] if r["updateAvailable"] else "up to date"
                print("  %-22s installed %-5s latest %-5s  %s" % (r["name"], r["installed"], r["latest"], tag))
    else:
        n = sum(1 for r in results if r.get("updateAvailable"))
        print(json.dumps({"ok": True, "apps": results, "updates": n}))


if __name__ == "__main__":
    main()
