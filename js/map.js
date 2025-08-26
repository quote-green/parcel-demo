// js/map.js  (SAFE COMPACT v8 — required fields enforced + no refresh + satellite)
// Requires: your current index.html. Search Again still hard-reloads.

const API_BASE_URL = ""; // optional parcel API later

let map, drawMgr;
let lotPolygon = null;
const turfPolys = [];
const undoStack = [];
const redoStack = [];
let searchControlEl = null; // <gmp-place-autocomplete> or <input id="address">

// ---------- BOOT ----------
window.initMap = async function initMap() {
  try {
    if (google.maps.importLibrary) {
      await google.maps.importLibrary("maps");
      await google.maps.importLibrary("geometry");
      await google.maps.importLibrary("drawing");
      try { await google.maps.importLibrary("places"); } catch (_) {}
    }

    // Start in SATELLITE
    map = new google.maps.Map(document.getElementById("map"), {
      center: { lat: 39.8283, lng: -98.5795 },
      zoom: 4,
      mapTypeId: "satellite",
      tilt: 0,
      heading: 0
    });

    enforceSatellite(); // keep type = satellite
    keepOverhead();     // keep tilt/heading = 0
    lockOverhead();     // prevent tilt/heading changes

    ensureLeftPaneAndForm();   // contact form + required + submit logic
    await setupAutocomplete(); // dropdown + Enter fallback
    ensureToolbar();           // ensure map tools
    setupDrawingTools();       // wire events

    say("Ready — start typing or press Enter.");
    console.log("[OK] map init (satellite forced)");
  } catch (e) {
    console.error("[ERR] initMap:", e);
    say("Map failed to initialize. Check console.");
  }
};

// ---------- KEEP MAP TYPE = SATELLITE ----------
function enforceSatellite() {
  const SAT = (google.maps.MapTypeId && google.maps.MapTypeId.SATELLITE) ? google.maps.MapTypeId.SATELLITE : "satellite";
  try { map.setMapTypeId(SAT); } catch (_) {}
  map.addListener("maptypeid_changed", () => {
    const cur = map.getMapTypeId ? map.getMapTypeId() : map.get("mapTypeId");
    if (cur !== SAT) map.setMapTypeId(SAT);
  });
}
function setSatellite() {
  const SAT = (google.maps.MapTypeId && google.maps.MapTypeId.SATELLITE) ? google.maps.MapTypeId.SATELLITE : "satellite";
  if (map.getMapTypeId && map.getMapTypeId() !== SAT) map.setMapTypeId(SAT);
  keepOverhead();
}

// ---------- BUILD/RESTORE LEFT PANE + REQUIRED ----------
function ensureLeftPaneAndForm(){
  const page = document.querySelector(".page");
  if (!page) return;

  let leftCard = [...page.querySelectorAll(".card")].find(c => c.querySelector(".search-box"));
  if (!leftCard) {
    leftCard = document.createElement("section");
    leftCard.className = "card";
    leftCard.innerHTML = `<div class="search-box"></div>`;
    page.insertBefore(leftCard, page.firstChild);
  }

  let searchBox = leftCard.querySelector(".search-box");
  if (!searchBox) {
    searchBox = document.createElement("div");
    searchBox.className = "search-box";
    leftCard.prepend(searchBox);
  }
  if (!leftCard.querySelector("#address")) {
    const input = document.createElement("input");
    input.id = "address"; input.name = "address"; input.type = "search";
    input.placeholder = "Search address..."; input.autocomplete = "off";
    input.setAttribute("aria-label","Search for an address");
    searchBox.appendChild(input);
  }

  let form = leftCard.querySelector("#contactForm");
  if (!form) {
    form = document.createElement("form");
    form.id = "contactForm";
    form.innerHTML = `
      <div class="grid-2" style="margin-top:12px;">
        <div><label for="firstName">First Name</label><input id="firstName" name="firstName" type="text" autocomplete="given-name"></div>
        <div><label for="lastName">Last Name</label><input id="lastName" name="lastName" type="text" autocomplete="family-name"></div>
      </div>
      <div class="grid-2" style="margin-top:12px;">
        <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel"></div>
        <div><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email"></div>
      </div>
      <div style="margin-top:12px;">
        <label for="referrer">How did you find us?</label>
        <select id="referrer" name="referrer">
          <option value="" disabled selected>Select one...</option>
          <option>Google</option><option>Friend</option><option>Social Media</option>
          <option>Yard Sign / Vehicle</option><option>Other</option>
        </select>
      </div>
      <div class="checkbox-row">
        <input id="smsConsent" name="smsConsent" type="checkbox">
        <label for="smsConsent">Permission to contact you on this phone number</label>
      </div>
      <div class="half-inch-gap pair">
        <div><label for="lotSqft">Lot sq ft</label><input id="lotSqft" name="lotSqft" type="number" min="0" step="1"></div>
        <div><label for="turfSqft">Turf sq ft</label><input id="turfSqft" name="turfSqft" type="number" min="0" step="1"></div>
      </div>
      <div class="half-inch-gap"><button id="measureBtn" type="button" class="btn btn-primary">Measure Now</button></div>
      <div class="half-inch-gap"><button id="continueBtn" type="submit" class="btn btn-secondary">Continue</button></div>
    `;
    leftCard.appendChild(form);
  }

  // REQUIRED + client-side validation wiring
  enforceRequiredFields(form);
  setupFormValidation(form);
}

