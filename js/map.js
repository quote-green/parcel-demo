// ===== ONE-TIME GLOBALS (guards) =====
if (!window.API_BASE_URL) window.API_BASE_URL = "https://parcel-api-ohx5.vercel.app";
if (typeof window.parcelPolygon === "undefined") window.parcelPolygon = null;
if (typeof window.neighborPolygons === "undefined") window.neighborPolygons = [];

// js/map.js (minimal, stable)
// Guard against duplicate inclusion
if (!window.API_BASE_URL) window.API_BASE_URL = "https://parcel-api-ohx5.vercel.app";

let map, ac, marker, parcelPolygon = null;

window.initMap = function initMap() {
  // Base map
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 37.773972, lng: -122.431297 },
    zoom: 13,
    mapTypeId: "roadmap",
    tilt: 0,
    heading: 0,
  });

  marker = new google.maps.Marker({ map, visible: false });

  const input = document.getElementById("address");
  if (!input || !google.maps.places) {
    console.warn("Missing #address or Places library");
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
    if (p.geometry.viewport) {
      map.fitBounds(p.geometry.viewport);
      setTimeout(() => map.setZoom(Math.max(map.getZoom(), 19)), 0);
    } else {
      map.setCenter(p.geometry.location);
      map.setZoom(19);
    }
    map.setMapTypeId("satellite");
    map.setTilt(0);
    map.setHeading(0);

    marker.setPosition(p.geometry.location);
    marker.setVisible(true);

    // Fetch parcel + draw one outline
    const addr = p.formatted_address || input.value || "";
    try {
      const fc = await fetchParcelByAddress(addr);
      const feats = Array.isArray(fc?.features) ? fc.features : [];
      if (!feats.length) return;

      // Pick parcel that contains the selected point (else first)
      const focus = p.geometry.location;
      let chosen = feats[0];
      for (const f of feats) {
        if (containsPoint(geometryToPath(f.geometry), focus)) { chosen = f; break; }
      }
      drawSingleParcel(chosen.geometry);
    } catch (err) {
      console.warn("Parcel fetch failed:", err?.message || err);
    }
  });
};

// ---- Precisely API ----
async function fetchParcelByAddress(address) {
  const base = window.API_BASE_URL;
  if (!base) throw new Error("Set API_BASE_URL to your Vercel app URL");
  const url = `${base}/api/parcel-by-address?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return await res.json();
}

// ---- Drawing (single parcel) ----
function drawSingleParcel(geom) {
  if (parcelPolygon) { parcelPolygon.setMap(null); parcelPolygon = null; }
  const path = geometryToPath(geom);
  if (!path.length) return;

  parcelPolygon = new google.maps.Polygon({
    paths: path,
    map,
    strokeColor: "#ef4444",
    strokeWeight: 3,
    strokeOpacity: 1,
    fillOpacity: 0,
  });

  const b = new google.maps.LatLngBounds();
  path.forEach(pt => b.extend(pt));
  map.fitBounds(b, 40);

  // Optional: write Lot sq ft if #lotSqft exists
  const lot = document.getElementById("lotSqft");
  if (lot) {
    const sqft = computeSqft([path]);
    if (Number.isFinite(sqft)) lot.value = Math.round(sqft);
  }
}

// ---- Helpers ----
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

function computeSqft(paths) {
  const m2 = paths.reduce((sum, ring) => sum + google.maps.geometry.spherical.computeArea(ring), 0);
  return m2 * 10.7639;
}
