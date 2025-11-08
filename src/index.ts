import express from 'express';
const auth = new google.auth.JWT(
process.env.GOOGLE_CLIENT_EMAIL,
undefined,
(process.env.GOOGLE_PRIVATE_KEY||'').replace(/\\n/g, '\n'),
['https://www.googleapis.com/auth/spreadsheets.readonly','https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });


async function fetchHandymen() {
const res = await sheets.spreadsheets.values.get({
spreadsheetId: process.env.SHEETS_ID!,
range: 'handymen_offline!A2:O',
});
const rows = res.data.values || [];
const cols = ["id","name","phone","whatsapp","trade","specialties","district_coverage","languages","years_experience","availability","price_range","source","rating_avg","rating_count","last_active","notes"];
return rows.map(r => Object.fromEntries(cols.map((c,i)=>[c,r[i]||''])));
}


function score(c: any, q: any){
const w = {Expertise:.30,Coverage:.20,Language:.15,Trust:.15,Recency:.10,PriceFit:.10};
const has = (s:string,v:string)=>String(s||'').toLowerCase().includes(v);
let Expertise = (c.trade===q.trade?1:0) + (has(c.specialties,q.subcategory)?0.5:0);
let Coverage = c.district_coverage.split(',').map((x:string)=>x.trim().toLowerCase()).includes((q.district||'').toLowerCase())?1:0;
let Language = (c.languages||'').includes(q.language||'zh-HK')?1:0;
let Trust = (c.source==='offline-word-of-mouth'?1:0.4);
const r = parseFloat(c.rating_avg||'0'); if(!isNaN(r)) Trust = (Trust+ (r-1)/4)/2; // blend
let Recency = 0; // simple: mark 1 if last_active within 90d
if(c.last_active){
const d = Date.now()-new Date(c.last_active).getTime();
Recency = d<=90*864e5?1:(d<=180*864e5?0.5:0);
}
let PriceFit = 0.5; // TODO: parse price vs budget
const total = w.Expertise*Expertise + w.Coverage*Coverage + w.Language*Language + w.Trust*Trust + w.Recency*Recency + w.PriceFit*PriceFit;
return total;
}


app.post('/diagnose', async (req,res)=>{
const { text, district, appliance, language='zh-HK' } = req.body;
const system = `You are a Hong Kong home-appliance triage assistant. Respond in ${language}. Safety first... Return compact JSON as specified.`;
const user = `District: ${district||'N/A'}\nAppliance: ${appliance||'N/A'}\nIssue:\n"""\n${text}\n"""`;
// Call Ollama (OpenAI-compatible format is also fine if using vLLM server)
const r = await fetch(`${process.env.OLLAMA_BASE_URL}/api/generate`,{
method:'POST', headers:{'Content-Type':'application/json'},
body: JSON.stringify({ model: process.env.MODEL, prompt: `${system}\n\n${user}`, stream:false })
});
const data = await r.json();
// TODO: parse data.response to JSON safely with a regex fence
res.json({ raw: data.response });
});


app.get('/handymen/search', async (req,res)=>{
const { trade, district='', language='zh-HK', max='5' } = req.query as any;
const list = await fetchHandymen();
const enriched = list.map(c=>({ ...c, _score: score(c,{trade, subcategory:'', district, language}) }))
.sort((a,b)=>b._score-a._score).slice(0, parseInt(max));
res.json({ results: enriched });
});


app.post('/refer', async (req,res)=>{
// For MVP just echo and TODO: integrate WhatsApp/Email
res.json({ ok:true, job_id: 'job_'+Date.now() });
});


app.listen(process.env.PORT, ()=> console.log('AI Handyman API on', process.env.PORT));
