// js/map.js

// Set this when your Vercel API is live, e.g. "https://parcel-api-xyz.vercel.app"
const API_BASE_URL = ""; // leave empty for now

let map, advMarker, parcelPolygon;
let AdvancedMarkerElementRef = null;

window.initMap = function initMap() {
  // Build the map first so the UI isn't "just text"
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 37.773972, lng: -122.431297 },
    zoom: 13,
    mapTypeId: "roadmap",
    tilt: 0,
    heading: 0,
  });

  forceTopDown();
  lockTopDown();

  // Load optional libs without blocking the page
  (async () => {
    try {
      await google.maps.importLibrary("places"); // needed for new widget
    } catch (e) {
      console.warn("Places library not available:", e);
    }
    try {
      ({ AdvancedMarkerElement: AdvancedMarkerElementRef } = await google.maps.importLibrary("marker"));
    } catch (e) {
      console.warn("Advanced Marker library not available:", e);
    }
    setupSearchWidget(); // mount new widget or fallbacks
  })();
};

/* -------------------- SEARCH WIDGET -------------------- */
/* Try new PlaceAutocompleteElement; if unavailable, fallback gracefully. */
function setupSearchWidget() {
  const host = document.querySelector(".search-box");
  const input = document.getElementById("address");
  if (!host || !input) return;

  // If the new element exists, mount it and then hide/replace the old input
  const HasNewWidget =
    google?.maps?.places && "PlaceAutocompleteElement" in google.maps.places;

  if (HasNewWidget) {
    try {
      // Make the new widget
      // @ts-ignore (TS users)
      const pac = new google.maps.places.PlaceAutocompleteElement({
        // You can restrict, e.g.: includedPrimaryTypes: ['street_address']
      });
      pac.id = "place-autocomplete";
      pac.placeholder = input.placeholder || "Search address...";
      pac.style.width = "100%";

      // Replace the old input *only after* the new widget is ready
      host.replaceChild(pac, input);

      // Handle selection (new API uses 'gmp-select' + Place object)
      // @ts-ignore
      pac.addEventListener("gmp-select", async ({ placePrediction }) => {
        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ["formattedAddress", "location", "viewport"] }); // new Place.fetchFields API

        // Center/zoom
        if (place.viewport) {
          map.fitBounds(place.viewport);
        } else if (place.location) {
          map.setCenter(place.location);
          map.setZoom(18);
        }
        forceTopDown();

        // Optional marker
        if (place.location && AdvancedMarkerElementRef) {
          if (!advMarker) {
            advMarker = new AdvancedMarkerElementRef({ map, position: place.location });
          } else {
            advMarker.position = place.location;
            advMarker.map = map;
          }
        }

        // Try parcel fetch only if a real API base is set
        if (API_BASE_URL && place.formattedAddress) {
          try {
            const gj = await fetchParcelByAddress(place.formattedAddress);
            const poly = pickFirstPolygon(gj);
            if (poly) drawParcel(poly);
          } catch (e) {
            console.warn("Parcel fetch failed:", e?.message || e);
          }
        } else if (!API_BASE_URL) {
          console.warn("Parcel fetch skipped: API_BASE_URL not set");
        }
      });

      return; // we’re done — new widget is mounted
    } catch (e) {
      console.warn("New PlaceAutocompleteElement failed, falling back:", e);
      // Fall through to legacy/fallback
    }
  }

  // Legacy Autocomplete (works for older projects). If unavailable, we still keep input visible.
  if (google?.maps?.places?.Autocomplete) {
    const ac = new google.maps.places.Autocomplete(input, {
      types: ["address"],
      fields: ["formatted_address", "geometry"],
    });
    ac.addListener("place_changed", async () => {
      const p = ac.getPlace();
      if (!p || !p.geometry) return;
      const loc = p.geometry.location;
      if (p.geometry.viewport) {
        map.fitBounds(p.geometry.viewport);
      } else if (loc) {
        map.setCenter(loc);
        map.setZoom(18);
      }
      forceTopDown();

      if (AdvancedMarkerElementRef && loc) {
        if (!advMarker) {
          advMarker = new AdvancedMarkerElementRef({ map, position: loc });
        } else {
          advMarker.position = loc;
          advMarker.map = map;
        }
      }

      if (API_BASE_URL && p.formatted_address) {
        try {
          const gj = await fetchParcelByAddress(p.formatted_address);
          const poly = pickFirstPolygon(gj);
          if (poly) drawParcel(poly);
        } catch (e) {
          console.warn("Parcel fetch failed:", e?.message || e);
        }
      }
    });
  }

  // Always keep an Enter-to-geocode fallback
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = (input.value || "").trim();
      if (!q) return;
      await fallbackGeocode(q);
    }
  });
}

