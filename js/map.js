// Precisely API base (your live Vercel URL)
// Avoid duplicate-declaration crashes if the script is included twice
if (!window.API_BASE_URL) window.API_BASE_URL = "https://parcel-api-ohx5.vercel.app";

/* js/map.js  — full file
   - Google Maps + Places Autocomplete (legacy input#address)
   - Precisely parcel fetch via your Vercel API
   - Robust main-parcel selection (contains point → near edge → nearest centroid)
   - Draw neighbors in gray; click any outline to promote it to “main”
   - Manual turf measure with DrawingManager; area autos to #turfSqft
   - Basic tool wiring (Edit / Delete / Reset / Undo / Redo / Save / Search Again)
*/

//////////////////////
// CONFIG & GLOBALS //
//////////////////////

// Your live Vercel API project (already deployed)
const API_BASE_URL = "https://parcel-api-ohx5.vercel.app";

// Map + UX state
let map, ac, drawMgr, marker;
let parcelPolygon = null;       // main parcel outline
let neighborPolygons = [];      // adjacent parcels
let turfPolygon = null;         // user-drawn/edited turf
let lastParcelsFC = null;       // last FeatureCollection (for click-to-correct)
let isEditing = false;

// Simple history for Undo/Redo
const historyStack = [];
let historyIdx = -1;

/////////////////////
// MAP ENTRY POINT //
/////////////////////

window.initMap = function initMap() {
  // Base map
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 37.773972, lng: -122.431297 },
    zoom: 13,
    mapTypeId: "roadmap",
    tilt: 0,
    heading: 0,
    clickableIcons: false,
    fullscreenControl: true,
    mapTypeControl: true,
    streetViewControl: false,
    gestureHandling: "greedy",
  });

  // A simple marker (hidden until a place is picked)
  marker = new google.maps.Marker({ map, visible: false });

  // Drawing manager (for manual turf)
  drawMgr = new google.maps.drawing.DrawingManager({
    drawingControl: false,
    polygonOptions: {
      strokeColor: "#16a34a",
      strokeWeight: 3,
      strokeOpacity: 1,
      fillColor: "#22c55e",
      fillOpacity: 0.15,
      clickable: true,
      editable: false,
      zIndex: 3,
    },
  });
  drawMgr.setMap(map);

  // Handle freshly drawn turf
  google.maps.event.addListener(drawMgr, "overlaycomplete", (e) => {
    if (e.type === google.maps.drawing.OverlayType.POLYGON) {
      if (turfPolygon) turfPolygon.setMap(null);
      turfPolygon = e.overlay;
      drawMgr.setDrawingMode(null);
      updateTurfArea();
      attachTurfEditListeners(turfPolygon);
      snapshot(); // record state
      say("Turf polygon created — you can Edit to adjust it.");
    }
  });

  // Places Autocomplete on the #address input (legacy widget)
  const input = document.getElementById("address");
  if (input && google.maps.places) {
    ac = new google.maps.places.Autocomplete(input, {
      types: ["address"],
      fields: ["formatted_address", "geometry"],
    });

    // Replace any existing listener — we keep exactly one
    ac.addListener('place_changed', async () => {
  const p = ac.getPlace(); 
  if (!p || !p.geometry) return;

  // camera + satellite
  moveCamera(p.geometry.location ?? null, p.geometry.viewport ?? null, 19);
  setSatellite();

  // fetch parcels for the chosen address
  const addr = p.formatted_address || document.getElementById('address')?.value || '';
  if (!addr) return;

  try {
    const fc = await fetchParcelByAddress(addr); // FeatureCollection
    const feats = Array.isArray(fc?.features) ? fc.features : [];
    if (!feats.length) return;

    // choose the parcel that contains the selected point, otherwise keep the first
    const focus = p.geometry.location;
    let chosen = feats[0];
    for (const f of feats) {
      if (containsPoint(geometryToPath(f.geometry), focus)) { chosen = f; break; }
    }

    // draw the chosen parcel (single red outline)
    drawSingleParcel(chosen.geometry);

  } catch (e) {
    console.warn("Parcel fetch failed:", e?.message || e);
  }
});

  } else {
    console.warn("Places library not loaded or #address missing.");
  }

  wireTools();
  say("Search an address to begin.");
};

//////////////////////
// CAMERA & DISPLAY //
//////////////////////

