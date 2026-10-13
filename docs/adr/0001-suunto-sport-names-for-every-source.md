# Suunto's sport names are used for every source

Sommet started as an app for Suunto Ambit watches and now also imports from Garmin, Bryton, Wahoo,
Magene, Karoo, Coros and intervals.icu, each with its own sport names. We show one vocabulary
everywhere: Suunto's names, mapped in `shared/sport_names.json` and read by both apps. Suunto Ambit
stays the main product, so a ride from a Garmin is listed under the name the Ambit would give it.

A new source is added by mapping its names in that file, not by adding names to a screen.
