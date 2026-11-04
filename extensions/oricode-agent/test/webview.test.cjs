/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const path=require('node:path');
const Module=require('node:module');
const {chromium}=require('playwright-core');
let server,browser,page,provider,base,html;
const extensionRoot=path.resolve(__dirname,'..');
const evidence=path.resolve(extensionRoot,'../../.build/oricode-validation');
const noop={dispose(){}};
const vscode={EventEmitter:class{event=()=>noop;dispose(){}},Uri:{joinPath:(_,name)=>name},workspace:{getConfiguration:()=>({get:(_,fallback)=>fallback}),registerTextDocumentContentProvider:()=>noop},window:{registerWebviewViewProvider:(_,p)=>{provider=p;return noop;}},commands:{registerCommand:()=>noop,executeCommand:async()=>{}},authentication:{registerAuthenticationProvider:()=>noop}};
const oldLoad=Module._load;Module._load=function(id,...args){return id==='vscode'?vscode:oldLoad.call(this,id,...args);};const extension=require('../out/extension.js');Module._load=oldLoad;
const modelData=[{id:'adaptive',name:'Adaptive'},{id:'anthropic/claude-sonnet',name:'Claude Sonnet',inUsd:3,outUsd:15},{id:'openai/gpt-test',name:'GPT',inUsd:1,outUsd:2},{id:'google/gemini-test',name:'Gemini',free:true},{id:'deepseek/test',name:'DeepSeek',free:true},{id:'qwen/qwen-test',name:'Qwen',free:true},{id:'moonshotai/kimi-test',name:'Kimi'},{id:'nvidia/nemotron',name:'Nemotron',free:true},{id:'minimax/m3',name:'MiniMax'},{id:'meta-llama/llama',name:'Llama'},{id:'mistralai/mistral',name:'Mistral'},{id:'x-ai/grok',name:'Grok'},{id:'<img src=x onerror=alert(1)>/evil',name:'<script>bad</script>',desc:'" onclick="alert(1)'}];
const dispatch=message=>page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),message);
before(async()=>{
 extension.activate({secrets:{get:async()=>''},workspaceState:{get:(_,fallback)=>fallback,update:async()=>{}},extensionUri:'extension',subscriptions:[]});
 server=http.createServer(async(req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}try{const name=decodeURIComponent(req.url.split('?')[0]);assert.ok(name.startsWith('/media/'));assert.ok(!name.includes('..'));res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/javascript');res.end(await fs.readFile(path.join(extensionRoot,name)));}catch{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 html=provider._html({cspSource:base,asWebviewUri:()=>base+'/media'});
 browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:420,height:850}});
 await page.addInitScript(()=>{window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.messages.push(m)});});
 await page.goto(base);await page.waitForFunction(()=>window.messages.some(m=>m.type==='ready'));
 await dispatch({type:'models',models:modelData,current:'adaptive',mode:'cloud'});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
