// js/map.js

// ---- Set this AFTER you deploy a Vercel API (optional) ----
// Example: "https://parcel-api-yourname.vercel.app"
const API_BASE_URL = ""; // leave empty for now

// ---- Globals ----
let map, drawManager;
let lotPolygon = null;
const turfPolygons = [];

// -----------------------------------------------------------
// Google calls this (from the script tag's callback=initMap)
// -----------------------------------------------------------
window.initMap = function initMap() {
  // Build the map
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 39.8283, lng: -98.5795 }, // CONUS
    zoom: 4,
    mapTypeId: "roadmap",
    tilt: 0,
    heading: 0
  });

  keepOverhead();
  lockOverhead();

  // UI + features
  setupAutocomplete();    // address suggestions + fallbacks
  setupDrawingTools();    // wires your toolbar buttons
  say("Type an address and press Enter, or use the tools on the right.");
};

// -----------------------------------------------------------
// AUTOCOMPLETE (new PlaceAutocompleteElement → legacy → Enter)
// -----------------------------------------------------------
async function setupAutocomplete() {
  const host  = document.querySelector(".search-box");
  const input = document.getElementById("address");
  if (!host || !input) return;

  // Always keep Enter-to-geocode working
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = (input.value || "").trim();
      if (!q) return;
      say("Searching…");
      await fallbackGeocode(q);
    }
  });

  // Try to load Places library (new element lives here)
  try { await google.maps.importLibrary?.("places"); } catch (_) {}

  // Preferred: NEW PlaceAutocompleteElement (Mar 2025+ for new keys)
  const hasNew = !!(google?.maps?.places && "PlaceAutocompleteElement" in google.maps.places);
  if (hasNew) {
    try {
      // @ts-ignore (TS users only)
      const pac = new google.maps.places.PlaceAutocompleteElement();
      pac.placeholder = input.placeholder || "Search address...";
      pac.style.width = "100%";

      // replace your input with the new widget (keeps layout tidy)
      host.replaceChild(pac, input);

      // @ts-ignore
      pac.addEventListener("gmp-select", async ({ placePrediction }) => {
        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ["formattedAddress", "location", "viewport"] });

        moveCameraToPlace(place);
        if (API_BASE_URL && place.formattedAddress) {
          tryDrawParcel(place.formattedAddress);
        }
      });

      say("Search ready (new Places).");
      return;
    } catch (e) {
      console.warn("New Places widget failed, falling back:", e);
      // Fall through to legacy
    }
  }

  // Legacy Autocomplete for older keys/projects
  if (google?.maps?.places?.Autocomplete) {
    const ac = new google.maps.places.Autocomplete(input, {
      types: ["address"],
      fields: ["formatted_address", "geometry"]
    });
    ac.addListener("place_changed", async () => {
      const p = ac.getPlace();
      if (!p || !p.geometry) return;
      moveCameraToLegacyPlace(p);
      if (API_BASE_URL && p.formatted_address) {
        tryDrawParcel(p.formatted_address);
      }
    });
    say("Search ready (legacy Places).");
    return;
  }

  // If neither widget is available, Enter-to-geocode still works
  say("Search ready (press Enter to geocode).");
}

function moveCameraToPlace(place) {
  if (place.viewport) {
    map.fitBounds(place.viewport);
  } else if (place.location) {
    map.setCenter(place.location);
    map.setZoom(18);
  }
  keepOverhead();
  say("Address found. Outline the lot or measure turf.");
}

function moveCameraToLegacyPlace(p) {
  const loc = p.geometry.location;
  if (p.geometry.viewport) map.fitBounds(p.geometry.viewport);
  else if (loc) { map.setCenter(loc); map.setZoom(18); }
  keepOverhead();
  say("Address found. Outline the lot or measure turf.");
}

async function fallbackGeocode(query) {
  const geocoder = new google.maps.Geocoder();
  return new Promise((resolve) => {
    geocoder.geocode({ address: query }, (results, status) => {
      if (status === "OK" && results[0]) {
        const r = results[0];
        if (r.geometry?.viewport) map.fitBounds(r.geometry.viewport);
        else if (r.geometry?.location) { map.setCenter(r.geometry.location); map.setZoom(18); }
        keepOverhead();
        say("Address found. Outline the lot or measure turf.");
      } else {
        say("Geocode failed — try a full address.");
      }
      resolve();
    });
  });
}

// -----------------------------------------------------------
// DRAWING TOOLS (Outline Lot / Manual Turf) + area updates
// -----------------------------------------------------------
function setupDrawingTools() {
  drawManager = new google.maps.drawing.DrawingManager({
    drawingControl: false,
    polygonOptions: { fillColor: "#22c55e55", strokeColor: "#16a34a", strokeWeight: 2 }
  });
  drawManager.setMap(map);

  byId("btnOutlineLot")?.addEventListener("click", startDrawingLot);
  byId("btnManualTurf")?.addEventListener("click", startDrawingTurf);
  byId("measureBtn")?.addEventListener("click", () => {
    say("Click around the turf area. Double-click to finish.");
    startDrawingTurf();
  });
  byId("btnSearchAgain")?.addEventListener("click", resetAll);
}

