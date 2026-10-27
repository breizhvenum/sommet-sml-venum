#!/usr/bin/env python3
"""Estimated body composition from weight and bioelectrical impedance.

Uses the equations of Sun SS, Chumlea WC, Heymsfield SB, et al., "Development of bioelectrical
impedance analysis prediction equations for body composition with the use of a multicomponent
model for use in epidemiologic surveys", Am J Clin Nutr 2003;77:331-340. The same published
equations are used by openScale (github.com/oliexdev/openScale, GPL-3.0), whose source was used to
check the coefficients; this is an independent implementation, not a copy of its code.

These are ESTIMATES. The equations were built on hand-to-foot impedance; a foot-to-foot bathroom
scale measures mostly the legs, so the absolute number can be off by several points. Use the trend,
not the single reading. `offset_pct` lets one person shift the result to a reference they trust.

    tools/body_composition.py 74.6 500 --height 180 --sex M
    tools/body_composition.py selftest
"""
import argparse
import sys


def estimate(weight_kg, impedance_ohm, height_cm, sex, offset_pct=0.0):
    """Return {fat_pct, fat_free_kg, fat_kg, water_pct, water_kg} or None if inputs are unusable.

    sex is "M" or "F". Impedance of 0 means "not measured" (socks, no contact) and gives None.
    """
    if not (weight_kg and weight_kg > 0 and impedance_ohm and impedance_ohm > 0 and height_cm and height_cm > 0):
        return None
    sex = str(sex).upper()[:1]
    if sex not in ("M", "F"):
        return None
    h2r = height_cm * height_cm / impedance_ohm
    if sex == "M":
        ffm = -10.68 + 0.65 * h2r + 0.26 * weight_kg + 0.02 * impedance_ohm
        water = 0.99513 * (1.2 + 0.45 * h2r + 0.18 * weight_kg)
    else:
        ffm = -9.53 + 0.69 * h2r + 0.17 * weight_kg + 0.02 * impedance_ohm
        water = 0.99513 * (3.75 + 0.45 * h2r + 0.11 * weight_kg)
    # Keep the result physical: fat-free mass cannot exceed the body weight or be negative.
    ffm = min(max(ffm, 0.0), weight_kg)
    fat_pct = min(max((1.0 - ffm / weight_kg) * 100.0 + offset_pct, 0.0), 100.0)
    return {
        "fat_pct": round(fat_pct, 1),
        "fat_free_kg": round(ffm, 2),
        "fat_kg": round(weight_kg * fat_pct / 100.0, 2),
        "water_kg": round(water, 2),
        "water_pct": round(water / weight_kg * 100.0, 1),
    }


def selftest():
    # Worked by hand from the published equation: H=180, R=500, W=74.6, male.
    #   H^2/R = 32400/500 = 64.8
    #   FFM = -10.68 + 0.65*64.8 + 0.26*74.6 + 0.02*500 = 60.836
    #   fat = (1 - 60.836/74.6) * 100 = 18.45 %
    r = estimate(74.6, 500, 180, "M")
    assert abs(r["fat_free_kg"] - 60.84) < 0.01 and r["fat_pct"] == 18.5, r
    # Women: H=165, R=600, W=65:  H^2/R=45.375, FFM = -9.53+0.69*45.375+0.17*65+0.02*600 = 44.8288
    f = estimate(65, 600, 165, "f")
    assert abs(f["fat_free_kg"] - 44.83) < 0.01 and f["fat_pct"] == 31.0, f
    # Water, men: 0.99513*(1.2+0.45*64.8+0.18*74.6) = 43.6 L (58 % of weight)
    assert abs(r["water_kg"] - 43.57) < 0.05, r
    # Not measured / bad input gives nothing instead of a made-up number.
    assert estimate(74.6, 0, 180, "M") is None, "socks: impedance 0"
    assert estimate(0, 500, 180, "M") is None and estimate(74.6, 500, 0, "M") is None
    assert estimate(74.6, 500, 180, "?") is None
    # Offset shifts the percentage only, and stays within 0..100.
    assert estimate(74.6, 500, 180, "M", offset_pct=-2.0)["fat_pct"] == 16.5
    assert estimate(74.6, 500, 180, "M", offset_pct=-90)["fat_pct"] == 0.0
    # Fat-free mass never exceeds body weight (very low impedance).
    assert estimate(60, 150, 190, "M")["fat_pct"] == 0.0
    print("selftest ok")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("weight", nargs="?", help="kg, or the word selftest")
    p.add_argument("impedance", nargs="?", type=float, help="ohm")
    p.add_argument("--height", type=float, help="cm")
    p.add_argument("--sex", help="M or F")
    p.add_argument("--offset", type=float, default=0.0, help="percentage points added to body fat")
    a = p.parse_args()
    if a.weight == "selftest":
        selftest()
        return
    if a.weight is None or a.impedance is None or not a.height or not a.sex:
        p.error("need weight, impedance, --height and --sex")
    r = estimate(float(a.weight), a.impedance, a.height, a.sex, a.offset)
    if r is None:
        sys.exit("cannot estimate: impedance 0 means not measured, or an input is missing")
    print(f"body fat {r['fat_pct']} % (estimated), fat-free {r['fat_free_kg']} kg, water {r['water_pct']} %")


if __name__ == "__main__":
    main()
