'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { runAssistant } = require('../lib/ai/assistant');
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(__dirname, '..', 'frontend');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Cache-Control':'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function readJson(req, limit=2*1024*1024) {
  return new Promise((resolve,reject)=>{
    let size=0, chunks=[];
    req.on('data', chunk=>{ size+=chunk.length; if(size>limit){ reject(Object.assign(new Error('request body too large'),{status:413})); req.destroy(); } else chunks.push(chunk); });
    req.on('end',()=>{ try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('invalid JSON body'),{status:400})); } });
    req.on('error',reject);
  });
}
async function handler(req,res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method==='GET' && url.pathname==='/api/health') return send(res,200,{ok:true,app:'ARTEMIS R69',version:'6.1.0',mode:'analysis-only',persistentWrites:false,felExecEnabled:false});
  if (req.method==='GET' && url.pathname==='/api/build') {
    const info=JSON.parse(fs.readFileSync(path.join(ROOT,'..','BUILD_INFO.json'),'utf8')); return send(res,200,info);
  }
  if (req.method==='POST' && url.pathname==='/api/assistant') {
    try {
      const body=await readJson(req); const prompt=body.prompt;
      if(typeof prompt!=='string'||!prompt.trim()) return send(res,400,{error:'prompt_required'});
      if(prompt.length>12000) return send(res,413,{error:'prompt_too_long'});
      const result=await runAssistant(prompt.trim(),body.context&&typeof body.context==='object'?body.context:{});
      return send(res,200,result);
    } catch(e) { return send(res,e.status||500,{error:e.status===400?'invalid_json':e.status===413?'payload_too_large':'assistant_error',message:e.message}); }
  }
  if (req.method!=='GET' && req.method!=='HEAD') return send(res,405,{error:'method_not_allowed'});
  let pathname=decodeURIComponent(url.pathname);
  if(pathname==='/'||pathname.endsWith('/')) pathname+='index.html';
  const target=path.resolve(ROOT,'.'+pathname);
  if(!target.startsWith(ROOT+path.sep)) return send(res,403,{error:'forbidden'});
  fs.stat(target,(err,st)=>{
    if(err||!st.isFile()) return send(res,404,{error:'not_found'});
    res.writeHead(200,{'Content-Type':MIME[path.extname(target)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    if(req.method==='HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}
const server=http.createServer((req,res)=>{handler(req,res).catch(e=>send(res,500,{error:'internal_error',message:e.message}));});
if(require.main===module) server.listen(PORT,'0.0.0.0',()=>console.log(`ARTEMIS R69 v6.1.0 listening on ${PORT}`));
module.exports={server,handler};
