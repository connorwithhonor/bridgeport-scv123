// bridgeport-submit.mjs
// Netlify Function — handles form submissions from bridgeport.scv123.com
// Creates a contact in HonorElevate (LeadConnector) SCV123 sub-account with
// tags + custom fields. Token is pulled from Netlify env var GHL_PIT.
//
// Required Netlify env vars:
//   GHL_PIT          — Private Integration Token (pit-...) from HonorElevate
//                      Settings > Private Integrations > "Claude MCP"
//   GHL_LOCATION_ID  — SCV123 sub-account id (default fallback hardcoded below)
//
// To deploy: netlify deploy --prod from project root.
// To test locally: netlify dev (function available at http://localhost:8888/.netlify/functions/bridgeport-submit)

const GHL_BASE = "https://services.leadconnectorhq.com";
const DEFAULT_LOCATION_ID = "XrUKgftiwmJB0sd9bgXt"; // SCV123

// Custom field IDs in SCV123 (pulled via API 2026-04-28)
const CF = {
  community:        "u983a7UqA0khBwrFrviB", // SINGLE_OPTIONS — must match a picklist value
  campaign_source:  "HmGljkwiq0gWwHv5WeBR", // TEXT
  property_address: "uHZ9V0kMLLmB7uI0fsyS", // TEXT
  years_in_home:    "fdD6RNx65XvUDH3WmdXg", // NUMERICAL
  last_assessed:    "rWPST67QhjaJMbgxbdFM", // NUMERICAL
  lake_view:        "88S6keo6ZTTueRb0r6m6", // CHECKBOX
  floor_plan:       "F2CwcGEjx3XnBYBATVi2", // TEXT
};

const TIMELINE_TAG = {
  "just-curious":   "timeline-just-curious",
  "ready-now":      "timeline-ready-now",
  "6-12-months":    "timeline-6-12-months",
  "12-plus-months": "timeline-12-plus-months",
};

const VALID_TIMELINES = Object.keys(TIMELINE_TAG);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonRes(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://bridgeport.scv123.com",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function normalizePhone(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (String(input).trim().startsWith("+")) return "+" + digits;
  return null; // unrecognized format — drop it rather than send garbage
}

function sanitizeText(s, max = 200) {
  if (s == null) return "";
  return String(s).trim().slice(0, max);
}

export default async (req, _context) => {
  // Preflight
  if (req.method === "OPTIONS") {
    return jsonRes(204, {});
  }
  if (req.method !== "POST") {
    return jsonRes(405, { ok: false, message: "Method not allowed" });
  }

  // Parse body
  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonRes(400, { ok: false, message: "Invalid JSON" });
  }

  // Honeypot — if anything is in the hidden _hp field, silently 200 to bots
  if (payload._hp && String(payload._hp).trim() !== "") {
    return jsonRes(200, { ok: true, message: "Thanks!" });
  }

  // Pull and validate required fields
  const first_name = sanitizeText(payload.first_name, 80);
  const last_name  = sanitizeText(payload.last_name, 80);
  const email      = sanitizeText(payload.email, 200).toLowerCase();
  const phoneRaw   = sanitizeText(payload.phone, 40);
  const address    = sanitizeText(payload.property_address, 200);
  const timeline   = sanitizeText(payload.timeline, 40);
  const consent    = payload.consent === "on" || payload.consent === true || payload.consent === "true";
  const sourceUrl  = sanitizeText(payload.source_url, 200) || "https://bridgeport.scv123.com";
  const community  = sanitizeText(payload.community, 60) || "Bridgeport";
  const campaign   = sanitizeText(payload.campaign_source, 60) || "bridgeport-2026-q2";

  if (!first_name || !last_name) return jsonRes(400, { ok: false, message: "Name required." });
  if (!EMAIL_RE.test(email))     return jsonRes(400, { ok: false, message: "Valid email required." });
  if (!consent)                  return jsonRes(400, { ok: false, message: "Please confirm the consent checkbox." });
  if (!VALID_TIMELINES.includes(timeline)) {
    return jsonRes(400, { ok: false, message: "Please choose a timeline." });
  }

  // Env
  const token = process.env.GHL_PIT;
  if (!token) {
    console.error("bridgeport-submit: missing GHL_PIT env var");
    return jsonRes(500, { ok: false, message: "Server misconfigured. Try again later." });
  }
  const locationId = process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID;

  // Build tags
  const tags = [
    "bridgeport",
    "bridgeport-lead",
    "bridgeport-subscriber",
    campaign,            // bridgeport-2026-q2 by default
    "form submission",
    "source-scv123",
    TIMELINE_TAG[timeline],
  ].filter(Boolean);

  // Build custom fields
  const customFields = [
    { id: CF.community,        value: community },
    { id: CF.campaign_source,  value: campaign },
  ];
  if (address) customFields.push({ id: CF.property_address, value: address });

  // Build the GHL upsert payload
  const phone = normalizePhone(phoneRaw);
  const ghlPayload = {
    locationId,
    firstName: first_name,
    lastName:  last_name,
    email,
    tags,
    customFields,
    source: sourceUrl,
  };
  if (phone)   ghlPayload.phone = phone;
  if (address) ghlPayload.address1 = address;

  // Fire the upsert
  let ghlRes, ghlBody;
  try {
    ghlRes = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Version": "2021-07-28",
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(ghlPayload),
    });
    ghlBody = await ghlRes.json().catch(() => ({}));
  } catch (e) {
    console.error("bridgeport-submit: GHL upsert network error", e);
    return jsonRes(502, { ok: false, message: "Upstream temporarily unavailable. Please retry." });
  }

  if (!ghlRes.ok) {
    console.error("bridgeport-submit: GHL upsert returned non-2xx", ghlRes.status, ghlBody);
    return jsonRes(502, { ok: false, message: "Could not create contact. Please retry or text 661-263-4801." });
  }

  const contactId = ghlBody?.contact?.id || ghlBody?.id || null;
  console.log(`bridgeport-submit: ok contactId=${contactId} email=${email} timeline=${timeline}`);

  return jsonRes(200, {
    ok: true,
    message: "Thanks — your Bridgeport Report Card is on its way.",
    contactId,
  });
};

export const config = {
  path: "/.netlify/functions/bridgeport-submit",
};