function startDrawingLot() {
  drawManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  google.maps.event.addListenerOnce(drawManager, "polygoncomplete", (poly) => {
    if (lotPolygon) lotPolygon.setMap(null);
    lotPolygon = poly;
    // red outline, no fill
    lotPolygon.setOptions({ fillColor: "#00000000", strokeColor: "#ef4444", strokeWeight: 2 });
    drawManager.setDrawingMode(null);
    fitToPolygon(lotPolygon);
    updateAreas();
    say("Lot outlined. Now add turf polygons.");
  });
}

function startDrawingTurf() {
  drawManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  google.maps.event.addListenerOnce(drawManager, "polygoncomplete", (poly) => {
    poly.setOptions({ fillColor: "#22c55e55", strokeColor: "#16a34a", strokeWeight: 2 });
    turfPolygons.push(poly);
    drawManager.setDrawingMode(null);
    updateAreas();
  });
}

function updateAreas() {
  const areaM2 = (poly) => google.maps.geometry.spherical.computeArea(poly.getPath());
  const lot  = lotPolygon ? areaM2(lotPolygon) * 10.7639 : 0;
  const turf = turfPolygons.reduce((s, p) => s + areaM2(p) * 10.7639, 0);

  const n = (x) => Math.round(x);
  if (byId("lotSqft"))  byId("lotSqft").value  = n(lot);
  if (byId("turfSqft")) byId("turfSqft").value = n(turf);
}

function fitToPolygon(poly) {
  const b = new google.maps.LatLngBounds();
  poly.getPath().forEach((p) => b.extend(p));
  map.fitBounds(b);
  keepOverhead();
}

function resetAll() {
  if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; }
  while (turfPolygons.length) turfPolygons.pop().setMap(null);
  ["lotSqft","turfSqft","firstName","lastName","phone","email"].forEach((id) => {
    const el = byId(id);
    if (el) el.value = "";
  });
  say("Type an address and press Enter.");
}

// -----------------------------------------------------------
// OPTIONAL: Parcel fetch/draw (guarded until API_BASE_URL is set)
// -----------------------------------------------------------
async function tryDrawParcel(formattedAddress) {
  if (!API_BASE_URL) { console.warn("Parcel fetch skipped: API_BASE_URL not set"); return; }
  try {
    const url = API_BASE_URL + "/api/parcel-by-address?address=" + encodeURIComponent(formattedAddress);
    const res = await fetch(url);
    if (!res.ok) throw new Error("API " + res.status);
    const data = await res.json();
    const gj   = normalizePreciselyToGeoJSON(data);
    const poly = pickFirstPolygon(gj);
    if (poly) drawParcel(poly);
  } catch (e) {
    console.warn("Parcel fetch failed:", e && e.message ? e.message : e);
  }
}

function drawParcel(geometry) {
  if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; } // replace lot with fetched boundary

  const ring = extractOuterRing(geometry);
  if (!ring || !ring.length) return;

  const path = ring.map(function(pair){ return { lat: pair[1], lng: pair[0] }; });
  lotPolygon = new google.maps.Polygon({
    paths: path,
    map,
    strokeColor: "#ef4444",
    strokeWeight: 2,
    fillOpacity: 0
  });

  fitToPolygon(lotPolygon);
  updateAreas();
  say("Parcel drawn. You can add turf polygons now.");
}

// GeoJSON helpers
function normalizePreciselyToGeoJSON(payload) {
  if (payload && (payload.type === "FeatureCollection" || payload.type === "Feature")) return payload;
  if (Array.isArray(payload && payload.features)) {
    return { type: "FeatureCollection", features: payload.features };
  }
  if (payload && payload.geometry && payload.geometry.type && payload.geometry.coordinates) {
    return { type: "Feature", geometry: payload.geometry, properties: payload.properties || {} };
  }
  return { type: "FeatureCollection", features: [] };
}

function pickFirstPolygon(gj) {
  const feats = gj && gj.type === "FeatureCollection" ? gj.features : [gj];
  const f = (feats || []).find(function(x){ return x && x.geometry && String(x.geometry.type).indexOf("Polygon") !== -1; });
  return f ? f.geometry : null;
}

// Accepts Polygon or MultiPolygon; returns outer ring as [[lng,lat], ...]
function extractOuterRing(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  var coords = geometry.coordinates;
  if (geometry.type === "MultiPolygon") return coords && coords[0] && coords[0][0] ? coords[0][0] : null;
  if (geometry.type === "Polygon")      return coords && coords[0] ? coords[0] : null;
  if (Array.isArray(coords[0]) && typeof coords[0][0] === "number") return coords;
  return null;
}

// -----------------------------------------------------------
// Camera helpers
// -----------------------------------------------------------
function keepOverhead() {
  if (!map) return;
  map.setMapTypeId("roadmap");
  map.setHeading(0);
  map.setTilt(0);
}
function lockOverhead() {
  map.addListener("tilt_changed",    function(){ if (map.getTilt() !== 0) map.setTilt(0); });
  map.addListener("heading_changed", function(){ if (map.getHeading() !== 0) map.setHeading(0); });
}

// -----------------------------------------------------------
// Tiny DOM helpers
// -----------------------------------------------------------
function byId(id) { return document.getElementById(id); }
function say(msg) { var el = byId("mapCaption"); if (el) el.textContent = msg; }
