// Loads the US Census 2023 gazetteer (data/places.json: places, counties and ZIPs with coordinates)
// into tangent_places once, in chunks, resuming where it left off. Regions are built from it.
import fs from "node:fs";
import * as db from "./db.js";

const VERSION = "2023";
export async function seedPlaces() {
  if (process.env.DRY === "1") return;
  const cfg = await db.config(["places_version", "places_upto"]);
  if (cfg.places_version === VERSION) return;
  const rows = JSON.parse(fs.readFileSync(new URL("../data/places.json", import.meta.url)));
  let i = +(cfg.places_upto || 0);
  for (; i < rows.length; i += 4000) {
    await db.insertPlaces(rows.slice(i, i + 4000).map(([kind, name, state, lat, lon, area]) => ({ kind, name, state, lat, lon, area })));
    await db.setConfig("places_upto", String(i + 4000));
  }
  await db.setConfig("places_version", VERSION);
  console.log(`places: loaded ${rows.length}`);
}
