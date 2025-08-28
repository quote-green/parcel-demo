// js/map.js — sidebar tools wired + Search Again clears form + parcels + validation
(() => {
  "use strict";

  // One-time global for your Vercel API (safe even if included twice)
  if (!window.API_BASE_URL) window.API_BASE_URL = "https://parcel-api-ohx5.vercel.app";

  let map, ac, marker, drawMgr;

  // ========== MAP ENTRY POINT ==========
  window.initMap = function initMap() {
    // Base map
    map = new google.maps.Map(document.getElementById("map"), {
      center: { lat: 37.773972, lng: -122.431297 },
      zoom: 13,
      mapTypeId: "roadmap",
      tilt: 0,
      heading: 0,
      clickableIcons: false,
      streetViewControl: false,
      fullscreenControl: true,
      mapTypeControl: true,
      gestureHandling: "greedy",
    });

    marker = new google.maps.Marker({ map, visible: false });

    // Drawing manager (manual turf)
    drawMgr = new google.maps.drawing.DrawingManager({
      drawingControl: false,
      polygonOptions: {
        strokeColor: "#16a34a",
        strokeWeight: 3,
        strokeOpacity: 1,
        fillColor: "#22c55e",
        fillOpacity: 0.15,
        editable: false,
        zIndex: 3,
      },
    });
    drawMgr.setMap(map);

    // Finish a manual polygon
    google.maps.event.addListener(drawMgr, "overlaycomplete", (e) => {
      if (e.type === google.maps.drawing.OverlayType.POLYGON) {
        setTurfPolygon(e.overlay);
        drawMgr.setDrawingMode(null);
        attachTurfEditListeners(getTurfPolygon());
        updateTurfArea();
        say("Turf polygon created — use Edit to adjust.");
        snapshot();
      }
    });

    // Wire sidebar tools + form validation
    wireTools();
    setupFormValidation();

    // Autocomplete on #address
    const input = document.getElementById("address");
    if (!input || !google.maps.places) {
      console.warn("Missing #address or Places library");
      say("Search box not ready.");
      return;
    }

    ac = new google.maps.places.Autocomplete(input, {
      types: ["address"],
      fields: ["formatted_address", "geometry"],
    });

    ac.addListener("place_changed", async () => {
      const p = ac.getPlace();
      if (!p || !p.geometry) return;

      // Camera + satellite overhead
      moveCamera(p.geometry.location ?? null, p.geometry.viewport ?? null, 19);
      setSatellite();

      marker.setPosition(p.geometry.location);
      marker.setVisible(true);

      // Fetch parcel(s)
      const addr = p.formatted_address || input.value || "";
      if (!addr) return;

      try {
        const fc = await fetchParcelByAddress(addr);
        const feats = Array.isArray(fc?.features) ? fc.features : [];
        if (!feats.length) { say("No parcel found for that address."); return; }

        // Choose parcel that contains the selected point; fallback to nearest centroid
        const chosen = chooseBestFeature(feats, p.geometry.location);

        // Draw one red parcel outline
        drawSingleParcel(chosen.geometry);

        say("Parcel boundary drawn — outline turf if needed.");
        snapshot();
      } catch (err) {
        console.warn("Parcel fetch failed:", err?.message || err);
        say("Could not load parcel — try another address.");
      }
    });

    say("Search an address to begin.");
  };

  // ========== SIDEBAR TOOLS ==========
  function wireTools() {
    onClick("btnManualTurf", () => {
      startManualTurf();
    });

    onClick("btnOutlineLot", () => {
      const parcel = getParcelPolygon();
      if (!parcel) return say("Search an address first to get the parcel.");
      // Copy parcel ring as starting turf
      const paths = parcel.getPaths().getArray().map(p => p.getArray());
      const turf = new google.maps.Polygon({
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
      const prev = getTurfPolygon();
      if (prev) prev.setMap(null);
      setTurfPolygon(turf);
      attachTurfEditListeners(turf);
      updateTurfArea();
      say("Lot outline copied — edit to match your turf.");
      snapshot();
    });

    onClick("btnEdit", () => {
      const turf = getTurfPolygon();
      const parcel = getParcelPolygon();
      if (turf) {
        turf.setEditable(!turf.getEditable());
        if (!turf.getEditable()) { updateTurfArea(); snapshot(); }
        say(turf.getEditable() ? "Editing turf — drag handles to adjust." : "Edit finished.");
      } else if (parcel) {
        parcel.setEditable(!parcel.getEditable());
        say(parcel.getEditable() ? "Editing parcel outline." : "Edit finished.");
      } else {
        say("Nothing to edit yet.");
      }
    });

    onClick("btnDelete", () => {
      const turf = getTurfPolygon();
      const parcel = getParcelPolygon();
      if (turf) { turf.setMap(null); setTurfPolygon(null); updateTurfArea(); snapshot(); say("Turf deleted."); return; }
      if (parcel) { parcel.setMap(null); setParcelPolygon(null); snapshot(); say("Parcel deleted."); return; }
      say("Nothing to delete.");
    });

    onClick("btnReset", () => {
      resetApp(false); // clear everything, including form
    });

    onClick("btnUndo", () => undo());
    onClick("btnRedo", () => redo());

    onClick("btnSave", () => saveGeoJSON());

    // IMPORTANT: Search Again should clear contact form too
    onClick("btnSearchAgain", () => {
      resetApp(false); // clears shapes + form
      const input = document.getElementById("address");
      if (input) { input.value = ""; input.focus(); }
      say("Search an address to begin.");
    });

    // Optional: "Measure Now" just flips to satellite and allows drawing
    onClick("measureBtn", () => {
      setSatellite();
      startManualTurf();
    });
  }

  function onClick(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", (e) => { e.preventDefault(); fn(); });
  }

  // ========== FORM VALIDATION (native tooltip; no reload) ==========
  function setupFormValidation() {
    const form = document.getElementById("contactForm");
    const btn  = document.getElementById("continueBtn");
    if (!form || !btn) return;

    // Make button a normal button; we'll trigger native validation manually
    btn.type = "button";

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const ok = form.reportValidity(); // shows browser tooltip on first invalid
      if (!ok) {
        const firstInvalid = form.querySelector(":invalid");
        if (firstInvalid) {
          firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
          firstInvalid.focus({ preventScroll: true });
        }
        return;
      }
      // success path (no page refresh)
      say("Thanks — we’ll follow up shortly.");
    });
  }

  // ========== CAMERA / UI ==========
  function moveCamera(point, viewport, fallbackZoom = 18) {
    if (viewport) {
      map.fitBounds(viewport);
      setTimeout(() => map.setZoom(Math.max(map.getZoom(), fallbackZoom)), 0);
    } else if (point) {
      map.setCenter(point);
      map.setZoom(fallbackZoom);
    }
  }
  function setSatellite() { map.setMapTypeId("satellite"); map.setTilt(0); map.setHeading(0); }
  function say(msg) { const el = document.getElementById("mapCaption"); if (el) el.textContent = msg; }

  // ========== PRECISELY API ==========
  async function fetchParcelByAddress(address) {
    const base = window.API_BASE_URL;
    if (!base) throw new Error("Set API_BASE_URL to your Vercel app URL");
    const url = `${base}/api/parcel-by-address?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return await res.json();
  }

  // ========== PARCEL & TURF STORAGE (avoid global collisions) ==========
  function setParcelPolygon(poly) {
    if (map && map.__parcelPolygon) map.__parcelPolygon.setMap(null);
    if (map) map.__parcelPolygon = poly || null;
  }
  function getParcelPolygon() { return map ? map.__parcelPolygon || null : null; }

  function setTurfPolygon(poly) {
    if (map && map.__turfPolygon) map.__turfPolygon.setMap(null);
    if (map) map.__turfPolygon = poly || null;
  }
  function getTurfPolygon() { return map ? map.__turfPolygon || null : null; }

  // Draw one parcel from GeoJSON geometry
  function drawSingleParcel(geom) {
    setParcelPolygon(null);
    const path = geometryToPath(geom);
    if (!path.length) return;

    const poly = new google.maps.Polygon({
      paths: path,
      map,
      strokeColor: "#ef4444",
      strokeWeight: 3,
      strokeOpacity: 1,
      fillOpacity: 0,
      editable: false,
      zIndex: 2,
    });
    setParcelPolygon(poly);

    const b = new google.maps.LatLngBounds();
    path.forEach((pt) => b.extend(pt));
    if (!b.isEmpty()) map.fitBounds(b, 40);

    const lot = document.getElementById("lotSqft");
    if (lot) {
      const sqft = computeSqft([path]);
      if (Number.isFinite(sqft)) lot.value = Math.round(sqft);
    }
  }

  // ========== MANUAL TURF ==========
  function startManualTurf() {
    const t = getTurfPolygon();
    if (t) { t.setMap(null); setTurfPolygon(null); }
    drawMgr.setDrawingMode(google.maps.drawing.OverlayType.POLYGON);
    say("Click to outline turf; double-click to finish.");
  }

  function attachTurfEditListeners(poly) {
    if (!poly) return;
    const path = poly.getPath();
    ["insert_at", "remove_at", "set_at"].forEach(evt => {
      google.maps.event.addListener(path, evt, () => {
        if (poly.getEditable()) updateTurfArea();
      });
    });
  }

  function updateTurfArea() {
    const t = getTurfPolygon();
    const el = document.getElementById("turfSqft");
    if (!t || !el) return;
    const path = t.getPath().getArray();
    const sqft = computeSqft([path]);
    el.value = Math.round(sqft || 0);
  }

  // ========== UNDO / REDO (light) ==========
  const historyStack = [];
  let historyIdx = -1;

  function snapshot() {
    const parcel = getParcelPolygon();
    const turf = getTurfPolygon();
    const state = {
      parcel: parcel ? pathsToLngLat(parcel.getPaths()) : null,
      turf: turf ? pathToLngLat(turf.getPath()) : null,
      lot: document.getElementById("lotSqft")?.value || "",
      grass: document.getElementById("turfSqft")?.value || "",
    };
    historyStack.splice(historyIdx + 1);
    historyStack.push(state);
    historyIdx = historyStack.length - 1;
  }

  function applySnapshot(s) {
    const parcel = getParcelPolygon();
    if (parcel) parcel.setMap(null);
    const turf = getTurfPolygon();
    if (turf) turf.setMap(null);
    setParcelPolygon(null);
    setTurfPolygon(null);

    if (s?.parcel) {
      const poly = new google.maps.Polygon({
        paths: lngLatToPaths(s.parcel), map,
        strokeColor: "#ef4444", strokeWeight: 3, fillOpacity: 0, zIndex: 2
      });
      setParcelPolygon(poly);
    }
    if (s?.turf) {
      const poly = new google.maps.Polygon({
        paths: [s.turf.map(p => ({ lat: p.lat, lng: p.lng }))], map,
        strokeColor: "#16a34a", strokeWeight: 3,
        fillColor: "#22c55e", fillOpacity: 0.15, editable: false, zIndex: 3
      });
      setTurfPolygon(poly);
      attachTurfEditListeners(poly);
    }
    setVal("lotSqft", s?.lot || "");
    setVal("turfSqft", s?.grass || "");
  }

  function undo() {
    if (historyIdx <= 0) return say("Nothing to undo.");
    historyIdx--; applySnapshot(historyStack[historyIdx]); say("Undid last action.");
  }
  function redo() {
    if (historyIdx >= historyStack.length - 1) return say("Nothing to redo.");
    historyIdx++; applySnapshot(historyStack[historyIdx]); say("Redid action.");
  }

  // ========== SAVE ==========
  function saveGeoJSON() {
    const out = { type: "FeatureCollection", features: [] };
    const parcel = getParcelPolygon();
    const turf = getTurfPolygon();
    if (parcel) out.features.push({ type: "Feature", properties: { kind: "parcel" }, geometry: polygonToGeoJSON(parcel) });
    if (turf)   out.features.push({ type: "Feature", properties: { kind: "turf" },   geometry: polygonToGeoJSON(turf) });

    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "measurements.geojson"; a.click();
    URL.revokeObjectURL(url);
    say("Saved measurements.geojson");
  }

  // ========== RESET ==========
  function resetApp(keepForm) {
    const parcel = getParcelPolygon();
    if (parcel) parcel.setMap(null);
    const turf = getTurfPolygon();
    if (turf) turf.setMap(null);
    setParcelPolygon(null);
    setTurfPolygon(null);
    drawMgr.setDrawingMode(null);
    if (marker) marker.setVisible(false);

    if (!keepForm) {
      const form = document.getElementById("contactForm");
      if (form) form.reset();
      setVal("lotSqft", "");
      setVal("turfSqft", "");
    } else {
      setVal("turfSqft", "");
    }

    historyStack.length = 0;
    historyIdx = -1;

    map.setMapTypeId("roadmap");
    map.setCenter({ lat: 37.773972, lng: -122.431297 });
    map.setZoom(13);
  }

  // ========== GEOMETRY HELPERS ==========
  function geometryToPath(geom) {
    if (!geom) return [];
    if (geom.type === "Polygon") {
      const ring = geom.coordinates?.[0] || [];
      return ring.map(([lng, lat]) => ({ lat, lng }));
    }
    if (geom.type === "MultiPolygon") {
      const ring = geom.coordinates?.[0]?.[0] || [];
      return ring.map(([lng, lat]) => ({ lat, lng }));
    }
    return [];
  }
  function containsPoint(path, latLng) {
    if (!path?.length || !latLng) return false;
    const poly = new google.maps.Polygon({ paths: path });
    return google.maps.geometry.poly.containsLocation(latLng, poly) ||
           google.maps.geometry.poly.isLocationOnEdge(latLng, poly, 1e-6);
  }
  function centroidOfPath(path) {
    if (!path?.length) return null;
    let sx = 0, sy = 0;
    path.forEach(p => { sx += p.lat; sy += p.lng; });
    return { lat: sx / path.length, lng: sy / path.length };
  }
  function computeSqft(paths) {
    const m2 = paths.reduce((sum, ring) => sum + google.maps.geometry.spherical.computeArea(ring), 0);
    return m2 * 10.7639;
  }
  function polygonToGeoJSON(poly) {
    const paths = poly.getPaths();
    const rings = [];
    for (let i = 0; i < paths.getLength(); i++) {
      const ring = paths.getAt(i).getArray().map(ll => [ll.lng(), ll.lat()]);
      if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
        ring.push([...ring[0]]);
      }
      rings.push(ring);
    }
    return { type: "Polygon", coordinates: rings };
  }
  function pathsToLngLat(mvcArrayOfPaths) {
    const out = [];
    for (let i = 0; i < mvcArrayOfPaths.getLength(); i++) {
      const path = mvcArrayOfPaths.getAt(i);
      out.push(path.getArray().map(ll => ({ lng: ll.lng(), lat: ll.lat() })));
    }
    return out;
  }
  function pathToLngLat(mvcArray) {
    return mvcArray.getArray().map(ll => ({ lng: ll.lng(), lat: ll.lat() }));
  }
  function lngLatToPaths(arr) {
    return arr.map(ring => ring.map(p => ({ lat: p.lat, lng: p.lng })));
  }

  // ========== PARCEL CHOICE ==========
  function chooseBestFeature(features, focusLatLng) {
    if (!features?.length) return null;
    if (!focusLatLng) return features[0];
    // contains point
    for (const f of features) {
      const path = geometryToPath(f.geometry);
      if (path.length && containsPoint(path, focusLatLng)) return f;
    }
    // nearest centroid
    let best = features[0], bestD = Infinity;
    for (const f of features) {
      const c = centroidOfPath(geometryToPath(f.geometry));
      if (!c) continue;
      const d = google.maps.geometry.spherical.computeDistanceBetween(
        new google.maps.LatLng(c.lat, c.lng), focusLatLng
      );
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  // ========== SMALL HELPERS ==========
  function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

})();
