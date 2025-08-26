// js/map.js (diagnostic-safe)

const API_BASE_URL = ""; // set your real Vercel URL later

let map, parcelPolygon;

function say(msg) {
  const el = document.getElementById("mapCaption");
  if (el) el.textContent = msg;
}

(function bootstrap() {
  // This runs as soon as the file loads — proves the script tag/path is correct
  say("map.js loaded ✅ — waiting for Google…");
})();

window.initMap = function initMap() {
  try {
    say("initMap fired ✅ — building map…");

    map = new google.maps.Map(document.getElementById("map"), {
      center: { lat: 37.773972, lng: -122.431297 },
      zoom: 13,
      mapTypeId: "roadmap",
      tilt: 0,
      heading: 0,
    });

    // keep overhead
    map.addListener("tilt_changed", () => map.getTilt() !== 0 && map.setTilt(0));
    map.addListener("heading_changed", () => map.getHeading() !== 0 && map.setHeading(0));

    say("Map ready ✅ — type an address and press Enter");

    // Try to enable search (new widget → legacy → plain geocode)
    enableSearchSafely();
  } catch (e) {
    say("initMap error ❌ — " + (e && e.message ? e.message : e));
  }
};

// --- Search wiring with graceful fallbacks ---
async function enableSearchSafely() {
  const host = document.querySelector(".search-box");
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

  // Try the new Places widget (if available for your key)
  try {
    await google.maps.importLibrary?.("places");
  } catch (_) {}

  const hasNew = !!(google?.maps?.places && "PlaceAutocompleteElement" in google.maps.places);
  if (hasNew) {
    try {
      // @ts-ignore
      const pac = new google.maps.places.PlaceAutocompleteElement();
      pac.placeholder = input.placeholder || "Search address...";
      pac.style.width = "100%";
      host.replaceChild(pac, input);

      // @ts-ignore
      pac.addEventListener("gmp-select", async ({ placePrediction }) => {
        say("Address selected — moving map…");
        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ["formattedAddress", "location", "viewport"] });

        if (place.viewport) {
          map.fitBounds(place.viewport);
        } else if (place.location) {
          map.setCenter(place.location);
          map.setZoom(18);
        }
        forceFlat();

        if (API_BASE_URL && place.formattedAddress) {
          tryDrawParcel(place.formattedAddress);
        } else if (!API_BASE_URL) {
          console.warn("Parcel fetch skipped: API_BASE_URL not set");
        }
      });

      say("Search ready ✅ (new Places)");
      return;
    } catch (e) {
      console.warn("New Places widget failed, falling back:", e);
    }
  }

  // Try legacy Autocomplete if allowed on your project
  if (google?.maps?.places?.Autocomplete) {
    const ac = new google.maps.places.Autocomplete(input, {
      types: ["address"],
      fields: ["formatted_address", "geometry"],
    });
    ac.addListener("place_changed", async () => {
      const p = ac.getPlace();
      if (!p || !p.geometry) return;
      say("Address selected — moving map…");
      const loc = p.geometry.location;
      if (p.geometry.viewport) map.fitBounds(p.geometry.viewport);
      else if (loc) { map.setCenter(loc); map.setZoom(18); }
      forceFlat();
      if (API_BASE_URL && p.formatted_address) tryDrawParcel(p.formatted_address);
    });
    say("Search ready ✅ (legacy Places)");
    return;
  }

  // If neither Places API is available, we still have Enter-to-geocode
  say("Search ready ✅ (press Enter to geocode)");
}

// --- Parcel fetch/draw (guarded) ---
async function tryDrawParcel(formattedAddress) {
  try {
    const url = `${API_BASE_URL}/api/parcel-by-address?address=${encodeURIComponent(formattedAddress)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const gj = normalizePreciselyToGeoJSON(data);
    const poly = pickFirstPolygon(gj);
    if (poly) drawParcel(poly);
  } catch (e) {
    console.warn("Parcel fetch failed:", e?.message || e);
  }
}

function drawParcel(geometry) {
  if (parcelPolygon) parcelPolygon.setMap(null);
  const ring = extractOuterRing(geometry);
  if (!ring || !ring.length) return;

  const path = ring.map(([lng, lat]) => ({ lat, lng }));
  parcelPolygon = new google.maps.Polygon({
    paths: path,
    map,
    strokeColor: "#ff0000",
    strokeWeight: 3,
    fillOpacity: 0,
  });

  const bounds = new google.maps.LatLngBounds();
  path.forEach((pt) => bounds.extend(pt));
  map.fitBounds(bounds, 40);
  forceFlat();
  say("Parcel drawn ✅");
}

// --- Utils ---
function forceFlat() {
  map.setMapTypeId("roadmap");
  map.setHeading(0);
  map.setTilt(0);
}

async function fallbackGeocode(query) {
  const geocoder = new google.maps.Geocoder();
  return new Promise((resolve) => {
    geocoder.geocode({ address: query }, (results, status) => {
      if (status === "OK" && results[0]) {
        const r = results[0];
        if (r.geometry?.viewport) map.fitBounds(r.geometry.viewport);
        else if (r.geometry?.location) { map.setCenter(r.geometry.location); map.setZoom(18); }
        forceFlat();
        say("Address found ✅ — outline the lot or measure turf.");
      } else {
        say("Geocode failed ❌ — try a full address.");
      }
      resolve();
    });
  });
}

// GeoJSON helpers
function normalizePreciselyToGeoJSON(payload) {
  if (payload?.type === "FeatureCollection" || payload?.type === "Feature") return payload;
  if (Array.isArray(payload?.features)) return { type: "FeatureCollection", features: payload.features };
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
function extractOuterRing(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  if (geometry.type === "MultiPolygon") return geometry.coordinates?.[0]?.[0] || null;
  if (geometry.type === "Polygon") return geometry.coordinates?.[0] || null;
  const c = geometry.coordinates;
  if (Array.isArray(c?.[0]) && typeof c[0][0] === "number") return c;
  return null;
}
