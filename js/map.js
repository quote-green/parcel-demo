// js/map.js

// --- SET THIS after you deploy to Vercel ---
// Example: 'https://parcel-api-yourname.vercel.app'
const API_BASE_URL = ""; // leave empty for now

let map, advMarker, parcelPolygon;
let AdvancedMarkerElementRef = null;

window.initMap = async function initMap() {
  // Base map (keep overhead)
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 37.773972, lng: -122.431297 },
    zoom: 13,
    mapTypeId: "roadmap",
    tilt: 0,
    heading: 0,
  });

  // Load modern libraries
  await google.maps.importLibrary("places");
  ({ AdvancedMarkerElement: AdvancedMarkerElementRef } = await google.maps.importLibrary("marker"));

  setupAutocompleteNew();  // New Places widget
  forceTopDown();
  lockTopDown();
};

/* ===================== NEW AUTOCOMPLETE ===================== */
/* Uses PlaceAutocompleteElement with 'gmp-select' event. */
function setupAutocompleteNew() {
  const host = document.querySelector(".search-box");
  const legacyInput = document.getElementById("address");
  if (!host || !legacyInput) return;

  // Hide your old input (keep it for form submit)
  legacyInput.style.display = "none";

  // Create the new widget
  // @ts-ignore (for TS users)
  const pac = new google.maps.places.PlaceAutocompleteElement({
    // Restrict to addresses if you want:
    // includedPrimaryTypes: ['street_address']
  });
  pac.id = "place-autocomplete";
  pac.placeholder = "Search address...";
  pac.style.width = "100%";
  host.appendChild(pac);

  // When user selects an item
  // @ts-ignore
  pac.addEventListener("gmp-select", async ({ placePrediction }) => {
    const place = placePrediction.toPlace();
    await place.fetchFields({ fields: ["formattedAddress", "location", "viewport"] });

    // Keep your hidden input in sync for form posts
    legacyInput.value = place.formattedAddress || "";

    // Move/zoom map
    if (place.viewport) {
      map.fitBounds(place.viewport);
    } else if (place.location) {
      map.setCenter(place.location);
      map.setZoom(18);
    }
    forceTopDown();

    // Show an advanced marker at the address (optional)
    if (place.location && AdvancedMarkerElementRef) {
      if (!advMarker) {
        advMarker = new AdvancedMarkerElementRef({ map, position: place.location });
      } else {
        advMarker.position = place.location;
        advMarker.map = map;
      }
    }

    // Try parcel fetch (only if you set API_BASE_URL)
    try {
      if (!API_BASE_URL) {
        console.warn("Parcel fetch skipped: API_BASE_URL not set");
      } else if (place.formattedAddress) {
        const gj = await fetchParcelByAddress(place.formattedAddress);
        const poly = pickFirstPolygon(gj);
        if (poly) drawParcel(poly);
      }
    } catch (e) {
      console.warn("Parcel fetch failed:", e?.message || e);
    }
  });
}

/* ===================== PARCEL FETCH/DRAW ===================== */
async function fetchParcelByAddress(address) {
  if (!API_BASE_URL) throw new Error("Set API_BASE_URL to your Vercel app URL");
  const url = `${API_BASE_URL}/api/parcel-by-address?address=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return normalizePreciselyToGeoJSON(data);
}

function drawParcel(geometry) {
  // Remove old
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

/* --- helpers to normalize Precisely → GeoJSON-ish --- */
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

/* Accepts Polygon or MultiPolygon geometry and returns the first outer ring as [ [lng,lat], ... ] */
function extractOuterRing(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  const coords = geometry.coordinates;

  // MultiPolygon: [ [ [ [lng,lat], ... ] ] , ... ]
  if (geometry.type === "MultiPolygon") {
    return coords?.[0]?.[0] || null;
  }
  // Polygon: [ [ [lng,lat], ... outer ring ... ], [ ...holes... ]? ]
  if (geometry.type === "Polygon") {
    return coords?.[0] || null;
  }
  // Fallback: already a ring?
  if (Array.isArray(coords?.[0]) && typeof coords[0][0] === "number") {
    return coords;
  }
  return null;
}

/* ===================== CAMERA CONTROL ===================== */
function forceTopDown() {
  if (!map) return;
  map.setMapTypeId("roadmap"); // avoids 45° imagery/tilt
  map.setHeading(0);
  map.setTilt(0);
}
function lockTopDown() {
  map.addListener("tilt_changed", () => map.getTilt() !== 0 && map.setTilt(0));
  map.addListener("heading_changed", () => map.getHeading() !== 0 && map.setHeading(0));
}