/* -------------------- PARCEL FETCH/DRAW -------------------- */
async function fetchParcelByAddress(address) {
  if (!API_BASE_URL) throw new Error("Set API_BASE_URL to your Vercel app URL");
  const url = `${API_BASE_URL}/api/parcel-by-address?address=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return normalizePreciselyToGeoJSON(data);
}

function drawParcel(geometry) {
  if (parcelPolygon) parcelPolygon.setMap(null);

  const ring = extractOuterRing(geometry);
  if (!ring || !ring.length) return;

  const path = ring.map(([lng, lat]) => ({ lat, lng }));
  parcelPolygon = new google.maps.Polygon({
    paths: path,
    map,
    strokeColor: "#ff0000",
    strokeWeight: 3,
    fillOpacity: 0, // red outline, no fill
  });

  const bounds = new google.maps.LatLngBounds();
  path.forEach((pt) => bounds.extend(pt));
  map.fitBounds(bounds, 40);
  forceTopDown();
}

/* -------------------- GeoJSON helpers -------------------- */
function normalizePreciselyToGeoJSON(payload) {
  if (payload?.type === "FeatureCollection" || payload?.type === "Feature") return payload;
  if (Array.isArray(payload?.features)) {
    return { type: "FeatureCollection", features: payload.features };
  }
  if (payload?.geometry?.type && payload?.geometry?.coordinates) {
    return { type: "Feature", geometry: payload.geometry, properties: payload.properties || {} };
  }
  return { type: "FeatureCollection", features: [] };
}

function pickFirstPolygon(gj) {
  const feats = gj?.type === "FeatureCollection" ? gj.features : [gj];
  const f = (feats || []).find((x) => x?.geometry?.type?.includes("Polygon"));
  return f ? f.geometry : null;
}

// Accepts Polygon or MultiPolygon; returns outer ring as [[lng,lat], ...]
function extractOuterRing(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  const coords = geometry.coordinates;
  if (geometry.type === "MultiPolygon") return coords?.[0]?.[0] || null;
  if (geometry.type === "Polygon") return coords?.[0] || null;
  if (Array.isArray(coords?.[0]) && typeof coords[0][0] === "number") return coords;
  return null;
}

/* -------------------- CAMERA + GEOCODER -------------------- */
function forceTopDown() {
  if (!map) return;
  map.setMapTypeId("roadmap");
  map.setHeading(0);
  map.setTilt(0);
}
function lockTopDown() {
  map.addListener("tilt_changed", () => map.getTilt() !== 0 && map.setTilt(0));
  map.addListener("heading_changed", () => map.getHeading() !== 0 && map.setHeading(0));
}

async function fallbackGeocode(query) {
  const geocoder = new google.maps.Geocoder();
  return new Promise((resolve) => {
    geocoder.geocode({ address: query }, (results, status) => {
      if (status === "OK" && results[0]) {
        const loc = results[0].geometry.location;
        if (results[0].geometry.viewport) {
          map.fitBounds(results[0].geometry.viewport);
        } else if (loc) {
          map.setCenter(loc);
          map.setZoom(18);
        }
        forceTopDown();
      }
      resolve();
    });
  });
}