function moveCamera(point, viewport, fallbackZoom = 18) {
  if (viewport) {
    map.fitBounds(viewport);
    setTimeout(() => map.setZoom(Math.max(map.getZoom(), fallbackZoom)), 0);
  } else if (point) {
    map.setCenter(point);
    map.setZoom(fallbackZoom);
  }
}

function setSatellite() {
  map.setMapTypeId("satellite");
  // ensure overhead (no oblique/45°)
  map.setTilt(0);
  map.setHeading(0);
}

function say(msg) {
  const el = document.getElementById("mapCaption");
  if (el) el.textContent = msg;
}

///////////////////////////////
// PRECISELY: FETCH & RENDER //
///////////////////////////////

async function fetchParcelByAddress(address) {
  if (!API_BASE_URL) throw new Error("Set API_BASE_URL to your Vercel app URL");
  const url = `${API_BASE_URL}/api/parcel-by-address?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return await res.json(); // FeatureCollection
}

// Draw FeatureCollection; pick best main parcel given the selected point
function drawParcels(featureCollection, focusLatLng) {
  lastParcelsFC = featureCollection;

  // Clear old parcel outlines
  if (parcelPolygon) { parcelPolygon.setMap(null); parcelPolygon = null; }
  neighborPolygons.forEach((p) => p.setMap(null));
  neighborPolygons.length = 0;

  const feats = Array.isArray(featureCollection?.features) ? featureCollection.features : [];
  if (!feats.length) return;

  // --- choose main feature robustly ---
  let mainIdx = 0; // default first
  if (focusLatLng) {
    const TOL_M = 12;
    const tolRad = TOL_M / 6378137;

    // (a) contains the point
    for (let i = 0; i < feats.length; i++) {
      const paths = geometryToPaths(feats[i].geometry);
      if (!paths.length) continue;
      const polyTest = new google.maps.Polygon({ paths });
      if (google.maps.geometry.poly.containsLocation(focusLatLng, polyTest)) {
        mainIdx = i; break;
      }
    }
    // (b) near edge tolerance
    if (mainIdx === 0) {
      for (let i = 0; i < feats.length; i++) {
        const paths = geometryToPaths(feats[i].geometry);
        if (!paths.length) continue;
        const polyTest = new google.maps.Polygon({ paths });
        if (google.maps.geometry.poly.isLocationOnEdge(focusLatLng, polyTest, tolRad)) {
          mainIdx = i; break;
        }
      }
    }
    // (c) nearest centroid
    if (mainIdx === 0) {
      let bestD = Infinity, bestI = 0;
      for (let i = 0; i < feats.length; i++) {
        const c = centroidOfPaths(geometryToPaths(feats[i].geometry));
        if (!c) continue;
        const d = google.maps.geometry.spherical.computeDistanceBetween(
          new google.maps.LatLng(c.lat, c.lng),
          focusLatLng
        );
        if (d < bestD) { bestD = d; bestI = i; }
      }
      mainIdx = bestI;
    }
  }

  const ordered = [feats[mainIdx], ...feats.filter((_, i) => i !== mainIdx)];
  const bounds = new google.maps.LatLngBounds();
  let primaryArea = null;

  ordered.forEach((f, idx) => {
    const isAdj = idx !== 0;
    const paths = geometryToPaths(f.geometry);
    if (!paths.length) return;

    const poly = new google.maps.Polygon({
      paths,
      map,
      strokeColor: isAdj ? "#64748b" : "#ef4444",
      strokeOpacity: isAdj ? 0.7 : 1,
      strokeWeight: isAdj ? 2 : 3,
      fillOpacity: 0,
      clickable: true,
      zIndex: isAdj ? 1 : 2,
    });

    // click-to-correct: promote clicked outline to main by reselecting with that point
    poly.addListener("click", (e) => {
      if (lastParcelsFC) drawParcels(lastParcelsFC, e.latLng);
    });

    paths.forEach((ring) => ring.forEach((pt) => bounds.extend(pt)));

    if (!isAdj && !parcelPolygon) {
      parcelPolygon = poly;
      const apiArea = Number(f.properties?.areaSqFt);
      primaryArea = Number.isFinite(apiArea) ? apiArea : computeSqft(paths);
    } else {
      neighborPolygons.push(poly);
    }
  });

  if (!bounds.isEmpty()) map.fitBounds(bounds, 40);

  // Populate Lot sq ft if present
  const lotEl = document.getElementById("lotSqft");
  if (lotEl && primaryArea) lotEl.value = Math.round(primaryArea);

  say("Parcel boundary drawn — you can outline turf next.");
}

//////////////////////
// GEOMERY HELPERS  //
//////////////////////

function geometryToPaths(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") {
    return [(geom.coordinates?.[0] || []).map(([lng, lat]) => ({ lat, lng }))];
  }
  if (geom.type === "MultiPolygon") {
    // Use first ring from each polygon for outline purposes
    return (geom.coordinates || []).map((rings) =>
      (rings?.[0] || []).map(([lng, lat]) => ({ lat, lng }))
    );
  }
  return [];
}

function centroidOfPaths(paths) {
  if (!paths.length) return null;
  const ring = paths[0];
  let sx = 0, sy = 0;
  ring.forEach((p) => { sx += p.lat; sy += p.lng; });
  const n = ring.length || 1;
  return { lat: sx / n, lng: sy / n };
}

function computeSqft(paths) {
  const m2 = paths.reduce((sum, ring) => sum + google.maps.geometry.spherical.computeArea(ring), 0);
  return m2 * 10.7639;
}

//////////////////////
// TURF MEASURMENT  //
//////////////////////

function startManualTurf() {
  if (turfPolygon) {
    turfPolygon.setMap(null);
    turfPolygon = null;
  }
  drawMgr.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  say("Click on the map to outline the turf area; double-click to finish.");
}

function attachTurfEditListeners(poly) {
  if (!poly) return;
  const path = poly.getPath();
  ["insert_at", "remove_at", "set_at"].forEach((evt) => {
    google.maps.event.addListener(path, evt, () => {
      if (isEditing) updateTurfArea();
    });
  });
}

function updateTurfArea() {
  if (!turfPolygon) return;
  const path = turfPolygon.getPath().getArray();
  const sqft = computeSqft([path]);
  const el = document.getElementById("turfSqft");
  if (el) el.value = Math.round(sqft);
}

//////////////////////
// TOOLS & HANDLERS //
//////////////////////

function wireTools() {
  onClick("btnManualTurf", () => startManualTurf());

  onClick("btnOutlineLot", () => {
    if (!parcelPolygon) return say("Search an address first to get the parcel.");
    // Make a soft editable copy of parcel as the turf starting shape
    if (turfPolygon) turfPolygon.setMap(null);
    const paths = parcelPolygon.getPaths().getArray().map((p) => p.getArray());
    turfPolygon = new google.maps.Polygon({
      paths,
      map,
      strokeColor: "#16a34a",
      strokeWeight: 3,
      strokeOpacity: 1,
      fillColor: "#22c55e",
      fillOpacity: 0.15,
      editable: true,
      zIndex: 3,
    });
    isEditing = true;
    attachTurfEditListeners(turfPolygon);
    updateTurfArea();
    snapshot();
    say("Lot outline copied — edit to match your turf.");
  });

  onClick("btnEdit", () => {
    if (turfPolygon) {
      isEditing = !turfPolygon.getEditable();
      turfPolygon.setEditable(isEditing);
      if (!isEditing) { updateTurfArea(); snapshot(); }
      say(isEditing ? "Editing turf — drag handles to adjust." : "Edit finished.");
    } else if (parcelPolygon) {
      // allow parcel edit toggling if desired
      isEditing = !parcelPolygon.getEditable();
      parcelPolygon.setEditable(isEditing);
      say(isEditing ? "Editing parcel outline." : "Edit finished.");
    } else {
      say("Nothing to edit yet.");
    }
  });

  onClick("btnDelete", () => {
    let deleted = false;
    if (turfPolygon) { turfPolygon.setMap(null); turfPolygon = null; deleted = true; }
    else if (parcelPolygon) { parcelPolygon.setMap(null); parcelPolygon = null; deleted = true; }
    neighborPolygons.forEach((p) => p.setMap(null));
    neighborPolygons.length = 0;
    if (deleted) { snapshot(); say("Shape deleted."); }
  });

  onClick("btnReset", () => resetAll());

  onClick("btnUndo", () => undo());
  onClick("btnRedo", () => redo());

  onClick("btnSave", () => saveGeoJSON());

  onClick("btnSearchAgain", () => {
    // Soft reset (keep page, clear shapes + input, back to roadmap)
    resetAll(/*keepForm=*/true);
    const input = document.getElementById("address");
    if (input) { input.value = ""; input.focus(); }
    map.setMapTypeId("roadmap");
    map.setZoom(13);
    marker.setVisible(false);
    say("Search an address to begin.");
  });

  // Optional: Measure Now button to jump straight into turf drawing
  onClick("measureBtn", () => {
    setSatellite();
    startManualTurf();
  });

  // Prevent form submit from reloading page; we use HTML validation
  const form = document.getElementById("contactForm");
  if (form) {
    form.addEventListener("submit", (e) => {
      if (!form.checkValidity()) {
        // Let native bubbles show
        return;
      }
      e.preventDefault();
      say("Thanks — we’ll follow up shortly.");
    });
  }
}

function onClick(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", (e) => { e.preventDefault(); fn(); });
}

function resetAll(keepForm = false) {
  if (parcelPolygon) { parcelPolygon.setMap(null); parcelPolygon = null; }
  neighborPolygons.forEach((p) => p.setMap(null));
  neighborPolygons.length = 0;
  if (turfPolygon) { turfPolygon.setMap(null); turfPolygon = null; }
  drawMgr.setDrawingMode(null);
  isEditing = false;
  if (!keepForm) {
    setValue("lotSqft", "");
    setValue("turfSqft", "");
    setChecked("smsConsent", false);
  } else {
    setValue("turfSqft", "");
  }
  historyStack.length = 0;
  historyIdx = -1;
}

function setValue(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v;
}
function setChecked(id, v) {
  const el = document.getElementById(id);
  if (el && "checked" in el) el.checked = !!v;
}

//////////////////////
// UNDO / REDO      //
//////////////////////

function snapshot() {
  const state = {
    parcel: parcelPolygon ? pathsToLngLat(parcelPolygon.getPaths()) : null,
    neighbors: neighborPolygons.map((p) => pathsToLngLat(p.getPaths())),
    turf: turfPolygon ? pathToLngLat(turfPolygon.getPath()) : null,
    lotSqft: document.getElementById("lotSqft")?.value || "",
    turfSqft: document.getElementById("turfSqft")?.value || "",
  };
  // Trim redo branch
  historyStack.splice(historyIdx + 1);
  historyStack.push(state);
  historyIdx = historyStack.length - 1;
}

function undo() {
  if (historyIdx <= 0) { say("Nothing to undo."); return; }
  historyIdx--;
  applySnapshot(historyStack[historyIdx]);
  say("Undid last action.");
}

function redo() {
  if (historyIdx >= historyStack.length - 1) { say("Nothing to redo."); return; }
  historyIdx++;
  applySnapshot(historyStack[historyIdx]);
  say("Redid action.");
}

function applySnapshot(state) {
  // clear current
  if (parcelPolygon) { parcelPolygon.setMap(null); parcelPolygon = null; }
  neighborPolygons.forEach((p) => p.setMap(null));
  neighborPolygons.length = 0;
  if (turfPolygon) { turfPolygon.setMap(null); turfPolygon = null; }

  // parcel
  if (state?.parcel) {
    parcelPolygon = new google.maps.Polygon({
      paths: lngLatToPaths(state.parcel),
      map,
      strokeColor: "#ef4444",
      strokeWeight: 3,
      fillOpacity: 0,
      zIndex: 2,
    });
  }
  // neighbors
  (state?.neighbors || []).forEach((pathsArr) => {
    const poly = new google.maps.Polygon({
      paths: lngLatToPaths(pathsArr),
      map,
      strokeColor: "#64748b",
      strokeOpacity: 0.7,
      strokeWeight: 2,
      fillOpacity: 0,
      zIndex: 1,
    });
    neighborPolygons.push(poly);
  });
  // turf
  if (state?.turf) {
    turfPolygon = new google.maps.Polygon({
      paths: [state.turf.map((p) => ({ lat: p.lat, lng: p.lng }))],
      map,
      strokeColor: "#16a34a",
      strokeWeight: 3,
      fillColor: "#22c55e",
      fillOpacity: 0.15,
      editable: false,
      zIndex: 3,
    });
    attachTurfEditListeners(turfPolygon);
  }
  setValue("lotSqft", state?.lotSqft || "");
  setValue("turfSqft", state?.turfSqft || "");
}

// convert Polygon.getPaths() → [[{lng,lat}...], ...]
function pathsToLngLat(mvcArrayOfPaths) {
  const out = [];
  for (let i = 0; i < mvcArrayOfPaths.getLength(); i++) {
    const path = mvcArrayOfPaths.getAt(i);
    out.push(path.getArray().map((ll) => ({ lng: ll.lng(), lat: ll.lat() })));
  }
  return out;
}
// convert Polygon.getPath() for single ring turf → [{lng,lat}...]
function pathToLngLat(mvcArray) {
  return mvcArray.getArray().map((ll) => ({ lng: ll.lng(), lat: ll.lat() }));
}
// inverse: [[{lng,lat}...], ...] → paths arg for new Polygon
function lngLatToPaths(arr) {
  return arr.map((ring) => ring.map((p) => ({ lat: p.lat, lng: p.lng })));
}

//////////////////////
// SAVE (GeoJSON)   //
//////////////////////

function saveGeoJSON() {
  const fc = { type: "FeatureCollection", features: [] };

  if (parcelPolygon) {
    fc.features.push({
      type: "Feature",
      properties: { kind: "parcel" },
      geometry: polygonToGeoJSON(parcelPolygon),
    });
  }
  neighborPolygons.forEach((p, i) => {
    fc.features.push({
      type: "Feature",
      properties: { kind: "neighbor", index: i },
      geometry: polygonToGeoJSON(p),
    });
  });
  if (turfPolygon) {
    fc.features.push({
      type: "Feature",
      properties: { kind: "turf", sqft: +document.getElementById("turfSqft")?.value || null },
      geometry: polygonToGeoJSON(turfPolygon),
    });
  }

  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "measurements.geojson";
  a.click();
  URL.revokeObjectURL(url);
  say("Saved measurements.geojson");
}
// --- Precisely: fetch (FeatureCollection) ---
async function fetchParcelByAddress(address) {
  if (!API_BASE_URL) throw new Error("Set API_BASE_URL to your Vercel app URL");
  const url = `${API_BASE_URL}/api/parcel-by-address?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return await res.json();
}

