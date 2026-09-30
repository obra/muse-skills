#!/usr/bin/env bun
// Generate a map URL from a JSON file. Does not fetch or publish anything.
import { readFile } from 'node:fs/promises';
import { buildStaticMapUrl, mapsDirectionsUrl, mapsSearchUrl } from './map_helpers.mjs';

const usage = `Usage: bun map_urls.mjs <static|search|directions> <input.json>
  static      Static map options: center [lat,lng], zoom, optional markers, etc.
  search      A PlaceRef object: label, address/locality, or lat/lng.
  directions  {"destination": PlaceRef, "options": {"origin": {"lat": 0, "lng": 0}}}
Prints the URL. Fetch static map images separately and store them in the artifact.`;

const [command, inputPath, ...extra] = process.argv.slice(2);
if (command === '--help' || command === '-h') {
  console.log(usage);
} else {
  try {
    if (!['static', 'search', 'directions'].includes(command) || !inputPath || extra.length) {
      throw new Error(usage);
    }
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    if (command === 'static' && (
      !Array.isArray(input.center) || input.center.length !== 2
      || !input.center.every(Number.isFinite) || !Number.isFinite(input.zoom)
    )) {
      throw new Error('Static maps require center: [latitude, longitude] and a numeric zoom.');
    }
    const url = command === 'static' ? buildStaticMapUrl(input)
      : command === 'search' ? mapsSearchUrl(input)
        : mapsDirectionsUrl(input.destination, input.options);
    if (url === null) throw new Error('The place has no usable location.');
    console.log(url);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
