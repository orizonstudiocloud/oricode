/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const Module = require('node:module');
const { requestJson, streamChat } = require('../out/network.js');
let server, base, fixture, viewProvider, onMessage, onDispose, authProvider, secrets, received = [], posts = [], answer = '', documents = new Map();
const settings = { maxSteps: 6, responseTimeout: 30000 };
class Uri {
 constructor(value) { this.url = new URL(value); this.scheme = this.url.protocol.slice(0,-1); this.path = decodeURIComponent(this.url.pathname); this.fsPath = this.scheme === 'file' ? fileURLToPath(this.url) : this.path; }
 toString() { return this.url.href; }
 static file(p) { return new Uri(pathToFileURL(p).href); }
 static parse(p) { return new Uri(p); }
 static joinPath(uri, ...parts) { return Uri.file(path.join(uri.fsPath,...parts)); }
}
class FileSystemError extends Error { constructor(code) { super(code); this.code=code; } }
const disposable = { dispose() {} };
const store = new Map();
const state = { get: (key,fallback) => store.has(key) ? store.get(key) : fallback, update: async (key,value) => {store.set(key,value);} };
store.set('oricode.mode', 'local');
const rootUri = () => Uri.file(fixture);
async function openDocument(uri) {
 if(documents.has(uri.fsPath)) return documents.get(uri.fsPath);
 const doc = { uri, isDirty:false, getText: () => doc.text, text: await fs.readFile(uri.fsPath,'utf8'), positionAt: n => n, save: async () => {await fs.writeFile(uri.fsPath,doc.text);doc.isDirty=false;return true;} };
 documents.set(uri.fsPath,doc); return doc;
}
const vscode = {
 Uri, FileSystemError, FileType:{File:1,Directory:2,SymbolicLink:64}, l10n:{t:(text,...args)=>text.replace(/\{(\d+)\}/g,(_,n)=>args[n])},
 Range:class {constructor(start,end){this.start=start;this.end=end;}},
 WorkspaceEdit:class {changes=[];replace(uri,range,text){this.changes.push({uri,range,text});}createFile(uri,options){this.changes.push({uri,options});}},
 EventEmitter:class {listeners=[];event=listener=>{this.listeners.push(listener);return disposable;};fire(value){for(const listener of this.listeners)listener(value);}dispose(){}},
 workspace: {
  get workspaceFolders(){return [{uri:rootUri()}];},isTrusted:true,
  getConfiguration:()=>({get:(key,fallback)=>settings[key]??fallback}),
  getWorkspaceFolder:uri=>path.relative(fixture,uri.fsPath).startsWith('..')?undefined:{uri:rootUri()},
  asRelativePath:uri=>path.relative(fixture,uri.fsPath),
  registerTextDocumentContentProvider:()=>disposable,
  openTextDocument:openDocument,
  fs:{
   readFile:uri=>fs.readFile(uri.fsPath),
   readDirectory:async uri=>(await fs.readdir(uri.fsPath,{withFileTypes:true})).map(e=>[e.name,e.isDirectory()?2:e.isSymbolicLink()?64:1]),
   stat:async uri=>{try{return await fs.stat(uri.fsPath);}catch(e){if(e.code==='ENOENT')throw new FileSystemError('FileNotFound');throw e;}},
   createDirectory:uri=>fs.mkdir(uri.fsPath,{recursive:true})
  },
  applyEdit:async edit=>{for(const c of edit.changes){if(c.options){await fs.writeFile(c.uri.fsPath,c.options.contents,{flag:'wx'});}else{const d=await openDocument(c.uri);d.text=c.text;d.isDirty=true;}}return true;}
 },
 window:{get activeTextEditor(){return undefined;},registerWebviewViewProvider:(id,provider)=>{viewProvider=provider;return disposable;},showWarningMessage:async (_text,_options,...choices)=>answer||choices[0],showErrorMessage:async()=>{},showOpenDialog:async()=>undefined},
 commands:{registerCommand:()=>disposable,executeCommand:async()=>{}},
 authentication:{registerAuthenticationProvider:(_id,_label,provider)=>{authProvider=provider;return disposable;}},languages:{getDiagnostics:()=>[]},env:{clipboard:{writeText:async()=>{}}}
};
const oldLoad = Module._load;
Module._load = function(id,...args) {return id==='vscode'?vscode:oldLoad.call(this,id,...args);};
const agent = require('../out/agent.js');
const extension = require('../out/extension.js');
Module._load = oldLoad;
function event(text) {return 'data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n';}
let responder = (req,res) => {res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(event('Hola')+'data: [DONE]\n\n');};
before(async()=>{
 fixture=await fs.mkdtemp(path.join(os.tmpdir(),'oricode-test-'));
 await fs.writeFile(path.join(fixture,'index.js'),'const value = 1;\n');
 server=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;let body=data?JSON.parse(data):{};received.push({url:req.url,body});if(req.url==='/api/tags'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{name:'qwen3:8b',size:5000000000},{name:'remote:cloud',remote_host:'https://ollama.com'}]}));}else responder(req,res,body);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;settings.ollamaUrl=base;settings.cloudUrl=base;
 secrets=new Map([['oricode.apiKey','orz_test_key'],['oricode.server',base]]);
 const context={secrets:{get:async key=>secrets.get(key),store:async(key,value)=>secrets.set(key,value),delete:async key=>secrets.delete(key)},workspaceState:state,globalState:state,extensionUri:Uri.file(path.resolve(__dirname,'..')),subscriptions:[]};extension.activate(context);
 viewProvider.resolveWebviewView({webview:{cspSource:base,asWebviewUri:()=>base+'/media',postMessage:m=>{posts.push(m);return Promise.resolve(true);},onDidReceiveMessage:listener=>{onMessage=listener;return disposable;}},onDidDispose:listener=>{onDispose=listener;return disposable;}});
 await viewProvider.restoreSession();
 await onMessage({type:'setMode',mode:'local'});
});
after(async()=>{viewProvider.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(fixture,{recursive:true,force:true});});
const chat = (options={})=>streamChat(base+'/chat','test',[{role:'user',content:'hola'}],{local:false,onDelta:()=>{},timeoutMs:3000,...options});
test('JSON rejects HTTP errors with useful status',async()=>{responder=(_q,r)=>{r.writeHead(401);r.end('{"detail":"Invalid key"}');};await assert.rejects(requestJson(base+'/error'),/HTTP 401: Invalid key/);});
test('SSE decodes split UTF-8 and flushes final line',async()=>{const bytes=Buffer.from(event('España 🛠')+'data: '+JSON.stringify({choices:[{delta:{content:' fin'}}]}));responder=(_q,r)=>{r.writeHead(200,{'Content-Type':'text/event-stream'});const split=bytes.indexOf(Buffer.from('🛠'))+2;r.write(bytes.subarray(0,split));setTimeout(()=>r.end(bytes.subarray(split)),10);};assert.equal((await chat()).text,'España 🛠 fin');});
test('SSE rejects provider error events in HTTP 200',async()=>{responder=(_q,r)=>{r.writeHead(200,{'Content-Type':'text/event-stream'});r.end('data: {"error":{"message":"quota exceeded"}}\n\n');};await assert.rejects(chat(),/quota exceeded/);});
test('JSON response to streaming request is handled',async()=>{responder=(_q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end('{"choices":[{"message":{"content":"respuesta"}}],"oricode":{"credits_remaining":3}}');};assert.deepEqual(await chat(),{text:'respuesta',thinking:'',credits:3});});
test('NDJSON local response flushes trailing event',async()=>{responder=(_q,r)=>r.end('{"message":{"content":"local","thinking":"razón"},"done":true}');assert.deepEqual(await chat({local:true}),{text:'local',thinking:'razón',credits:undefined});});
test('empty provider response reports error',async()=>{responder=(_q,r)=>r.end();await assert.rejects(chat(),/no devolvió contenido/);});
test('cancel terminates a request before headers arrive',async()=>{responder=()=>{};const controller=new AbortController();const result=chat({signal:controller.signal});controller.abort();await assert.rejects(result,/abort/i);});
test('response deadline terminates a silent provider',async()=>{responder=()=>{};await assert.rejects(chat({timeoutMs:40}),/agotado|responder/);});
test('interrupted stream cannot report success',async()=>{responder=(_q,r)=>{r.writeHead(200,{'Content-Type':'text/event-stream'});r.write(event('parcial'));setTimeout(()=>r.destroy(),10);};await assert.rejects(chat(),/interrump|aborted/i);});
test('action parser validates a single action and ignores ordinary code',()=>{assert.equal(agent.parseAction('hola'),undefined);assert.deepEqual(agent.parseAction('~~~'.replace('~~~','\x60\x60\x60oricode-action\n{"tool":"read_file","path":"a.js"}\n\x60\x60\x60')),{tool:'read_file',path:'a.js'});assert.throws(()=>agent.parseAction('\x60\x60\x60oricode-action\n{}\n\x60\x60\x60'),/inválida/);});
test('paths reject traversal, absolute paths, secrets and escaping junctions',async()=>{for(const p of ['../outside.txt','C:/Windows/test','/tmp/test','.env','.ssh/id_rsa','nested/key.pem'])await assert.rejects(agent.workspaceTarget(p));const outside=await fs.mkdtemp(path.join(os.tmpdir(),'oricode-outside-'));try{await fs.symlink(outside,path.join(fixture,'escape'),'junction');await assert.rejects(agent.workspaceTarget('escape/new.txt'),/enlace/);}finally{await fs.rm(path.join(fixture,'escape'),{force:true});await fs.rm(outside,{recursive:true,force:true});}});
test('Plan and Ask cannot write or execute commands',async()=>{for(const mode of ['ask','plan'])assert.match(await agent.executeAction({tool:'write_file',path:'blocked.txt',content:'no'},mode,new AbortController().signal),/únicamente lectura/);await assert.rejects(fs.stat(path.join(fixture,'blocked.txt')));});
test('edits require a unique match and preserve unrelated content',async()=>{const signal=new AbortController().signal;await agent.executeAction({tool:'edit_file',path:'index.js',old_string:'value = 1',new_string:'value = 2'},'smart',signal);assert.equal(await fs.readFile(path.join(fixture,'index.js'),'utf8'),'const value = 2;\n');await assert.rejects(agent.executeAction({tool:'edit_file',path:'index.js',old_string:'missing',new_string:'oops'},'smart',signal),/única/);});
test('dirty editor buffers block overwrite',async()=>{const doc=await openDocument(Uri.file(path.join(fixture,'index.js')));doc.isDirty=true;await assert.rejects(agent.executeAction({tool:'write_file',path:'index.js',content:'lost'},'bypass',new AbortController().signal),/sin guardar/);doc.isDirty=false;});
test('untrusted workspaces reject mutations',async()=>{vscode.workspace.isTrusted=false;try{await assert.rejects(agent.executeAction({tool:'run_command',command:'echo no'},'bypass',new AbortController().signal),/Confía/);}finally{vscode.workspace.isTrusted=true;}});
test('ready loads actual installed models and distinguishes Ollama Cloud',async()=>{posts=[];await onMessage({type:'ready'});const catalog=posts.find(p=>p.type==='models');assert.deepEqual(catalog.models.map(m=>({id:m.id,free:m.free,local:m.local})),[{id:'qwen3:8b',free:true,local:true},{id:'remote:cloud',free:false,local:false}]);assert.equal(catalog.current,'qwen3:8b');});
test('agent completes read, edit and check with results fed to the model',async()=>{posts=[];received=[];await onMessage({type:'setAgentMode',mode:'smart'});let step=0;const actions=[{tool:'read_file',path:'index.js'},{tool:'edit_file',path:'index.js',old_string:'value = 2',new_string:'value = 3'},{tool:'run_command',command:'node -e "console.log(123)"'}];responder=(_q,r)=>{r.writeHead(200);r.end(JSON.stringify({message:{content:step<actions.length?'\x60\x60\x60oricode-action\n'+JSON.stringify(actions[step++])+'\n\x60\x60\x60':'Verificado: 123'},done:true})+'\n');};await onMessage({type:'send',text:'Repara y comprueba',model:'qwen3:8b'});assert.equal(await fs.readFile(path.join(fixture,'index.js'),'utf8'),'const value = 3;\n');assert.equal(received.filter(r=>r.url==='/api/chat').length,4);assert.ok(received.at(-1).body.messages.some(m=>m.content.includes('Exit code: 0\n123')));assert.equal(posts.find(p=>p.type==='reply').text,'Verificado: 123');assert.deepEqual(posts.filter(p=>p.type==='busy').map(p=>p.value),[true,false]);});
test('subsequent turns include conversation history and persisted model',async()=>{await onMessage({type:'setModel',model:'qwen3:8b'});responder=(_q,r)=>r.end('{"message":{"content":"Continuación"},"done":true}\n');await onMessage({type:'send',text:'Continúa',model:'qwen3:8b'});assert.ok(received.at(-1).body.messages.some(m=>m.content==='Verificado: 123'));assert.equal(store.get('oricode.model.local'),'qwen3:8b');});
test('concurrent send is ignored and stop releases the task',async()=>{responder=()=>{};received=[];const task=onMessage({type:'send',text:'espera',model:'qwen3:8b'});await new Promise(resolve=>setTimeout(resolve,30));await onMessage({type:'send',text:'duplicado',model:'qwen3:8b'});await onMessage({type:'cancel'});await task;assert.equal(received.filter(r=>r.url==='/api/chat').length,1);assert.match(posts.filter(p=>p.type==='reply').at(-1).text,/detenida/);});
test('new conversation clears workspace history and rotates session',async()=>{const previous=store.get('oricode.sessionId');await onMessage({type:'clearHistory'});assert.deepEqual(store.get('oricode.history'),[]);assert.notEqual(store.get('oricode.sessionId'),previous);assert.equal(typeof onDispose,'function');});

