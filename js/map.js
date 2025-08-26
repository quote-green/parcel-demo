// js/map.js

/* =================== CONFIG =================== */
// Optional: your parcel API later, e.g., "https://parcel-api-yourname.vercel.app"
const API_BASE_URL = "";
// Autocomplete suggestions: set to false temporarily if your key blocks Places (403)
const USE_PLACES = true;

/* =================== STATE =================== */
let map, drawManager;
let lotPolygon = null;
const turfPolygons = [];
const undoStack = [];
const redoStack = [];

/* =================== MAP BOOT =================== */
window.initMap = function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 39.8283, lng: -98.5795 },
    zoom: 4,
    mapTypeId: "roadmap",
    tilt: 0,
    heading: 0,
  });

  keepOverhead();
  lockOverhead();

  setupAutocomplete();
  setupDrawingTools();
  say("Ready — search or draw.");
};

/* =================== AUTOCOMPLETE =================== */
async function setupAutocomplete() {
  const host  = document.querySelector(".search-box");
  const input = document.getElementById("address");
  if (!host || !input) return;

  // Always support Enter-to-geocode
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = (input.value || "").trim();
      if (q) await geocode(q);
    }
  });

  if (!USE_PLACES) return;

  // Try new Places widget first (recommended for new keys)
  try { await google.maps.importLibrary?.("places"); } catch (_) {}
  if (google?.maps?.places && "PlaceAutocompleteElement" in google.maps.places) {
    try {
      // @ts-ignore
      const pac = new google.maps.places.PlaceAutocompleteElement();
      pac.placeholder = input.placeholder || "Search address...";
      pac.style.width = "100%";
      host.replaceChild(pac, input);

      // @ts-ignore
      pac.addEventListener("gmp-select", async ({ placePrediction }) => {
        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ["formattedAddress", "location", "viewport"] });
        moveCamera(place.location, place.viewport);
        if (API_BASE_URL && place.formattedAddress) tryDrawParcel(place.formattedAddress);
      });
      say("Search ready (new Places).");
      return;
    } catch (e) {
      console.warn("New Places failed, trying legacy:", e);
    }
  }

  // Legacy Autocomplete (older projects)
  if (google?.maps?.places?.Autocomplete) {
    const ac = new google.maps.places.Autocomplete(input, {
      types: ["address"],
      fields: ["formatted_address", "geometry"],
    });
    ac.addListener("place_changed", () => {
      const p = ac.getPlace();
      if (!p || !p.geometry) return;
      moveCamera(p.geometry.location, p.geometry.viewport);
      if (API_BASE_URL && p.formatted_address) tryDrawParcel(p.formatted_address);
    });
    say("Search ready (legacy Places).");
  }
}

async function geocode(q) {
  const g = new google.maps.Geocoder();
  return new Promise((resolve) => {
    g.geocode({ address: q }, (results, status) => {
      if (status === "OK" && results[0]) {
        const r = results[0];
        moveCamera(r.geometry.location, r.geometry.viewport);
        say("Address found — outline lot or measure turf.");
      } else {
        say("Geocode failed — try a full address.");
      }
      resolve();
    });
  });
}

function moveCamera(location, viewport) {
  if (viewport) map.fitBounds(viewport);
  else if (location) { map.setCenter(location); map.setZoom(18); }
  keepOverhead();
}

/* =================== DRAWING TOOLS =================== */
function setupDrawingTools() {
  drawManager = new google.maps.drawing.DrawingManager({
    drawingControl: false,
    polygonOptions: { fillColor: "#22c55e55", strokeColor: "#16a34a", strokeWeight: 2 },
  });
  drawManager.setMap(map);

  bind("btnOutlineLot", startDrawingLot);
  bind("btnManualTurf", startDrawingTurf);
  bind("measureBtn", () => { say("Click around the turf; double-click to finish."); startDrawingTurf(); });
  bind("btnSearchAgain", resetAll);
  bind("btnReset", resetAll);
  bind("btnDelete", deleteLast);
  bind("btnEdit", toggleEdit);
  bind("btnUndo", undo);
  bind("btnRedo", redo);
  bind("btnSave", saveGeoJSON);
}

function startDrawingLot() {
  drawManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  google.maps.event.addListenerOnce(drawManager, "polygoncomplete", (poly) => {
    if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; }
    lotPolygon = poly;
    poly.setOptions({ fillColor: "#00000000", strokeColor: "#ef4444", strokeWeight: 2 }); // red outline, no fill
    attachPathListeners(poly);
    drawManager.setDrawingMode(null);
    pushAction({ type: "setLot", path: pathToLngLatArray(poly.getPath()) });
    fit(poly);
    updateAreas();
    say("Lot outlined — add turf polygons.");
  });
}

