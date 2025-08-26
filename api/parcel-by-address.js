// api/parcel-by-address.js
// Vercel Serverless Function that proxies Precisely Parcel Boundary APIs.

const AUTH_URL = "https://api.cloud.precisely.com/auth/v2/token";
const BY_ADDRESS_URL = "https://api.cloud.precisely.com/property/v1/parcelboundary/byaddress";
const BY_LOCATION_URL = "https://api.cloud.precisely.com/property/v1/parcelboundary/bylocation";

let tokenCache = { token: null, exp: 0 };

async function getPreciselyToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;

  const { PRECISELY_API_KEY, PRECISELY_API_SECRET } = process.env;
  if (!PRECISELY_API_KEY || !PRECISELY_API_SECRET) {
    throw new Error("Missing PRECISELY_API_KEY or PRECISELY_API_SECRET env vars");
  }

  const basic = Buffer.from(`${PRECISELY_API_KEY}:${PRECISELY_API_SECRET}`).toString("base64");
  const resp = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Precisely auth failed: ${resp.status} ${txt}`);
  }

  const data = await resp.json(); // { access_token, expires_in }
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3000) };
  return tokenCache.token;
}

module.exports = async (req, res) => {
  try {
    // CORS (so your GitHub Pages site can call the Vercel API)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const address = url.searchParams.get("address");
    const lat = url.searchParams.get("lat");
    const lng = url.searchParams.get("lng");

    if (!address && !(lat && lng)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Provide ?address=... OR ?lat=...&lng=..." }));
      return;
    }

    const token = await getPreciselyToken();

    let target;
    if (address) {
      target = new URL(BY_ADDRESS_URL);
      target.searchParams.set("address", address);
      // target.searchParams.set("maxCandidates", "1");
      // target.searchParams.set("includeGeometry", "true");
    } else {
      target = new URL(BY_LOCATION_URL);
      target.searchParams.set("latitude", String(lat));
      target.searchParams.set("longitude", String(lng));
    }

    const r = await fetch(target.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    const payload = (() => { try { return JSON.parse(text); } catch { return text; } })();

    res.statusCode = r.status;
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.setHeader("Content-Type", "application/json");
    res.end(typeof payload === "string" ? JSON.stringify({ raw: payload }) : JSON.stringify(payload));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
};

