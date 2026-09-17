// Google grants access directly; this app never receives a Google password.
export const GOOGLE_SCOPES=['openid','email','https://www.googleapis.com/auth/drive.file'];
export async function accountId(namespace,sub) {
  if(typeof sub!=='string'||!sub||sub.length>255)throw new Error('Cuenta de Google no válida.');
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(namespace+'\0'+sub)));
  bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;
  const h=Array.from(bytes.slice(0,16),x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export async function googleIdentity(token,fetcher=fetch) {
  const response=await fetcher('https://openidconnect.googleapis.com/v1/userinfo',{
    headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Google no pudo verificar la cuenta. Vuelve a conectar.');
  const user=await response.json();
  if(typeof user.sub!=='string'||!user.sub||user.sub.length>255||user.email_verified!==true||typeof user.email!=='string')
    throw new Error('Google no ha confirmado la identidad y el correo de esta cuenta.');
  return user;
}