test('SSE completion marker finishes even if upstream keeps connection open',async()=>{responder=(_q,r)=>{r.writeHead(200,{'Content-Type':'text/event-stream'});r.write(event('finalizado')+'data: [DONE]\n\n');};assert.equal((await chat({timeoutMs:300})).text,'finalizado');});

test('web sign-in persists a verified session and sends chat directly to OriCode',async()=>{
 await viewProvider.signOut();
 received=[];
 responder=(q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify(q.url==='/api/auth/ide/me'?{authenticated:true,user:{username:'cuenta-web'}}:{data:[{id:'test/cloud',name:'Cloud',pricing:{prompt:'0',completion:'0'}}]}));};
 vscode.env.openExternal=async uri=>{
  const params=new URL(uri.toString()).searchParams;
  const redirect=new URL('http://127.0.0.1:'+params.get('port')+'/oricode/callback');
  redirect.searchParams.set('state',params.get('state'));
  redirect.searchParams.set('key','orz_browser_test');redirect.searchParams.set('user','cuenta-web');
  assert.equal((await fetch(redirect)).status,200);return true;
 };
 await viewProvider.signIn();
 await onMessage({type:'ready'});
 assert.deepEqual({server:secrets.get('oricode.server'),username:secrets.get('oricode.username'),key:secrets.get('oricode.apiKey'),mode:store.get('oricode.mode')},{server:base,username:'cuenta-web',key:'orz_browser_test',mode:'cloud'});
 responder=(q,r)=>{assert.equal(q.headers.authorization,'Bearer orz_browser_test');r.writeHead(200,{'Content-Type':'text/event-stream'});r.end(event('Respuesta de OriCode')+'data: [DONE]\n\n');};
 await onMessage({type:'send',text:'hola',model:'test/cloud'});
 assert.equal(received.at(-1).url,'/v1/chat/completions');
 assert.equal(posts.filter(p=>p.type==='reply').at(-1).text,'Respuesta de OriCode');
});

test('changing the configured server cannot forward another server session',async()=>{
 settings.cloudUrl='http://127.0.0.1:45678';
 try{assert.deepEqual(await authProvider.getSessions(),[]);}finally{settings.cloudUrl=base;}
});

test('signing out clears account credentials and prevents further cloud requests',async()=>{
 await viewProvider.signOut();received=[];
 await onMessage({type:'send',text:'sin sesión',model:'test/cloud'});
 assert.deepEqual({sessions:await authProvider.getSessions(),requests:received,key:secrets.get('oricode.apiKey')},{sessions:[],requests:[],key:undefined});
});
