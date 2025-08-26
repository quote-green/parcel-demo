<script type="text/plain" data-filename="js/map.js">


// ---------------- Optional parcel fetch/draw ----------------
async function tryDrawParcel(formattedAddress) {
if (!API_BASE_URL) { console.warn("Parcel fetch skipped: API_BASE_URL not set"); return; }
try {
const url = API_BASE_URL + "/api/parcel-by-address?address=" + encodeURIComponent(formattedAddress);
const res = await fetch(url);
if (!res.ok) throw new Error("API " + res.status);
const data = await res.json();
const gj = normalizePreciselyToGeoJSON(data);
const poly = pickFirstPolygon(gj);
if (poly) drawParcel(poly);
} catch (e) {
console.warn("Parcel fetch failed:", e && e.message ? e.message : e);
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
fitToPolygon(lotPolygon);
updateAreas();
say("Parcel drawn. You can add turf polygons now.");
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
const c = geometry.coordinates;
if (geometry.type === "MultiPolygon") return c?.[0]?.[0] || null;
if (geometry.type === "Polygon") return c?.[0] || null;
if (Array.isArray(c?.[0]) && typeof c[0][0] === "number") return c;
return null;
}


// Camera & DOM helpers
function keepOverhead(){ if (!map) return; map.setMapTypeId("roadmap"); map.setHeading(0); map.setTilt(0); }
function lockOverhead(){ map.addListener("tilt_changed",()=> map.getTilt()!==0 && map.setTilt(0)); map.addListener("heading_changed",()=> map.getHeading()!==0 && map.setHeading(0)); }
function byId(id){ return document.getElementById(id); }
function say(msg){ const el = byId("mapCaption"); if (el) el.textContent = msg; }
</script>
