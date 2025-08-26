
// js/map.js
// --- SET THIS after you deploy to Vercel ---
// If your frontend stays on GitHub Pages, you must call the Vercel URL explicitly.
// Example after deploy: 'https://quote-green.vercel.app'
const API_BASE_URL = ""; // ← leave empty until you have your real https://parcel-api-xxx.vercel.app

// If you later host the frontend on Vercel too, you can set: const API_BASE = '';

let map, marker, parcelPolygon, autocomplete;

window.initMap = function initMap() {
  // Basic map
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 37.773972, lng: -122.431297 },
    zoom: 13,
    mapTypeId: 'roadmap'
  });

  // Marker (classic is fine for now)
  marker = new google.maps.Marker({ map, visible: false });

  // Autocomplete on #address (keep using the classic widget for now)
  const input = document.getElementById('address');
  if (!input) {
    console.warn('No #address input found');
    return;
  }
  if (!google.maps.places) {
    console.warn('Places library not loaded');
    return;
  }

  autocomplete = new google.maps.places.Autocomplete(input, {
    types: ['address'],
    fields: ['formatted_address', 'geometry']
  });

  autocomplete.addListener('place_changed', async () => {
    const p = autocomplete.getPlace();
    if (!p || !p.geometry) return;

    map.setCenter(p.geometry.location);
    map.setZoom(18);
    map.setMapTypeId('satellite');

    marker.setPosition(p.geometry.location);
    marker.setVisible(true);

    // Try to fetch parcel (works after you deploy the API on Vercel)
    try {
      const gj = await fetchParcelByAddress(p.formatted_address);
      const poly = pickFirstPolygon(gj);
      if (poly) drawParcel(poly);
    } catch (e) {
      console.warn('Parcel fetch skipped or failed:', e?.message || e);
    }
  });
};

async function fetchParcelByAddress(address) {
  if (!API_BASE) throw new Error('Set API_BASE to your Vercel app URL');
  const url = `${API_BASE}/api/parcel-by-address?address=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return normalizePreciselyToGeoJSON(data);
}

function drawParcel(geometry) {
  // Remove old
  if (parcelPolygon) parcelPolygon.setMap(null);

  const ring = geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }));
  parcelPolygon = new google.maps.Polygon({
    paths: ring,
    map,
    strokeColor: '#ff0000',
    strokeWeight: 3,
    fillOpacity: 0
  });

  const bounds = new google.maps.LatLngBounds();
  ring.forEach(pt => bounds.extend(pt));
  map.fitBounds(bounds, 40);
}

// --- helpers ---
function normalizePreciselyToGeoJSON(payload) {
  // Already GeoJSON?
  if (payload?.type === 'FeatureCollection' || payload?.type === 'Feature') return payload;

  // Common Precisely shape: { features: [ { geometry:{type:'Polygon', coordinates:[...]}, ... } ] }
  if (Array.isArray(payload?.features)) {
    return { type: 'FeatureCollection', features: payload.features };
  }
  if (payload?.geometry?.type && payload?.geometry?.coordinates) {
    return { type: 'Feature', geometry: payload.geometry, properties: payload.properties || {} };
  }
  // Fallback: empty
  return { type: 'FeatureCollection', features: [] };
}

function pickFirstPolygon(gj) {
  const feats = gj?.type === 'FeatureCollection' ? gj.features : [gj];
  const f = (feats || []).find(x => x?.geometry?.type?.includes('Polygon'));
  return f ? f.geometry : null;
}
