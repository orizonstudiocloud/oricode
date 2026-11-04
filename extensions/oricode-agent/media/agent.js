/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';
const v = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const log = $('log'), input = $('in'), selPanel = $('selPanel'), selList = $('selList'), selBtn = $('selBtn'), search = $('selSearch');
const brandMark=document.createElement('img');brandMark.src=document.body.dataset.assets+'/oricode-agent-logo.png';brandMark.alt='OriCode · Orizon Studio';brandMark.className='brand-mark';document.querySelector('#top')?.prepend(brandMark);
let voiceReply = false, speechState = 'idle', speechBase = '', speechProgrammatic = false;
const actions = $('actions');
if (actions) {
 const speech = element('button','tool voice'); speech.id='speech'; speech.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="13" rx="5"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/></svg>'; speech.title='Dictar mensaje con el micrófono'; speech.setAttribute('aria-label','Dictar mensaje con el micrófono'); speech.setAttribute('aria-pressed','false');
 const speak = element('button','tool voice','🔊 Voz'); speak.id='speak'; speak.title='Leer las respuestas en voz alta';
 actions.insertBefore(speech, $('mpick')); actions.insertBefore(speak, $('mpick'));
 const meter = element('span','speech-meter'); meter.id='speechMeter'; meter.setAttribute('role','meter'); meter.setAttribute('aria-valuemin','0'); meter.setAttribute('aria-valuemax','100'); meter.setAttribute('aria-valuenow','0'); meter.setAttribute('aria-label','Nivel de micrófono'); meter.hidden=true;
 const meterBar = element('span','speech-meter-bar'); meter.append(meterBar);
 actions.insertBefore(meter, $('mpick'));
 speech.addEventListener('click',()=>{
  if(speechState==='idle'){speechBase=input.value;setSpeechState('preparing');v.postMessage({type:'speechStart'});}
  else if(speechState==='recording'){setSpeechState('processing');v.postMessage({type:'speechStop'});}
  else if(speechState==='preparing'){v.postMessage({type:'speechCancel'});setSpeechState('idle');}
 });
 speak.addEventListener('click',()=>{voiceReply=!voiceReply;speak.classList.toggle('on',voiceReply);speak.textContent=voiceReply?'🔊 Voz ON':'🔊 Voz';if(!voiceReply)window.speechSynthesis?.cancel();});
}
const state = v.getState() || {};
let models = [], current = '', busy = false, pending, attachment, selectedRow = -1;
const MODES = [ ['code','Code','Edita con confirmación'], ['smart','Smart','Edita archivos automáticamente; confirma comandos'], ['ask','Ask','Consulta el proyecto sin modificarlo'], ['plan','Plan','Inspecciona y prepara un plan'], ['bypass','Bypass','Edita y ejecuta sin confirmación'] ];
const PROVIDERS = {
 "aion-labs":["Aion Labs","aionlabs-color"],"dots-studio":["Dots Studio","dotsstudio"],"fireworks":["Fireworks AI","fireworks-color"],"inference-net":["Inference.net","inference"],"liquid":["Liquid AI","liquid"],"morph":["Morph","morph-color"],"perceptron":["Perceptron","perceptron"],"poolside":["Poolside","poolside-color"],"rekaai":["Reka","reka"],"relace":["Relace","relace"],"sakana":["Sakana AI","sakana-color"],"tencent":["Tencent","tencent-color"],"typesafe":["Typesafe","typesafeai"],"upstage":["Upstage","upstage-color"],
 openai:['OpenAI','openai'],anthropic:['Anthropic','claude'],google:['Google','gemini-color'],deepseek:['DeepSeek','deepseek-color'],qwen:['Qwen','qwen-color'],'x-ai':['xAI','grok'],moonshotai:['Moonshot AI','kimi'],'meta-llama':['Meta','meta-color'],meta:['Meta','meta-color'],mistralai:['Mistral','mistral-color'],nvidia:['NVIDIA','nvidia-color'],ollama:['Ollama','ollama'],openrouter:['OpenRouter','openrouter'],minimax:['MiniMax','minimax-color'],'z-ai':['Z.ai','zai'],cohere:['Cohere','cohere-color'],perplexity:['Perplexity','perplexity'],amazon:['Amazon','aws-color'],microsoft:['Microsoft','microsoft-color'],'bytedance-seed':['ByteDance','bytedance-color'],bytedance:['ByteDance','bytedance-color'],inception:['Inception','inception'],xiaomi:['Xiaomi','xiaomimimo'],'arcee-ai':['Arcee AI','arcee-color'],ai21:['AI21','ai21'],nousresearch:['Nous Research','nousresearch'],stepfun:['StepFun','stepfun-color']
};
function element(tag, className, text) { const el = document.createElement(tag); if(className) el.className = className; if(text !== undefined) el.textContent = text; return el; }
function setSpeechState(s){
 const speech=$('speech'),meter=$('speechMeter');
 speechState=s;
 if(speech){
  speech.classList.toggle('on',s==='recording');
  speech.setAttribute('aria-pressed',String(s==='recording'||s==='preparing'));
  const label=s==='recording'?'Detener dictado':s==='preparing'?'Cancelar preparación del dictado':s==='processing'?'Procesando dictado…':'Dictar mensaje con el micrófono';
  speech.setAttribute('aria-label',label); speech.title=label;
 }
 if(meter)meter.hidden=s!=='recording';
 $('status').textContent=s==='preparing'?'Preparando el dictado…':s==='recording'?'Escuchando…':s==='processing'?'Procesando…':'';
}
function applyTranscript(text){
 speechProgrammatic=true;
 input.value=speechBase+(speechBase&&!/\s$/.test(speechBase)?' ':'')+text;
 input.dispatchEvent(new Event('input'));
 speechProgrammatic=false;
}
function provider(model) {
 if(model.id === 'adaptive') return ['Adaptive',''];
 if(model.id.includes('/')) { const id=model.id.split('/')[0].replace(/^~/,''); return PROVIDERS[id] || [id,'']; }
 const id = model.id.toLowerCase();
 const brand = /qwen|orizon/.test(id) ? 'qwen' : /deepseek/.test(id) ? 'deepseek' : /llama/.test(id) ? 'meta' : /minimax/.test(id) ? 'minimax' : /mistral/.test(id) ? 'mistralai' : 'ollama';
 return PROVIDERS[brand];
}
function avatar(model) {
 const [name, slug] = provider(model), el = element('span','mi-av'); el.setAttribute('aria-hidden','true');
 if(slug) { const img = document.createElement('img'); img.src = document.body.dataset.assets + '/providers/' + slug + '.svg'; img.alt = ''; img.className = slug.endsWith('-color') ? '' : 'mono'; img.addEventListener('error',()=>el.replaceChildren(element('span','',name[0]))); el.append(img); }
 else if(model.id === 'adaptive') { const img = document.createElement('img'); img.src = document.body.dataset.assets + '/oricode-star.png'; img.alt = ''; el.append(img); }
 else { el.textContent = name[0].toUpperCase(); }
 return el;
}
function nameOf(model) { return model.id === 'adaptive' ? 'Adaptive' : model.name || model.id.split('/').pop(); }
function currentButton() {
 const model = models.find(m=>m.id===current); selBtn.replaceChildren();
 if(model) selBtn.append(avatar(model),element('span','selected-name',nameOf(model)),element('span','chevron','⌄'));
 else selBtn.textContent = 'Sin modelos';
}
function price(model) {
 if(model.id === 'adaptive') return 'Automático';
 if(model.local) return 'Local';
 if(model.free) return 'Gratis';
 if(!Number.isFinite(model.inUsd) || !Number.isFinite(model.outUsd)) return 'Según proveedor';
 return '$'+model.inUsd.toFixed(2)+' / $'+model.outUsd.toFixed(2)+' · 1M tokens';
}
function row(model) {
 const el = element('div','mi'+(model.id===current?' on':'')); el.dataset.id=model.id; el.setAttribute('role','option'); el.setAttribute('aria-selected',String(model.id===current)); el.id='model-'+models.indexOf(model); el.tabIndex=-1;
 el.append(avatar(model)); const body=element('div','mi-body'), top=element('div','mi-top'); top.append(element('span','mi-name',nameOf(model)),element('span','mi-check',model.id===current?'✓':'')); body.append(top);
 const sub=element('div','mi-sub'); sub.append(element('span','mi-prov',provider(model)[0]),element('span','mi-price',price(model))); body.append(sub);
 if(model.desc) { const desc=element('div','mi-desc',model.desc); body.append(desc); } el.title=model.id; el.append(body); return el;
}
function renderModels() {
 const filter=search.value.trim().toLowerCase(); selectedRow=-1; search.removeAttribute('aria-activedescendant');
 const visible=models.filter(m=>[m.id,m.name,provider(m)[0]].join(' ').toLowerCase().includes(filter)); selList.replaceChildren();
 const append=(title,list)=>{if(!list.length)return;selList.append(element('div','mi-sep',title));list.forEach(m=>selList.append(row(m)));};
 if(filter) visible.forEach(m=>selList.append(row(m)));
 else { const recent=(state.recent||[]).map(id=>visible.find(m=>m.id===id)).filter(Boolean); append('Usados recientemente',recent); const recommended=visible.filter(m=>!recent.includes(m) && (m.id==='adaptive'||m.id==='openrouter/free'||/qwen3:8b|sonnet|gpt.*(sol|mini)|gemini.*flash|deepseek.*chat/i.test(m.id))).slice(0,8); append('Recomendados',recommended); append('Todos los modelos · '+visible.length,visible.filter(m=>!recent.includes(m)&&!recommended.includes(m))); }
 if(!visible.length) selList.append(element('div','empty','No hay modelos que coincidan.'));
}
function closePickers() { selPanel.hidden=true; $('modePanel').hidden=true; selBtn.setAttribute('aria-expanded','false'); $('modeBtn').setAttribute('aria-expanded','false'); search.setAttribute('aria-expanded','false'); }
function positionPopup(panel, button) { const rect=button.getBoundingClientRect(); panel.style.bottom=(window.innerHeight-rect.top+8)+'px'; }
selBtn.addEventListener('click',()=>{const open=selPanel.hidden;closePickers();if(!open)return;selPanel.hidden=false;positionPopup(selPanel,selBtn);selBtn.setAttribute('aria-expanded','true');search.setAttribute('aria-expanded','true');search.value='';renderModels();search.focus();});
search.addEventListener('input',renderModels);
function choose(id) { current=id;state.recent=[id,...(state.recent||[]).filter(x=>x!==id)].slice(0,5);v.setState(state);currentButton();closePickers();v.postMessage({type:'setModel',model:id});selBtn.focus(); }
selList.addEventListener('click',event=>{const el=event.target.closest('[data-id]');if(el)choose(el.dataset.id);});
search.addEventListener('keydown',event=>{
 const rows=[...selList.querySelectorAll('[role=option]')];
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();selectedRow=Math.max(0,Math.min(rows.length-1,selectedRow+(event.key==='ArrowDown'?1:-1)));rows.forEach((r,i)=>r.classList.toggle('focused',i===selectedRow));if(rows[selectedRow]){search.setAttribute('aria-activedescendant',rows[selectedRow].id);rows[selectedRow].scrollIntoView({block:'nearest'});}}
 if(event.key==='Enter'&&rows.length){event.preventDefault();choose(rows[Math.max(selectedRow,0)].dataset.id);}
});
const modePanel=$('modePanel');
MODES.forEach(([id,name,description])=>{const button=element('button','mode-option');button.setAttribute('role','option');button.dataset.mode=id;button.append(element('strong','',name),element('span','',description));button.addEventListener('click',()=>{setAgentMode(id);v.postMessage({type:'setAgentMode',mode:id});closePickers();$('modeBtn').focus();});modePanel.append(button);});
function setAgentMode(id) { $('modeBtn').textContent=MODES.find(m=>m[0]===id)?.[1]||'Code';modePanel.querySelectorAll('[data-mode]').forEach(el=>el.setAttribute('aria-selected',String(el.dataset.mode===id))); }
$('modeBtn').addEventListener('click',()=>{const open=modePanel.hidden;closePickers();modePanel.hidden=!open;if(open){positionPopup(modePanel,$('modeBtn'));$('modeBtn').setAttribute('aria-expanded','true');modePanel.querySelector('button').focus();}});
document.addEventListener('click',event=>{if(!event.target.closest('.picker,#mpick'))closePickers();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closePickers();input.focus();}});
window.addEventListener('resize',closePickers);
function esc(text) { return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function markdown(text) {return esc(text).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\x60([^\x60\n]+)\x60/g,'<code>$1</code>').replace(/^#{1,3} (.+)$/gm,'<strong class="heading">$1</strong>').replace(/\n/g,'<br>');}
function billingAction(el,text) {
 if(!/HTTP (402|429)|saldo.*agotad|cuota|créditos|account\/#plans/i.test(text))return;
 const link=element('a','billing-action','Gestionar créditos ↗');link.href='https://oricode.orizonstudio.cloud/account/#plans';link.target='_blank';link.rel='noopener noreferrer';el.append(link);
}
function content(el,text) {
 el.replaceChildren(); const fence=/\x60{3}([^\n]*)\n([\s\S]*?)\x60{3}/g; let last=0;
 for(const match of text.matchAll(fence)) {
  if(match.index>last){const span=element('div','prose');span.innerHTML=markdown(text.slice(last,match.index));el.append(span);}
  const file=match[1].match(/filename\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i); const card=element('div','diffcard'),header=element('div','dh');
  const fileName=file?.[1]||file?.[2]||file?.[3]; header.append(element('span','fname',fileName||match[1]||'Código'));
  if(fileName){const apply=element('button','apply','Revisar y aplicar');apply.addEventListener('click',()=>v.postMessage({type:'apply',file:fileName,code:match[2]}));header.append(apply);}
  else {const copy=element('button','apply','Copiar');copy.addEventListener('click',()=>v.postMessage({type:'copy',text:match[2]}));header.append(copy);}
  card.append(header,element('pre','db',match[2]));el.append(card);last=match.index+match[0].length;
 }
 if(last<text.length){const span=element('div','prose');span.innerHTML=markdown(text.slice(last));el.append(span);}
 billingAction(el,text);
}
function speak(text) {
 if(!window.speechSynthesis)return;
 const u=new SpeechSynthesisUtterance(String(text).replace(/```[\s\S]*?```/g,'').replace(/[*_#`]/g,''));u.lang='es-ES';
 window.speechSynthesis.cancel();window.speechSynthesis.speak(u);
}
function msgActions(el,text,copyOnly=false) {
 const bar=element('div','msg-actions');
 const mk=(label,title,fn)=>{const b=element('button','msg-action',label);b.title=title;b.setAttribute('aria-label',title);b.addEventListener('click',()=>fn(b));bar.append(b);return b;};
 mk('⧉','Copiar',b=>{v.postMessage({type:'copy',text});b.textContent='✓';setTimeout(()=>{b.textContent='⧉';},1500);});
 if(copyOnly){el.append(bar);return;}
 mk('↻','Regenerar respuesta',()=>{v.postMessage({type:'retry'});});
 mk('♪','Leer en voz alta',b=>{speak(text);b.classList.add('on');setTimeout(()=>b.classList.remove('on'),2000);});
 mk('👍','Respuesta útil',b=>{b.classList.toggle('on');v.postMessage({type:'feedback',vote:'up',text:String(text).slice(0,500)});});
 mk('👎','Respuesta mejorable',b=>{b.classList.toggle('on');v.postMessage({type:'feedback',vote:'down',text:String(text).slice(0,500)});});
 el.append(bar);
}
function add(role,text,thinking) {
 const el=element('article','msg '+(role==='user'?'user':'bot')); if(thinking){const details=element('details','think');details.append(element('summary','','Razonamiento'),element('div','',thinking));el.append(details);}
 const body=element('div','message-body');if(role==='user')body.textContent=text;else content(body,text);el.append(body);
 if(text)msgActions(el,text,role==='user');
 log.append(el);log.scrollTop=log.scrollHeight;return el;
}
function welcome() {const el=element('div','welcome');const mark=element('div','welcome-mark');const markImg=document.createElement('img');markImg.src=document.body.dataset.assets+'/oricode-agent-logo.png';markImg.alt='';mark.append(markImg);el.append(mark,element('h2','','¿Qué construimos?'),element('p','','Puedo inspeccionar archivos, aplicar cambios y ejecutar comprobaciones en tu proyecto.'));log.append(el);}
function setBusy(value) {busy=value;$('send').disabled=!value&&!models.length;$('send').textContent=value?'■':'↑';$('send').title=value?'Detener tarea':'Enviar';$('send').setAttribute('aria-label',$('send').title);for(const id of ['mLocal','mCloud','selBtn','newChat','signin','refresh'])$(id).disabled=value;if(!value)$('status').textContent='';}
function send() {
 if(busy){v.postMessage({type:'cancel'});$('status').textContent='Deteniendo…';return;}
 const text=input.value.trim();if(!text||!models.length)return;
 log.querySelector('.welcome')?.remove();add('user',text);const full=attachment?'[Archivo adjunto: '+attachment.name+']\n'+attachment.content+'\n\n'+text:text;
 attachment=undefined;$('atchip').hidden=true;input.value='';input.style.height='';pending=add('bot','Preparando tarea…');setBusy(true);v.postMessage({type:'send',text:full,model:current});
}
function queueMsg() {
 const text=input.value.trim();if(!text)return;
 log.querySelector('.welcome')?.remove();add('user',text);const full=attachment?'[Archivo adjunto: '+attachment.name+']\n'+attachment.content+'\n\n'+text:text;
 attachment=undefined;$('atchip').hidden=true;input.value='';input.style.height='';$('status').textContent='Mensaje en cola…';v.postMessage({type:'send',text:full,model:current});
}
$('send').addEventListener('click',send);input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(busy)queueMsg();else send();}});input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px';if(speechState!=='idle'&&!speechProgrammatic){v.postMessage({type:'speechCancel'});setSpeechState('idle');}});
$('mLocal').addEventListener('click',()=>v.postMessage({type:'setMode',mode:'local'}));$('mCloud').addEventListener('click',()=>v.postMessage({type:'setMode',mode:'cloud'}));$('signin').addEventListener('click',()=>v.postMessage({type:signedIn?'signOut':'signIn'}));$('attach').addEventListener('click',()=>v.postMessage({type:'attach'}));$('refresh').addEventListener('click',()=>v.postMessage({type:'refreshModels'}));$('newChat').addEventListener('click',()=>v.postMessage({type:'clearHistory'}));
function tool(text) {pending?.remove();pending=undefined;const el=element('details','tool-event');const summary=element('summary','',text);el.append(summary);billingAction(summary,text);log.append(el);log.scrollTop=log.scrollHeight;return el;}
let signedIn=false;
function gateOverlay(show){
 let g=document.getElementById('gate');
 if(!show){g?.remove();return;}
 if(g)return;
 g=element('div','','');g.id='gate';
 const card=element('div','gate-card');
 const star=element('div','gate-star');const starImg=document.createElement('img');starImg.src=document.body.dataset.assets+'/oricode-agent-logo.png';starImg.alt='';star.append(starImg);card.append(star);
 card.append(element('h2','','Bienvenido a OriCode'));
 card.append(element('p','','Inicia sesión con tu cuenta OriCode para empezar. El plan gratuito incluye créditos de inicio y modelos locales.'));
 const sign=element('button','gate-btn primary','Iniciar sesión con OriCode');sign.addEventListener('click',()=>v.postMessage({type:'signIn'}));card.append(sign);
 const reg=element('a','gate-link','¿No tienes cuenta? Regístrate gratis ↗');reg.href='https://oricode.orizonstudio.cloud/account/';reg.target='_blank';reg.rel='noopener noreferrer';card.append(reg);
 card.append(element('p','gate-note','OriCode by Orizon Studio'));
 g.append(card);document.body.append(g);
}
window.addEventListener('message',event=>{const m=event.data;
 if(m.type==='gate'){signedIn=!!m.signed;gateOverlay(!m.signed);const sb=$('signin');if(sb)sb.textContent=signedIn?(m.user?('👤 '+m.user):'Cerrar sesión'):'Iniciar sesión';}
 else if(m.type==='ready'&&!signedIn)gateOverlay(true);
 if(m.type==='models') {models=(m.models||[]).map(x=>typeof x==='string'?{id:x}:x);current=m.current||models[0]?.id||'';currentButton();renderModels();$('mLocal').classList.toggle('on',m.mode==='local');$('mCloud').classList.toggle('on',m.mode==='cloud');$('connection').textContent=m.error||((m.mode==='cloud'?'OriCode Cloud':'Ollama')+' · '+models.length+' modelos');$('connection').classList.toggle('error',!!m.error);const sb=$('selBtn');if(sb){sb.style.display=m.freePlan?'none':'';const sel=$('selPanel');if(sel)sel.hidden=true;}if(m.freePlan){const tag=element('span','free-tag','Plan Free · '+ (models.find(x=>x.id===current)?.name||'modelo gratuito'));if(!$('freeTag')){tag.id='freeTag';$('selBtn')?.parentElement?.insertBefore(tag,$('selBtn'));}}else{$('freeTag')?.remove();}setBusy(busy);}
 else if(m.type==='loadingModels'){$('connection').textContent='Cargando modelos '+(m.mode==='cloud'?'Cloud':'de Ollama')+'…';models=[];$('send').disabled=true;}
 else if(m.type==='busy'){setBusy(m.value);}
 else if(m.type==='status'){$('status').textContent=m.text;if(pending)pending.querySelector('.message-body').textContent=m.text;}
 else if(m.type==='delta'){if(!pending)pending=add('bot','');pending.querySelector('.message-body').textContent=m.text;log.scrollTop=log.scrollHeight;}
 else if(m.type==='thinking'){$('status').textContent='Razonando… '+m.text.length+' caracteres';}
 else if(m.type==='tool'){tool(m.text);}
 else if(m.type==='toolResult'){const el=log.lastElementChild;if(el?.classList.contains('tool-event'))el.append(element('pre','tool-output',m.text));}
 else if(m.type==='reply'){pending?.remove();pending=undefined;add('bot',m.text||'Respuesta vacía',m.thinking);if(voiceReply)speak(m.text||'');}
 else if(m.type==='notice'){add('bot',m.text);}
 else if(m.type==='attached'){attachment={name:m.name,content:m.content};$('atchip').hidden=false;$('atchip').textContent='Adjunto: '+m.name+' · pulsa para quitar';}
 else if(m.type==='speechText'){input.value=m.text||'';input.dispatchEvent(new Event('input'));input.focus();}
 else if(m.type==='speechUpdate'){
  if(typeof m.text==='string'&&(m.state==='recording'||m.state==='done'))applyTranscript(m.text);
  if(typeof m.level==='number'){const pct=Math.round(Math.max(0,Math.min(1,m.level))*100);const mb=document.querySelector('#speechMeter .speech-meter-bar');if(mb)mb.style.width=pct+'%';$('speechMeter')?.setAttribute('aria-valuenow',String(pct));}
  if(m.state==='preparing'&&typeof m.progress==='number')$('status').textContent='Preparando el dictado… '+Math.round(m.progress*100)+'%';
  else if(m.state==='error'){setSpeechState('idle');$('status').textContent=m.error||'Error de dictado';}
  else if(m.state&&m.state!==speechState)setSpeechState(m.state==='done'?'idle':m.state);
 }
 else if(m.type==='speechEnd'){if(typeof setSpeechState==='function')setSpeechState('idle');}
 else if(m.type==='history'){log.replaceChildren();if(!(m.items||[]).length)welcome();else m.items.forEach(item=>add(item.r,item.x,item.t));}
 else if(m.type==='agentMode'){setAgentMode(m.mode);}
 else if(m.type==='credits'){$('credits').hidden=false;$('credits').textContent=Number(m.value).toFixed(1)+' cr';}
});
$('atchip').addEventListener('click',()=>{attachment=undefined;$('atchip').hidden=true;});
window.addEventListener('error',event=>{add('bot','Error de interfaz: '+event.message);setBusy(false);});
v.postMessage({type:'ready'});
