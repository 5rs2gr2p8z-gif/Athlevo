import { readFileSync } from "node:fs";
/* Regression: detection MUST work from the real Intervals response shape,
   and MUST NOT report count 0 for any failure mode. */
process.env.SUPABASE_URL="https://db.test";process.env.SUPABASE_SERVICE_ROLE_KEY="svc";
process.env.OAUTH_STATE_SECRET="s";process.env.INTERVALS_CLIENT_ID="c";
process.env.INTERVALS_CLIENT_SECRET="x";process.env.APP_URL="https://athlevo.org";
const handler=(await import("../api/providers/index.js")).default;
let p=0,f=0;const t=(n,c,e)=>{c?(p++,console.log("PASS — "+n)):(f++,console.log("FAIL — "+n+(e?"  ["+e+"]":"")))};

// The REAL documented Intervals.icu activity summary shape.
const realActivity = { id:"i55751783", start_date_local:"2026-07-19T07:35:18",
  type:"Run", name:"Morning Run", distance:12000, moving_time:3600,
  elapsed_time:3700, icu_training_load:95, source:"GARMIN", file_type:"fit" };

const ACC={id:"pa1",user_id:"u1",provider:"intervals",access_token:"tok",
  provider_athlete_id:"i12345",status:"connected"};

function world({ respond }){ const seen=[];
  globalThis.fetch=async(u,i={})=>{const s=String(u);
    const J=(c,b,txt)=>({ok:c<300,status:c,headers:{get:()=>"application/json"},
      json:async()=>b,text:async()=>txt??JSON.stringify(b)});
    if(s.includes("/auth/v1/user"))return J(200,{id:"u1"});
    if(s.includes("rest/v1/provider_accounts"))return (i.method?J(204,null):J(200,[ACC]));
    if(s.includes("rest/v1/activities")){
      if((i.method||"GET").toUpperCase()==="POST"){
        const rows=JSON.parse(i.body); return J(201,rows.map((r,n)=>({id:"a"+n,...r})));
      }
      return J(200,[]);
    }
    if(s.includes("intervals.icu")){ seen.push(s.replace("https://intervals.icu/api/v1","")); return respond(s,J); }
    return J(404,{});};
  return seen;
}
const res=()=>{const r={};r.status=c=>(r.code=c,r);r.json=b=>(r.body=b,r);r.setHeader=()=>{};r.end=()=>r;return r};
const call=async a=>{const r=res();const L=console.log;console.log=()=>{};console.error=()=>{};
  await handler({query:{provider:"intervals",action:a},method:"POST",headers:{authorization:"Bearer g"},body:{},query:{provider:"intervals",action:a}},r);
  console.log=L;return r};

console.log("\n── Real Intervals response shape is detected ──");
{ world({respond:(s,J)=>s.includes("/activities")?J(200,Array.from({length:289},(_,n)=>({...realActivity,id:"i"+(55751783+n),start_date_local:new Date(Date.now()-n*86400000).toISOString().slice(0,19)}))):J(403,{})});
  const r=await call("diagnose");
  t("counts all 289 activities", r.body.probes.wideWindow3y.count===289, String(r.body.probes.wideWindow3y.count));
  t("verdict says the API is fine", /API is fine/.test(r.body.verdict), r.body.verdict);
  t("sample keys expose the real schema",
    r.body.probes.syncWindow180d.sampleKeys.includes("start_date_local"));
  t("id/type/source captured", r.body.probes.syncWindow180d.sample.id==="i55751783");
  const sync=await call("sync");
  t("sync imports them", sync.body.imported>0, JSON.stringify(sync.body).slice(0,80));
}

console.log("\n── A genuinely empty account is distinguishable ──");
{ world({respond:(s,J)=>s.includes("/activities")?J(200,[]):J(403,{})});
  const r=await call("diagnose");
  t("count is 0", r.body.probes.wideWindow3y.count===0);
  t("raw body proves it was really []", r.body.probes.wideWindow3y.rawSample==="[]");
  t("verdict says genuinely zero", /genuinely has zero/.test(r.body.verdict));
}