function enforceRequiredFields(form){
  const req = (sel, cb) => {
    const el = form.querySelector(sel);
    if (!el) return;
    el.required = true;
    el.setAttribute("aria-required","true");
    if (typeof cb === "function") cb(el);
    ensureErrorSlot(el);
  };

  req("#firstName");
  req("#lastName");
  req("#email"); // type=email handles format
  req("#phone", (el) => {
    el.pattern = "[0-9\\-+() .]{7,}";
    el.title = "Please enter a valid phone number (at least 7 digits).";
  });
  req("#referrer");
  req("#smsConsent", (el) => { el.required = true; });
}

function setupFormValidation(form){
  // Remove novalidate to allow native checks
  form.removeAttribute("novalidate");

  // Recompute button disabled state on input
  const watch = ["#firstName","#lastName","#email","#phone","#referrer","#smsConsent"];
  const updateButton = () => {
    const btn = form.querySelector("#continueBtn");
    if (!btn) return;
    btn.disabled = !form.checkValidity();
  };
  watch.forEach(sel => {
    const el = form.querySelector(sel);
    if (!el) return;
    el.addEventListener("input", () => { clearError(el); updateButton(); });
    el.addEventListener("change", () => { clearError(el); updateButton(); });
  });
  updateButton();

  // Intercept submit: never navigate; show errors if invalid
  form.addEventListener("submit", (e) => {
    e.preventDefault(); // <-- stops refresh
    if (!form.checkValidity()) {
      showInlineErrors(form);
      form.reportValidity(); // also show native bubble
      say("Please complete the required fields.");
      return;
    }
    // Success path — keep user on page, show confirmation
    say("Thanks — we’ll follow up shortly.");
  });
}

function ensureErrorSlot(el){
  // Add a <div class="field-hint"> under the field if missing
  const wrap = el.closest("div");
  if (!wrap) return;
  if (!wrap.querySelector(".field-hint")) {
    const hint = document.createElement("div");
    hint.className = "field-hint";
    hint.style.display = "none";
    wrap.appendChild(hint);
  }
}
function setError(el, msg){
  const wrap = el.closest("div");
  if (!wrap) return;
  const hint = wrap.querySelector(".field-hint");
  if (!hint) return;
  hint.textContent = msg || "";
  hint.style.display = msg ? "block" : "none";
  el.classList.add("invalid");
}
function clearError(el){
  const wrap = el.closest("div");
  if (!wrap) return;
  const hint = wrap.querySelector(".field-hint");
  if (hint) { hint.textContent = ""; hint.style.display = "none"; }
  el.classList.remove("invalid");
}
function showInlineErrors(form){
  const f = (sel) => form.querySelector(sel);
  const firstName = f("#firstName");
  const lastName  = f("#lastName");
  const email     = f("#email");
  const phone     = f("#phone");
  const referrer  = f("#referrer");
  const consent   = f("#smsConsent");

  if (firstName && !firstName.checkValidity()) setError(firstName, "First name is required.");
  if (lastName  && !lastName.checkValidity())  setError(lastName,  "Last name is required.");
  if (email     && !email.checkValidity())     setError(email,     email.validationMessage || "Enter a valid email.");
  if (phone     && !phone.checkValidity())     setError(phone,     phone.validationMessage || "Enter a valid phone.");
  if (referrer  && !referrer.checkValidity())  setError(referrer,  "Please select one option.");
  if (consent   && !consent.checkValidity())   setError(consent,   "Please check this box to continue.");
}

