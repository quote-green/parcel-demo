// js/map.js  (SAFE COMPACT v1)
// Dropdown (new Places -> legacy), Enter-to-geocode, drawing tools, overhead lock.

const API_BASE_URL = ""; // optional parcel API later

let map, drawMgr;
let lotPolygon = null;
const turfPolys = [];
const undoStack = [];
const redoStack = [];

// --------- BOOT ----------
window.initMap = async function initMap() {
  try {
    // Load libs if supported
    if (google.maps.importLibrary) {
      await google.maps.importLibrary("maps");
      await google.maps.importLibrary("geometry");
      await google.maps.importLibrary("drawing");
      try { await google.maps.importLibrary("places"); } catch (_) {}
    }

    // Map
    map = new google.maps.Map(document.getElementById("map"), {
      center: { lat: 39.8283, lng: -98.5795 },
      zoom: 4,
      mapTypeId: "roadmap",
      tilt: 0,
      heading: 0
    });
    keepOverhead();
    lockOverhead();

    await setupAutocomplete(); // dropdown + Enter fallback
    setupDrawingTools();       // toolbar

    say("Ready — start typing or press Enter.");
    console.log("[OK] map init");
  } catch (e) {
    console.error("[ERR] initMap:", e);
    say("Map failed to initialize. Check console.");
  }
};

// --------- AUTOCOMPLETE (new -> legacy -> Enter) ----------
async function setupAutocomplete() {
  const host  = document.querySelector(".search-box");
  const input = document.getElementById("address");
  if (!host || !input) return;

  // Always: Enter-to-geocode fallback
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = (input.value || "").trim();
      if (q) await geocode(q);
    }
  });

  // New Places element (preferred)
  if (google?.maps?.places && "PlaceAutocompleteElement" in google.maps.places) {
    try {
      const pac = new google.maps.places.PlaceAutocompleteElement();
      pac.placeholder = input.placeholder || "Search address...";
      pac.style.width = "100%";
      // SAFE mount: append (don't replace) then hide input — avoids observer(null) issues
      host.appendChild(pac);
      input.style.display = "none";

      pac.addEventListener("gmp-select", async ({ placePrediction }) => {
        try {
          const place = placePrediction.toPlace();
          await place.fetchFields({ fields: ["formattedAddress","location","viewport"] });
          moveCamera(place.location, place.viewport);
          if (API_BASE_URL && place.formattedAddress) tryDrawParcel(place.formattedAddress);
        } catch (err) {
          console.warn("[places:new] select error:", err);
        }
      });

      console.log("[places] new element ready");
      say("Suggestions ready.");
      return;
    } catch (e) {
      console.warn("[places] new element failed; falling back:", e);
    }
  }

  // Legacy Autocomplete
  if (google?.maps?.places?.Autocomplete) {
    const ac = new google.maps.places.Autocomplete(input, {
      types: ["address"],
      fields: ["formatted_address","geometry"]
    });
    ac.addListener("place_changed", () => {
      const p = ac.getPlace();
      if (!p || !p.geometry) return;
      moveCamera(p.geometry.location, p.geometry.viewport);
      if (API_BASE_URL && p.formatted_address) tryDrawParcel(p.formatted_address);
    });
    console.log("[places] legacy Autocomplete ready");
    say("Suggestions ready.");
    return;
  }

  // Otherwise, Enter-to-geocode only
  console.warn("[places] no dropdown available; using Enter only");
  say("Press Enter to geocode.");
}

// --------- GEOCODE & CAMERA ----------
function geocode(q) {
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

// --------- DRAWING TOOLS ----------
function setupDrawingTools() {
  if (!google?.maps?.drawing) {
    console.error("[drawing] library missing");
    say("Drawing tools unavailable — check script libraries.");
    return;
  }

  drawMgr = new google.maps.drawing.DrawingManager({
    drawingControl: false,
    polygonOptions: { fillColor:"#22c55e55", strokeColor:"#16a34a", strokeWeight:2 }
  });
  drawMgr.setMap(map);

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

  console.log("[drawing] toolbar wired");
}

function startDrawingLot() {
  drawMgr.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  google.maps.event.addListenerOnce(drawMgr, "polygoncomplete", (poly) => {
    if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; }
    lotPolygon = poly;
    poly.setOptions({ fillColor:"#0000", strokeColor:"#ef4444", strokeWeight:2 });
    attachPathListeners(poly);
    drawMgr.setDrawingMode(null);
    pushAction({ type:"setLot", path:pathToLngLatArray(poly.getPath()) });
    fit(poly); updateAreas(); say("Lot outlined — add turf polygons.");
  });
}
function startDrawingTurf() {
  drawMgr.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
  google.maps.event.addListenerOnce(drawMgr, "polygoncomplete", (poly) => {
    poly.setOptions({ fillColor:"#22c55e55", strokeColor:"#16a34a", strokeWeight:2 });
    turfPolys.push(poly);
    attachPathListeners(poly);
    drawMgr.setDrawingMode(null);
    pushAction({ type:"addTurf", path:pathToLngLatArray(poly.getPath()) });
    updateAreas();
  });
}

