/**
 * Artifact map runtime — an imperative wrapper over @meta/maps.
 *
 * Artifacts are plain HTML generated on the VM. They have no bundler and no
 * React, so they cannot consume @meta/maps' component API directly. This module
 * is bundled to a single IIFE that owns the React tree internally and exposes
 * one function.
 *
 * Attribution is deliberately not implemented here: MetaMap mounts MapLibre's
 * AttributionControl with the mandated Meta Maps entries. Anything that
 * reimplements the credit goes stale the moment that wording changes, so the
 * control stays the only source.
 */

import {Component, useState, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {
  MetaMap,
  MetaMapSource,
  MetaMapLayer,
  MetaMapMarker,
  MetaMapTooltip,
  LngLatBounds,
  type LayerSpecification,
} from '@meta/maps';

/**
 * Re-exported so a page can ask before it mounts. Returns
 * `{supported, reason?: 'webgl' | 'worker'}`.
 *
 * It is a capability check, not a guarantee: a surface can pass it and still
 * refuse the style, glyph and tile requests once the map has mounted, which
 * reaches the caller through `onFatalError`. Probing first means a page that
 * cannot run a map renders its place list rather than briefly mounting one.
 */
export {isMetaMapSupported} from '@meta/maps';

/** `_nc_client_caller` for every artifact map request. */
const CLIENT_CALLER = 'Muse_Artifact';

/**
 * Resolves the library's own `STYLE_URLS` — the `external.xx.fbcdn.net` set,
 * which answers `access-control-allow-origin: *`.
 *
 * The other two modes cannot serve an artifact: `proxy` rewrites to an
 * `/api/map-proxy/...` route that exists in a Nest app and not in a generated
 * page, and `direct` resolves `www.facebook.com`, which sends no CORS headers.
 * The mode covers glyphs, sprites and tiles as well as the style document, so
 * nothing downstream needs a second opt-in.
 */
const FETCH_MODE = 'cdn' as const;

const SOURCE_ID = 'places';
const PIN_LAYER = 'places-pins';
const LABEL_LAYER = 'places-labels';

export type MapPlace = {
  /** Display label. Rendered beside the pin when it survives collision. */
  label: string;
  lat: number;
  lng: number;
};

/** Country and US-state geometry, served with `access-control-allow-origin: *`. */
export const BOUNDARIES = {
  countries:
    'https://external.xx.fbcdn.net/maps/static/boundaries/v1/countries.json',
  usStates:
    'https://external.xx.fbcdn.net/maps/static/boundaries/v1/us_states.json',
} as const;

export type MapOverlay = {
  /** Source id. Every layer's `source` must name it. */
  id: string;
  /**
   * Inline GeoJSON, or a URL MapLibre fetches itself — `BOUNDARIES.countries`
   * is the usual URL case. A version directory is never rewritten, so a
   * pinned URL keeps returning the bytes it returned.
   */
  data: GeoJSON.FeatureCollection | GeoJSON.Feature | string;
  /** MapLibre layer specs drawn over that source, in order. */
  layers: LayerSpecification[];
  /**
   * Style slot these layers insert before. Defaults to `insert-here`, which
   * puts them under the basemap's own labels — a fill or a heatmap drawn over
   * the type hides the place names the reader needs to locate the data.
   *
   * This is the opposite of the pin layers, which append last on purpose so
   * they win label collision against the basemap. Data is the backdrop's
   * subject; a pin is the map's.
   */
  before?: string;
};

export type MountOptions = {
  /** Pins. Omit for a map whose subject is an overlay rather than places. */
  places?: MapPlace[];
  /**
   * Data drawn under the pins: a choropleth (`type: 'fill'`), a density
   * surface (`type: 'heatmap'`), a dot map (`type: 'circle'`). Each overlay
   * mounts before the pin layers, so pins and their labels stay on top of it.
   *
   * Pair one with `baseStyle: 'grayscale'`: a full-colour basemap under a
   * colour-encoded overlay puts two colour systems on one image.
   */
  overlays?: MapOverlay[];
  /** `_nc_client_id` — the artifact kind, e.g. "artifact_web". */
  clientId: string;
  /**
   * The three the reference offers. `grayscale` is not decoration: a map whose
   * subject is data wants it underneath, so the basemap's colour stops
   * competing with the overlay's.
   *
   * `@meta/maps` also has `light-no-labels`, `dark-no-labels` and `empty`,
   * deliberately not offered here. A basemap stripped of its labels leaves the
   * reader nothing to locate the data against, and a data overlay belongs on
   * `grayscale` rather than on nothing at all.
   */
  baseStyle?: 'light' | 'dark' | 'grayscale';
  /**
   * Overrides for the reader's locale and political view. Leave both unset.
   * The style, glyph and tile requests leave the reader's own browser, so the
   * maps backend resolves the values correct for whoever is reading; setting
   * them here pins one view of every disputed border onto every reader of the
   * artifact. `@meta/maps` appends them only when supplied. Set them only to
   * correct a resolution found to be wrong.
   */
  locale?: string;
  politicalView?: string;
  /**
   * Globe projection instead of the flat map. For an intercontinental or
   * worldwide extent, where a flat projection distorts the very comparison the
   * map is being drawn to make. Requires vector tiles, so it does not combine
   * with a raster or static tier.
   */
  globe?: boolean;
  /**
   * URL of MapLibre's RTL text plugin, for a page that hosts a copy. Default
   * `false`, which skips registration outright.
   *
   * The library's own default derives the vendored asset's URL from
   * `import.meta.url`, which this build cannot use: an IIFE bundle with no
   * asset loader neither resolves that specifier nor emits the file. `false`
   * declines it cleanly rather than reporting a failed attempt through
   * `onError`.
   *
   * Consequence of the default: Arabic, Hebrew and Persian labels render
   * mis-shaped and reversed. The reference does not offer this option, because
   * an artifact has nowhere to get the asset; it stays here for a page that
   * can serve one from its own origin.
   */
  rtlTextPluginUrl?: string | false;
  /**
   * Custom pin content, rendered as a DOM element over the canvas — a number
   * matching a list row, a category icon, a price. Supplying it opts the map
   * into markers; leave it out and the pins stay a MapLibre circle layer.
   *
   * `selected` is true for the pin `selectPlace` or a click last chose, so the
   * marker can style itself to match the highlighted row.
   *
   * Markers are DOM nodes, not layer features: they do not take part in label
   * collision and they cost more per pin. Use them for a place list a reader
   * could plausibly read — a few dozen — and leave larger sets on the circle
   * layer, which thins its own labels and stays cheap into the thousands.
   */
  marker?: (
    place: MapPlace,
    index: number,
    selected: boolean,
  ) => string | HTMLElement | ReactNode;
  /**
   * Hover tooltip for the features under the cursor. Turn it on whenever an
   * overlay carries values: a choropleth or a heatmap shows the reader a
   * shape, and the tooltip is where the number behind it lives.
   *
   * Return the rows to show for one feature. Keep it to the few properties
   * that matter — the whole joined record is not a tooltip.
   */
  tooltip?: (feature: any) => ReactNode;
  /**
   * Called when the reader clicks a pin, with its index into `places`, or
   * `null` when they click the map away from one.
   *
   * Pair it with `selectPlace` on the handle to wire a map and a list
   * together: the map reports the click, the page highlights the row; the row
   * reports its own click, the page calls `selectPlace`. A map beside a list
   * that do not talk to each other is two widgets on one page.
   */
  onSelectPlace?: (index: number | null) => void;
  /** Fixed camera. Omit to frame all places. */
  center?: {lat: number; lng: number};
  zoom?: number;
  /** Called on a fatal error (no WebGL, style load failed, context lost). */
  onFatalError?: (message: string) => void;
};

export type MapHandle = {
  destroy: () => void;
  /**
   * Highlight a pin from the page — the other half of `onSelectPlace`. Pass
   * `null` to clear. Highlighting is feature state, so it restyles the
   * existing pin rather than adding a layer, and it survives a basemap change.
   */
  selectPlace: (index: number | null) => void;
};

function toGeoJSON(places: MapPlace[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: places.map((place, index) => ({
      type: 'Feature',
      id: index,
      geometry: {type: 'Point', coordinates: [place.lng, place.lat]},
      properties: {label: place.label, index},
    })),
  };
}

/**
 * A generated page has no JSX, so `marker` returns what plain JavaScript can
 * build: an HTML string or a DOM node. React renders a bare string as text, so
 * returning markup without this would print the tags on the map.
 *
 * The string is inserted as markup. It is the page's own template, at the same
 * trust level as the rest of the page — but a place name interpolated into it
 * comes from the graph, so escape any value that is not yours.
 */
function markerContent(content: string | HTMLElement | ReactNode): ReactNode {
  if (typeof content === 'string') {
    return <span dangerouslySetInnerHTML={{__html: content}} />;
  }
  if (typeof HTMLElement !== 'undefined' && content instanceof HTMLElement) {
    return (
      <span
        ref={node => {
          if (node && node.firstChild !== content) {
            node.replaceChildren(content);
          }
        }}
      />
    );
  }
  return content as ReactNode;
}

const pinLayer: LayerSpecification = {
  id: PIN_LAYER,
  type: 'circle',
  source: SOURCE_ID,
  paint: {
    // Feature state rather than a second filtered layer: the selected pin
    // restyles in place, so it keeps its position in label collision and
    // survives a source update.
    //
    // The selected test is written out per property rather than hoisted to a
    // constant: these are tuple types, and a hoisted array widens to
    // `(string | boolean | string[])[]`, which no longer satisfies them.
    'circle-radius': [
      'case',
      ['boolean', ['feature-state', 'selected'], false],
      11,
      7,
    ],
    'circle-color': [
      'case',
      ['boolean', ['feature-state', 'selected'], false],
      '#1D4ED8',
      '#0064E0',
    ],
    'circle-stroke-width': [
      'case',
      ['boolean', ['feature-state', 'selected'], false],
      3,
      2,
    ],
    'circle-stroke-color': '#FFFFFF',
  },
};

const labelLayer: LayerSpecification = {
  id: LABEL_LAYER,
  type: 'symbol',
  source: SOURCE_ID,
  layout: {
    'text-field': ['get', 'label'],
    'text-font': ['Optimistic-SemiBold', 'NotoSans-Kurrent-Regular'],
    'text-size': 12,
    'text-anchor': 'top',
    'text-offset': [0, 0.6],
    'text-max-width': 8,
    // Drop a label that would land on another one rather than drawing both;
    // the pin stays either way. Without this a dense cluster is unreadable.
    'text-allow-overlap': false,
    'text-optional': true,
    // Lower key is placed first, so earlier places keep their labels longest.
    'symbol-sort-key': ['get', 'index'],
  },
  paint: {
    'text-color': '#1C2B33',
    'text-halo-color': '#FFFFFF',
    'text-halo-width': 1.75,
  },
};

/**
 * Shared between `mountMap` and the React tree it owns. Selection lives here
 * rather than in component state because the page drives it from outside
 * React, and because a click and a `selectPlace` call must not fight.
 */
type Selection = {
  map: any | null;
  index: number | null;
  /** Installed by the component so a marker re-renders on selection change. */
  notify: ((index: number | null) => void) | null;
  apply: () => void;
};

function ArtifactMap({
  options,
  selection,
}: {
  options: MountOptions;
  selection: Selection;
}) {
  // Markers are DOM nodes, so a selection change has to re-render them;
  // the circle layer restyles through feature state and needs no state here.
  const [selected, setSelected] = useState<number | null>(null);
  selection.notify = setSelected;

  const {
    places = [],
    overlays,
    marker,
    tooltip,
    onSelectPlace,
    clientId,
    baseStyle = 'light',
    center,
    zoom,
    locale,
    politicalView,
    globe = false,
    rtlTextPluginUrl = false,
    onFatalError,
  } = options;

  /** One path for both directions, so a click and `selectPlace` cannot diverge. */
  const select = (index: number | null) => {
    selection.index = index;
    selection.apply();
    onSelectPlace?.(index);
  };

  // One place cannot be fitted to a bounds — a zero-area box zooms to the
  // limit — so it is centred here instead. Without this a single-venue map
  // opens on the world and the reader has to hunt for their one pin.
  const solo = !center && places.length === 1 ? places[0] : null;
  // Every layer the tooltip may query, named explicitly. Passing `undefined`
  // lets it query the whole style, so it fires over the basemap's own roads
  // and labels and reads as a tooltip that will not go away. Markers are DOM
  // nodes and never appear in `queryRenderedFeatures`, so the pin layer joins
  // the list only when the built-in circles are what is drawn.
  const tooltipLayers = [
    ...(overlays?.flatMap(o => o.layers.map(l => l.id)) ?? []),
    ...(places.length > 0 && !marker ? [PIN_LAYER] : []),
  ];

  const initialView = center
    ? {center: [center.lng, center.lat] as [number, number], zoom: zoom ?? 13}
    : solo
      ? {center: [solo.lng, solo.lat] as [number, number], zoom: zoom ?? 14}
      : {center: [0, 0] as [number, number], zoom: 2};

  return (
    <MetaMap
      surface={clientId}
      clientCaller={CLIENT_CALLER}
      clientId={clientId}
      mapType={globe ? 'globe' : 'vector'}
      baseStyle={baseStyle}
      fetchMode={FETCH_MODE}
      rtlTextPluginUrl={rtlTextPluginUrl}
      styleOptions={locale || politicalView ? {locale, politicalView} : undefined}
      mapView={initialView}
      style={{width: '100%', height: '100%'}}
      onMapReady={map => {
        selection.map = map;
        selection.apply();

        // Clicking the map away from a pin clears the selection. The pin's
        // own click is a layer/marker prop, so this only has to recognise a
        // miss: anything that hit a pin is handled there and returns here.
        if (onSelectPlace) {
          map.on('click', (event: any) => {
            if (marker) {
              // A marker is a DOM node over the canvas, so its own click is
              // handled by the marker and usually never arrives here. Guard
              // the case where it does rather than skipping the whole
              // handler, which would leave a marker map unable to deselect.
              const el = event.originalEvent?.target;
              if (el?.closest?.('.maplibregl-marker')) return;
              select(null);
              return;
            }
            const hit = map.queryRenderedFeatures(event.point, {
              layers: [PIN_LAYER],
            });
            if (hit.length > 0) return;
            select(null);
          });
        }

        // Frame every place unless the caller pinned the camera. A single
        // place is already centred by `initialView` above, and fitting it
        // here would zoom a zero-area bounds to the limit.
        if (center || places.length < 2) return;
        const bounds = new LngLatBounds();
        for (const place of places) bounds.extend([place.lng, place.lat]);
        map.fitBounds(bounds, {padding: 48, maxZoom: 16, duration: 0});
      }}
      onMapError={event => {
        // Fatal errors arrive as a synthetic ErrorEvent carrying only
        // `message`; `error` is undefined.
        onFatalError?.(event.message || 'Map failed to load');
      }}
    >
      {/*
        Scoped to the overlay layers: an unscoped tooltip queries every layer
        and fires over the basemap's own roads and labels, which reads as a
        tooltip that will not go away.
      */}
      {tooltip && tooltipLayers.length > 0 && (
        <MetaMapTooltip layers={tooltipLayers} render={tooltip} />
      )}
      {overlays?.map(overlay => (
        <MetaMapSource
          key={overlay.id}
          id={overlay.id}
          source={{type: 'geojson', data: overlay.data as any}}
        >
          {overlay.layers.map(layer => (
            <MetaMapLayer
              key={layer.id}
              style={layer}
              before={overlay.before ?? 'insert-here'}
            />
          ))}
        </MetaMapSource>
      ))}
      {/*
        The pin and label layers append to the end of the style document —
        deliberately no `before`, unlike the overlays above. Collision is
        resolved across the whole style, so appending last lets these places
        collide out the basemap's own labels, which is what keeps a pin on top
        of its own data. Inserting them underneath inverts that and drops the
        labels this map exists to show.
      */}
      {marker
        ? places.map((place, index) => (
            <MetaMapMarker
              key={index}
              longitude={place.lng}
              latitude={place.lat}
              anchor="bottom"
              zIndex={selected === index ? 1 : 0}
              loggingLabel="artifact_map_place"
              onClick={() => select(index)}
            >
              {markerContent(marker(place, index, selected === index))}
            </MetaMapMarker>
          ))
        : places.length > 0 && (
            <MetaMapSource
              id={SOURCE_ID}
              source={{type: 'geojson', data: toGeoJSON(places)}}
            >
              <MetaMapLayer
                style={pinLayer}
                onClick={(event: any) => {
                  const index = event.features?.[0]?.properties?.index;
                  if (typeof index === 'number') select(index);
                }}
                onMouseEnter={() => {
                  if (selection.map) selection.map.getCanvas().style.cursor = 'pointer';
                }}
                onMouseLeave={() => {
                  if (selection.map) selection.map.getCanvas().style.cursor = '';
                }}
              />
              <MetaMapLayer style={labelLayer} />
            </MetaMapSource>
          )}
    </MetaMap>
  );
}

/**
 * Mount a map into `container`. The container needs a resolved height; a map in
 * a zero-height element renders nothing and reports no error.
 */
/**
 * Turns a render-phase throw into the caller's fallback.
 *
 * `onMapError` only sees errors the map control itself reports. A throw while
 * the map is being constructed never reaches it, and `createRoot().render()`
 * is concurrent, so the error surfaces asynchronously and a `try`/`catch`
 * around the call cannot see it either. Without a boundary it reaches the
 * window uncaught and the page keeps a dead container where the map belongs.
 *
 * A build cannot know in advance which surface a reader will open the artifact
 * on, and construction is where a surface-specific refusal shows up, so the
 * page has to degrade when it finds out rather than when it is built.
 */
class MapErrorBoundary extends Component<
  {children: ReactNode; onFatalError?: (message: string) => void},
  {failed: boolean}
> {
  state = {failed: false};

  static getDerivedStateFromError() {
    return {failed: true};
  }

  componentDidCatch(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.props.onFatalError?.(message || 'Map failed to load');
  }

  render() {
    // Render nothing on failure: the caller owns the replacement, the same way
    // it does for a fatal `onMapError`, so the page keeps one fallback path.
    return this.state.failed ? null : this.props.children;
  }
}

export function mountMap(container: HTMLElement, options: MountOptions): MapHandle {
  let root: Root | null = createRoot(container);

  // `applied` is what the map currently shows, `index` what it should show.
  // Keeping both means a selectPlace call before the map is ready is not
  // lost: onMapReady calls apply() once the source exists.
  let applied: number | null = null;
  const selection: Selection = {
    map: null,
    index: null,
    notify: null,
    apply() {
      this.notify?.(this.index);
      const map = this.map;
      // No places source on the marker path — markers re-render off `notify`
      // instead, and setting feature state on a missing source throws.
      if (!map || !map.getSource(SOURCE_ID)) return;
      if (applied != null) {
        map.setFeatureState(
          {source: SOURCE_ID, id: applied},
          {selected: false},
        );
      }
      if (this.index != null) {
        map.setFeatureState(
          {source: SOURCE_ID, id: this.index},
          {selected: true},
        );
      }
      applied = this.index;
    },
  };

  root.render(
    <MapErrorBoundary onFatalError={options.onFatalError}>
      <ArtifactMap options={options} selection={selection} />
    </MapErrorBoundary>,
  );

  return {
    destroy() {
      root?.unmount();
      root = null;
      selection.map = null;
      // The tree is gone; keeping its setter would set state on it.
      selection.notify = null;
    },
    selectPlace(index) {
      selection.index = index;
      selection.apply();
    },
  };
}