// ---------- AUTOCOMPLETE (new -> legacy -> Enter) ----------
async function setupAutocomplete() {
  const host  = document.querySelector(".search-box");
  const input = document.getElementById("address");
  if (!host || !input) return;

  // Enter-to-geocode fallback
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = (input.value || "").trim();
      if (q) await geocode(q);
    }
  });

  // New Places element
  if (google?.maps?.places && "PlaceAutocompleteElement" in google.maps.places) {
    try {
      const pac = new google.maps.places.PlaceAutocompleteElement();
      pac.placeholder = input.placeholder || "Search address...";
 // style + replace wrapper so there’s only one box
styleSearchElement(pac);
if (input && input.remove) input.remove();
if (host && host.replaceWith) {
  host.replaceWith(pac);
} else {
  host.appendChild(pac);
}
searchControlEl = pac;



      pac.addEventListener("gmp-select", async ({ placePrediction }) => {
        try {
          const place = placePrediction.toPlace();
          await place.fetchFields({ fields: ["formattedAddress","location","viewport"] });
          moveCamera(place.location ?? null, place.viewport ?? null, 19);
          setSatellite();
          if (API_BASE_URL && place.formattedAddress) tryDrawParcel(place.formattedAddress);
        } catch (err) { console.warn("[places:new] select error:", err); }
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
      types: ["address"], fields: ["formatted_address","geometry"]
    });
    ac.addListener("place_changed", () => {
      const p = ac.getPlace(); if (!p || !p.geometry) return;
      moveCamera(p.geometry.location ?? null, p.geometry.viewport ?? null, 19);
      setSatellite();
      if (API_BASE_URL && p.formatted_address) tryDrawParcel(p.formatted_address);
    });
    searchControlEl = input;
    console.log("[places] legacy Autocomplete ready");
    say("Suggestions ready.");
    return;
  }

  // Enter-only
  searchControlEl = input;
  console.warn("[places] no dropdown available; using Enter only");
  say("Press Enter to geocode.");
}

// ---------- GEOCODE & CAMERA ----------
function geocode(q) {
  const g = new google.maps.Geocoder();
  return new Promise((resolve) => {
    g.geocode({ address: q }, (results, status) => {
      if (status === "OK" && results[0]) {
        const r = results[0];
        moveCamera(r.geometry.location ?? null, r.geometry.viewport ?? null, 19);
        setSatellite();
        say("Address found — outline lot or measure turf.");
      } else {
        say("Geocode failed — try a full address.");
      }
      resolve();
    });
  });
}

/** Tight zoom + keep overhead (2D). */
function moveCamera(location, viewport, zoom = 19) {
  if (location) {
    map.setCenter(location);
    map.setZoom(zoom);
    keepOverhead();
    return;
  }
  if (viewport) {
    map.fitBounds(viewport);
    google.maps.event.addListenerOnce(map, "idle", () => {
      map.setZoom(zoom);
      keepOverhead();
    });
    return;
  }
  keepOverhead();
}

// ---------- TOOLBAR (auto-create if missing) ----------
function ensureToolbar() {
  let tools = document.querySelector(".tools");
  if (tools) return tools;
  const mapCard = document.querySelector(".map-card") || document.body;
  tools = document.createElement("nav");
  tools.className = "tools";
  tools.setAttribute("aria-label", "Map tools");
  tools.style.cssText = "width:84px;flex-shrink:0;border:1px solid #e5e7eb;border-radius:14px;background:#f9f9f9;display:flex;flex-direction:column;gap:10px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.08);height:fit-content;margin-left:10px;";
  tools.innerHTML = `
    <button id="btnManualTurf">Manual Turf Measure</button>
    <button id="btnOutlineLot">Outline Property Boundaries</button>
    <button id="btnEdit">Edit</button>
    <button id="btnDelete">Delete</button>
    <button id="btnReset">Reset</button>
    <button id="btnUndo">Undo</button>
    <button id="btnRedo">Redo</button>
    <button id="btnSave">Save</button>
    <button id="btnSearchAgain" title="Start a new search">Search Again</button>
  `;
  tools.querySelectorAll("button").forEach((b) => {
    b.style.cssText = "width:100%;padding:10px 8px;font-size:13px;background:#fff;border:1px solid #ccc;border-radius:8px;cursor:pointer;";
    b.addEventListener("mouseover", () => (b.style.background = "#eee"));
    b.addEventListener("mouseout",  () => (b.style.background = "#fff"));
  });
  const again = tools.querySelector("#btnSearchAgain");
  if (again) { again.style.background = "#22c55e"; again.style.color = "#fff"; again.style.borderColor = "#16a34a"; }
  mapCard.appendChild(tools);
  return tools;
}