console.log("\n── A FAILURE is never reported as zero activities ──");
{ world({respond:(s,J)=>s.includes("/activities")
    ?J(400,{error:"bad athlete id"},'{"error":"bad athlete id"}'):J(403,{})});
  const r=await call("diagnose");
  const pr=r.body.probes.syncWindow180d;
  t("probe records an error, not a count", pr.error==="REQUEST_FAILED" && pr.count==null);
  t("the HTTP status is preserved", pr.httpStatus===400);
  t("the response BODY is captured", /bad athlete id/.test(pr.errorBody||""), pr.errorBody);
  t("verdict does NOT claim zero activities", !/genuinely has zero/.test(r.body.verdict), r.body.verdict);
}

console.log("\n── Athlete-id form (bare vs i-prefixed) is disambiguated ──");
{ const seen=world({respond:(s,J)=>{
    // ONLY the bare-numeric form returns data.
    if(s.includes("/athlete/12345/activities")) return J(200,Array.from({length:289},(_,n)=>({...realActivity,id:"i"+(55751783+n),start_date_local:new Date(Date.now()-n*86400000).toISOString().slice(0,19)})));
    if(s.includes("/activities")) return J(200,[]);
    return J(403,{});}});
  const r=await call("diagnose");
  t("the alt-form probe runs", r.body.probes.athleteIdAltForm!=null);
  t("...and finds the activities the stored form missed",
    r.body.probes.athleteIdAltForm.count===289, String(r.body.probes.athleteIdAltForm&&r.body.probes.athleteIdAltForm.count));
  t("the stored id FORM is reported", r.body.athleteIdForm==="i-prefixed", r.body.athleteIdForm);
  t("'0' shorthand was tried first", seen.some(u=>u.includes("/athlete/0/activities")));

  const sync=await call("sync");
  t("SYNC recovers via the alt form too", sync.body.imported===289, JSON.stringify(sync.body).slice(0,90));
}

/* ═══════ A 404 must mean "no such route", never "not connected" ═══════ */

console.log("\n──── 404 is reserved for routing; NOT_CONNECTED is a state ────");
{
  const src = readFileSync("./api/providers/index.js", "utf8");

  /*
   * This cost two debugging rounds: diagnose returned 404 for an athlete with
   * no provider row, which is indistinguishable from an unrouted endpoint.
   */
  t("NOT_CONNECTED is 409, not 404",
    /status\(409\)[\s\S]{0,120}NOT_CONNECTED/.test(src) &&
    !/status\(404\)[\s\S]{0,120}NOT_CONNECTED/.test(src));

  const fourOhFours = src.match(/status\(404\)[^\n]*/g) || [];
  t("every remaining 404 is a genuine unknown-route case",
    fourOhFours.length > 0 && fourOhFours.every(l => /not available|Unknown provider/.test(l)),
    fourOhFours.join(" | "));

  t("diagnose IS implemented and routed",
    /async function actionDiagnose/.test(src) &&
    /if \(action === "diagnose"\) return actionDiagnose/.test(src));

  // The client must agree with the method gate, or every call is a 405.
  const brain = readFileSync("./js/brain.js", "utf8");
  const pr = brain.slice(brain.indexOf("async function providerRequest"));
  t("the client POSTs, matching the server's method gate",
    /method: "POST"/.test(pr.slice(0, pr.indexOf("headers:"))));
  t("...and asks for the action name the server implements",
    /diagnoseIntervals[\s\S]{0,300}providerRequest\("diagnose"/.test(brain));

  /*
   * "Connected but empty" must never be shown when there is no connection.
   * This is now guaranteed upstream: a connection that cannot be verified is
   * rejected at finalize and never reaches detection at all. See
   * tests/oauth-persistence.test.mjs sections 2 and 9/10.
   */
  const conn = readFileSync("./js/onboardingConnect.js", "utf8");
  t("a failed connection routes to a real reason, not to 'no workouts'",
    /reason === "SESSION_CHANGED"/.test(conn) && /COMPLETION_EXPIRED/.test(conn));
  const html = readFileSync("./index.html", "utf8");
  t("detection cannot run before finalization succeeds",
    /if \(outcome\.ok\) return handleIntervalsResult\("connected"/.test(html));
}

console.log(`\n${p} passed, ${f} failed`);
process.exit(f?1:0);
