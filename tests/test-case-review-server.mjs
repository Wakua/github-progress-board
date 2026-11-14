// 製品の画面モジュールを、明示した架空のメモリ接続で確認する読取り専用サーバー。
import http from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url),port=Number(process.argv[2]||4495);
const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>#170 ケース編集の接続検証</title><link rel="stylesheet" href="/testing/case-editor.css"><style>body{margin:0;background:#101720;color-scheme:dark}.review{padding:10px 24px;background:#29251e;color:#f3d6a2;font:12px system-ui;display:flex;gap:16px;align-items:center;flex-wrap:wrap}.review select{font:inherit}</style><header class="review"><strong>接続検証用 · 架空データ</strong><span>保存先未接続・再読込で初期化</span><label>次の保存<select id="scenario"><option value="ok">成功</option><option value="failure">失敗</option><option value="conflict">競合</option><option value="lost-response">応答消失</option></select></label></header><main id="cases"></main><script type="module" src="/fixture.mjs"></script></html>`;
const fixture=`import {mountCaseEditor} from '/testing/case-view.mjs';import {memoryCaseRepository} from '/support/test-case-fixture.mjs';const repository=memoryCaseRepository();const control=document.querySelector('#scenario');control.onchange=()=>repository.setScenario(control.value);mountCaseEditor(document.querySelector('#cases'),{repository});`;
const paths=new Map([
 ['/testing/case-editor.css','dist/testing/case-editor.css'],['/testing/case-editor.mjs','dist/testing/case-editor.mjs'],['/testing/case-view.mjs','dist/testing/case-view.mjs'],['/support/test-case-fixture.mjs','tests/support/test-case-fixture.mjs'],
]);
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  const pathname=new URL(req.url,`http://127.0.0.1:${port}`).pathname;
  try {
    if(pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);return;}
    if(pathname==='/fixture.mjs'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'}).end(fixture);return;}
    const file=paths.get(pathname);if(!file){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'}).end(await readFile(new URL(file,root)));
  }catch{res.writeHead(500).end();}
});
server.listen(port,'127.0.0.1',()=>console.log(`#170 UI integration fixture: http://127.0.0.1:${port}/`));
