import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));

app.get("/", (_req, res) => {
  res.type("text").send("AI Handyman API is running 🧰");
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// (Optional) HMAC verify — you can disable during MVP if it blocks you
function verifyShopifyProxy(req: any) {
  const { signature, ...rest } = req.query || {};
  if (!signature) return true; // TEMP: allow during MVP
  const msg = Object.keys(rest || {})
    .sort()
    .map((k) => `${k}=${(rest as any)[k]}`)
    .join("");
  const h = crypto
    .createHmac("sha256", process.env.APP_PROXY_SECRET || "")
    .update(msg)
    .digest("hex");
  return h === signature;
}

// Google Sheets client
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  undefined,
  (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
  ]
);
const sheets = google.sheets({ version: "v4", auth });

async function fetchHandymen() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_ID!,
    range: "handymen_offline!A2:P",
  });
  const rows = res.data.values || [];
  const cols = [
    "id",
    "name",
    "phone",
    "whatsapp",
    "trade",
    "specialties",
    "district_coverage",
    "languages",
    "years_experience",
    "availability",
    "price_range",
    "source",
    "rating_avg",
    "rating_count",
    "last_active",
    "notes",
  ];
  return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] || ""])));
}

function score(c: any, q: any) {
  const w = { Expertise: 0.3, Coverage: 0.2, Language: 0.15, Trust: 0.15, Recency: 0.1, PriceFit: 0.1 };
  const has = (s: string, v: string) => String(s || "").toLowerCase().includes((v || "").toLowerCase());
  let Expertise = (c.trade === q.trade ? 1 : 0) + (has(c.specialties, q.subcategory) ? 0.5 : 0);
  let Coverage = (c.district_coverage || "")
    .split(",")
    .map((x: string) => x.trim().toLowerCase())
    .includes((q.district || "").toLowerCase())
    ? 1
    : 0;
  let Language = (c.languages || "").includes(q.language || "zh-HK") ? 1 : 0;
  let Trust = c.source === "offline-word-of-mouth" ? 1 : 0.4;
  const r = parseFloat(c.rating_avg || "0");
  if (!Number.isNaN(r)) Trust = (Trust + (r - 1) / 4) / 2;
  let Recency = 0;
  if (c.last_active) {
    const d = Date.now() - new Date(c.last_active).getTime();
    Recency = d <= 90 * 864e5 ? 1 : d <= 180 * 864e5 ? 0.5 : 0;
  }
  let PriceFit = 0.5;
  return (
    w.Expertise * Expertise +
    w.Coverage * Coverage +
    w.Language * Language +
    w.Trust * Trust +
    w.Recency * Recency +
    w.PriceFit * PriceFit
  );
}

app.get("/handymen/search", async (req, res) => {
  const { trade, district = "", language = "zh-HK", max = "5" } = req.query as any;
  const list = await fetchHandymen();
  const results = list
    .map((c: any) => ({ ...c, _score: score(c, { trade, district, language, subcategory: "" }) }))
    .sort((a: any, b: any) => b._score - a._score)
    .slice(0, parseInt(max as string));
  res.json({ results });
});

app.post("/diagnose", async (req, res) => {
  const { text, district, appliance, language = "zh-HK" } = req.body || {};
  const system = `You are a Hong Kong home-appliance triage assistant. Respond in ${language}. Return compact JSON. Safety first.`;
  const user = `District: ${district || "N/A"}\nAppliance: ${appliance || "N/A"}\nIssue:\n"""\n${text}\n"""`;

  // Node 20 has global fetch
  const r = await fetch(`${process.env.OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.MODEL,
      prompt: `${system}\n\n${user}`,
      stream: false,
    }),
  });
  const data = await r.json();
  res.json({ raw: data.response });
});

app.post("/refer", async (_req, res) => {
  res.json({ ok: true, job_id: `job_${Date.now()}` });
});

app.listen(process.env.PORT || 8787, () => {
  console.log("AI Handyman API on", process.env.PORT || 8787);
});
