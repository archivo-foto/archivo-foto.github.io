import {accountId,googleIdentity} from './auth.js?v=20260918-03';
import {Drive} from './drive.js?v=20260918-03';
import {mergePhotos,filterPhotos,UUID} from './model.js?v=20260918-03';

const $=id=>document.getElementById(id);
const state={desktop:false,config:null,user:null,epoch:0,operations:0,drive:null,snapshot:null,events:[],section:'all',selected:null,limit:80,busy:false,urls:new Set(),generation:0};
let observer,sessionTimer,jobTimer;
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);$('notice').hidden=false;}
function clearNotice(){$('notice').hidden=true;}
async function run(action,button){if(button)button.disabled=true;clearNotice();state.operations++;try{return await action();}catch(error){notice(error.message||'No se pudo completar la operación.',true);}finally{state.operations--;if(button)button.disabled=false;}}
function node(tag,text,className){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;}
async function local(path,body){
  const epoch=state.epoch;const response=await fetch(path,{...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{}),headers:{'Content-Type':'application/json','X-Archivo-Account':state.drive?.config.instanceId||''},credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(path==='/api/pick-folder'?250000:30000)});
  const data=await response.json();if(epoch!==state.epoch)throw new Error('La cuenta ha cambiado. Repite la operación.');if(!response.ok)throw new Error(data.error||'El programa de escritorio no responde.');return data;
}
async function localSession(){
  const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${state.drive.token}`},body:'{}',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('No se pudo verificar Google en este ordenador. Vuelve a conectar.');
  const session=await response.json();if(session.instanceId!==state.drive.config.instanceId)throw new Error('La cuenta local no coincide con Google.');
}
function photos(){return mergePhotos(state.snapshot?.photos||[],state.events);}
function clearImages(){observer?.disconnect();for(const url of state.urls)URL.revokeObjectURL(url);state.urls.clear();state.generation++;}
async function picture(photo,kind){
  if(state.desktop)return `/api/image/${photo.id}?kind=${kind}&account=${state.drive.config.instanceId}`;
  const id=photo[kind+'DriveId'];if(!id)throw new Error('Esta fotografía todavía no se ha sincronizado.');
  const blob=await state.drive.image(id);const url=URL.createObjectURL(blob);state.urls.add(url);return url;
}
function draw(){
  clearImages();const all=photos();const generation=state.generation;
  $('firstSteps').hidden=all.length>0;
  $('photoCount').textContent=all.length.toLocaleString('es');
  $('speciesCount').textContent=new Set(all.map(p=>p.species).filter(Boolean)).size;
  $('sessionCount').textContent=new Set(all.map(p=>p.session).filter(Boolean)).size;
  $('pendingCount').textContent=all.filter(p=>p.reviewStatus==='pendiente').length;
  const visible=filterPhotos(all,{query:$('search').value,rating:$('rating').value,section:state.section,sort:$('sort').value});
  $('resultCount').textContent=all.length?`${visible.length.toLocaleString('es')} fotografías · ${state.desktop?'Catálogo de este ordenador':'Catálogo de Google Drive'}`:'';
  $('empty').hidden=visible.length>0;$('emptyText').textContent=all.length?'No hay fotografías que coincidan. Prueba con otra búsqueda o filtro.':
    state.desktop?'Añade tu primera carpeta y sincroniza para consultar el catálogo desde el móvil.':'Conecta el mismo Google Drive que usas en Windows. El catálogo aparecerá después de su primera sincronización.';
  const grid=$('grid');grid.replaceChildren();$('moreButton').hidden=visible.length<=state.limit;
  observer=new IntersectionObserver(entries=>{
    for(const entry of entries){if(!entry.isIntersecting)continue;const img=entry.target;observer.unobserve(img);
      const photo=visible.find(p=>p.id===img.dataset.id);picture(photo,'thumb').then(url=>{if(generation===state.generation)img.src=url;else if(url.startsWith('blob:')){URL.revokeObjectURL(url);state.urls.delete(url);}}).catch(()=>{img.alt='Vista previa no disponible. Conecta Drive de nuevo.';});}
  },{rootMargin:'200px'});
  for(const photo of visible.slice(0,state.limit)){
    const card=node('button',undefined,'card');card.type='button';card.setAttribute('aria-label',`Abrir ${photo.species||photo.scientificName||photo.fileName}`);
    const img=node('img',undefined,'photo');img.alt=photo.species||photo.scientificName||photo.fileName;img.dataset.id=photo.id;
    const info=node('div',undefined,'info');info.append(node('h3',photo.species||photo.scientificName||photo.fileName),node('p',photo.session||'Sin sesión','meta'),node('p',photo.rating?'★'.repeat(photo.rating)+'☆'.repeat(5-photo.rating):'Sin valorar','meta'));
    if(photo.scientificName)info.append(node('p',photo.scientificName,'meta'));
    if(photo.reviewStatus==='pendiente')info.append(node('span','Por revisar','badge'));
    card.append(img,info);card.onclick=()=>run(()=>openPhoto(photo.id));grid.append(card);observer.observe(img);
  }
}
async function reload(){
  if(state.desktop){const data=await local('/api/catalog');state.snapshot=data.snapshot;state.events=data.events;}
  else {const data=await state.drive.load();state.snapshot=data.snapshot;state.events=data.events;}
  draw();
}
async function openPhoto(id){
  const photo=photos().find(p=>p.id===id);if(!photo)return;
  state.selected=id;$('detailTitle').textContent=photo.species||photo.scientificName||photo.fileName;
  $('detailMetadata').textContent=[photo.fileName,photo.capturedAt?.slice(0,10),photo.metadata].filter(Boolean).join(' · ');
  $('categoryInput').value=photo.category||'POR_CLASIFICAR';
  $('scientificDisplay').hidden=!photo.scientificName;
  $('scientificDisplay').textContent=(photo.scientificName||'')+(photo.species?'':' · Nombre en español no disponible')+(photo.nameSource?.source?' · Fuente: '+photo.nameSource.source:'');
  $('speciesInput').value=photo.species||'';$('sessionInput').value=photo.session||'';
  $('confidenceText').textContent=photo.reviewStatus==='manual'?'Identificación revisada por ti.':photo.confidence!=null?
    `Propuesta de BioCLIP 2: ${photo.scientificName||photo.species}. Puntuación del modelo: ${(photo.confidence*100).toFixed(1)} %. No es una garantía de identificación.`:'Pendiente de identificación. Puedes escribir la especie o analizarla en Windows.';
  $('ratingSource').textContent=photo.ratingSource==='manual'?'Valoración elegida por ti.':photo.ratingSource==='estimated'?'Estimación técnica basada en metadatos. Puedes cambiarla.':'Valora esta fotografía de 1 a 5 estrellas.';
  $('stars').replaceChildren();
  for(let n=1;n<=5;n++){const button=node('button',n<=(photo.rating||0)?'★':'☆');button.setAttribute('aria-label',`${n} estrellas`);button.setAttribute('aria-pressed',String(n<=(photo.rating||0)));button.onclick=()=>run(()=>save('rating',n),button);$('stars').append(button);}
  $('detailImage').removeAttribute('src');$('detailImage').alt=photo.species||photo.scientificName||photo.fileName;
  if(!$('detail').open)$('detail').showModal();
  const url=await picture(photo,'preview');if(state.selected===id&&$('detail').open)$('detailImage').src=url;
}
async function save(field,value){
  const event={id:crypto.randomUUID(),photoId:state.selected,field,value,at:state.events.reduce((latest,e)=>Math.max(latest,e.at+1),Date.now())};
  if(state.desktop)await local('/api/events',{events:[event]});else await state.drive.review(event);
  state.events.push(event);const id=state.selected;draw();await openPhoto(id);
  notice(state.desktop?'Corrección guardada. Sincroniza para verla en el móvil.':'Corrección guardada en tu Google Drive.');
}
async function sync(){
  if(state.busy)return;state.busy=true;
  $('importButton').disabled=true;$('analyzeButton').disabled=true;$('syncButton').disabled=true;
  try {
    await localSession();const data=await local('/api/catalog');
    const remoteEvents=await state.drive.publish(data.snapshot,data.events,async(id,kind)=>{
      const response=await fetch(`/api/image/${id}?kind=${kind}&account=${state.drive.config.instanceId}`,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('No se pudo leer una vista previa local.');return response.blob();
    },(done,total)=>{$('connectionText').textContent=`Sincronizando ${done} de ${total} fotografías…`;});
    if(remoteEvents.length)await local('/api/events',{events:remoteEvents});
    await reload();$('connectionText').textContent='Catálogo sincronizado con tu Google Drive.';notice('Sincronización completada. Ya puedes abrir el catálogo en el móvil.');
  } finally{state.busy=false;$('importButton').disabled=false;$('analyzeButton').disabled=false;$('syncButton').disabled=false;}
}
async function pollJob(){
  const job=await local('/api/job');if(job.status==='idle'){$('job').hidden=true;return;}$('job').hidden=false;
  $('jobText').textContent=job.status==='error'?job.error:job.status==='done'?
    `Tarea terminada: ${job.details.imported??job.details.analyzed??job.details.organized??job.details.named??job.details.exported??0} fotografías procesadas; ${job.details.duplicates??0} duplicadas; ${job.details.errors??0} errores.`:
    `${job.kind==='import'?'Importando':job.kind==='organize'?'Organizando carpetas':job.kind==='names'?'Consultando nombres en español':job.kind==='export'?'Preparando originales':'Analizando con BioCLIP 2'} · ${job.done} de ${job.total||'…'}${job.kind==='analyze'&&!job.done?' · Cargando el modelo incluido. Puede tardar.':''}`;
  if(job.kind==='export'&&job.status==='done')$('jobText').textContent=`JPG preparados: ${job.details.exported}. Carpeta: ${job.details.path}. Pendientes de subir a tu nube.`;
  if(job.total){$('jobProgress').max=job.total;$('jobProgress').value=job.done;}else $('jobProgress').removeAttribute('value');
  if(job.status==='running'){jobTimer=setTimeout(()=>run(pollJob),1500);return;}
  $('importButton').disabled=false;$('analyzeButton').disabled=false;
  if(job.status==='error')notice(job.error,true);await reload();
}
async function startJob(path,body){await localSession();await local(path,body);$('importDialog').close();$('importButton').disabled=true;$('analyzeButton').disabled=true;await pollJob();}

function resetAccount(){
  state.epoch++;clearInterval(sessionTimer);clearTimeout(jobTimer);clearImages();state.drive?.disconnect();
  state.drive=null;state.user=null;state.snapshot=null;state.events=[];state.selected=null;state.section='all';state.limit=80;
  $('grid').replaceChildren();$('detailImage').removeAttribute('src');$('detailImage').alt='';
  for(const id of ['search','speciesInput','sessionInput','folderInput'])$(id).value='';
  $('rating').value='';$('sort').value='recent';$('userEmail').textContent='';
  document.querySelectorAll('[data-section]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.section==='all')));
  document.querySelectorAll('dialog[open]').forEach(d=>d.close());
  $('exportHistory').replaceChildren();$('cloudLink').value='';$('openCloud').removeAttribute('href');$('openCloud').hidden=true;
  $('catalog').hidden=true;$('login').hidden=false;$('accountButton').hidden=true;$('job').hidden=true;
  $('syncButton').hidden=true;$('refreshButton').hidden=true;
  $('importButton').disabled=false;$('analyzeButton').disabled=false;
}
async function connectGoogle(){
  // Keep the popup inside the user gesture. Old account remains inaccessible during connection.
  const previous=state.drive?.config.instanceId;
  const candidate=new Drive(state.config);
  const connecting=candidate.connect();
  resetAccount();
  const logout=state.desktop&&previous?fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Archivo-Account':previous},body:'{}'}).catch(()=>{}):Promise.resolve();
  try{
    await Promise.all([connecting,logout]);
    const user=await googleIdentity(candidate.token);
    const instanceId=await accountId(state.config.catalogNamespace,user.sub);
    candidate.config={...state.config,instanceId};state.drive=candidate;state.user=user;
    if(state.desktop)await localSession();
    await reload();
    $('login').hidden=true;$('catalog').hidden=false;$('accountButton').hidden=false;
    $('desktopTools').hidden=!state.desktop;$('importButton').hidden=!state.desktop;
    $('syncButton').hidden=!state.desktop;$('refreshButton').hidden=state.desktop;
    $('userEmail').textContent=user.email;$('connectionText').textContent='Conectado a '+user.email+'. Tu catálogo pertenece a esta cuenta.';
    if(state.desktop)await pollJob();
  }catch(error){candidate.disconnect();resetAccount();throw error;}
}
async function initialize(){
  try{const response=await fetch('./config.json',{cache:'no-store'});state.config=response.ok?await response.json():{};}catch{state.config={};}
  const c=state.config;
  if(c.authMode!=='google'||!UUID.test(c.catalogNamespace)||!c.googleClientId?.endsWith('.apps.googleusercontent.com')){$('setup').hidden=false;return;}
  if(['localhost','127.0.0.1'].includes(location.hostname)){
    try{state.desktop=(await (await fetch('/api/info')).json()).desktop===true;}catch{}
  }
  $('login').hidden=false;
}
for(const id of ['googleButton','connectButton'])$(id).onclick=()=>{
  if(state.operations||state.busy)return notice('Espera a que termine la operación actual antes de cambiar de cuenta.');
  run(connectGoogle,$(id));
};
$('syncButton').onclick=()=>run(sync);$('refreshButton').onclick=()=>run(reload,$('refreshButton'));
$('importButton').onclick=()=>$('importDialog').showModal();
$('chooseFolderButton').onclick=()=>run(async()=>{await localSession();const result=await local('/api/pick-folder',{});if(result.folder)$('folderInput').value=result.folder;},$('chooseFolderButton'));
$('importForm').onsubmit=e=>{e.preventDefault();run(()=>startJob('/api/import',{folder:$('folderInput').value,autoAnalyze:$('autoAnalyze').checked,spanishNames:$('spanishNames').checked}),e.submitter);};
$('analyzeButton').onclick=()=>run(()=>startJob('/api/analyze',{spanishNames:$('spanishNames').checked}),$('analyzeButton'));
$('backupButton').onclick=()=>run(async()=>{await localSession();const result=await local('/api/backup-disk',{});notice('Copia del catálogo guardada y comprobada: '+result.path+' (sin fotografías).');},$('backupButton'));
$('speciesForm').onsubmit=e=>{e.preventDefault();run(()=>save('identification',{species:$('speciesInput').value.trim(),scientificName:photos().find(p=>p.id===state.selected)?.species===$('speciesInput').value.trim()?(photos().find(p=>p.id===state.selected)?.scientificName||''):''}),e.submitter);};
$('sessionForm').onsubmit=e=>{e.preventDefault();run(()=>save('session',$('sessionInput').value.trim()),e.submitter);};
for(const id of ['search','rating','sort'])$(id).addEventListener(id==='search'?'input':'change',()=>{state.limit=80;draw();});
document.querySelectorAll('[data-section]').forEach(button=>button.onclick=()=>{state.section=button.dataset.section;document.querySelectorAll('[data-section]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));draw();});
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
$('moreButton').onclick=()=>{state.limit+=80;draw();};
$('accountButton').onclick=()=>$('accountDialog').showModal();
$('logoutButton').onclick=()=>{
  if(state.operations||state.busy)return notice('Espera a que termine la operación actual antes de cerrar sesión.');
  run(async()=>{
    const previous=state.drive?.config.instanceId;
    resetAccount();
    if(state.desktop&&previous)await fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Archivo-Account':previous},body:'{}'}).catch(()=>{});
  },$('logoutButton'));
};
initialize().catch(error=>notice(error.message,true));

$('archiveButton').onclick=()=>run(async()=>{await localSession();const picked=await local('/api/pick-folder',{});if(!picked.folder)return;const result=await local('/api/archive',{folder:picked.folder});notice('Destino guardado: '+result.path+'. Los originales de las próximas importaciones se copiarán sin recomprimir.');},$('archiveButton'));

$('categoryForm').onsubmit=e=>{e.preventDefault();run(()=>save('category',$('categoryInput').value),e.submitter);};
$('organizeButton').onclick=()=>run(()=>startJob('/api/organize',{}),$('organizeButton'));

$('spanishNamesButton').onclick=()=>run(()=>startJob('/api/spanish-names',{}),$('spanishNamesButton'));

function exportSelection(){return filterPhotos(photos(),{query:$('search').value,rating:$('rating').value,section:state.section}).map(p=>p.id);}
async function showExports(){
  const data=await local('/api/exports');$('cloudLink').value=data.url;
  $('openCloud').hidden=!data.url;if(data.url)$('openCloud').href=data.url;else $('openCloud').removeAttribute('href');
  $('exportCount').textContent=exportSelection().length+' fotografías seleccionadas por los filtros.';
  $('exportHistory').replaceChildren();
  for(const batch of data.batches){
    const row=node('div');const labels={prepared:'Archivos preparados; subida pendiente',confirmed_manual:'Respaldo confirmado por ti (sin verificación automática)',incomplete:'Preparación incompleta',preparing:'En preparación'};
    row.append(node('p',`${batch.count} JPG · ${labels[batch.status]||batch.status}`),node('p',batch.path,'small'));
    if(batch.status==='prepared'){const button=node('button','He comprobado la subida a mi nube');button.onclick=()=>run(async()=>{await local('/api/export-confirm',{id:batch.id});await showExports();},button);row.append(button);}
    $('exportHistory').append(row);
  }
}
$('exportButton').onclick=()=>run(async()=>{await showExports();$('exportDialog').showModal();},$('exportButton'));
$('prepareExport').onclick=()=>run(async()=>{const ids=exportSelection();await localSession();await local('/api/export',{ids});$('exportDialog').close();await pollJob();},$('prepareExport'));
$('cloudLinkForm').onsubmit=e=>{e.preventDefault();run(async()=>{await local('/api/export-link',{url:$('cloudLink').value});await showExports();},e.submitter);};
