// Downloads raw OpenStreetMap data for the Cyber Nanning play area from the Overpass API.
// Usage: node scripts/fetch-osm.mjs  ->  data/osm-raw.json
import { writeFile } from 'node:fs/promises';
import { BBOX } from './area.mjs';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const b = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
const query = `[out:json][timeout:180];
(
  way["building"](${b}); relation["building"](${b}); way["building:part"](${b});
  way["highway"](${b});
  way["landuse"](${b}); relation["landuse"](${b});
  way["leisure"](${b}); relation["leisure"](${b});
  way["natural"](${b}); relation["natural"](${b}); node["natural"="tree"](${b});
  way["waterway"](${b}); way["amenity"](${b}); way["railway"](${b});
  node["railway"="station"](${b}); node["place"](${b});
);
out body; >; out skel qt;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let attempt = 0; attempt < 8; attempt++) {
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'CyberNanning/0.1', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) {
        await writeFile(new URL('../data/osm-raw.json', import.meta.url), text);
        console.log(`Saved ${(text.length / 1024).toFixed(0)} KB from ${url}`);
        process.exit(0);
      }
      console.warn(`${url}: HTTP ${res.status}, retrying`);
    } catch (err) {
      console.warn(`${url}: ${err.message}`);
    }
  }
  await sleep(5000 * 2 ** attempt);
}
console.error('All Overpass mirrors failed');
process.exit(1);
