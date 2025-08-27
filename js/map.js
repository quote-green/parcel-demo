// js/map.js — minimal, stable, no duplicate-globals
(() => {
  "use strict";

  // One-time global base URL for your Vercel API
  if (!window.API_BASE_URL) window.API_BASE_URL = "https://parcel-api-ohx5.vercel.app";

  let map, ac, marker;

  // Google callback
  window.initMap = function initMap() {
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

    // Search Again
    const again = document.getElementById("btnSearchAgain");
    if (again) again.addEventListener("click", (e) => { e.preventDefault(); resetApp(true); });

    // Measure Now (optional: just set satellite so user can draw)
    const measureBtn = document.getElementById("measureBtn");
    if (measureBtn) measureBtn.addEventListener("click", () => { setSatellite(); });

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

      moveCamera(p.geometry.location ?? null, p.geometry.viewport ?? null, 19);
      setSatellite();

      marker.setPosition(p.geometry.location);
      marker.setVisible(true);

      const addr = p.formatted_address || input.value || "";
      if (!addr) return;

      try {
        const fc = await fetchParcelByAddress(addr);
        const feats = Array.isArray(fc?.features) ? fc.features : [];
        if (!feats.length) { say("No parcel found for that address."); return; }

        const focus = p.geometry.location;
        const chosen = chooseBestFeature(feats, focus);
        drawSingleParcel(chosen.geometry);

        say("Parcel boundary drawn — outline turf if needed.");
      } catch (err) {
        console.warn("Parcel fetch failed:", err?.message || err);
        say("Could not load parcel — try another address.");
      }
    });

    say("Search an address to begin.");
  };

  // Camera / UI helpers
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

  // Precisely API
  async function fetchParcelByAddress(address) {
    const base = window.API_BASE_URL;
    if (!base) throw new Error("Set API_BASE_URL to your Vercel app URL");
    const url = `${base}/api/parcel-by-address?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return await res.json();
  }

  // Keep polygon on map object (no global collisions)
  function setParcelPolygon(poly) { if (map && map.__parcelPolygon) map.__parcelPolygon.setMap(null); if (map) map.__parcelPolygon = poly || null; }
  function getParcelPolygon() { return map ? map.__parcelPolygon || null : null; }

  function drawSingleParcel(geom) {
    setParcelPolygon(null);
    const path = geometryToPath(geom);
    if (!path.length) return;

    const poly = new google.maps.Polygon({
      paths: path, map,
      strokeColor: "#ef4444", strokeWeight: 3, strokeOpacity: 1, fillOpacity: 0
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

  // Feature selection (contains point → nearest centroid)
  function chooseBestFeature(features, focusLatLng) {
    if (!features?.length) return null;
    if (!focusLatLng) return features[0];
    for (const f of features) {
      const path = geometryToPath(f.geometry);
      if (path.length && containsPoint(path, focusLatLng)) return f;
    }
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

  // Geometry helpers
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
    const n = path.length || 1;
    return { lat: sx / n, lng: sy / n };
  }
  function computeSqft(paths) {
    const m2 = paths.reduce((sum, ring) => sum + google.maps.geometry.spherical.computeArea(ring), 0);
    return m2 * 10.7639;
  }

  // Reset (Search Again)
  function resetApp(keepForm) {
    setParcelPolygon(null);
    if (marker) marker.setVisible(false);
    if (!keepForm) {
      setVal("lotSqft",""); setVal("turfSqft",""); setCheck("smsConsent", false);
      const f = document.getElementById("contactForm"); f?.reset?.();
    } else { setVal("turfSqft",""); }
    const input = document.getElementById("address"); if (input) { input.value=""; input.focus(); }
    map.setMapTypeId("roadmap");
    map.setCenter({ lat: 37.773972, lng: -122.431297 }); map.setZoom(13);
    say("Search an address to begin.");
  }
  function setVal(id,v){const el=document.getElementById(id); if(el) el.value=v;}
  function setCheck(id,v){const el=document.getElementById(id); if(el&&"checked" in el) el.checked=!!v;}
  // --- Form validation wiring ---
const form = document.getElementById("contactForm");
const continueBtn = document.getElementById("continueBtn");

if (form && continueBtn) {
  const update = () => {
    continueBtn.disabled = !form.checkValidity();
  };
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  update();

  form.addEventListener("submit", (e) => {
    if (!form.checkValidity()) {
      e.preventDefault();
      form.reportValidity(); // shows the browser's tooltip on the first invalid field
      return;
    }
    e.preventDefault(); // handle your submit here (no page reload)
    say("Thanks — we’ll follow up shortly.");
  });
}


})();
