/* Reproduces each candidate cause against the REAL handler and asserts the
   diagnostics identify it correctly. */
process.env.SUPABASE_URL="https://db.test"; process.env.SUPABASE_SERVICE_ROLE_KEY="svc";
process.env.OAUTH_STATE_SECRET="s"; process.env.INTERVALS_CLIENT_ID="c";
process.env.INTERVALS_CLIENT_SECRET="x"; process.env.APP_URL="https://athlevo.org";
const handler = (await import("../api/providers/index.js")).default;

let pass=0, fail=0;
const t=(n,c,e)=>{ c?(pass++,console.log("PASS — "+n)):(fail++,console.log("FAIL — "+n+(e?"  ["+e+"]":""))); };

const ACCOUNT={id:"pa1",user_id:"u1",provider:"intervals",access_token:"SECRET_TOKEN_VALUE_a1b2c3",
  provider_athlete_id:"i12345",status:"connected",last_sync_at:null,sync_started_at:null};

function world({activitiesFor}){
  globalThis.fetch=async(url,init={})=>{
    const u=String(url), m=(init.method||"GET").toUpperCase();
    const J=(s,b,ct)=>({ok:s>=200&&s<300,status:s,headers:{get:()=>ct||"application/json"},json:async()=>b});
    if(u.includes("/auth/v1/user")) return J(200,{id:"u1"});
    if(u.includes("rest/v1/provider_accounts")){
      if(m==="PATCH"||m==="POST") return J(204,null);
      return J(200,[{...ACCOUNT}]);
    }
    if(u.includes("rest/v1/activities")) return J(200, m==="POST"?JSON.parse(init.body).map((r,i)=>({id:"a"+i,...r})):[]);
    if(u.includes("intervals.icu/api/v1/athlete/")&&u.includes("/activities")){
      const q=new URL(u).searchParams;
      const aid=u.split("/athlete/")[1].split("/")[0];
      return activitiesFor({aid,oldest:q.get("oldest"),newest:q.get("newest"),J});
    }
    if(u.match(/athlete\/0$/)) return J(200,{id:"i12345",name:"Dean"});
    if(u.includes("/intervals")) return J(404,{});
    return J(404,{});
  };
}
const req=(action)=>({query:{provider:"intervals",action},method:"POST",headers:{authorization:"Bearer g"},body:{}});
const res=()=>{const r={b:null,s:null};r.status=c=>(r.s=c,r);r.json=b=>(r.b=b,r);r.setHeader=()=>{};r.end=()=>r;return r;};
const RUN={id:"i1",type:"Run",start_date_local:"2026-07-15T06:00:00",start_date:"2026-07-15T06:00:00Z",
  distance:10000,moving_time:3000,average_heartrate:150};

console.log("\n─── CAUSE 1: account genuinely empty ───");
world({activitiesFor:({J})=>J(200,[])});
let r=res(); await handler(req("sync"),r);
t("sync reports returnedByApi 0 with 0 unparseable", r.b.diagnostics.returnedByApi===0 && r.b.diagnostics.unparseableWindows===0);
r=res(); await handler(req("diagnose"),r);
t("diagnose verdict: genuinely zero activities", /genuinely has zero activities/.test(r.b.verdict), r.b.verdict);

console.log("\n─── CAUSE 2: wrong date window (data older than 180d) ───");
world({activitiesFor:({oldest,J})=> J(200, oldest < "2024-01-01" ? [RUN] : [])});
r=res(); await handler(req("diagnose"),r);
t("diagnose verdict: date window is the cause", /date window is the cause/.test(r.b.verdict), r.b.verdict);

console.log("\n─── CAUSE 3: athlete id '0' shorthand broken ───");
world({activitiesFor:({aid,J})=> J(200, aid==="0" ? [] : [RUN])});
r=res(); await handler(req("diagnose"),r);
t("diagnose verdict: '0' shorthand is the cause", /shorthand is the cause/.test(r.b.verdict), r.b.verdict);
r=res(); await handler(req("sync"),r);
t("sync AUTO-RECOVERS via explicit athlete id", r.b.imported===1, "imported="+r.b.imported);
t("...and records that it did", r.b.diagnostics.windowReports.some(w=>w.usedExplicitAthleteId));

console.log("\n─── CAUSE 4: response shape mismatch (wrapped object) ───");
world({activitiesFor:({J})=>J(200,{activities:[RUN],page:1})});
r=res(); await handler(req("sync"),r);
t("sync counts unparseable windows instead of silently skipping", r.b.diagnostics.unparseableWindows>0);
t("...and reports returnedByApi 0 so the two causes are distinguishable", r.b.diagnostics.returnedByApi===0);
r=res(); await handler(req("diagnose"),r);
t("diagnose exposes the wrapper keys", JSON.stringify(r.b.probes).includes("activities"));

console.log("\n─── CAUSE 5: returned but dropped by normalization ───");
world({activitiesFor:({J})=>J(200,[{type:"Run",distance:5000}])});  // no id, no date
r=res(); await handler(req("sync"),r);
t("returnedByApi > 0 while imported 0 → points at normalization",
  r.b.diagnostics.returnedByApi>0 && r.b.imported===0 && r.b.failed>0,
  `returned=${r.b.diagnostics.returnedByApi} imported=${r.b.imported} failed=${r.b.failed}`);

console.log("\n─── Healthy path (regression) ───");
world({activitiesFor:({J})=>J(200,[RUN])});
r=res(); await handler(req("sync"),r);
t("normal sync still imports", r.b.imported===1 && r.b.diagnostics.returnedByApi>0);
r=res(); await handler(req("diagnose"),r);
t("diagnose confirms API is fine", /the API is fine/.test(r.b.verdict), r.b.verdict);

console.log("\n─── Auth failure ───");
world({activitiesFor:({J})=>J(401,{})});
globalThis.fetch=(orig=>async(u,i)=>String(u).match(/athlete\/0$/)?{ok:false,status:401,headers:{get:()=>null},json:async()=>({})}:orig(u,i))(globalThis.fetch);
r=res(); await handler(req("diagnose"),r);
t("diagnose verdict: token rejected", /Token rejected/.test(r.b.verdict), r.b.verdict);

console.log("\n─── Privacy ───");
world({activitiesFor:({J})=>J(200,[RUN])});
r=res(); await handler(req("diagnose"),r);
const dump=JSON.stringify(r.b);
t("no access token in the diagnostic payload", !dump.includes("SECRET_TOKEN_VALUE_a1b2c3"));
t("no client secret in the diagnostic payload", !dump.includes("csecret") && !dump.includes("\"x\""));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