function startDrawingTurf() {
  drawManager.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  google.maps.event.addListenerOnce(drawManager, "polygoncomplete", (poly) => {
    poly.setOptions({ fillColor: "#22c55e55", strokeColor: "#16a34a", strokeWeight: 2 });
    turfPolygons.push(poly);
    attachPathListeners(poly);
    drawManager.setDrawingMode(null);
    pushAction({ type: "addTurf", path: pathToLngLatArray(poly.getPath()) });
    updateAreas();
  });
}

function toggleEdit() {
  // Toggle edit on lot if exists; otherwise on last turf polygon
  if (lotPolygon) {
    lotPolygon.setEditable(!lotPolygon.getEditable());
    say(lotPolygon.getEditable() ? "Lot editable — drag points." : "Edit off.");
    return;
  }
  const last = turfPolygons[turfPolygons.length - 1];
  if (last) {
    last.setEditable(!last.getEditable());
    say(last.getEditable() ? "Turf editable — drag points." : "Edit off.");
  } else {
    say("Nothing to edit yet.");
  }
}

function deleteLast() {
  if (turfPolygons.length) {
    const poly = turfPolygons.pop();
    poly.setMap(null);
    pushAction({ type: "deleteTurf", path: pathToLngLatArray(poly.getPath()) });
    updateAreas();
    say("Deleted last turf polygon.");
    return;
  }
  if (lotPolygon) {
    const path = pathToLngLatArray(lotPolygon.getPath());
    lotPolygon.setMap(null);
    lotPolygon = null;
    pushAction({ type: "deleteLot", path });
    updateAreas();
    say("Deleted lot outline.");
    return;
  }
  say("Nothing to delete.");
}

function resetAll() {
  if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; }
  while (turfPolygons.length) turfPolygons.pop().setMap(null);
  ["lotSqft","turfSqft","firstName","lastName","phone","email"].forEach((id) => { const el = byId(id); if (el) el.value = ""; });
  undoStack.length = 0; redoStack.length = 0;
  say("Reset — type an address and press Enter.");
  updateAreas();
}

/* =================== UNDO / REDO (simple) =================== */
function pushAction(a) { undoStack.push(a); redoStack.length = 0; }
function undo() {
  const a = undoStack.pop(); if (!a) { say("Nothing to undo."); return; }
  if (a.type === "addTurf") {
    // remove the last turf (should match)
    const p = turfPolygons.pop();
    if (p) p.setMap(null);
    redoStack.push({ type: "addTurf", path: a.path });
  } else if (a.type === "setLot") {
    if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; }
    redoStack.push({ type: "setLot", path: a.path });
  } else if (a.type === "deleteTurf") {
    // re-add the deleted turf
    const poly = polygonFromPath(a.path, { fillColor:"#22c55e55", strokeColor:"#16a34a", strokeWeight:2 });
    turfPolygons.push(poly);
    attachPathListeners(poly);
    redoStack.push({ type: "deleteTurf", path: a.path });
  } else if (a.type === "deleteLot") {
    // re-add the deleted lot
    lotPolygon = polygonFromPath(a.path, { fillColor:"#00000000", strokeColor:"#ef4444", strokeWeight:2 });
    attachPathListeners(lotPolygon);
    redoStack.push({ type: "deleteLot", path: a.path });
  }
  updateAreas();
  say("Undid last action.");
}
function redo() {
  const a = redoStack.pop(); if (!a) { say("Nothing to redo."); return; }
  if (a.type === "addTurf") {
    const poly = polygonFromPath(a.path, { fillColor:"#22c55e55", strokeColor:"#16a34a", strokeWeight:2 });
    turfPolygons.push(poly);
    attachPathListeners(poly);
    undoStack.push({ type: "addTurf", path: a.path });
  } else if (a.type === "setLot") {
    if (lotPolygon) lotPolygon.setMap(null);
    lotPolygon = polygonFromPath(a.path, { fillColor:"#00000000", strokeColor:"#ef4444", strokeWeight:2 });
    attachPathListeners(lotPolygon);
    undoStack.push({ type: "setLot", path: a.path });
  } else if (a.type === "deleteTurf") {
    const p = turfPolygons.pop();
    if (p) p.setMap(null);
    undoStack.push({ type: "deleteTurf", path: a.path });
  } else if (a.type === "deleteLot") {
    if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; }
    undoStack.push({ type: "deleteLot", path: a.path });
  }
  updateAreas();
  say("Redid last action.");
}