// --- Draw exactly one parcel polygon in red ---
let parcelPolygon = (typeof parcelPolygon !== "undefined") ? parcelPolygon : null;
function drawSingleParcel(geom) {
  // clear any old
  if (parcelPolygon) { parcelPolygon.setMap(null); parcelPolygon = null; }

  const path = geometryToPath(geom); // [{lat,lng},...]
  if (!path.length) return;

  parcelPolygon = new google.maps.Polygon({
    paths: path,
    map,
    strokeColor: "#ef4444",
    strokeWeight: 3,
    strokeOpacity: 1,
    fillOpacity: 0
  });

  // fit bounds
  const b = new google.maps.LatLngBounds();
  path.forEach(pt => b.extend(pt));
  map.fitBounds(b, 40);

  // optional: write Lot sq ft if you have #lotSqft
  try {
    const sqft = computeSqft([path]);
    const lotEl = document.getElementById("lotSqft");
    if (lotEl && Number.isFinite(sqft)) lotEl.value = Math.round(sqft);
  } catch {}
}

// --- Geometry utilities ---
function geometryToPath(geom) {
  // Returns first outer ring as [{lat,lng}, ...]
  if (!geom) return [];
  if (geom.type === "Polygon") {
    const ring = geom.coordinates?.[0] || [];
    return ring.map(([lng,lat]) => ({ lat, lng }));
  }
  if (geom.type === "MultiPolygon") {
    const ring = geom.coordinates?.[0]?.[0] || [];
    return ring.map(([lng,lat]) => ({ lat, lng }));
  }
  return [];
}

function containsPoint(path, latLng) {
  if (!path?.length || !latLng) return false;
  const poly = new google.maps.Polygon({ paths: path });
  return google.maps.geometry.poly.containsLocation(latLng, poly) ||
         google.maps.geometry.poly.isLocationOnEdge(latLng, poly, 1e-6);
}

function computeSqft(paths) {
  const m2 = paths.reduce((sum, ring) => sum + google.maps.geometry.spherical.computeArea(ring), 0);
  return m2 * 10.7639;
}


function polygonToGeoJSON(poly) {
  const paths = poly.getPaths();
  const rings = [];
  for (let i = 0; i < paths.getLength(); i++) {
    const ring = paths.getAt(i).getArray().map((ll) => [ll.lng(), ll.lat()]);
    // Ensure closed ring
    if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      ring.push([...ring[0]]);
    }
    rings.push(ring);
  }
  return { type: "Polygon", coordinates: rings };
}