function toggleEdit() {
  if (lotPolygon) {
    lotPolygon.setEditable(!lotPolygon.getEditable());
    say(lotPolygon.getEditable() ? "Lot editable — drag points." : "Edit off.");
    return;
  }
  const last = turfPolys[turfPolys.length - 1];
  if (last) {
    last.setEditable(!last.getEditable());
    say(last.getEditable() ? "Turf editable — drag points." : "Edit off.");
  } else {
    say("Nothing to edit yet.");
  }
}

function deleteLast() {
  if (turfPolys.length) {
    const p = turfPolys.pop(); p.setMap(null);
    pushAction({ type:"deleteTurf", path:pathToLngLatArray(p.getPath()) });
    updateAreas(); say("Deleted last turf polygon."); return;
  }
  if (lotPolygon) {
    const path = pathToLngLatArray(lotPolygon.getPath());
    lotPolygon.setMap(null); lotPolygon = null;
    pushAction({ type:"deleteLot", path }); updateAreas(); say("Deleted lot outline."); return;
  }
  say("Nothing to delete.");
}

function resetAll() {
  if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; }
  while (turfPolys.length) turfPolys.pop().setMap(null);
  ["lotSqft","turfSqft","firstName","lastName","phone","email"].forEach(id => { const el = byId(id); if (el) el.value = ""; });
  undoStack.length = 0; redoStack.length = 0;
  say("Reset — search again."); updateAreas();
}

// --------- UNDO/REDO ----------
function pushAction(a){ undoStack.push(a); redoStack.length = 0; }
function undo(){
  const a = undoStack.pop(); if (!a) return say("Nothing to undo.");
  if (a.type==="addTurf"){ const p=turfPolys.pop(); if(p) p.setMap(null); redoStack.push({type:"addTurf",path:a.path}); }
  else if (a.type==="setLot"){ if(lotPolygon){lotPolygon.setMap(null); lotPolygon=null;} redoStack.push({type:"setLot",path:a.path}); }
  else if (a.type==="deleteTurf"){ const p=polygonFromPath(a.path,{fillColor:"#22c55e55",strokeColor:"#16a34a",strokeWeight:2}); turfPolys.push(p); attachPathListeners(p); redoStack.push({type:"deleteTurf",path:a.path}); }
  else if (a.type==="deleteLot"){ lotPolygon=polygonFromPath(a.path,{fillColor:"#0000",strokeColor:"#ef4444",strokeWeight:2}); attachPathListeners(lotPolygon); redoStack.push({type:"deleteLot",path:a.path}); }
  updateAreas(); say("Undid last action.");
}
function redo(){
  const a = redoStack.pop(); if (!a) return say("Nothing to redo.");
  if (a.type==="addTurf"){ const p=polygonFromPath(a.path,{fillColor:"#22c55e55",strokeColor:"#16a34a",strokeWeight:2}); turfPolys.push(p); attachPathListeners(p); undoStack.push({type:"addTurf",path:a.path}); }
  else if (a.type==="setLot"){ if(lotPolygon) lotPolygon.setMap(null); lotPolygon=polygonFromPath(a.path,{fillColor:"#0000",strokeColor:"#ef4444",strokeWeight:2}); attachPathListeners(lotPolygon); undoStack.push({type:"setLot",path:a.path}); }
  else if (a.type==="deleteTurf"){ const p=turfPolys.pop(); if(p) p.setMap(null); undoStack.push({type:"deleteTurf",path:a.path}); }
  else if (a.type==="deleteLot"){ if(lotPolygon){lotPolygon.setMap(null); lotPolygon=null;} undoStack.push({type:"deleteLot",path:a.path}); }
  updateAreas(); say("Redid last action.");
}

