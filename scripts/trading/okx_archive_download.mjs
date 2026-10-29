#!/usr/bin/env node
// Research-only OKX official public archive downloader. No keys, orders,
// account state, arbitrary URLs, automatic retries, or scheduling.
import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const [symbol, month, moduleArg, folder] = process.argv.slice(2);
if (!/^[A-Z0-9]+-USDT-SWAP$/.test(symbol||"") ||
    !/^20\d\d-(0[1-9]|1[0-2])$/.test(month||"") ||
    !["2","3"].includes(moduleArg) || !folder) {
  throw Error("Usage: node okx_archive_download.mjs SYMBOL YYYY-MM 2|3 DIRECTORY");
}
const family = symbol.slice(0,-5), monthShort=month.replace("-","");
const begin = new Date(month+"-01T00:00:00+08:00").getTime();
const [year,mon]=month.split("-").map(Number);
const end = new Date(Date.UTC(year,mon,0,16)).getTime()-24*3600*1000;
const endpoint = new URL("https://www.okx.com/api/v5/public/market-data-history");
for(const [key,val] of Object.entries({
  module:moduleArg,instType:"SWAP",dateAggrType:"monthly",
  instFamilyList:family,begin:String(begin),end:String(end)
})) endpoint.searchParams.set(key,val);
async function get(url, limit) {
  const r=await fetch(url,{method:"GET",redirect:"error",signal:AbortSignal.timeout(18000)});
  if(!r.ok)throw Error("HTTP_"+r.status);
  const bytes=Buffer.from(await r.arrayBuffer());
  if(bytes.length>limit)throw Error("oversized_http_response");
  return bytes;
}
const metadataBytes=await get(endpoint,250000);
const metadata=JSON.parse(metadataBytes.toString("utf8"));
if(metadata.code!=="0"||!Array.isArray(metadata.data))throw Error("invalid_metadata");
const records=metadata.data.flatMap(x=>x.details||[]).flatMap(x=>x.groupDetails||[]);
const expectedSuffix=moduleArg==="2"?"candlesticks":"funding-rate";
const selected=records.filter(x=>typeof x.url==="string"&&typeof x.filename==="string" &&
  x.filename.includes(symbol)&&x.filename.endsWith(".zip") &&
  (moduleArg==="2"?x.filename.includes("candlesticks"):x.filename.includes("funding")));
if(selected.length!==1)throw Error("exactly_one_matching_archive_required_"+selected.length);
const item=selected[0];
const url=new URL(item.url);
if(url.protocol!=="https:"||url.hostname!=="static.okx.com"||
   url.port!==""||url.username!==""||url.password!==""||
   !url.pathname.startsWith("/cdn/okex/traderecords/")||
   !url.pathname.endsWith("/"+encodeURIComponent(item.filename))) {
  throw Error("archive_url_not_whitelisted");
}
const body=await get(url,20_000_000);
if(body.slice(0,2).toString("hex")!=="504b")throw Error("not_zip_data");
await mkdir(folder,{recursive:true});
const zipPath=join(folder,item.filename);
const manifestPath=zipPath+".receipt.json";
const receipt={
  protocol:"okx_official_archive_v5", symbol,month,module:moduleArg,
  utc8_calendar:true, official_metadata_url:endpoint.toString(),
  archive_url:url.toString(),zip_file:item.filename,
  sha256:createHash("sha256").update(body).digest("hex"),
  size_bytes:body.length,
  metadata_sha256:createHash("sha256").update(metadataBytes).digest("hex"),
  downloaded_at_utc:new Date().toISOString(),
  origin_cryptographically_signed:false,
};
const handle=await open(zipPath,"wx",0o600);
try{await handle.writeFile(body);}finally{await handle.close();}
try{
  const h=await open(manifestPath,"wx",0o600);
  try{await h.writeFile(JSON.stringify(receipt,null,2)+"\n")}finally{await h.close()}
}catch(error){await unlink(zipPath);throw error}
process.stdout.write(JSON.stringify({symbol,month,module:moduleArg,zip:zipPath,
  bytes:body.length,sha256:receipt.sha256})+"\n");