test('provider icons load locally and search supports provider labels',async()=>{
 await page.locator('#selBtn').click();await page.waitForFunction(()=>[...document.querySelectorAll('#selList img')].every(img=>img.complete&&img.naturalWidth>0));
 assert.ok(await page.locator('#selList img').count()>10);assert.equal(await page.locator('img[src^="https:"]').count(),0);
 await page.locator('#selSearch').fill('Moonshot');assert.equal(await page.locator('#selList [role=option]').count(),1);await page.locator('#selSearch').press('ArrowDown');await page.locator('#selSearch').press('Enter');assert.match(await page.locator('#selBtn').innerText(),/Kimi/);
});
test('popup fits narrow and wide viewports without horizontal overflow',async()=>{
 for(const width of [320,420,800]){await page.setViewportSize({width,height:850});await page.locator('#selBtn').click();const rect=await page.locator('#selPanel').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.keyboard.press('Escape');}
 await page.setViewportSize({width:420,height:850});
});
test('mode menu closes on escape and reports selection',async()=>{await page.locator('#modeBtn').click();await page.locator('[data-mode="plan"]').click();assert.equal(await page.locator('#modeBtn').innerText(),'Plan');assert.ok(await page.evaluate(()=>messages.some(m=>m.type==='setAgentMode'&&m.mode==='plan')));await page.locator('#modeBtn').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#modePanel').isVisible(),false);});
test('one send stays pending until reply and allows cancellation',async()=>{
 await page.locator('#in').fill('Repara mi proyecto');await page.locator('#send').click();assert.equal(await page.locator('#send').getAttribute('aria-label'),'Detener tarea');await page.locator('#send').click();assert.ok(await page.evaluate(()=>messages.some(m=>m.type==='cancel')));
 await dispatch({type:'delta',text:'Respuesta parcial'});await dispatch({type:'notice',text:'Aviso independiente'});assert.equal(await page.locator('#log').getByText('Respuesta parcial',{exact:true}).count(),1);
 await dispatch({type:'reply',text:'Listo: archivo corregido'});await dispatch({type:'busy',value:false});assert.equal(await page.locator('#send').getAttribute('aria-label'),'Enviar');
});
test('file proposals render an actionable review button and escape HTML',async()=>{
 await dispatch({type:'reply',text:'Cambio:\n\x60\x60\x60js filename=src/app.js\nconst x = "<script>bad</script>";\n\x60\x60\x60'});await page.locator('.apply').filter({hasText:'Revisar y aplicar'}).click();assert.ok(await page.evaluate(()=>messages.some(m=>m.type==='apply'&&m.file==='src/app.js')));assert.equal(await page.locator('.db').innerText(),'const x = "<script>bad</script>";\n');
 await page.locator('#selBtn').click();await page.locator('#selSearch').fill('evil');assert.equal(await page.locator('#selList script').count(),0);assert.equal(await page.locator('#selList img[src="x"]').count(),0);await page.keyboard.press('Escape');
});
test('history maps bot styling and new chat emits a real clear request',async()=>{await dispatch({type:'history',items:[{r:'user',x:'hola'},{r:'bot',x:'respuesta'}]});assert.equal(await page.locator('.msg.bot').count(),1);await page.locator('#newChat').click();assert.ok(await page.evaluate(()=>messages.some(m=>m.type==='clearHistory')));});
test('visual evidence for provider picker in light and dark themes',async()=>{
 await fs.mkdir(evidence,{recursive:true});
 await dispatch({type:'history',items:[]});await page.locator('#selBtn').click();
 await page.evaluate(()=>{document.body.className='vscode-light';document.body.style.cssText='--vscode-foreground:#252525;--vscode-sideBar-background:#fafafa;--vscode-input-background:#fff;--vscode-input-foreground:#252525;--vscode-panel-border:#e5e5e5;--vscode-widget-border:#ddd;--vscode-descriptionForeground:#777;--vscode-editorWidget-background:#fff;--vscode-list-hoverBackground:#f2f2f2;--vscode-list-inactiveSelectionBackground:#eee';});
 await page.screenshot({path:path.join(evidence,'picker-light.png')});await page.evaluate(()=>{document.body.className='vscode-dark';document.body.style.cssText='';});await page.screenshot({path:path.join(evidence,'picker-dark.png')});
});

test('every declared provider asset loads, including prefixed aliases',async()=>{
 const ids=await page.evaluate(()=>Object.keys(PROVIDERS));
 await dispatch({type:'models',models:ids.map(id=>({id:id+'/test'})).concat([{id:'~openai/test'}]),current:'~openai/test',mode:'cloud'});
 if (!await page.locator('#selSearch').isVisible()) { await page.locator('#selBtn').click(); }
 await page.locator('#selSearch').fill('');
 await page.waitForFunction(()=>[...document.querySelectorAll('#selList img')].every(img=>img.complete&&img.naturalWidth>0));
 assert.ok(await page.locator('#selList img').count()>=39);
 assert.match(await page.locator('#selBtn img').getAttribute('src'),/openai\.svg$/);
});

test('billing errors and free fallback offer a trusted account link',async()=>{
 await dispatch({type:'notice',text:'HTTP 402: Has consumido tus créditos de OriCode.'});
 let link=page.locator('.billing-action').last();
 assert.equal(await link.getAttribute('href'),'https://oricode.orizonstudio.cloud/account/#plans');
 assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
 await dispatch({type:'tool',text:'Proveedor sin cuota/disponibilidad. Reintentando con un modelo gratuito.'});
 assert.equal(await page.locator('.tool-event .billing-action').last().innerText(),'Gestionar créditos ↗');
});


const speechUpdate=data=>page.evaluate(d=>window.dispatchEvent(new MessageEvent('message',{data:d})),data);
test('dictation start posts speechStart and streaming transcript preserves typed prefix',async()=>{
 await page.locator('#in').fill('nota previa:');
 await page.locator('#speech').click();
 assert.ok(await page.evaluate(()=>messages.some(m=>m.type==='speechStart')));
 await speechUpdate({type:'speechUpdate',state:'recording',text:'hola'});
 await speechUpdate({type:'speechUpdate',state:'recording',text:'hola mundo'});
 assert.equal(await page.locator('#in').inputValue(),'nota previa: hola mundo');
 await speechUpdate({type:'speechUpdate',state:'done',text:'hola mundo final'});
 assert.equal(await page.locator('#in').inputValue(),'nota previa: hola mundo final');
 await speechUpdate({type:'speechEnd'});
});
test('real level drives the meter; silence stays at zero',async()=>{
 await page.locator('#speech').click();
 await speechUpdate({type:'speechUpdate',state:'recording',level:0});
 assert.equal(await page.locator('#speechMeter').isVisible(),true);
 assert.equal(await page.locator('#speechMeter').getAttribute('aria-valuenow'),'0');
 await speechUpdate({type:'speechUpdate',state:'recording',level:0.6,text:''});
 assert.equal(await page.locator('#speechMeter').getAttribute('aria-valuenow'),'60');
 await speechUpdate({type:'speechUpdate',state:'idle'});await speechUpdate({type:'speechEnd'});
 assert.equal(await page.locator('#speechMeter').isVisible(),false);
});
test('stop and cancel controls map to bridge messages',async()=>{
 await page.locator('#speech').click();
 assert.equal(await page.locator('#speech').getAttribute('aria-pressed'),'true');
 await speechUpdate({type:'speechUpdate',state:'recording'});
 await page.locator('#speech').click();
 assert.ok(await page.evaluate(()=>messages.some(m=>m.type==='speechStop')));
 await speechUpdate({type:'speechUpdate',state:'done',text:''});await speechUpdate({type:'speechEnd'});
 await page.locator('#speech').click();
 await page.locator('#speech').click(); // preparing -> cancel
 assert.ok(await page.evaluate(()=>messages.some(m=>m.type==='speechCancel')));
 await speechUpdate({type:'speechEnd'});
});
test('manual edit cancels dictation and preserves typed text',async()=>{
 await page.locator('#in').fill('escribo ');
 await page.locator('#speech').click();
 await speechUpdate({type:'speechUpdate',state:'recording',text:'dictado'});
 await page.locator('#in').pressSequentially('manual');
 assert.ok(await page.evaluate(()=>messages.filter(m=>m.type==='speechCancel').length>=1));
 assert.match(await page.locator('#in').inputValue(),/manual$/);
 await speechUpdate({type:'speechEnd'});
});
test('error snapshot is visible and resets the button',async()=>{
 await page.locator('#speech').click();
 await speechUpdate({type:'speechUpdate',state:'error',error:'micrófono no disponible'});
 assert.match(await page.locator('#status').innerText(),/micrófono no disponible/);
 assert.equal(await page.locator('#speech').getAttribute('aria-pressed'),'false');
 await speechUpdate({type:'speechEnd'});
});
