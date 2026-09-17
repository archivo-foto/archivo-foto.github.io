export const PHOTO_ID = /^[a-f0-9]{64}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validateEvent(event) {
  if (!event || !UUID.test(event.id) || !PHOTO_ID.test(event.photoId) ||
      !Number.isSafeInteger(event.at) || event.at < 0 || !['rating', 'species', 'session', 'category', 'identification'].includes(event.field))
    throw new Error('Corrección de catálogo no válida.');
  if(event.field==='identification'){
    const v=event.value;
    if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='scientificName,species'||typeof v.species!=='string'||!v.species.trim()||v.species.length>160||typeof v.scientificName!=='string'||v.scientificName.length>160)throw new Error('Identificación no válida.');
    return event;
  }
  if (event.field === 'rating' && (!Number.isInteger(event.value) || event.value < 1 || event.value > 5))
    throw new Error('La valoración debe estar entre 1 y 5.');
  if (event.field !== 'rating' && (typeof event.value !== 'string' || !event.value.trim() || event.value.length > 160))
    throw new Error('El texto debe tener entre 1 y 160 caracteres.');
  if(event.field==='category'&&!['POR_CLASIFICAR','LINCE','AVES','FAUNA','FLORA','INSECTOS','MACRO EXTREMO','NOCTURNAS','PAISAJE'].includes(event.value))throw new Error('Categoría no válida.');
  return event;
}
export function mergePhotos(photos, events) {
  const result = new Map(photos.map(photo => [photo.id, {...photo}]));
  const seen = new Map();
  for (const event of [...events].sort((a,b) => a.at - b.at || a.id.localeCompare(b.id))) {
    validateEvent(event);
    const signature = JSON.stringify([event.photoId,event.at,event.field,event.value]);
    if (seen.has(event.id)) {
      if (seen.get(event.id) !== signature) throw new Error('Hay dos correcciones incompatibles con el mismo identificador.');
      continue;
    }
    seen.set(event.id,signature);
    const photo = result.get(event.photoId);
    if (!photo) continue;
    if(event.field==='identification'){Object.assign(photo,event.value);photo.reviewStatus='manual';photo.confidence=null;photo.nameSource=null;}
    else photo[event.field] = event.value;
    if (event.field === 'species') { photo.reviewStatus = 'manual'; photo.confidence = null; photo.scientificName='';photo.nameSource=null; }
    if (event.field === 'rating') photo.ratingSource = 'manual';
  }
  return [...result.values()];
}
export function filterPhotos(photos, {query='', rating='', section='all', sort='recent'}={}) {
  const clean = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  const terms = clean(query).trim().split(/\s+/).filter(Boolean);
  return photos.filter(photo => (!rating || photo.rating === Number(rating)) &&
    (section !== 'pending' || photo.reviewStatus === 'pendiente') &&
    terms.every(term => clean([photo.fileName, photo.species, photo.scientificName, photo.session, photo.metadata].join(' ')).includes(term)))
    .sort((a,b) => sort === 'rating' ? (b.rating ?? 0) - (a.rating ?? 0) :
      sort === 'name' ? (a.species || a.fileName).localeCompare(b.species || b.fileName, 'es') :
      (b.capturedAt || b.importedAt || '').localeCompare(a.capturedAt || a.importedAt || ''));
}
export function validateSnapshot(value, instanceId) {
  if (!value || value.schema !== 1 || value.instanceId !== instanceId || !UUID.test(value.writerId) || !Array.isArray(value.photos))
    throw new Error('Este catálogo pertenece a otra instalación o tiene un formato incompatible.');
  const ids = new Set();
  for (const p of value.photos) {
    if (!p || !PHOTO_ID.test(p.id) || ids.has(p.id) || typeof p.fileName !== 'string') throw new Error('Fotografía de catálogo no válida.');
    if (p.rating != null && (!Number.isInteger(p.rating) || p.rating < 1 || p.rating > 5)) throw new Error('Valoración de catálogo no válida.');
    for (const field of ['species','scientificName','session','capturedAt','importedAt']) {
      if (p[field] != null && typeof p[field] !== 'string') throw new Error('Texto de catálogo no válido.');
    }
    ids.add(p.id);
  }
  return value;
}
