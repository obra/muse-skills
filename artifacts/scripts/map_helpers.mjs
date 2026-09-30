// Portable artifact map helpers. Browser functions require HatchMaps loaded.

const STATIC_MAP_BASE = "https://external.xx.fbcdn.net/static_map.php";

export function buildStaticMapUrl(opts) {
  const params = new URLSearchParams();
  params.set("v", "2067");
  params.set("ccb", "4-4");
  params.set("center", `${opts.center[0]},${opts.center[1]}`);
  params.set("zoom", String(opts.zoom));
  params.set("size", `${opts.width ?? 400}x${opts.height ?? 400}`);
  if (opts.scale != null) params.set("scale", String(opts.scale));
  if (opts.format) params.set("format", opts.format);
  if (opts.theme) params.set("theme", opts.theme);
  if (opts.language) params.set("language", opts.language);
  if (opts.region) params.set("region", opts.region);
  params.set("show_attribution", "1");
  params.set("_nc_client_caller", "Muse_Artifact");
  params.set("_nc_client_id", "artifact_static");
  if (opts.markers?.length) {
    params.set("markers", opts.markers.map(m => [
      ...(m.scale && m.scale !== 1 ? [`scale:${m.scale}`] : []),
      `${m.position[0]},${m.position[1]}`,
    ].join("|")).join("|"));
  }
  return `${STATIC_MAP_BASE}?${params.toString()}`;
}

// Omit complete address components already included in preceding fields.
function placeQuery(place) {
  const parts = [];
  const alreadySaid = (haystack, needle) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
  };
  for (const raw of [
    place.venue || place.label,
    place.address,
    place.locality,
    place.region,
    place.country,
  ]) {
    const value = (raw || "").trim();
    if (!value) continue;
    if (alreadySaid(parts.join(", "), value)) continue;
    parts.push(value);
  }
  return parts.join(", ");
}

// Prefer a name with an address or locality; otherwise use known coordinates.
function placeTarget(place) {
  const name = (place.venue || place.label || "").trim();
  const hasLocator = Boolean(
    (place.address && place.address.trim()) || (place.locality && place.locality.trim()),
  );
  if (name && hasLocator) return placeQuery(place);
  if (typeof place.lat === "number" && typeof place.lng === "number") {
    return `${place.lat},${place.lng}`;
  }
  return placeQuery(place);
}

function isCoordinatePair(value) {
  return /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(value.trim());
}

function encodeMapsValue(value) {
  const trimmed = value.trim();
  if (isCoordinatePair(trimmed)) return trimmed;
  return encodeURIComponent(trimmed);
}

function mapsUrl(base, params) {
  const query = Object.entries(params)
    .filter(entry => Boolean(entry[1]))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeMapsValue(value)}`)
    .join("&");
  return `${base}?${query}`;
}

export function mapsSearchUrl(place) {
  const query = placeTarget(place);
  if (!query) return null;
  return mapsUrl("https://www.google.com/maps/search/", {
    api: "1",
    query,
  });
}

export function mapsDirectionsUrl(destination, options = {}) {
  const destinationValue = placeTarget(destination);
  if (!destinationValue) return null;
  return mapsUrl("https://www.google.com/maps/dir/", {
    api: "1",
    destination: destinationValue,
    origin: options.origin ? `${options.origin.lat},${options.origin.lng}` : undefined,
    travelmode: options.travelmode,
  });
}

// The caller renders the same non-map content for unsupported and fatal cases.
export function mountMap(container, options, onUnavailable) {
  const { supported } = globalThis.HatchMaps.isMetaMapSupported();
  if (!supported) {
    onUnavailable();
    return null;
  }
  return globalThis.HatchMaps.mountMap(container, {
    ...options,
    clientId: 'artifact_web',
    onFatalError: onUnavailable,
  });
}

// For short place lists. Style .pin, .pin--on, and the selected row class.
export function mountPlaceListMap(container, options, onUnavailable) {
  const { rows, selectedClass = 'map-selected', ...mapOptions } = options;
  const highlight = (index, scroll) => {
    rows.forEach((row, i) => row.classList.toggle(selectedClass, i === index));
    if (scroll && index !== null) {
      rows[index].scrollIntoView({ block: 'nearest' });
    }
  };
  const map = mountMap(container, {
    ...mapOptions,
    marker: (_place, index, selected) =>
      `<div class="pin${selected ? ' pin--on' : ''}">${index + 1}</div>`,
    onSelectPlace: index => highlight(index, true),
  }, onUnavailable);
  if (map === null) return null;
  rows.forEach((row, index) => {
    row.addEventListener('click', () => {
      map.selectPlace(index);
      highlight(index, false);
    });
  });
  return map;
}

// colorStops is an alternating density/color array, including transparency at 0.
export function heatmapOverlay(id, data, colorStops, radius = 20) {
  return {
    id,
    data,
    layers: [{
      id: `${id}-density`,
      type: 'heatmap',
      source: id,
      paint: {
        'heatmap-radius': radius,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], ...colorStops],
      },
    }],
  };
}

// Fetch published geometry and join caller-supplied rates before mounting.
// colorStops is an alternating value/color array derived from the artifact.
// The page owns its hover text: pass missingLabel in the artifact's language,
// or tooltip to replace the default line entirely.
export async function mountChoropleth(container, options, onUnavailable) {
  const {
    boundaryUrl, rows, featureKey, rowKey, valueKey, colorStops, outlineColor,
    missingLabel = 'no data', tooltip,
    ...mapOptions
  } = options;
  const { supported } = globalThis.HatchMaps.isMetaMapSupported();
  if (!supported) {
    onUnavailable();
    return null;
  }

  let geometry;
  try {
    const response = await fetch(boundaryUrl);
    if (!response.ok) throw new Error(`Boundary fetch failed: ${response.status}`);
    geometry = await response.json();
  } catch {
    onUnavailable();
    return null;
  }
  const values = new Map(rows.map(row => [row[rowKey], row[valueKey]]));
  for (const feature of geometry.features) {
    feature.properties.value = values.get(feature.properties[featureKey]) ?? null;
  }
  return mountMap(container, {
    ...mapOptions,
    baseStyle: 'grayscale',
    tooltip: tooltip ?? (feature =>
      `${feature.properties.name}: ${feature.properties.value ?? missingLabel}`),
    overlays: [{
      id: 'regions',
      data: geometry,
      layers: [
        {
          id: 'regions-fill', type: 'fill', source: 'regions',
          filter: ['!=', ['get', 'value'], null],
          paint: {
            'fill-color': ['interpolate', ['linear'], ['get', 'value'], ...colorStops],
            'fill-opacity': 0.45,
          },
        },
        {
          id: 'regions-outline', type: 'line', source: 'regions',
          paint: { 'line-color': outlineColor, 'line-width': 1 },
        },
      ],
    }],
  }, onUnavailable);
}