// --------- SAVE ----------
function saveGeoJSON(){
  const gj = { type:"FeatureCollection", features:[] };
  if (lotPolygon) gj.features.push(polygonToFeature(lotPolygon,{kind:"lot"}));
  turfPolys.forEach((poly,i)=>gj.features.push(polygonToFeature(poly,{kind:"turf",index:i})));
  const blob = new Blob([JSON.stringify(gj,null,2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download="measurement.geojson"; a.click();
  URL.revokeObjectURL(a.href); say("Saved GeoJSON.");
}

// --------- Optional parcel fetch ----------
async function tryDrawParcel(formattedAddress){
  if (!API_BASE_URL) return;
  try {
    const url = `${API_BASE_URL}/api/parcel-by-address?address=${encodeURIComponent(formattedAddress)}`;
    const res = await fetch(url); if(!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const gj = normalizePreciselyToGeoJSON(data);
    const geom = pickFirstPolygon(gj);
    if (geom) drawParcel(geom);
  } catch(e){ console.warn("parcel fetch failed:", e?.message||e); }
}
function drawParcel(geometry){
  if (lotPolygon){ lotPolygon.setMap(null); lotPolygon=null; }
  const ring = extractOuterRing(geometry); if(!ring?.length) return;
  const path = ring.map(([lng,lat])=>({lat,lng}));
  lotPolygon = new google.maps.Polygon({ paths:path, map, strokeColor:"#ef4444", strokeWeight:2, fillOpacity:0 });
  attachPathListeners(lotPolygon);
  pushAction({type:"setLot", path: path.map(p=>[p.lng,p.lat])});
  fit(lotPolygon); updateAreas(); say("Parcel drawn — add turf polygons.");
}

// --------- HELPERS ----------
function keepOverhead(){ map.setMapTypeId("roadmap"); map.setHeading(0); map.setTilt(0); }
function lockOverhead(){ map.addListener("tilt_changed",()=> map.getTilt()!==0 && map.setTilt(0)); map.addListener("heading_changed",()=> map.getHeading()!==0 && map.setHeading(0)); }
function fit(poly){ const b=new google.maps.LatLngBounds(); poly.getPath().forEach(p=>b.extend(p)); map.fitBounds(b); keepOverhead(); }
function updateAreas(){
  const m2 = (poly)=>google.maps.geometry.spherical.computeArea(poly.getPath());
  const lot  = lotPolygon ? m2(lotPolygon)*10.7639 : 0;
  const turf = turfPolys.reduce((s,p)=> s + m2(p)*10.7639, 0);
  if (byId("lotSqft"))  byId("lotSqft").value  = Math.round(lot);
  if (byId("turfSqft")) byId("turfSqft").value = Math.round(turf);
}
function attachPathListeners(poly){ const path=poly.getPath(); ["set_at","insert_at","remove_at"].forEach(ev=>path.addListener(ev, updateAreas)); }
function bind(id,fn){ const el=byId(id); if(el) el.addEventListener("click", fn); }
function byId(id){ return document.getElementById(id); }
function say(t){ const el=byId("mapCaption"); if(el) el.textContent=t; }

function polygonToFeature(poly, props){
  const coords = [ pathToLngLatArray(poly.getPath()) ];
  return { type:"Feature", geometry:{ type:"Polygon", coordinates: coords }, properties: props||{} };
}
function pathToLngLatArray(path){
  const arr=[]; for(let i=0;i<path.getLength();i++){ const p=path.getAt(i); arr.push([p.lng(),p.lat()]); }
  const a0 = arr[0], an = arr[arr.length-1];
  if (arr.length && (a0[0]!==an[0] || a0[1]!==an[1])) arr.push(a0.slice());
  return arr;
}
function polygonFromPath(lnglat, opts){ const path=lnglat.map(([lng,lat])=>({lat,lng})); return new google.maps.Polygon(Object.assign({ paths:path, map }, opts||{})); }
function normalizePreciselyToGeoJSON(p){
  if (p?.type==="FeatureCollection"||p?.type==="Feature") return p;
  if (Array.isArray(p?.features)) return {type:"FeatureCollection",features:p.features};
  if (p?.geometry?.type && p?.geometry?.coordinates) return {type:"Feature",geometry:p.geometry,properties:p.properties||{}};
  return {type:"FeatureCollection",features:[]};
}
function pickFirstPolygon(gj){ const fs=gj?.type==="FeatureCollection"?gj.features:[gj]; const f=(fs||[]).find(x=>x?.geometry?.type?.includes("Polygon")); return f?f.geometry:null; }
function extractOuterRing(g){
  if(!g||!g.coordinates) return null; const c=g.coordinates;
  if (g.type==="MultiPolygon") return c?.[0]?.[0]||null;
  if (g.type==="Polygon")      return c?.[0]||null;
  if (Array.isArray(c?.[0]) && typeof c[0][0]==="number") return c;
  return null;
}
// END FILE
