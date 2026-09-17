import {GOOGLE_SCOPES} from './auth.js';
import {validateEvent, validateSnapshot} from './model.js';
const API='https://www.googleapis.com/drive/v3';
const SCOPE='https://www.googleapis.com/auth/drive.file';
const escapeQuery=value=>value.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
const PUBLIC_FIELDS=['id','fileName','session','category','species','scientificName','nameSource','reviewStatus','confidence','rating','ratingSource','capturedAt','importedAt','metadata','width','height','analyzed'];

export class Drive {
  constructor(config, fetcher=(...args)=>globalThis.fetch(...args)) { this.config=config; this.fetcher=fetcher; this.token=''; this.until=0; this.folder=null; }
  connect() {
    if (!globalThis.google?.accounts?.oauth2) return Promise.reject(new Error('No se ha cargado la conexión de Google. Comprueba Internet y vuelve a intentarlo.'));
    return new Promise((resolve,reject)=>{
      const client=google.accounts.oauth2.initTokenClient({client_id:this.config.googleClientId, scope:GOOGLE_SCOPES.join(' '),
        callback:response=>{
          if(response.error || !response.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response,...GOOGLE_SCOPES)) {
            reject(new Error('Google Drive no ha autorizado el acceso a los archivos de esta app.')); return;
          }
          this.token=response.access_token; this.until=Date.now()+Number(response.expires_in)*1000;
          this.folder=null; resolve(response);
        }, error_callback:()=>reject(new Error('La conexión con Google se canceló o el navegador bloqueó la ventana.'))});
      client.requestAccessToken({prompt:'select_account'});
    });
  }
  disconnect() { this.token=''; this.until=0; this.folder=null; }
  async request(path, options={}) {
    if(!this.token || this.until < Date.now()+10000) throw new Error('La conexión con Drive ha caducado. Pulsa «Conectar Google Drive» para renovarla.');
    const response=await this.fetcher(path.startsWith('https://') ? path : API+path, {
      ...options, headers:{...options.headers,Authorization:`Bearer ${this.token}`}, signal:AbortSignal.timeout(60000)});
    if (!response.ok) {
      const data=await response.json().catch(()=>({}));
      const reason=data.error?.errors?.[0]?.reason;
      if(response.status===401){this.disconnect();throw new Error('Conecta Google Drive de nuevo.');}
      if(reason==='storageQuotaExceeded') throw new Error('Google Drive está lleno. No se ha publicado el nuevo catálogo.');
      throw new Error(`Google Drive no pudo completar la operación (${response.status}). Tu catálogo anterior se conserva; puedes reintentar.`);
    }
    return response;
  }
  async list(q) {
    const files=[]; let pageToken;
    do {
      const args=new URLSearchParams({q:`trashed = false and (${q})`,fields:'nextPageToken,files(id,name,mimeType,createdTime,appProperties)',pageSize:'1000'});
      if(pageToken)args.set('pageToken',pageToken);
      const data=await (await this.request('/files?'+args)).json(); files.push(...(data.files||[])); pageToken=data.nextPageToken;
    } while(pageToken);
    return files;
  }
  async root(create=false) {
    if(this.folder)return this.folder;
    const instance=escapeQuery(this.config.instanceId);
    const roots=await this.list(`mimeType = 'application/vnd.google-apps.folder' and appProperties has {key='archivoInstance' and value='${instance}'}`);
    if(roots.length>1)throw new Error('Hay dos carpetas de este catálogo en Drive. Revisa la configuración antes de sincronizar.');
    if(roots.length){this.folder=roots[0].id;return this.folder;}
    if(!create)return null;
    const folder=await (await this.request('/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:`Archivo fotográfico · ${this.config.instanceId.slice(0,8)}`,mimeType:'application/vnd.google-apps.folder',
        appProperties:{archivoInstance:this.config.instanceId}})})).json();
    this.folder=folder.id;return folder.id;
  }
  async inventory(create=false) { const folder=await this.root(create);return folder ? this.list(`'${escapeQuery(folder)}' in parents`) : []; }
  async upload(name,blob,kind) {
    const root=await this.root(true);
    const boundary='archivo_'+crypto.randomUUID();
    const metadata={name,parents:[root],appProperties:{kind,archivoInstance:this.config.instanceId}};
    const body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,blob,`\r\n--${boundary}--`]);
    return (await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime',{
      method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body})).json();
  }
  async json(id) { return (await this.request(`/files/${encodeURIComponent(id)}?alt=media`)).json(); }
  async image(id) { return (await this.request(`/files/${encodeURIComponent(id)}?alt=media`)).blob(); }
  async load() {
    const files=await this.inventory();
    const snapshots=files.filter(f=>f.appProperties?.kind==='snapshot').sort((a,b)=>b.createdTime.localeCompare(a.createdTime)||b.id.localeCompare(a.id));
    const snapshot=snapshots.length ? validateSnapshot(await this.json(snapshots[0].id),this.config.instanceId) : null;
    const events=[];
    for(const f of files.filter(f=>f.appProperties?.kind==='review')) events.push(validateEvent(await this.json(f.id)));
    return {snapshot,events,files};
  }
  async review(event) {
    validateEvent(event);
    return this.upload(`review-${event.id}.json`,new Blob([JSON.stringify(event)],{type:'application/json'}),'review');
  }
  async publish(snapshot, events, media, progress=()=>{}) {
    validateSnapshot(snapshot,this.config.instanceId);
    const remote=await this.load();
    if(remote.snapshot && remote.snapshot.writerId!==snapshot.writerId)
      throw new Error('Este Drive está vinculado a otro catálogo de escritorio. Restaura su copia de seguridad; no se sobrescribirá.');
    const files=remote.files;
    const existing=new Map(files.map(f=>[f.name,f.id]));
    const photos=[];
    let done=0; const total=snapshot.photos.length;
    for(const photo of snapshot.photos) {
      const result=Object.fromEntries(PUBLIC_FIELDS.filter(key=>key in photo).map(key=>[key,photo[key]]));
      for(const kind of ['thumb','preview']) {
        const name=`${photo.id}-${kind}.jpg`;
        let id=existing.get(name);
        if(!id){id=(await this.upload(name,await media(photo.id,kind),'image')).id;existing.set(name,id);}
        result[kind+'DriveId']=id;
      }
      // Explicit allowlist: no local filesystem paths, passwords or device credentials.
      photos.push(result); progress(++done,total);
    }
    const remoteIds=new Set(remote.events.map(event=>event.id));
    for(const event of events)if(!remoteIds.has(event.id)){await this.review(event);remoteIds.add(event.id);}
    // Publish last. A partial image upload never replaces the last complete snapshot.
    await this.upload(`catalog-${crypto.randomUUID()}.json`,new Blob([JSON.stringify({...snapshot,photos,exportedAt:new Date().toISOString()})],{type:'application/json'}),'snapshot');
    return remote.events;
  }
}