/* =================== SAVE (GeoJSON download) =================== */
function saveGeoJSON() {
  const gj = {
    type: "FeatureCollection",
    features: []
  };
  if (lotPolygon) {
    gj.features.push(polygonToFeature(lotPolygon, { kind: "lot" }));
  }
  turfPolygons.forEach((poly, i) => {
    gj.features.push(polygonToFeature(poly, { kind: "turf", index: i }));
  });

  const blob = new Blob([JSON.stringify(gj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "measurement.geojson";
  a.click();
  URL.revokeObjectURL(a.href);
  say("Saved GeoJSON.");
}

/* =================== PARCEL FETCH (optional) =================== */
async function tryDrawParcel(formattedAddress) {
  if (!API_BASE_URL) { console.warn("Parcel fetch skipped: API_BASE_URL not set"); return; }
  try {
    const url = `${API_BASE_URL}/api/parcel-by-address?address=${encodeURIComponent(formattedAddress)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const gj   = normalizePreciselyToGeoJSON(data);
    const geom = pickFirstPolygon(gj);
    if (geom) drawParcel(geom);
  } catch (e) {
    console.warn("Parcel fetch failed:", e?.message || e);
  }
}

function drawParcel(geometry) {
  if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; }
  const ring = extractOuterRing(geometry);
  if (!ring || !ring.length) return;

  const path = ring.map(([lng, lat]) => ({ lat, lng }));
  lotPolygon = new google.maps.Polygon({
    paths: path,
    map,
    strokeColor: "#ef4444",
    strokeWeight: 2,
    fillOpacity: 0,
  });
  attachPathListeners(lotPolygon);
  pushAction({ type: "setLot", path: path.map(p => [p.lng, p.lat]) });
  fit(lotPolygon);
  updateAreas();
  say("Parcel drawn — add turf polygons.");
}

/* =================== HELPERS =================== */
function keepOverhead(){ if(!map) return; map.setMapTypeId("roadmap"); map.setHeading(0); map.setTilt(0); }
function lockOverhead(){ map.addListener("tilt_changed",()=> map.getTilt()!==0 && map.setTilt(0)); map.addListener("heading_changed",()=> map.getHeading()!==0 && map.setHeading(0)); }
function fit(poly){ const b=new google.maps.LatLngBounds(); poly.getPath().forEach(p=>b.extend(p)); map.fitBounds(b); keepOverhead(); }
function updateAreas(){
  const m2 = (poly) => google.maps.geometry.spherical.computeArea(poly.getPath());
  const lot  = lotPolygon ? m2(lotPolygon) * 10.7639 : 0;
  const turf = turfPolygons.reduce((s, p) => s + m2(p) * 10.7639, 0);
  if (byId("lotSqft"))  byId("lotSqft").value  = Math.round(lot);
  if (byId("turfSqft")) byId("turfSqft").value = Math.round(turf);
}
function attachPathListeners(poly){
  const path = poly.getPath();
  ["set_at","insert_at","remove_at"].forEach(ev => path.addListener(ev, updateAreas));
}
function bind(id, fn){ const el = byId(id); if (el) el.addEventListener("click", fn); }
function byId(id){ return document.getElementById(id); }
function say(msg){ const el = byId("mapCaption"); if (el) el.textContent = msg; }

/* ---- GeoJSON utilities ---- */
function polygonToFeature(poly, props){
  const coords = [ pathToLngLatArray(poly.getPath()) ];
  return { type:"Feature", geometry:{ type:"Polygon", coordinates: coords }, properties: props || {} };
}
function pathToLngLatArray(path){
  const arr = [];
  for (let i=0; i<path.getLength(); i++){
    const p = path.getAt(i);
    arr.push([p.lng(), p.lat()]);
  }
  // ensure ring closed
  if (arr.length && (arr[0][0] !== arr[arr.length-1][0] || arr[0][1] !== arr[arr.length-1][1])) {
    arr.push(arr[0].slice());
  }
  return arr;
}
function polygonFromPath(lnglat, opts){
  const path = lnglat.map(([lng,lat]) => ({ lat, lng }));
  const poly = new google.maps.Polygon(Object.assign({
    paths: path, map
  }, opts || {}));
  return poly;
}
function normalizePreciselyToGeoJSON(payload) {
  if (payload?.type === "FeatureCollection" || payload?.type === "Feature") return payload;
  if (Array.isArray(payload?.features)) return { type: "FeatureCollection", features: payload.features };
  if (payload?.geometry?.type && payload?.geometry?.coordinates) return { type: "Feature", geometry: payload.geometry, properties: payload.properties || {} };
  return { type: "FeatureCollection", features: [] };
}
function pickFirstPolygon(gj) {
  const feats = gj?.type === "FeatureCollection" ? gj.features : [gj];
  const f = (feats || []).find((x) => x?.geometry?.type?.includes("Polygon"));
  return f ? f.geometry : null;
}
function extractOuterRing(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  const c = geometry.coordinates;
  if (geometry.type === "MultiPolygon") return c?.[0]?.[0] || null;
  if (geometry.type === "Polygon") return c?.[0] || null;
  if (Array.isArray(c?.[0]) && typeof c[0][0] === "number") return c;
  return null;
}
