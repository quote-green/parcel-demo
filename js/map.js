// js/map.js — stable build: map + autocomplete + parcel + required-fields UX
(() => {
  "use strict";

  // One-time global for your Vercel API
  if (!window.API_BASE_URL) window.API_BASE_URL = "https://parcel-api-ohx5.vercel.app";

  let map, ac, marker;

  // Google callback (must exist once)
  window.initMap = function initMap() {
    // --- Base map ---
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

    // --- Form UX: make Continue a controlled button (no page reload) ---
    setupFormValidation();

    // --- “Search Again” (optional) ---
    const again = document.getElementById("btnSearchAgain");
    if (again) again.addEventListener("click", (e) => { e.preventDefault(); resetApp(true); });

    // --- Autocomplete on #address ---
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

      // Fetch parcel(s) from your API
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
      } catch (err) {
        console.warn("Parcel fetch failed:", err?.message || err);
        say("Could not load parcel — try another address.");
      }
    });

    say("Search an address to begin.");
  };

  // ---------- Camera / UI ----------
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

  // ---------- Form validation (no refresh; show what’s missing) ----------
  function setupFormValidation() {
    const form = document.getElementById("contactForm");
    const btn = document.getElementById("continueBtn");
    if (!form || !btn) return;

    // Prevent default submit refresh; we manage it in JS
    btn.type = "button";

    const update = () => { btn.disabled = !form.checkValidity(); };
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    update();

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity(); // native tooltip on the first invalid field
        return;
      }
      // ✅ All good — do your next step here (no page reload)
      say("Thanks — we’ll follow up shortly.");
    });
  }

  // ---------- Precisely API ----------
  async function fetchParcelByAddress(address) {
    const base = window.API_BASE_URL;
    if (!base) throw new Error("Set API_BASE_URL to your Vercel app URL");
    const url = `${base}/api/parcel-by-address?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return await res.json();
  }

  // ---------- Draw ONE parcel (stored on map to avoid global collisions) ----------
  function setParcelPolygon(poly) {
    if (map && map.__parcelPolygon) map.__parcelPolygon.setMap(null);
    if (map) map.__parcelPolygon = poly || null;
  }
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

  // ---------- Feature selection (correct lot) ----------
  function chooseBestFeature(features, focusLatLng) {
    if (!features?.length) return null;
    if (!focusLatLng) return features[0];

    // (a) contains the point
    for (const f of features) {
      const path = geometryToPath(f.geometry);
      if (path.length && containsPoint(path, focusLatLng)) return f;
    }
    // (b) nearest centroid
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

  // ---------- Geometry helpers ----------
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
    return (
      google.maps.geometry.poly.containsLocation(latLng, poly) ||
      google.maps.geometry.poly.isLocationOnEdge(latLng, poly, 1e-6)
    );
  }
  function centroidOfPath(path) {
    if (!path?.length) return null;
    let sx = 0, sy = 0;
    path.forEach((p) => { sx += p.lat; sy += p.lng; });
    const n = path.length || 1;
    return { lat: sx / n, lng: sy / n };
  }
  function computeSqft(paths) {
    const m2 = paths.reduce((sum, ring) => sum + google.maps.geometry.spherical.computeArea(ring), 0);
    return m2 * 10.7639;
  }

  // ---------- Reset (Search Again) ----------
  function resetApp(keepForm) {
    setParcelPolygon(null);
    if (marker) marker.setVisible(false);

    if (!keepForm) {
      setVal("lotSqft", ""); setVal("turfSqft", ""); setCheck("smsConsent", false);
      const f = document.getElementById("contactForm"); f?.reset?.();
    } else {
      setVal("turfSqft", "");
    }

    const input = document.getElementById("address");
    if (input) { input.value = ""; input.focus(); }

    map.setMapTypeId("roadmap");
    map.setCenter({ lat: 37.773972, lng: -122.431297 });
    map.setZoom(13);
    say("Search an address to begin.");
  }
  function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
  function setCheck(id, v) { const el = document.getElementById(id); if (el && "checked" in el) el.checked = !!v; }
// --- Required-fields UX: prevent refresh, show what's missing ---
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("contactForm");
  const btn  = document.getElementById("continueBtn");
  if (!form || !btn) return;

  // Make sure this is NOT a submit button (prevents page reload)
  btn.type = "button";

  // Disable button until the form is valid
  const update = () => { btn.disabled = !form.checkValidity(); };
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  update(); // initial state

  // On click: either show the native tooltip on the first invalid field, or proceed
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity(); // shows the browser's message
      const firstInvalid = form.querySelector(":invalid");
      if (firstInvalid) {
        firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
        firstInvalid.focus({ preventScroll: true });
      }
      return;
    }
    // ✅ All fields valid — put your submit/next-step here
    const cap = document.getElementById("mapCaption");
    if (cap) cap.textContent = "Thanks — we’ll follow up shortly.";
  });
});

})();
