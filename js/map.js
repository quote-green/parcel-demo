function drawParcels(featureCollection, focusLatLng) {
  lastParcelsFC = featureCollection;

  // Clear old
  if (parcelPolygon) { parcelPolygon.setMap(null); parcelPolygon = null; }
  neighborPolygons.forEach(p => p.setMap(null));
  neighborPolygons.length = 0;

  const feats = Array.isArray(featureCollection?.features) ? featureCollection.features : [];
  if (!feats.length) return;

  // --- choose the main feature robustly ---
  let mainIdx = 0; // default
  if (focusLatLng) {
    const TOL_M = 12;
    const tolRad = TOL_M / 6378137; // radians tolerance for isLocationOnEdge

    // (a) contains point
    for (let i = 0; i < feats.length; i++) {
      const paths = geometryToPaths(feats[i].geometry);
      if (!paths.length) continue;
      const polyTest = new google.maps.Polygon({ paths });
      if (google.maps.geometry.poly.containsLocation(focusLatLng, polyTest)) { mainIdx = i; break; }
    }

    // (b) near edge within tolerance (only if not found above)
    if (mainIdx === 0) {
      for (let i = 0; i < feats.length; i++) {
        const paths = geometryToPaths(feats[i].geometry);
        if (!paths.length) continue;
        const polyTest = new google.maps.Polygon({ paths });
        if (google.maps.geometry.poly.isLocationOnEdge(focusLatLng, polyTest, tolRad)) { mainIdx = i; break; }
      }
    }

    // (c) nearest centroid fallback
    if (mainIdx === 0) {
      let bestD = Infinity, bestI = 0;
      for (let i = 0; i < feats.length; i++) {
        const c = centroidOfPaths(geometryToPaths(feats[i].geometry));
        if (!c) continue;
        const d = google.maps.geometry.spherical.computeDistanceBetween(
          new google.maps.LatLng(c.lat, c.lng), focusLatLng
        );
        if (d < bestD) { bestD = d; bestI = i; }
      }
      mainIdx = bestI;
    }
  }

  // Draw main first, neighbors after
  const ordered = [feats[mainIdx], ...feats.filter((_, i) => i !== mainIdx)];
  const bounds = new google.maps.LatLngBounds();
  let primaryArea = null;

  ordered.forEach((f, idx) => {
    const isAdj = idx !== 0;
    const paths = geometryToPaths(f.geometry);
    if (!paths.length) return;

    const poly = new google.maps.Polygon({
      paths,
      map,
      strokeColor: isAdj ? "#64748b" : "#ef4444",
      strokeOpacity: isAdj ? 0.7 : 1,
      strokeWeight: isAdj ? 2 : 3,
      fillOpacity: 0,
      clickable: true,
      zIndex: isAdj ? 1 : 2,
    });

    // click-to-correct: re-run selection using the clicked point
    poly.addListener("click", (e) => {
      if (lastParcelsFC) drawParcels(lastParcelsFC, e.latLng);
    });

    paths.forEach(ring => ring.forEach(pt => bounds.extend(pt)));

    if (!isAdj && !parcelPolygon) {
      parcelPolygon = poly;
      const apiArea = Number(f.properties?.areaSqFt);
      primaryArea = Number.isFinite(apiArea) ? apiArea : computeSqft(paths);
    } else {
      neighborPolygons.push(poly);
    }
  });

  if (!bounds.isEmpty()) map.fitBounds(bounds, 40);

  const lotEl = document.getElementById("lotSqft");
  if (lotEl && primaryArea) lotEl.value = Math.round(primaryArea);

  const cap = document.getElementById("mapCaption");
  if (cap) cap.textContent = "Parcel boundary drawn — you can outline turf next.";
}

// helpers (keep your existing versions if you already added them)
function geometryToPaths(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") {
    return [ (geom.coordinates?.[0] || []).map(([lng,lat]) => ({ lat, lng })) ];
  }
  if (geom.type === "MultiPolygon") {
    return (geom.coordinates || []).map(rings => (rings?.[0] || []).map(([lng,lat]) => ({ lat, lng })));
  }
  return [];
}
function centroidOfPaths(paths) {
  if (!paths.length) return null;
  const ring = paths[0];
  let sx = 0, sy = 0;
  ring.forEach(p => { sx += p.lat; sy += p.lng; });
  const n = ring.length || 1;
  return { lat: sx / n, lng: sy / n };
}
function computeSqft(paths) {
  const m2 = paths.reduce((sum, ring) => sum + google.maps.geometry.spherical.computeArea(ring), 0);
  return m2 * 10.7639;
}
