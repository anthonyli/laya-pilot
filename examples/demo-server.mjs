// Local regression fixture only. Random IDs/order and fresh DOM on every navigation.
import http from 'node:http';
import fs from 'node:fs/promises';
const port=Number(process.env.PORT||8765);
const html=await fs.readFile(new URL('./demo.html',import.meta.url),'utf8');
http.createServer((req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}if(req.url==='/api/save-fail'){res.writeHead(500,{'Content-Type':'application/json'});res.end('{"message":"fixture server error"}');return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html.replace('__SAVE_ERROR__',JSON.stringify(process.env.DEMO_SAVE_HTTP_500==='1')));}).listen(port,'127.0.0.1',()=>console.log('演示系统 http://127.0.0.1:'+port));
