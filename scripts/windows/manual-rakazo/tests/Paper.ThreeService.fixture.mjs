import { pathToFileURL } from "node:url";
if (!process.env.QA_STOP_BUNDLE) throw Error("Isolated QA canonical stop bundle missing");
const { createPaperStopControl } = await import(pathToFileURL(process.env.QA_STOP_BUNDLE).href);
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const role=process.env.QA_ROLE, directory=process.env.QA_RUNTIME;
const port=Number(process.env.QA_PORT);
if(!directory || !["api","worker","gateway"].includes(role))throw Error("QA inputs");
let server;
if(role!=="worker"){
 server=createServer(async(_req,res)=>{await new Promise(r=>setTimeout(r,400));res.end("qa-"+role);});
 await new Promise(r=>server.listen(port,"127.0.0.1",r));
}
await createPaperStopControl({
 directory,service:role,
 drain:async()=>{
   await writeFile(path.join(directory,role+".begin"),"yes");
   if(role==="worker")await new Promise(r=>setTimeout(r,500));
   if(server)await new Promise((resolve,reject)=>{
     server.close(err=>err?reject(err):resolve());
     server.closeIdleConnections();
   });
   await writeFile(path.join(directory,role+".done"),"yes");
 },
 exit:code=>process.exit(code),
 onError:err=>writeFile(path.join(directory,role+".error"),String(err)).catch(()=>{}),
});
setInterval(()=>{},60000);
