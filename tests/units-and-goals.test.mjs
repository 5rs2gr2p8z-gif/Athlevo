/* Verify the unit + distance logic by EXECUTING the real functions. */
import { readFileSync } from "node:fs";
const src = readFileSync("./js/onboarding.js","utf8");
const store = new Map();
const sandbox = { console, localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},
  document:{getElementById:()=>null,querySelectorAll:()=>[]}, window:{}, supabaseClient:{} };
const api = new Function(...Object.keys(sandbox), src + "; return {obNormalizeDistance,OB_CONVERT,obUnits,obSetUnits,obApplyUnits,obVisibleFields};")(...Object.values(sandbox));
let p=0,f=0; const t=(n,c,e)=>{c?(p++,console.log("PASS — "+n)):(f++,console.log("FAIL — "+n+(e?"  ["+e+"]":"")))};

console.log("\n── P4: custom distance normalisation ──");
[["10 miles","10 miles"],["10mi","10 miles"],["1 mile","1 mile"],["15 km","15 km"],["15k","15 km"],
 ["50km","50 km"],["100 km","100 km"],["Chicago trail race","Chicago trail race"]]
 .forEach(([i,o])=>t(`"${i}" → "${o}"`, api.obNormalizeDistance(i)===o, api.obNormalizeDistance(i)));
t("empty input returns null", api.obNormalizeDistance("")===null);
t("never invents a distance", api.obNormalizeDistance("something vague")==="something vague");

console.log("\n── P3: conversions round-trip ──");
const C=api.OB_CONVERT;
t("175cm → 68.9in", Math.abs(C.cmToIn(175)-68.897)<0.01);
t("69in → 175.3cm", Math.abs(C.inToCm(69)-175.26)<0.01);
t("68kg → 149.9lb", Math.abs(C.kgToLb(68)-149.91)<0.01);
t("150lb → 68.0kg", Math.abs(C.lbToKg(150)-68.04)<0.01);
t("10km → 6.21mi", Math.abs(C.kmToMi(10)-6.21371)<0.001);
t("cm→in→cm round-trips", Math.abs(C.inToCm(C.cmToIn(180))-180)<0.001);
t("kg→lb→kg round-trips", Math.abs(C.lbToKg(C.kgToLb(72))-72)<0.001);

console.log("\n── P3: field spec follows the chosen units ──");
t("defaults to metric", api.obUnits()==="metric");
let hf = api.obApplyUnits({id:"height",unitKey:"height"});
t("metric height is cm", hf.unit==="cm" && hf.min===100);
store.set("athlevo_units","imperial");
hf = api.obApplyUnits({id:"height",unitKey:"height"});
t("imperial height is in", hf.unit==="in" && hf.min===39);
const wf = api.obApplyUnits({id:"weight",unitKey:"weight"});
t("imperial weight is lb", wf.unit==="lb" && wf.max===660);
t("a field without unitKey is untouched",
  api.obApplyUnits({id:"x",unit:"z"}).unit==="z");

console.log("\n── P4: the custom field only shows when 'Other' ──");
const fields=[{id:"distance"},{id:"customDistance",showWhen:{distance:"Other"}}];
const g=new Function(...Object.keys(sandbox), src + "; obData.distance='5K'; return obVisibleFields;")(...Object.values(sandbox));
t("hidden for 5K", g(fields).length===1);
const g2=new Function(...Object.keys(sandbox), src + "; obData.distance='Other'; return obVisibleFields;")(...Object.values(sandbox));
t("shown for Other", g2(fields).length===2);

console.log(`\n${p} passed, ${f} failed`);
process.exit(f?1:0);