// ---------- DRAWING TOOLS ----------
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

  // REFRESH the whole page on "Search Again"
  bind("btnSearchAgain", forceReload);

  bind("btnReset", () => { resetAll(false); });
  bind("btnDelete", deleteLast);
  bind("btnEdit", toggleEdit);
  bind("btnUndo", undo);
  bind("btnRedo", redo);
  bind("btnSave", saveGeoJSON);

  console.log("[drawing] toolbar wired");
}

function forceReload() {
  try {
    const url = new URL(location.href);
    url.searchParams.set("cb", Date.now().toString());
    location.replace(url.toString());
  } catch (_) {
    location.reload();
  }
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

function resetAll(focusSearch) {
  if (lotPolygon) { lotPolygon.setMap(null); lotPolygon = null; }
  while (turfPolys.length) turfPolys.pop().setMap(null);
  ["lotSqft","turfSqft","firstName","lastName","phone","email"].forEach(id => { const el = byId(id); if (el) el.value = ""; });
  undoStack.length = 0; redoStack.length = 0;
  say("Reset — search again.");
  updateAreas();

  try {
    if (searchControlEl) {
      if ("value" in searchControlEl) searchControlEl.value = "";
      if (focusSearch && typeof searchControlEl.focus === "function") searchControlEl.focus();
    } else {
      const input = document.getElementById("address");
      if (focusSearch && input) input.focus();
    }
  } catch (_) {}
}

// ---------- UNDO/REDO ----------
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
  else if (a.type==="deleteLot"){ if (lotPolygon) { lotPolygon.setMap(null); lotPolygon=null; } undoStack.push({type:"deleteLot",path:a.path}); }
  updateAreas(); say("Redid last action.");
}

// ---------- SAVE ----------
function saveGeoJSON(){
  const gj = { type:"FeatureCollection", features:[] };
  if (lotPolygon) gj.features.push(polygonToFeature(lotPolygon,{kind:"lot"}));
  turfPolys.forEach((poly,i)=>gj.features.push(polygonToFeature(poly,{kind:"turf",index:i})));
  const blob = new Blob([JSON.stringify(gj,null,2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download="measurement.geojson"; a.click();
  URL.revokeObjectURL(a.href); say("Saved GeoJSON.");
}

// ---------- Optional parcel fetch ----------
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

// ---------- HELPERS ----------
function keepOverhead(){ map.setHeading(0); map.setTilt(0); }
function lockOverhead(){
  map.addListener("tilt_changed",   ()=> map.getTilt()!==0    && map.setTilt(0));
  map.addListener("heading_changed",()=> map.getHeading()!==0 && map.setHeading(0));
}
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
  if (p?.geometry?.type && p?.geometry?.coordinates) return { type:"Feature", geometry:p.geometry, properties:p.properties||{} };
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
function flattenSearchBox(host){
  // Remove the outer pill so we don't see a box-inside-a-box
  if (!host) return;
  host.style.border = "0";
  host.style.padding = "0";
  host.style.background = "transparent";
  host.style.borderRadius = "0";
  host.style.boxShadow = "none";
} 
function styleSearchElement(el) {
  if (!el) return;
  // visuals
  el.style.display = "block";
  el.style.width = "100%";
  el.style.boxSizing = "border-box";
  el.style.border = "2px solid #1f2937";
  el.style.borderRadius = "999px";      // <- round corners (change to "12px" if you prefer)
  el.style.padding = "10px 14px";
  el.style.background = "#e5e7eb";
  el.style.color = "#111827";
  el.style.outline = "none";
  // helper text
  if ("placeholder" in el) {
    el.placeholder = "Search address (street, city or full address)…";
  }
}


