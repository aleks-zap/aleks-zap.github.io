import { SUPABASE_URL, SUPABASE_KEY, NOMBRE_CURSO, PRECIOS, NIVELES_A_LA_VENTA } from './config.js';
import { prepararModelo, estadoAlumno, siguienteTarea, etiquetaTema, panorama, resumenPalabras, proyeccion, textoProyeccion, seleccionActiva, sortearPreguntas, itemDeRef, ORALES, HABILIDADES, HABILIDAD, EJ_REPASO, EJ_UBICACION, palabrasEnTexto, fechaLocal } from './motor.js';
let vocabCache = null, formasCache = null;
let reglasCache = null;

const DEMO = new URLSearchParams(location.search).has('demo');
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');

// ---------------------------------------------------------------- utilidades
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ids = s => String(s || '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
const barajar = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function norm(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ё/g, 'е').replace(/й/g, 'й')
    .replace(/[.,!?¡¿«»"“”'’:;()\-–—…\/|]/g, ' ').replace(/\s+/g, ' ').trim();
}
// й se descompone con NFD (и + breve): la recomponemos antes de quitar diacríticos
function normRu(s) { return norm(String(s ?? '').replace(/й/g, '\u0001').replace(/Й/g, '\u0001')).replace(/\u0001/g, 'й'); }
const igual = (resp, answers) => (answers || []).some(a => normRu(a) === normRu(resp) && normRu(a) !== '');
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// ---------------------------------------------------------------- capa de datos
let sb = null, sesion = null, perfil = null;
const cacheUrl = new Map();

const api = DEMO ? await crearDemo() : await crearSupabase();

async function crearSupabase() {
  const { createClient } = await import('./supabase.mjs')   // copia propia (v2.119.1): no depende de un CDN externo al abrir;
  sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const ok = r => { if (r.error) throw r.error; return r.data; };
  return {
    async sesion() { return (await sb.auth.getSession()).data.session; },
    async login(email, password) { ok(await sb.auth.signInWithPassword({ email, password })); },
    async logout() { await sb.auth.signOut(); },
    async registro(nombre, email, password) { return ok(await sb.auth.signUp({ email, password, options: { data: { nombre, terminos_cuenta: TERMINOS_CUENTA }, emailRedirectTo: location.origin + location.pathname } })); },
    async recuperar(email) { ok(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname + '#/nueva-clave' })); },
    async nuevaClave(password) { ok(await sb.auth.updateUser({ password })); },
    async cambiarNombre(nombre) { ok(await sb.rpc('cambiar_mi_nombre', { p_nombre: nombre })); },
    async misAceptaciones() { return ok(await sb.from('aceptaciones').select('documento,version,aceptado_en').eq('usuario', sesion.user.id)); },
    async aceptar(documento, version) { ok(await sb.rpc('aceptar_documento', { p_documento: documento, p_version: version })); },
    async cambiarCorreo(email) { ok(await sb.auth.updateUser({ email }, { emailRedirectTo: location.origin + location.pathname })); },
    async cambiarClave(actual, nueva) {      // se confirma la contraseña actual antes de cambiarla
      const r = await sb.auth.signInWithPassword({ email: sesion.user.email, password: actual });
      if (r.error) throw new Error('La contraseña actual no es correcta.');
      ok(await sb.auth.updateUser({ password: nueva }));
    },
    async reportar(o) { ok(await sb.from('reportes').insert(o)); },
    async reportes() { return ok(await sb.from('reportes').select('*').order('creado_en', { ascending: false }).limit(200)); },
    async resolverReporte(id) { ok(await sb.from('reportes').update({ estado: 'resuelto' }).eq('id', id)); },
    async ajustes() { return ok(await sb.from('ajustes').select('*')); },
    async espacio() { return ok(await sb.rpc('espacio_usado')); },
    async guardarAjuste(clave, valor) { ok(await sb.from('ajustes').upsert({ clave, valor })); },
    async usoIA() { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return ok(await sb.from('uso_ia').select('costo_usd,modelo,tarea').gte('creado_en', d.toISOString())); },
    async generarRepaso(datos) { const r = await sb.functions.invoke('corregir', { body: { accion: 'generar', ...datos } }); if (r.error) throw r.error; if (!r.data?.items) throw new Error(r.data?.omitido || r.data?.error || 'sin tarea'); return r.data; },
    async evaluarPronunciacion(audio, texto) { const r = await sb.functions.invoke('pronunciacion', { body: { audio, texto } }); if (r.error) throw r.error; return r.data; },
    async corregirIA(intento_id) { const r = await sb.functions.invoke('corregir', { body: { intento_id } }); if (r.error) throw r.error; return r.data; },
    async funcionClase(body) {
      const r = await sb.functions.invoke('clase', { body });
      if (r.error) { let m = r.error.message; try { m = (await r.error.context.json()).error || m; } catch {} throw new Error(m); }
      if (r.data?.omitido) throw new Error(r.data.omitido);
      return r.data;
    },
    // la grabación va directo del navegador a ElevenLabs (no pasa por Supabase); el permiso dura 15 min y sirve una vez
    async transcribirClase(file, conEspanol = true) {
      const { token } = await this.funcionClase({ accion: 'token' });
      const fd = new FormData();
      fd.append('file', file); fd.append('model_id', 'scribe_v3'); fd.append('diarize', 'true'); fd.append('num_speakers', '2'); fd.append('tag_audio_events', 'false');
      if (conEspanol) { fd.append('language_code', 'rus'); fd.append('secondary_language_codes', 'spa'); }
      const r = await fetch(`https://api.elevenlabs.io/v1/speech-to-text?token=${encodeURIComponent(token)}`, { method: 'POST', body: fd });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(out?.detail?.message || (typeof out?.detail === 'string' ? out.detail : '') || `ElevenLabs respondió ${r.status}`); e.status = r.status; throw e; }
      return out;
    },
    async examenes(todos = false) { let q = sb.from('examenes').select('*').order('iniciado_en', { ascending: false }); if (!todos) q = q.eq('usuario', sesion.user.id); return ok(await q); },
    async crearExamen(o) { return ok(await sb.from('examenes').insert(o).select().single()); },
    async actualizarExamen(id, o) { ok(await sb.from('examenes').update(o).eq('id', id)); },
    async subirFotoExamen(blob, path) { ok(await sb.storage.from('examenes').upload(path, blob, { contentType: 'image/jpeg' })); },
    async fotosExamen(uid, exId) {
      const l = ok(await sb.storage.from('examenes').list(`${uid}/${exId}`, { limit: 200, sortBy: { column: 'name', order: 'asc' } }));
      if (!l.length) return [];
      const r = ok(await sb.storage.from('examenes').createSignedUrls(l.map(f => `${uid}/${exId}/${f.name}`), 3600));
      return r.map(x => x.signedUrl).filter(Boolean);
    },
    async certificados() { return ok(await sb.from('certificados').select('*').order('emitido_en', { ascending: false })); },
    async verificar(codigo) { const r = ok(await sb.rpc('verificar_certificado', { p_codigo: codigo })); return r[0] || null; },
    async perfil(uid) { return ok(await sb.from('perfiles').select('*').eq('id', uid).single()); },
    async todosEscenarios() { return ok(await sb.from('escenarios').select('*').order('orden')); },
    async ejerciciosLigeros() { return ok(await sb.from('ejercicios').select('*').order('id')); },
    async vocabUso() {                                   // palabras del curso (activas y pasivas), en páginas de 1000
      const out = [];
      for (let i = 0; ; i += 1000) {
        const r = ok(await sb.from('vocabulario').select('id,lema,traduccion,categoria,uso').not('uso', 'is', null).order('id').range(i, i + 999));
        out.push(...r); if (r.length < 1000) break;
      }
      return out;
    },
    async reglas() {
      const [g, p] = await Promise.all([sb.from('gramatica').select('id,nombre,nivel,descripcion,ejemplo,prerrequisitos,explicacion'), sb.from('pronunciacion').select('id,nombre,nivel,descripcion,ejemplo,prerrequisitos,explicacion')]);
      return [...ok(g), ...ok(p)];
    },
    async vocabulario(lista) { return lista.length ? ok(await sb.from('vocabulario').select('id,lema,traduccion,categoria').in('id', lista)) : []; },
    async misEventos() { return ok(await sb.from('eventos').select('tipo,ref,creado_en').eq('alumno_id', sesion.user.id)); },
    async reiniciarAlumno(uid) { ok(await sb.from('eventos').delete().eq('alumno_id', uid)); ok(await sb.from('intentos').delete().eq('alumno_id', uid)); },
    async eventosDe(uid) { return ok(await sb.from('eventos').select('tipo,ref,creado_en').eq('alumno_id', uid)); },
    async registrar(tipo, refs) { ok(await sb.from('eventos').insert(refs.map(ref => ({ tipo, ref })))); },
    async registrarPara(alumno_id, tipo, refs, creado_en) { ok(await sb.from('eventos').insert(refs.map(ref => ({ alumno_id, tipo, ref, ...(creado_en ? { creado_en } : {}) })))); },
    async tipos() { return ok(await sb.from('tipos_ejercicio').select('id,nombre,habilidades_principales')); },
    async temas() { return ok(await sb.from('temas').select('*')); },
    async gramaticaTodas() { return ok(await sb.from('gramatica').select('id,nombre')); },
    async escenario(id) { return ok(await sb.from('escenarios').select('*').eq('id', id).single()); },
    async ejerciciosEsc(id) { return ok(await sb.from('ejercicios').select('*').eq('escenario', id).order('id')); },
    async ejercicio(id) { return ok(await sb.from('ejercicios').select('*').eq('id', id).single()); },
    async conteoEjercicios() { return ok(await sb.from('ejercicios').select('id,escenario')); },
    async materiales(lista) { return lista.length ? ok(await sb.from('materiales').select('*').in('id', lista)) : []; },
    async materialesEsc(id) { return ok(await sb.from('materiales').select('*').ilike('escenarios', `%${id}%`).order('id')); },
    async gramatica(lista) { return lista.length ? ok(await sb.from('gramatica').select('id,nombre,descripcion,ejemplo').in('id', lista)) : []; },
    async misIntentos() { return ok(await sb.from('intentos').select('ejercicio_id,correcto,puntaje,estado,feedback,respuesta,creado_en').eq('alumno_id', sesion.user.id)); },
    async guardarIntento(o) { return ok(await sb.from('intentos').insert(o).select().single()); },
    async subirGrabacion(blob) {
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const path = `${sesion.user.id}/${Date.now()}.${ext}`;
      ok(await sb.storage.from('grabaciones').upload(path, blob, { contentType: blob.type }));
      return path;
    },
    async url(bucket, path) {
      const k = bucket + '/' + path;
      if (cacheUrl.has(k)) return cacheUrl.get(k);
      const r = await sb.storage.from(bucket).createSignedUrl(path, 60 * 60 * 6);
      const u = r.error ? null : r.data.signedUrl;
      cacheUrl.set(k, u); return u;
    },
    // ---- docente
    async upsert(tabla, filas) { ok(await sb.from(tabla).upsert(filas, { onConflict: 'id' })); },
    async actualizar(tabla, id, cambios) {                // edición desde el panel docente
      const r = ok(await sb.from(tabla).update(cambios).eq('id', id).select('id'));
      if (!r.length) throw new Error('No se guardó (sin permiso o fila inexistente).');
    },
    async buscarVocab(q) {
      const t = q.replace(/[,()%*]/g, ' ').trim();
      return ok(await sb.from('vocabulario').select('id,lema,traduccion,categoria,uso').or(`lema.ilike.%${t}%,traduccion.ilike.%${t}%,id.eq.${t}`).order('id').limit(20));
    },
    async tablaCompleta(tabla) {                          // para descargar el contenido actual, en páginas de 1000
      const out = [];
      for (let i = 0; ; i += 1000) { const r = ok(await sb.from(tabla).select('*').order('id').range(i, i + 999)); out.push(...r); if (r.length < 1000) break; }
      return out;
    },
    async subirMedio(file, path, cache) { ok(await sb.storage.from('materiales').upload(path, file, { upsert: true, contentType: file.type || undefined, ...(cache ? { cacheControl: cache } : {}) })); cacheUrl.delete('materiales/' + path); },
    async alumnos() { return ok(await sb.from('perfiles').select('*').order('nombre')); },
    async renombrar(id, nombre) { ok(await sb.from('perfiles').update({ nombre }).eq('id', id)); },
    async actualizarPerfil(id, campos) { ok(await sb.from('perfiles').update(campos).eq('id', id)); },
    async intentosDe(uid) { return ok(await sb.from('intentos').select('*').eq('alumno_id', uid).order('creado_en', { ascending: false })); },
    async pendientes() { return ok(await sb.from('intentos').select('*').in('estado', ['pendiente_docente', 'pendiente_ia']).neq('ejercicio_id', 'EJ_UBICACION').order('creado_en')); },
    async revisar(id, campos) { ok(await sb.from('intentos').update(campos).eq('id', id)); },
  };
}

async function crearDemo() {
  const d = await (await fetch('demo/demo.json')).json();
  const intentos = JSON.parse(sessionStorage.getItem('demo_intentos') || '[]');
  const eventos = JSON.parse(sessionStorage.getItem('demo_eventos') || '[]');
  const by = (t, id) => d[t].find(x => x.id === id);
  return {
    async sesion() { return new URLSearchParams(location.search).get('demo') === 'publico' ? null : { user: { id: 'demo', email: 'demo@demo' } }; },
    async login() {}, async logout() {},
    async registro() { return { session: null }; }, async misAceptaciones() { return new URLSearchParams(location.search).get('terminos') === '0' && !sessionStorage.getItem('demo_acepto') ? [] : [{ documento: 'cuenta', version: TERMINOS_CUENTA }]; }, async aceptar() { sessionStorage.setItem('demo_acepto', '1'); }, async recuperar() {}, async nuevaClave() {}, async cambiarNombre() {}, async cambiarCorreo() {}, async cambiarClave(a) { if (a !== 'demo1234') throw new Error('La contraseña actual no es correcta.'); },
    async reportar(o) { console.log('reporte', o); }, async reportes() { return new URLSearchParams(location.search).has('rep') ? [{ id: 1, usuario: null, pagina: 'video:M461', texto: '🎬 Video de YouTube no disponible: M461 — borrado, privado o enlace inválido.', navegador: 'revisión automática diaria', estado: 'nuevo', creado_en: new Date().toISOString() }] : []; }, async resolverReporte() {},
    async evaluarPronunciacion() { return { total: 82, exactitud: 85, fluidez: 78, completitud: 100, palabras: [{ palabra: 'привет', nota: 92, error: 'None' }, { palabra: 'меня', nota: 64, error: 'Mispronunciation' }, { palabra: 'зовут', nota: 88, error: 'None' }] }; },
    async generarRepaso(d0) { return { enunciado: 'Responde las preguntas con frases completas.', items: [{ pregunta: 'Какой у тебя дом?', palabras: d0.palabras.slice(0, 2).map(p => p.lema), reglas: d0.reglas.map(g => g.nombre) }, { pregunta: 'Ты работаешь?', palabras: d0.palabras.slice(2).map(p => p.lema) }] }; },
    async ajustes() { return [{ clave: 'ia_activa', valor: new URLSearchParams(location.search).has('ia') }, { clave: 'pronunciacion_activa', valor: new URLSearchParams(location.search).has('pron') }, { clave: 'ia_tope_mensual_usd', valor: 5 }]; },
    async espacio() { return [{ tipo: 'base', nombre: 'base de datos', bytes: 61e6 }, { tipo: 'archivos', nombre: 'materiales', bytes: 640e6, archivos: 352 }, { tipo: 'archivos', nombre: 'grabaciones', bytes: 95e6, archivos: 40 }, { tipo: 'archivos', nombre: 'examenes', bytes: 110e6, archivos: 300 }]; }, async guardarAjuste() {}, async usoIA() { return [{ costo_usd: 0.0021, modelo: 'claude-haiku-5-5', tarea: 'escritura' }, { costo_usd: 0.1, modelo: 'scribe_v3', tarea: 'transcripcion_clase' }, { costo_usd: 0.004, modelo: 'claude-haiku-5-5', tarea: 'analisis_clase' }]; }, async funcionClase(b) { await new Promise(r => setTimeout(r, 400)); if (b.accion === 'analizar') return { reglas: (b.reglas || []).slice(0, 3).map((g, i) => ({ id: g.id, ok: i !== 1 })), errores: [{ original: 'я живу в Куэнка', correccion: 'я живу в Куэнке', explicacion: 'prepositivo tras в' }] }; return {}; },
    async transcribirClase() { await new Promise(r => setTimeout(r, 800)); const fr = (sp, t) => t.split(' ').flatMap((w, i) => [...(i ? [{ text: ' ', type: 'spacing', speaker_id: sp }] : []), { text: w, type: 'word', speaker_id: sp }]);
      const ws = [['speaker_0', 'Привет! Как дела? Расскажи, что ты делал в выходные?'], ['speaker_1', 'Привет! Хорошо. В субботу я был дома, я читал книгу.'], ['speaker_0', 'Очень хорошо. А где ты живёшь?'], ['speaker_1', 'Я живу в Куэнка. Мой дом большой, есть кухня и две комнаты.'], ['speaker_0', 'Отлично. Bueno, ahora vamos a practicar.'], ['speaker_1', 'Sí. Я люблю пить кофе утром.']].flatMap(([s, t], i) => [...(i ? [{ text: '\n', type: 'spacing', speaker_id: s }] : []), ...fr(s, t)]);
      return { audio_duration_secs: 1800, words: ws }; },
    async corregirIA() { const u = intentos[intentos.length - 1]; return { puntaje: 100, feedback: '¡Muy bien! Sin errores.', errores: [], objetivos: (u?.respuesta?.objetivos || []).slice(0, 3).map(o => ({ id: o.id, ok: true })) }; },
    async examenes() { return JSON.parse(sessionStorage.getItem('demo_examenes') || '[]'); },
    async crearExamen(o) { const l = JSON.parse(sessionStorage.getItem('demo_examenes') || '[]'); const x = { id: Date.now(), estado: 'en_curso', incidencias: [], iniciado_en: new Date().toISOString(), ...o }; l.unshift(x); sessionStorage.setItem('demo_examenes', JSON.stringify(l)); return x; },
    async actualizarExamen(id, o) { const l = JSON.parse(sessionStorage.getItem('demo_examenes') || '[]'); const x = l.find(e => e.id === id); Object.assign(x, o); sessionStorage.setItem('demo_examenes', JSON.stringify(l)); },
    async subirFotoExamen() {}, async fotosExamen() { return []; },
    async certificados() { return [{ codigo: 'RU-A1-DEMO42', nombre: 'Alumno de prueba', nivel: 'A1', emitido_en: '2026-11-17', notas: { lexico: 88, lectura: 80, audicion: 75, escritura: 70, oral: 82 } }]; },
    async verificar(c) { return c.trim().toUpperCase() === 'RU-A1-DEMO42' ? { nombre: 'Alumno de prueba', nivel: 'A1', emitido_en: '2026-11-17' } : null; },
    async perfil() { return { id: 'demo', plan: new URLSearchParams(location.search).get('plan') || 'completo', nombre: 'Alumno de prueba', rol: new URLSearchParams(location.search).get('demo') === 'docente' ? 'docente' : 'alumno', orales_zoom: new URLSearchParams(location.search).has('zoom'), plan_nivel: new URLSearchParams(location.search).get('nivel') || 'A1' }; },
    async todosEscenarios() { return d.escenarios; },
    async ejerciciosLigeros() { return d.ejercicios; },
    async reglas() { return d.reglas || []; },
    async vocabUso() { return (d.vocabulario || []).filter(v => v.uso); },
    async vocabulario(l) { return (d.vocabulario || []).filter(v => l.includes(v.id)); },
    async misEventos() { return eventos; }, async eventosDe() { return []; }, async registrarPara() {},
    async registrar(tipo, refs) { refs.forEach(ref => eventos.push({ tipo, ref, creado_en: new Date().toISOString() })); sessionStorage.setItem('demo_eventos', JSON.stringify(eventos)); },
    async tipos() { return d.tipos; }, async temas() { return d.temas; }, async gramaticaTodas() { return d.gramatica; },
    async escenario(id) { return by('escenarios', id); },
    async ejerciciosEsc(id) { return d.ejercicios.filter(e => e.escenario === id); },
    async ejercicio(id) { return by('ejercicios', id); },
    async conteoEjercicios() { return d.ejercicios.map(e => ({ id: e.id, escenario: e.escenario })); },
    async materiales(l) { return d.materiales.filter(m => l.includes(m.id)); },
    async materialesEsc(id) { return d.materiales.filter(m => ids(m.escenarios).includes(id)); },
    async gramatica(l) { return d.gramatica.filter(g => l.includes(g.id)); },
    async misIntentos() { return intentos; },
    async guardarIntento(o) { intentos.push({ ...o, creado_en: new Date().toISOString() }); sessionStorage.setItem('demo_intentos', JSON.stringify(intentos)); return o; },
    async subirGrabacion() { return 'demo/grabacion.webm'; },
    async url(bucket, path) { return bucket === 'materiales' ? 'demo/media/' + path : null; },
    async actualizar(tabla, id, cambios) { const t = { gramatica: d.gramatica, pronunciacion: d.reglas, escenarios: d.escenarios, ejercicios: d.ejercicios }[tabla] || []; const f = t.find(x => x.id === id) || (d.reglas || []).find(x => x.id === id); if (f) Object.assign(f, cambios); },
    async buscarVocab(q) { q = q.toLowerCase(); return (d.vocabulario || []).filter(v => (v.lema + ' ' + v.traduccion + ' ' + v.id).toLowerCase().includes(q)).slice(0, 20); },
    async tablaCompleta(tabla) { return { gramatica: d.gramatica, escenarios: d.escenarios, ejercicios: d.ejercicios, materiales: d.materiales, temas: d.temas, tipos_ejercicio: d.tipos, vocabulario: d.vocabulario }[tabla] || []; },
    async upsert() {}, async subirMedio() {}, async alumnos() { return []; }, async intentosDe() { return []; }, async pendientes() { return []; }, async revisar() {}, async renombrar() {}, async actualizarPerfil() {}, async reiniciarAlumno() {},
  };
}

// ---------------------------------------------------------------- medios
function rutasMedio(m) {
  if (m.tipo === 'audio') {
    if (/lento:/i.test(m.fuente || '')) return [['Versión lenta', `audio/${m.id}-lento.mp3`], ['Versión normal', `audio/${m.id}-rapido.mp3`]];
    return [['', `audio/${m.id}.mp3`]];
  }
  if (m.tipo === 'imagen') return [['', `img/${m.id}.jpg`]];
  if (m.tipo === 'video') return [['', `video/${m.id}.mp4`]];
  return [];
}
async function bloqueMaterial(m, { mostrarTexto = true } = {}) {
  const div = h(`<div class="material"></div>`);
  if (m.tipo === 'audio' && /^voz/i.test(m.fuente || '')) {
    // Audio original de la plataforma: lo lee la voz rusa del dispositivo (sin archivo mp3)
    if (!HAY_VOZ) div.append(h(`<p class="error">Tu navegador no tiene voz. Usa la transcripción.</p>`));
    else {
      const fila = h(`<div class="voz-fila"><button type="button" class="btn sec">▶ Escuchar despacio</button> <button type="button" class="btn sec">▶ Velocidad normal</button> <button type="button" class="btn sec">■</button></div>`);
      const [b1, b2, b3] = fila.querySelectorAll('button');
      b1.onclick = () => leerDialogo(m.transcripcion, 0.7); b2.onclick = () => leerDialogo(m.transcripcion, 0.95); b3.onclick = () => speechSynthesis.cancel();
      div.append(fila);
    }
    if (m.transcripcion) div.append(h(`<details><summary>Ver transcripción</summary><div class="texto-ru">${esc(m.transcripcion)}</div></details>`));
  } else if (m.tipo === 'audio') {
    for (const [etq, p] of rutasMedio(m)) {
      const u = await api.url('materiales', p);
      div.append(h(`<div>${etq ? `<div class="etq">${esc(etq)}</div>` : ''}${u ? `<audio controls preload="none" src="${esc(u)}"></audio>` : `<p class="error">Audio no disponible (${esc(p)})</p>`}</div>`));
    }
    if (m.transcripcion) div.append(h(`<details><summary>Ver transcripción</summary><div class="texto-ru">${esc(m.transcripcion)}</div></details>`));
  } else if (m.tipo === 'imagen') {
    const u = await api.url('materiales', `img/${m.id}.jpg`);
    div.append(u ? h(`<img loading="lazy" alt="${esc(m.titulo)}" src="${esc(u)}">`) : h(`<p class="error">Imagen no disponible</p>`));
  } else if (m.tipo === 'video' && /youtu\.?be/.test(m.fuente || '')) {
    const idY = (String(m.fuente).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/) || [])[1];
    const seg = t => { const p = String(t || '').split(':').map(Number); return p.some(isNaN) ? 0 : p.reduce((a, b) => a * 60 + b, 0); };
    const ini = seg(m.inicio), fin = seg(m.fin);
    div.append(idY ? h(`<div class="yt"><iframe src="https://www.youtube-nocookie.com/embed/${idY}?rel=0${ini ? `&start=${ini}` : ''}${fin ? `&end=${fin}` : ''}" title="${esc(m.titulo || 'Video')}" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`) : h(`<p class="error">Enlace de YouTube no válido</p>`));
    if (m.transcripcion) div.append(h(`<details><summary>Ver transcripción</summary><div class="texto-ru">${esc(m.transcripcion)}</div></details>`));
  } else if (m.tipo === 'video') {
    const u = await api.url('materiales', `video/${m.id}.mp4`);
    div.append(u ? h(`<video controls playsinline preload="metadata" src="${esc(u)}"></video>`) : h(`<p class="error">Video no disponible</p>`));
    if (m.transcripcion) div.append(h(`<details><summary>Ver transcripción</summary><div class="texto-ru">${esc(m.transcripcion)}</div></details>`));
  } else if (m.tipo === 'texto' && mostrarTexto) {
    div.append(h(`<div><div class="etq">${esc(m.titulo)}</div><div class="texto-ru">${esc(m.transcripcion)}</div></div>`));
  }
  return div;
}

// ---------------------------------------------------------------- grabador
function crearGrabador() {
  const cont = h(`<div class="grabador"><button class="btn sec" type="button">🎙 Grabar</button><span class="estado"></span></div>`);
  const btn = cont.querySelector('button'), est = cont.querySelector('.estado');
  let rec = null, partes = [], blob = null;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { btn.disabled = true; est.textContent = 'Tu navegador no permite grabar.'; }
  btn.onclick = async () => {
    if (rec && rec.state === 'recording') { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      partes = []; rec = new MediaRecorder(stream);
      rec.ondataavailable = e => partes.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        blob = new Blob(partes, { type: rec.mimeType || 'audio/webm' });
        est.innerHTML = ''; est.append(h(`<audio controls src="${URL.createObjectURL(blob)}"></audio>`));
        btn.textContent = '🎙 Grabar de nuevo';
      };
      rec.start(); btn.textContent = '⏹ Detener'; est.innerHTML = '<span class="punto"></span> grabando…';
    } catch { est.textContent = 'No se pudo usar el micrófono.'; }
  };
  return { el: cont, get blob() { return blob; } };
}

// ---------------------------------------------------------------- motor de ejercicios
// Cada renderizador devuelve { el, corregir() -> {total, bien, respuesta, abierta?} }
function rItems(c) {
  const el = h(`<div></div>`);
  if (c.texto) el.append(h(`<div class="texto-ru">${esc(c.texto)}</div>`));
  if (c.banco) el.append(h(`<div class="banco">${barajar(c.banco).map(b => `<span>${esc(b)}</span>`).join('')}</div>`));
  const filas = c.items.map((it, i) => {
    const f = h(`<div class="item"><div class="q${it.fuente === 'cursiva' ? ' cursiva' : ''}">${esc(it.q)}</div></div>`);
    if (it.img && it.imgAntes) f.querySelector('.q').insertAdjacentHTML('afterbegin', `<img class="img-item" data-mat="${esc(it.img)}" alt=""><br>`);
    if (it.tipo === 'choice') {
      const ops = h(`<div class="opciones"></div>`);
      barajar(it.options).forEach(o => ops.append(h(`<label><input type="radio" name="o${i}" value="${esc(o)}"> <span>${esc(o)}</span></label>`)));
      f.append(ops);
    } else f.append(h(`<input type="text" autocomplete="off" autocapitalize="off" spellcheck="false">`));
    el.append(f); return f;
  });
  return {
    el, corregir() {
      let bien = 0; const resp = [], det = [];
      c.items.forEach((it, i) => {
        const f = filas[i]; let v, ok;
        if (it.tipo === 'choice') { v = f.querySelector('input:checked')?.value ?? ''; ok = v === it.answer; }
        else { v = f.querySelector('input').value; ok = igual(v, it.answers); }
        resp.push(v); if (ok) bien++;
        f.classList.remove('ok', 'mal'); f.classList.add(ok ? 'ok' : 'mal');
        f.querySelector('.marca-res')?.remove();
        const correcta = it.tipo === 'choice' ? it.answer : (it.answers || [])[0];
        det.push({ q: it.q, r: v, c: correcta, ok, p: it.tipo !== 'choice' });
        f.append(h(`<div class="marca-res ${ok ? 'ok' : 'mal'}">${ok ? '✓ Correcto' : `✗ Respuesta: <span class="correcta">${esc(correcta)}</span>`}</div>`));
        if (it.img && !it.imgAntes && !f.querySelector('.img-item')) f.append(h(`<img class="img-item" data-mat="${esc(it.img)}" alt="">`));
      });
      return { total: c.items.length, bien, respuesta: resp, detalle: det };
    }
  };
}
function rMatch(c) {
  const el = h(`<div></div>`); const der = barajar(c.pairs.map(p => p[1]));
  const filas = c.pairs.map(([a]) => {
    const f = h(`<div class="item"><div class="q">${esc(a)}</div><select><option value="">— elige —</option>${der.map(d => `<option>${esc(d)}</option>`).join('')}</select></div>`);
    el.append(f); return f;
  });
  return { el, corregir() {
    let bien = 0; const resp = [], det = [];
    c.pairs.forEach(([a, b], i) => { const f = filas[i], v = f.querySelector('select').value, ok = v === b; resp.push(v); det.push({ q: a, r: v, c: b, ok }); if (ok) bien++;
      f.classList.remove('ok', 'mal'); f.classList.add(ok ? 'ok' : 'mal'); f.querySelector('.marca-res')?.remove();
      f.append(h(`<div class="marca-res ${ok ? 'ok' : 'mal'}">${ok ? '✓' : `✗ <span class="correcta">${esc(b)}</span>`}</div>`)); });
    return { total: c.pairs.length, bien, respuesta: resp, detalle: det };
  } };
}
function rOrder(c) {
  const el = h(`<div><div class="fichas"></div><div class="etq">Tu orden:</div><div class="secuencia"></div><div class="acciones"><button class="btn sec" type="button">Reiniciar</button></div></div>`);
  const fichas = el.querySelector('.fichas'), sec = el.querySelector('.secuencia'); let orden = [];
  const pintar = () => {
    fichas.innerHTML = ''; c.tiles.forEach((t, i) => { const b = h(`<button class="ficha" type="button">${esc(t)}</button>`); b.disabled = orden.includes(i); b.onclick = () => { orden.push(i); pintar(); }; fichas.append(b); });
    sec.innerHTML = orden.map(i => `<div>${esc(c.tiles[i])}</div>`).join('');
  };
  el.querySelector('.acciones button').onclick = () => { orden = []; pintar(); };
  // barajamos el orden de presentación
  c = { ...c, tiles: barajar(c.tiles) }; pintar();
  return { el, corregir() {
    const resp = orden.map(i => c.tiles[i]); let bien = 0; const det = [];
    c.answer.forEach((a, i) => { const ok = resp[i] === a; if (ok) bien++; det.push({ q: 'posición ' + (i + 1), r: resp[i] ?? '', c: a, ok }); });
    sec.innerHTML = c.answer.map((a, i) => `<div style="background:${resp[i] === a ? '#e3f1e8' : '#f7e3e1'}">${i + 1}. ${esc(resp[i] ?? '—')}${resp[i] === a ? ' ✓' : ` → <b class="correcta">${esc(a)}</b>`}</div>`).join('');
    return { total: c.answer.length, bien, respuesta: resp, detalle: det };
  } };
}
function rClasificar(c) {
  const cats = Object.keys(c.categorias), pal = barajar(cats.flatMap(k => c.categorias[k].map(w => [w, k])));
  const el = h(`<div>${c.nota ? `<p class="sub">${esc(c.nota)}</p>` : ''}</div>`);
  const filas = pal.map(([w]) => { const f = h(`<div class="item"><div class="q">${esc(w)}</div><select><option value="">—</option>${cats.map(k => `<option>${esc(k)}</option>`).join('')}</select></div>`); el.append(f); return f; });
  return { el, corregir() {
    let bien = 0; const resp = {}, det = [];
    pal.forEach(([w, k], i) => { const f = filas[i], v = f.querySelector('select').value, ok = v === k; resp[w] = v; det.push({ q: w, r: v, c: k, ok }); if (ok) bien++;
      f.classList.remove('ok', 'mal'); f.classList.add(ok ? 'ok' : 'mal'); f.querySelector('.marca-res')?.remove();
      f.append(h(`<div class="marca-res ${ok ? 'ok' : 'mal'}">${ok ? '✓' : `✗ <span class="correcta">${esc(k)}</span>`}</div>`)); });
    return { total: pal.length, bien, respuesta: resp, detalle: det, flexible: !!c.nota };
  } };
}
function rConjunto(c) {
  const el = h(`<div><p class="sub">Escribe ${c.answers.length} palabras, en cualquier orden.</p></div>`);
  const ins = c.answers.map(() => { const f = h(`<div class="item"><input type="text" autocomplete="off"></div>`); el.append(f); return f; });
  return { el, corregir() {
    const libres = c.answers.map(a => a); let bien = 0; const resp = [];
    ins.forEach(f => { const v = f.querySelector('input').value; resp.push(v); const k = libres.findIndex(g => g && igual(v, g)); const ok = k >= 0; if (ok) { libres[k] = null; bien++; }
      f.classList.remove('ok', 'mal'); f.classList.add(ok ? 'ok' : 'mal'); });
    const falt = libres.filter(Boolean).map(g => g[0]);
    const det = resp.map(r => ({ q: 'palabra', r, c: r, ok: c.answers.some(g => igual(r, g)), p: true }));
    if (falt.length) el.append(h(`<p class="marca-res mal">Faltaron: <span class="correcta">${esc(falt.join(', '))}</span></p>`));
    return { total: c.answers.length, bien, respuesta: resp, detalle: det };
  } };
}
async function rOral(c, ej) {
  // repetir / leer: práctica oral con grabación opcional
  const el = h(`<div></div>`);
  if (c.tipo === 'repetir') el.append(h(`<div class="texto-ru">${c.elementos.map(esc).join('\n')}</div>`));
  if (c.tipo === 'leer') {
    for (const t of c.textos) {
      if (/^M\d{3}$/.test(t)) { const [m] = await api.materiales([t]); if (m) el.append(h(`<div class="texto-ru">${esc(m.transcripcion)}</div>`)); }
      else el.append(h(`<div class="texto-ru">${esc(t)}</div>`));
    }
  }
  el.append(h(`<p class="sub">Escucha el audio, repite en voz alta y grábate. Tu profesor escuchará la grabación.</p>`));
  const g = crearGrabador(); el.append(g.el);
  if (await pronunciacionActiva()) {
    const ref = c.tipo === 'repetir' ? c.elementos.join(' ') : [...el.querySelectorAll('.texto-ru')].map(x => x.textContent).join(' ');
    const caja = h(`<div class="pron"><button class="btn sec" type="button">📊 Evaluar mi pronunciación</button><div class="pron-res"></div></div>`);
    caja.querySelector('button').onclick = async ev => {
      const res = caja.querySelector('.pron-res');
      if (!g.blob) { res.innerHTML = '<p class="sub">Primero grábate.</p>'; return; }
      ev.target.disabled = true; res.innerHTML = '<p class="sub">Evaluando… ⏳</p>';
      try {
        const r = await api.evaluarPronunciacion(await aWav16k(g.blob), ref.replace(/\u0301/g, ''));
        if (!r?.palabras) { res.innerHTML = `<p class="sub">No se pudo evaluar${r?.omitido ? ': ' + esc(r.omitido) : ''}.</p>`; }
        else res.innerHTML = `<p><b>Pronunciación: ${r.total} %</b> <span class="sub">· exactitud ${r.exactitud} · fluidez ${r.fluidez} · completitud ${r.completitud}</span></p>
          <p class="pron-palabras">${r.palabras.map(w => `<span class="${w.error === 'Omission' ? 'omitida' : w.nota >= 80 ? 'bien' : w.nota >= 60 ? 'regular' : 'mal'}" title="${w.nota} %">${esc(w.palabra)}</span>`).join(' ')}</p>
          <p class="sub">Verde: bien · amarillo: mejorable · rojo: repítela · tachada: no se oyó.</p>`;
      } catch (e) { res.innerHTML = '<p class="sub">No se pudo evaluar ahora. Tu profesora escuchará la grabación.</p>'; }
      ev.target.disabled = false;
    };
    el.append(caja);
  }
  return { el, abierta: true, async corregir() {
    const audio = g.blob ? await api.subirGrabacion(g.blob) : null;
    return { abierta: true, respuesta: { grabada: !!audio }, audio };
  } };
}
function rAbierta(c, ej) {
  const oral = ej.tipo_ejercicio === 'TE15';
  const el = h(`<div></div>`);
  if (c.preguntas) el.append(h(`<ol>${c.preguntas.map(p => `<li>${esc(p)}</li>`).join('')}</ol>`));
  const ta = h(`<textarea placeholder="${oral ? 'Puedes escribir aquí lo que vas a decir (opcional)' : 'Escribe tu respuesta en ruso'}"></textarea>`);
  el.append(ta);
  const g = crearGrabador(); if (oral) el.append(g.el);
  return { el, abierta: true, async corregir() {
    const audio = g.blob ? await api.subirGrabacion(g.blob) : null;
    if (!ta.value.trim() && !audio) throw new Error(oral ? 'Graba tu respuesta o escríbela antes de enviar.' : 'Escribe tu respuesta antes de enviar.');
    if (c.modelo) el.append(h(`<details open><summary>Ejemplo de respuesta</summary><div class="texto-ru">${esc(c.modelo)}</div></details>`));
    return { abierta: true, respuesta: { texto: ta.value }, audio };
  } };
}
// imágenes de materiales dentro de ejercicios y explicaciones: <img data-mat="M123">
async function resolverImgs(el) {
  for (const im of el.querySelectorAll('img[data-mat]:not([src])')) {
    const u = await api.url('materiales', `img/${im.dataset.mat}.jpg`);
    if (u) im.src = u; else im.replaceWith(h(`<span class="sub">(imagen ${esc(im.dataset.mat)} no disponible)</span>`));
  }
}

// ---------- Voz: lee palabras rusas con la voz del dispositivo (sin archivos de audio)
const HAY_VOZ = 'speechSynthesis' in window;
function hablar(texto) {
  if (!HAY_VOZ) return;
  const u = new SpeechSynthesisUtterance(String(texto).replace(/́/g, ''));
  u.lang = 'ru-RU'; u.rate = 0.85;
  const v = speechSynthesis.getVoices().find(x => /^ru/i.test(x.lang)); if (v) u.voice = v;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}
// Lee un diálogo línea por línea; cada hablante (línea que empieza con «—» o «Nombre:») alterna voz o tono
function leerDialogo(texto, rate = 0.9) {
  if (!HAY_VOZ || !texto) return;
  speechSynthesis.cancel();
  const voces = speechSynthesis.getVoices().filter(x => /^ru/i.test(x.lang));
  const lineas = String(texto).replace(/́/g, '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  let turno = 0;
  for (const l of lineas) {
    const dialogo = /^[—–-]/.test(l) || /^[А-ЯЁA-Z][^:]{0,20}:/.test(l);
    const u = new SpeechSynthesisUtterance(l.replace(/^[—–-]\s*/, '').replace(/^[А-ЯЁA-Z][^:]{0,20}:\s*/, ''));
    u.lang = 'ru-RU'; u.rate = rate;
    if (voces.length) u.voice = voces[(dialogo ? turno : 0) % voces.length];
    if (dialogo && voces.length < 2) u.pitch = turno % 2 ? 0.75 : 1.15;
    if (dialogo) turno++;
    speechSynthesis.speak(u);
  }
}
function botonVoz(texto) {
  if (!HAY_VOZ) return document.createTextNode('');
  const b = h(`<button class="voz" type="button" title="Escuchar" aria-label="Escuchar">🔊</button>`);
  b.onclick = e => { e.stopPropagation(); hablar(texto); }; return b;
}
// ---------- Racha: días seguidos con actividad (cuenta hoy o, si hoy aún no hay, hasta ayer)
function racha(intentos, eventos) {
  const dia = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const dias = new Set([...intentos, ...eventos.filter(e => ['tarjeta', 'intro'].includes(e.tipo))].map(x => dia(x.creado_en)));
  const d = new Date(); let n = 0; const hoy = dias.has(dia(d));
  if (!hoy) d.setDate(d.getDate() - 1);
  while (dias.has(dia(d))) { n++; d.setDate(d.getDate() - 1); }
  return { n, hoy };
}
// ---------- Felicitación al completar un nivel
function confeti(ms = 6000) {
  const cv = h(`<canvas class="confeti"></canvas>`); document.body.append(cv);
  const cx = cv.getContext('2d'); cv.width = innerWidth; cv.height = innerHeight;
  const col = ['#b4372f', '#2f5d8a', '#e2a400', '#2e7d4f', '#8e44ad', '#ff7a59'];
  const ps = Array.from({ length: 180 }, () => ({ x: Math.random() * cv.width, y: -Math.random() * cv.height, r: 5 + Math.random() * 7, c: col[Math.random() * col.length | 0], vy: 2 + Math.random() * 4, vx: -1.5 + Math.random() * 3, a: Math.random() * 6, va: -.2 + Math.random() * .4 }));
  const t0 = performance.now();
  (function paso(t) {
    cx.clearRect(0, 0, cv.width, cv.height);
    for (const p of ps) { p.x += p.vx; p.y += p.vy; p.a += p.va; if (p.y > cv.height + 20 && t - t0 < ms - 1500) { p.y = -20; p.x = Math.random() * cv.width; }
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.a); cx.fillStyle = p.c; cx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); cx.restore(); }
    if (t - t0 < ms) requestAnimationFrame(paso); else cv.remove();
  })(t0);
}
function celebrarNivel(nivel, eventos) {
  const clave = `nivel_celebrado_${sesion?.user?.id || 'demo'}`;
  if (!nivel || localStorage.getItem(clave) === nivel) return;
  try { localStorage.setItem(clave, nivel); } catch (e) {}
  const pedido = !planConCertificado() || eventos.some(e => e.tipo === 'certificado' && e.ref === nivel);   // sin plan Pro: solo felicitación
  const o = h(`<div class="felicidades"><div class="caja"><div class="copa">🏆</div><h1>¡Felicidades!</h1>
    <p class="grande">Alcanzaste el nivel <b>${esc(nivel)}</b> de ruso.</p><p>Поздравляем! Dominas el vocabulario, la gramática y las habilidades de este nivel.</p>
    ${pedido ? '' : `<p class="instr">¿Quieres recibir tu certificado de nivel ${esc(nivel)}?</p><p class="sub">El certificado se entrega al aprobar el examen de suficiencia (5 partes, mínimo 66 % en cada una). Puedes rendirlo cuando quieras desde tu inicio.</p>`}
    <div class="acciones" style="justify-content:center">${pedido ? '' : `<button class="btn" data-c="1" type="button">Sí, quiero mi certificado</button>`}<button class="btn sec" data-c="0" type="button">${pedido ? 'Seguir aprendiendo' : 'Ahora no'}</button></div><p class="error" hidden></p></div></div>`);
  document.body.append(o); confeti();
  o.querySelectorAll('[data-c]').forEach(b => b.onclick = async () => {
    if (b.dataset.c === '1') {
      try { await api.registrar('certificado', [nivel]); o.querySelector('.caja').innerHTML = `<div class="copa">📜</div><h1>¡Listo!</h1><p>Registramos tu solicitud de certificado ${esc(nivel)}. Tu profesora te escribirá pronto.</p><div class="acciones" style="justify-content:center"><button class="btn" type="button">Seguir aprendiendo</button></div>`; o.querySelector('button').onclick = () => o.remove(); }
      catch (err) { const e = o.querySelector('.error'); e.hidden = false; e.textContent = 'No se pudo registrar la solicitud. Avisa a tu profesora.'; }
    } else o.remove();
  });
}
// Tarjetas para descubrir: una a la vez (palabra rusa con audio, sin imagen); el alumno escribe qué cree que significa,
// la tarjeta se voltea y muestra la traducción. No se penaliza el error; si acierta, la palabra entra al repaso como reconocida.
const sinArticulo = x => norm(x).replace(/^(el|la|los|las|un|una|unos|unas|lo)\s+/, '');
function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function traduccionOk(resp, es) {
  const r = sinArticulo(resp); if (!r) return false;
  const opciones = String(es || '').split(/[,;/()]|\s+o\s+/).map(sinArticulo).filter(Boolean);
  return opciones.some(o => o === r || distancia(o, r) <= (o.length >= 8 ? 2 : o.length >= 4 ? 1 : 0)
    || (r.length >= 4 && (` ${o} `).includes(` ${r} `)));
}
function rDescubrir(c) {
  const el = h(`<div class="desc-una"></div>`); const res = c.tarjetas.map(() => null);
  const r = { el, propio: true, alTerminar: null, corregir() {
    const det = c.tarjetas.map((t, i) => ({ q: t.ru, r: res[i] ? 'reconoció' : '', c: t.ru, ok: true, p: false })).filter((_, i) => res[i]);
    return { total: c.tarjetas.length, bien: c.tarjetas.length, aciertos: res.filter(Boolean).length, respuesta: res, detalle: det, sinNota: true };
  } };
  const mostrar = k => {
    const t = c.tarjetas[k];
    const f = h(`<div class="tarjeta-desc grande-desc"><div class="etq">Tarjeta ${k + 1} de ${c.tarjetas.length}</div>
      <div class="ru">${esc(t.ru)}</div>${t.tr ? `<div class="tr">${esc(t.tr)}</div>` : ''}
      <div class="frente"><label class="sub" style="display:block;margin:10px 0 4px">¿Qué crees que significa? Escríbelo en español:</label>
        <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="en español">
        <div class="acciones" style="justify-content:center"><button class="btn" type="button">Enviar</button></div></div>
      <div class="dorso" hidden>${t.img ? `<img data-mat="${esc(t.img)}" alt="">` : ''}<div class="es">${esc(t.es)}</div>${t.nota ? `<div class="sub">${esc(t.nota)}</div>` : ''}<div class="marca-res"></div>
        <div class="acciones" style="justify-content:center"><button class="btn" type="button">${k + 1 < c.tarjetas.length ? 'Siguiente tarjeta →' : 'Terminar'}</button></div></div></div>`);
    f.querySelector('.ru').append(' ', botonVoz(t.ru));
    const inp = f.querySelector('.frente input'), [bE, bS] = f.querySelectorAll('.acciones .btn');
    const enviar = () => {
      res[k] = traduccionOk(inp.value, t.es);
      f.querySelector('.frente').remove(); f.querySelector('.dorso').hidden = false;      // lo escrito desaparece: no se muestra ni se penaliza
      resolverImgs(f);                                                            // la imagen solo se ve con la respuesta: no delata la palabra
      if (res[k]) { f.classList.add('ok'); f.querySelector('.marca-res').textContent = '✓ ¡Lo adivinaste!'; }
      bS.focus();
    };
    bE.onclick = enviar; inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); enviar(); } };
    bS.onclick = () => { if (k + 1 < c.tarjetas.length) mostrar(k + 1); else { el.innerHTML = `<p class="instr">¡Listo! Viste las ${c.tarjetas.length} tarjetas.</p>`; r.alTerminar?.(); } };
    el.innerHTML = ''; el.append(f); resolverImgs(f); setTimeout(() => inp.focus(), 0);
  };
  mostrar(0);
  return r;
}
// Seguir el trazo: el alumno repasa con el dedo o el mouse una letra cursiva (fuente Bad Script)
function rTrazo(c) {
  const el = h(`<div class="trazos"></div>`); const W = 300, H = 190, FUENTE = '130px "Bad Script"';
  const lienzos = c.elementos.map(txt => {
    const f = h(`<div class="trazo"><canvas width="${W}" height="${H}"></canvas><div class="acciones" style="margin-top:6px"><button class="btn sec" type="button">Borrar</button><span class="marca-res"></span></div></div>`);
    const cv = f.querySelector('canvas'), cx = cv.getContext('2d'); let trazos = [], act = null;
    const dibujar = () => {
      cx.clearRect(0, 0, W, H); cx.font = FUENTE; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillStyle = '#d9d2c4'; cx.fillText(txt, W / 2, H / 2 + 5);
      cx.strokeStyle = '#2f5d8a'; cx.lineWidth = 9; cx.lineCap = cx.lineJoin = 'round';
      for (const t of trazos) { cx.beginPath(); t.forEach(([x, y], k) => k ? cx.lineTo(x, y) : cx.moveTo(x, y)); if (t.length === 1) cx.lineTo(t[0][0] + .1, t[0][1]); cx.stroke(); }
    };
    const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
    cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); act = [pos(e)]; trazos.push(act); dibujar(); };
    cv.onpointermove = e => { if (act) { act.push(pos(e)); dibujar(); } };
    cv.onpointerup = cv.onpointercancel = () => { act = null; };
    f.querySelector('button').onclick = () => { trazos = []; f.querySelector('.marca-res').textContent = ''; f.classList.remove('ok', 'mal'); dibujar(); };
    document.fonts.load(FUENTE).then(dibujar, dibujar); dibujar();
    el.append(f);
    // evaluación: cuánto del modelo cubrió el trazo y cuánto del trazo cae sobre el modelo
    const evaluar = () => {
      const mk = () => { const o = document.createElement('canvas'); o.width = W; o.height = H; const x = o.getContext('2d'); x.font = FUENTE; x.textAlign = 'center'; x.textBaseline = 'middle'; return [o, x]; };
      const pinta = (x, ancho) => { x.lineWidth = ancho; x.lineCap = x.lineJoin = 'round'; x.strokeStyle = '#000'; for (const t of trazos) { x.beginPath(); t.forEach(([a, b], k) => k ? x.lineTo(a, b) : x.moveTo(a, b)); if (t.length === 1) x.lineTo(t[0][0] + .1, t[0][1]); x.stroke(); } };
      const [, mod] = mk(); mod.fillText(txt, W / 2, H / 2 + 5);
      const [, banda] = mk(); banda.lineWidth = 22; banda.lineJoin = 'round'; banda.strokeText(txt, W / 2, H / 2 + 5); banda.fillText(txt, W / 2, H / 2 + 5);
      const [, usu] = mk(); pinta(usu, 9); const [, usuAncho] = mk(); pinta(usuAncho, 28);
      const A = mod.getImageData(0, 0, W, H).data, B = banda.getImageData(0, 0, W, H).data, U = usu.getImageData(0, 0, W, H).data, UA = usuAncho.getImageData(0, 0, W, H).data;
      let m = 0, cub = 0, u = 0, dentro = 0;
      for (let i = 3; i < A.length; i += 4) { if (A[i] > 100) { m++; if (UA[i] > 100) cub++; } if (U[i] > 100) { u++; if (B[i] > 100) dentro++; } }
      const cobertura = m ? cub / m : 0, precision = u ? dentro / u : 0, ok = cobertura >= 0.7 && precision >= 0.75;
      f.classList.remove('ok', 'mal'); f.classList.add(ok ? 'ok' : 'mal');
      f.querySelector('.marca-res').textContent = ok ? '✓ Bien' : (cobertura < 0.7 ? '✗ Falta recorrer partes de la letra' : '✗ El trazo se sale del modelo');
      return ok;
    };
    return { txt, evaluar };
  });
  return { el, corregir() {
    const det = lienzos.map(l => ({ q: 'trazo ' + l.txt, r: '', c: '', ok: l.evaluar() }));
    return { total: det.length, bien: det.filter(d => d.ok).length, respuesta: det.map(d => d.ok), detalle: det };
  } };
}

async function renderizar(ej) {
  const c = typeof ej.contenido === 'string' ? JSON.parse(ej.contenido) : ej.contenido;
  switch (c.tipo) {
    case 'match': return rMatch(c);
    case 'order': return rOrder(c);
    case 'clasificar': return rClasificar(c);
    case 'conjunto': return rConjunto(c);
    case 'repetir': case 'leer': return rOral(c, ej);
    case 'abierta': return rAbierta(c, ej);
    case 'descubrir': return rDescubrir(c);
    case 'trazo': return rTrazo(c);
    default: return rItems(c);
  }
}

// ---------------------------------------------------------------- vistas
function nav(activa) {
  if (!sesion) { $nav.innerHTML = `<a href="#/planes">Planes</a><a href="#/entrar">Entrar</a><a class="btn-mini" href="#/registro">Prueba gratis</a>`; return; }
  const links = [['#/', perfil?.rol === 'docente' ? 'Lecciones' : 'Inicio', 'inicio']];
  if (perfil?.rol === 'docente') links.push(['#/docente', 'Panel docente', 'docente']);
  $nav.innerHTML = links.map(([u, t, k]) => `<a href="${u}" class="${k === activa ? 'activo' : ''}">${t}</a>`).join('') +
    `<a class="chip" href="#/cuenta" title="Mi cuenta">👤 ${esc(perfil?.nombre || sesion.user.email)}</a>` + (DEMO ? '<span class="chip pend">demo</span>' : '<a href="#/salir">Salir</a>');
  if (perfil?.rol === 'docente') reportesNuevos().then(n => {     // aviso de reportes sin resolver (problemas de alumnos, videos caídos)
    const a = $nav.querySelector('a[href="#/docente"]');
    if (a && n && !a.querySelector('.insignia')) a.insertAdjacentHTML('beforeend', ` <span class="insignia" title="Reportes sin resolver">${n}</span>`);
  });
}

let cacheReportes = null;
async function reportesNuevos(forzar = false) {
  if (!forzar && cacheReportes && Date.now() - cacheReportes.t < 5 * 60e3) return cacheReportes.n;
  try { const n = (await api.reportes()).filter(r => r.estado === 'nuevo').length; cacheReportes = { n, t: Date.now() }; return n; } catch { return 0; }
}
function vLogin(msg = '') {
  nav();
  $app.innerHTML = '';
  const f = h(`<form class="tarjeta login"><h1>${esc(NOMBRE_CURSO)}</h1><p class="sub">Entra con tu correo y contraseña.</p>
    <div class="campo"><label>Correo</label><input type="email" required autocomplete="username"></div>
    <div class="campo"><label>Contraseña</label><input type="password" required autocomplete="current-password"></div>
    <p class="error">${esc(msg)}</p><button class="btn" type="submit">Entrar</button>
    <p class="sub"><a href="#/recuperar">¿Olvidaste tu contraseña?</a> · <a href="#/registro">Crear cuenta gratis</a></p></form>`);
  f.onsubmit = async e => {
    e.preventDefault(); const [em, pw] = f.querySelectorAll('input');
    f.querySelector('button').disabled = true;
    try { await api.login(em.value.trim(), pw.value); await iniciar(); }
    catch (err) { vLogin('No se pudo entrar: revisa correo y contraseña.'); }
  };
  $app.append(f);
}

let intentosCache = null;
async function progreso() {
  intentosCache = await api.misIntentos();
  const hechos = new Map();
  for (const i of intentosCache) { const p = hechos.get(i.ejercicio_id); if (!p || (i.puntaje ?? 0) > (p.puntaje ?? 0)) hechos.set(i.ejercicio_id, i); }
  return hechos;
}

async function cargarModelo(intentos, eventos, oralesZoom = false) {
  const [escenarios, ejercicios, tipos, temas, reglas, voc, formas] = await Promise.all([api.todosEscenarios(), api.ejerciciosLigeros(), api.tipos(), api.temas(),
    reglasCache || api.reglas(), vocabCache || api.vocabUso(), formasCache || fetch('formas.json').then(r => r.ok ? r.json() : { f: {}, m: {} }).catch(() => ({ f: {}, m: {} }))]);
  reglasCache = reglas; vocabCache = voc; formasCache = formas;
  const ia = perfil?.rol === 'docente' ? false : await iaActiva();
  const vocab = Object.fromEntries(voc.map(v => [v.id, v]));
  if (enPrueba()) {                                                        // prueba gratis: solo las primeras lecciones
    const esc0 = escenarios.filter(s => LECCIONES_PRUEBA.includes(s.id));
    const ej0 = ejercicios.filter(e => LECCIONES_PRUEBA.includes(e.escenario));
    return { m: prepararModelo({ escenarios: esc0, ejercicios: ej0, tipos, intentos, eventos, reglas, temas, formas, vocab, oralesZoom, iaActiva: ia }), escenarios, vocab };
  }
  if (perfil?.rol !== 'docente' && PLANES_UN_NIVEL.includes(perfil?.plan) && perfil.plan_nivel) {      // compra de un nivel: solo las lecciones de ese nivel, para siempre
    const escN = escenarios.filter(x => (x.nivel || 'A1') === perfil.plan_nivel), ids = new Set(escN.map(x => x.id));
    return { m: prepararModelo({ escenarios: escN, ejercicios: ejercicios.filter(e => ids.has(e.escenario)), tipos, intentos, eventos, reglas, temas, formas, vocab, oralesZoom, iaActiva: ia }), escenarios, vocab };
  }
  return { m: prepararModelo({ escenarios, ejercicios, tipos, intentos, eventos, reglas, temas, formas, vocab, oralesZoom, iaActiva: ia }), escenarios, vocab };
}

// Modo ejercicio: tras empezar, las tareas siguen una tras otra hasta que el alumno sale o recarga la página
let enFlujo = false;
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a'); if (!a) return;
  if (a.hasAttribute('data-flujo')) enFlujo = true;
  else if (a.getAttribute('href') === '#/' || a.getAttribute('href') === '#/salir') enFlujo = false;
}, true);
// Guías que se muestran una vez por dispositivo, justo antes de la primera actividad que las necesita
const guiaVista = k => { try { return localStorage.getItem(`guia_${k}_${sesion?.user?.id || 'demo'}`) === '1'; } catch (e) { return true; } };
function guia(k, seguir) {
  const T = {
    teclado: ['⌨️ Antes de escribir en ruso', `<p>En esta actividad vas a escribir con letras rusas. Tienes dos opciones:</p>
      <p><b>1. Teclado en pantalla.</b> Debajo de cada actividad aparecen las letras rusas: toca una y se escribe. No hay que instalar nada.</p>
      <p><b>2. Teclado ruso en tu dispositivo</b> (más cómodo para escribir seguido):</p>
      <ul><li><b>Android:</b> Ajustes → Sistema → Idiomas e introducción → Teclado en pantalla → Gboard → Idiomas → Añadir teclado → Ruso. Cambias de idioma con la tecla 🌐.</li>
      <li><b>iPhone / iPad:</b> Ajustes → General → Teclado → Teclados → Añadir nuevo teclado → Ruso. Cambias con la tecla 🌐.</li>
      <li><b>Windows:</b> Configuración → Hora e idioma → Idioma y región → Agregar un idioma → Русский. Cambias con <kbd>Windows</kbd> + <kbd>Espacio</kbd>.</li>
      <li><b>Mac:</b> Ajustes del Sistema → Teclado → Fuentes de entrada → Editar → + → Ruso. Cambias con <kbd>Ctrl</kbd> + <kbd>Espacio</kbd> o la tecla 🌐.</li></ul>
      <p class="sub">Los nombres de los menús pueden variar un poco según la versión de tu dispositivo.</p>`],
    voz: ['🔊 Antes de escuchar las palabras', `<p>Junto a cada palabra rusa verás el botón 🔊: lee la palabra con la voz rusa de tu dispositivo. Pruébalo:</p>
      <p><button class="btn sec" type="button" data-probar>🔊 Probar: «Привет!»</button></p>
      <p>Si no suena o suena con acento extraño, instala la voz rusa:</p>
      <ul><li><b>Android:</b> Ajustes → Sistema → Idiomas e introducción → Síntesis de voz → ⚙ junto a «Servicios de voz de Google» → Instalar datos de voz → Ruso.</li>
      <li><b>iPhone / iPad:</b> Ajustes → Accesibilidad → Contenido leído → Voces → Ruso → descarga una voz (por ejemplo, Milena).</li>
      <li><b>Windows:</b> Configuración → Hora e idioma → Voz → Agregar voces → Ruso.</li>
      <li><b>Mac:</b> Ajustes del Sistema → Accesibilidad → Contenido leído → Voz del sistema → Administrar voces → Ruso.</li></ul>
      <p class="sub">Después de instalarla, cierra y vuelve a abrir la plataforma. Los nombres de los menús pueden variar según la versión.</p>`] }[k];
  $app.innerHTML = `<div class="tarjeta guia"><h2 style="margin-top:0">${T[0]}</h2>${T[1]}<div class="acciones"><button class="btn" type="button" data-ok>Entendido, continuar →</button></div></div>`;
  const p = $app.querySelector('[data-probar]'); if (p) p.onclick = () => hablar('Привет!');
  $app.querySelector('[data-ok]').onclick = () => { try { localStorage.setItem(`guia_${k}_${sesion?.user?.id || 'demo'}`, '1'); } catch (e) {} seguir(); };
}
// Bienvenida: se muestra una vez, en el primer ingreso del alumno (antes de su primera actividad)
function bienvenida(seguir) {
  const nombre = (perfil?.nombre || '').split(' ')[0];
  const zoom = !!perfil?.orales_zoom, prueba = enPrueba();
  $app.innerHTML = `<div class="tarjeta guia bienvenida">
    <h1 style="margin-top:0">¡Добро пожаловать${nombre ? ', ' + esc(nombre) : ''}! 👋</h1>
    <p>Te damos la bienvenida a <b>${esc(NOMBRE_CURSO)}</b>. Aquí aprendes ruso a tu ritmo: la plataforma decide qué te toca practicar cada día según lo que ya sabes.</p>
    <h3>Cómo funciona</h3>
    <ol>
      <li><b>Abre «Inicio» y pulsa «Empezar».</b> Siempre verás una sola tarea: la siguiente que te conviene. Al terminarla, la siguiente aparece sola; sales con «← Salir».</li>
      <li><b>Primero las letras.</b> Empiezas con el alfabeto: ninguna palabra aparece antes de que conozcas sus letras.</li>
      <li><b>Un poco cada día.</b> Con 15–20 minutos diarios avanzas más que con dos horas una vez por semana. Tu <b>racha</b> 🔥 cuenta los días seguidos.</li>
      <li><b>Repaso del día.</b> La plataforma te devuelve las palabras justo cuando empiezas a olvidarlas. Hazlo antes del material nuevo.</li>
      <li><b>Tus errores no se castigan:</b> sirven para saber qué repasar.</li>
      ${zoom ? '<li><b>Clase por Zoom.</b> Las tareas orales (hablar, presentarte, describir) se guardan para tu clase semanal con la profesora.</li>' : ''}
      ${prueba ? '<li><b>Prueba gratis:</b> tienes la primera lección completa: «Primeras palabras» (el alfabeto). Al terminarla podrás elegir un plan.</li>' : ''}
    </ol>
    <h3>Tus primeras lecciones</h3>
    <ul>
      <li><b>Primeras palabras:</b> el alfabeto (А, О, К, М, Т…), cómo suena cada letra, la letra cursiva y tus primeras palabras parecidas al español.</li>
      <li><b>«Привет! Как тебя зовут?»:</b> saludar, presentarte, preguntar «¿cómo te llamas?» y videos cortos de clase.</li>
    </ul>
    <h3>Antes de empezar (2 minutos)</h3>
    <ul>
      <li>Usa audífonos o sube el volumen: muchas actividades tienen voz 🔊.</li>
      <li><b>Instálala como app:</b> en el celular, menú del navegador → «Agregar a pantalla de inicio» (Android) o Compartir → «Agregar a inicio» (iPhone).</li>
      <li>Cuando una actividad pida teclado ruso o voz rusa, te explicaremos cómo activarlos en tu dispositivo.</li>
      <li>¿Algo no funciona? Usa «⚠️ Reportar un problema técnico» abajo a la derecha.</li>
    </ul>
    <div class="acciones"><button class="btn" type="button" data-ok>¡Empezar! Поехали! →</button></div>
  </div>`;
  $app.querySelector('[data-ok]').onclick = () => { try { localStorage.setItem(`guia_bienvenida_${sesion?.user?.id || 'demo'}`, '1'); } catch (e) {} seguir(); };
}
const pideTeclado = (c, tipoEj) => (c.items || []).some(it => it.tipo === 'input' && (it.answers || []).some(a => /[а-яё]/i.test(a))) || (c.tipo === 'abierta' && !ORALES.has(tipoEj));

async function vInicio() {
  nav('inicio');
  $app.innerHTML = `<p class="cargando">Preparando tu próxima tarea…</p>`;
  const [intentos, eventos] = await Promise.all([api.misIntentos(), api.misEventos()]);
  let { m, escenarios, vocab } = await cargarModelo(intentos, eventos, !!perfil?.orales_zoom);
  if (perfil?.rol === 'docente') {                    // el docente no recibe tareas: ve las lecciones en vista previa
    const pan = panorama(m);
    $app.innerHTML = `<h1>Lecciones</h1><p class="sub">Vista previa de todas las lecciones, con sus ejercicios en el orden en que los recibiría un alumno que empieza de cero (el orden real se adapta a cada alumno). Los informes de alumnos están en «Panel docente».</p>`;
    const l = h(`<div class="lista"></div>`);
    for (const s0 of m.esc) {
      const r = pan.porLeccion.get(s0.id);
      l.append(h(`<a class="fila" href="#/e/${s0.id}"><div class="txt"><b>${esc(s0.id)} · ${esc(s0.nombre)}</b><small>${esc(s0.nivel || '')} · ${r.orden.length} ejercicios${r.practica.length ? ` · ${r.practica.length} de práctica adicional` : ''}</small></div></a>`));
    }
    if (pan.sinLeccion.length) l.append(h(`<a class="fila" href="#/e/_practica"><div class="txt"><b>Práctica sin lección asignada</b><small>${pan.sinLeccion.length} ejercicios cuya regla todavía no se enseña en ninguna lección (sobre todo A2)</small></div></a>`));
    $app.append(l);
    return;
  }
  if (!intentos.length && !guiaVista('bienvenida')) return bienvenida(vInicio);   // primer ingreso: cómo funciona la plataforma
  const ubic = necesitaUbicacion(m, intentos, eventos);
  if (ubic === 'preguntar') return preguntaUbicacion();
  if (m.alertaUbicacion) await avisarMalaUbicacion(m);
  let est = estadoAlumno(m), sig = siguienteTarea(m);
  if (sig.tipo === 'iniciar') {                       // primer escenario: se fija sin preguntar
    await api.registrar('escenario', [sig.escenario.id]); return vInicio();
  }
  if (sig.tipo === 'zoom') {                          // ejercicio oral: pasa a la lista de la clase por Zoom
    await api.registrar('zoom', [sig.ejercicio.id]); return vInicio();
  }
  if (sig.tipo === 'sortear') {                       // ejercicio-banco: se fijan las preguntas que tocan
    await api.registrar('sorteo', [sig.ref]); return vInicio();
  }
  if (sig.tipo === 'planificar') {                    // repaso del día: se fija al primer ingreso
    await api.registrar('repaso', [sig.ref]); return vInicio();
  }
  const esEj = ['nuevo', 'repaso', 'repasoDia'].includes(sig.tipo) && !!sig.ejercicio;   // reglas y palabras nuevas se presentan antes, también en modo ejercicio
  if (['descanso', 'fin'].includes(sig.tipo)) enFlujo = false;
  if (enFlujo && esEj) { location.hash = `#/x/${sig.ejercicio.id}`; return; }          // sigue directo con el siguiente ejercicio
  if (sig.tipo === 'tarjetas') {
    if (HAY_VOZ && !guiaVista('voz')) return guia('voz', vInicio);
    if (sig.items.some(i => i.modo === 'p') && !guiaVista('teclado')) return guia('teclado', vInicio);
  }
  const hoy = intentos.filter(i => new Date(i.creado_en).toDateString() === new Date().toDateString()).length;
  $app.innerHTML = `<h1>Привет${perfil?.nombre ? ', ' + esc(perfil.nombre) : ''}!</h1>
    <p class="sub">${hoy ? `Hoy llevas ${hoy} ${hoy === 1 ? 'tarea' : 'tareas'}. ¡Sigue así!` : 'Tu plan avanza paso a paso según lo que ya sabes.'}</p>
    <div class="meta">${esc(textoProyeccion(proyeccion(m)))}</div>`;
  const rc = racha(intentos, eventos);
  if (rc.n) $app.querySelector('.sub').after(h(`<div class="racha ${rc.hoy ? '' : 'pend'}">🔥 <b>${rc.n}</b> ${rc.n === 1 ? 'día seguido' : 'días seguidos'}${rc.hoy ? '' : ' · practica hoy (cualquier actividad cuenta) para mantener tu racha'}</div>`));
  if (enPrueba()) {
    $app.querySelector('.meta').textContent = 'Prueba gratis: la primera lección completa (alfabeto, sonidos, letra cursiva y primeras palabras).';
    if (sig.tipo === 'elegir' && sig.opciones.length) { await api.registrar('escenario', [sig.opciones[0].s.id]); return vInicio(); }   // sigue con la otra lección de la prueba
    if (['fin', 'elegir'].includes(sig.tipo)) { $app.append(tarjetaFinPrueba()); return; }
  } else {
    celebrarNivel(proyeccion(m).logrado || (location.search.includes('demo') && new URLSearchParams(location.search).get('celebrar')), eventos);
    const logrado = proyeccion(m).logrado || (location.search.includes('demo') && new URLSearchParams(location.search).get('celebrar'));
    const [certs, exs] = await Promise.all([api.certificados().catch(() => []), api.examenes().catch(() => [])]);
    for (const c of certs) $app.append(h(`<a class="fila cert-fila" href="#/certificado/${esc(c.codigo)}"><div class="txt"><b>📜 Certificado de nivel ${esc(c.nivel)}</b><small>Código ${esc(c.codigo)} · ver e imprimir</small></div></a>`));
    if (logrado && !certs.some(c => c.nivel === logrado) && !planConCertificado()) {
      $app.append(h(`<div class="tarjeta"><div class="etq">Examen de suficiencia · ${esc(logrado)}</div><p>Ya dominas el nivel ${esc(logrado)}. 🎉 El examen y el certificado son parte del plan <b>Pro</b>, que estará disponible muy pronto.</p></div>`));
    } else if (logrado && !certs.some(c => c.nivel === logrado)) {
      const ex = exs.find(x => x.nivel === logrado && x.estado !== 'anulado');
      $app.append(h(`<div class="tarjeta"><div class="etq">Examen de suficiencia · ${esc(logrado)}</div>${ex ? `<p>${ex.estado === 'en_curso' ? 'Tienes un examen sin terminar.' : ex.estado === 'entregado' ? 'Examen entregado: tu profesora lo está calificando.' : ex.aprobado ? 'Aprobado: tu certificado se está emitiendo.' : 'Calificado: no alcanzaste el mínimo en alguna parte. Puedes volver a intentarlo.'}</p>` : `<p>Ya dominas el nivel ${esc(logrado)}. Rinde el examen para obtener tu certificado (solo desde una computadora con cámara).</p>`}
        ${!ex || ex.estado === 'en_curso' || (ex.estado === 'calificado' && !ex.aprobado) ? `<div class="acciones"><a class="btn sec" href="#/examen?nivel=${esc(logrado)}">${ex?.estado === 'en_curso' ? 'Continuar examen' : 'Rendir examen'}</a></div>` : ''}</div>`));
    }
  }
  const card = h(`<div class="tarjeta"></div>`);
  const filaAct = est.actual ? est.fila[est.actual] : null;
  if (filaAct && !['elegir', 'fin', 'repasoDia', 'tarjetas', 'descanso', 'repasoEscrito', 'reglaUbicada'].includes(sig.tipo) && (!sig.ejercicio || sig.ejercicio.escenario === est.actual) && !(sig.tipo === 'palabras' && !sig.ejercicio)) card.append(h(`<div class="etq">${esc(filaAct.s.nombre)} · ${filaAct.hechos} de ${filaAct.total}</div>`));
  if (sig.tipo === 'descanso') {
    card.append(h(`<p class="instr">¡Buen trabajo por hoy! 💪</p>`));
    card.append(h(`<p>Tienes bastante vocabulario y gramática por repasar, así que por hoy no agregamos material nuevo: así lo que aprendiste se queda contigo. Mañana empezarás con el repaso y luego seguirás avanzando.</p>`));
  } else if (sig.tipo === 'fin' && perfil?.plan === 'gratuito') card.append(h(`<p class="instr">¡Terminaste todas las lecciones del nivel ${esc(perfil.plan_nivel || '')}! 🎉 Sigue con tu repaso diario para dominarlo.</p>`));
  else if (sig.tipo === 'fin' && perfil?.plan === 'nivel') card.append(h(`<p class="instr">¡Terminaste todas las lecciones del nivel ${esc(perfil.plan_nivel || '')}! 🎉 Sigue con tu repaso diario para dominarlo.</p><div class="acciones"><a class="btn sec" href="#/planes">Ver el siguiente nivel</a></div>`));
  else if (sig.tipo === 'fin') card.append(h(`<p class="instr">${proyeccion(m).logrado && !proyeccion(m).nivel ? '¡Completaste todo el contenido disponible! 🎉 Pronto habrá más lecciones.' : 'Ya hiciste todas las lecciones disponibles. 🎉 Sigue con tu repaso diario: así llegarás a dominar el nivel.'}</p>`));
  else if (sig.tipo === 'elegir') {
    card.append(h(`<p class="instr">¡Terminaste esta etapa! 🎉 ¿Con qué situación quieres seguir?</p>`));
    const l = h(`<div class="lista"></div>`);
    sig.opciones.forEach(o => {
      const tema = etiquetaTema(m, o.s);
      const f = h(`<button class="fila" type="button" style="text-align:left;width:100%;font:inherit;cursor:pointer"><div class="txt"><b>${esc(tema || o.s.nombre)}</b><small>${esc(o.s.objetivo_comunicativo || '')}</small></div><span class="btn sec">Elegir</span></button>`);
      f.onclick = async () => { f.disabled = true; await api.registrar('escenario', [o.s.id]); vInicio(); };
      l.append(f);
    });
    card.append(l);
  } else if (sig.tipo === 'regla') {
    const r = sig.regla, esP = /^P/.test(r.id);
    card.append(h(`<div class="etq">${esP ? 'Pronunciación nueva' : 'Regla nueva'}${sig.pendientes > 1 ? ` · quedan ${sig.pendientes} antes del ejercicio` : ''}</div>`));
    card.append(h(`<div class="regla" style="margin-top:6px"><b style="font-size:18px">${esc(r.nombre)}</b>${r.explicacion ? explicacionHtml(r.explicacion) : `<p style="margin:8px 0">${esc(r.descripcion || '')}</p>`}${r.ejemplo ? `<div class="texto-ru">${esc(r.ejemplo)}</div>` : ''}</div>`));
    resolverImgs(card);
    const b = h(`<div class="acciones"><button class="btn" type="button">Entendido, continuar →</button></div>`);
    b.querySelector('button').onclick = async e => { e.target.disabled = true; await api.registrar('intro', [r.id]); vInicio(); };
    card.append(b);
  } else if (sig.tipo === 'reglaUbicada') {
    // regla que la prueba de ubicación dio por sabida, pero el alumno la usó mal: se vuelve a presentar
    const r = sig.regla;
    card.append(h(`<div class="etq">Repaso de una regla${sig.pendientes > 1 ? ` · quedan ${sig.pendientes}` : ''}</div>`));
    card.append(h(`<p class="instr">Hace poco usaste esta regla con un error. Repásala con calma: la practicarás en tu repaso.</p>`));
    card.append(h(`<div class="regla" style="margin-top:6px"><b style="font-size:18px">${esc(r.nombre)}</b>${r.explicacion ? explicacionHtml(r.explicacion) : `<p style="margin:8px 0">${esc(r.descripcion || '')}</p>`}${r.ejemplo ? `<div class="texto-ru">${esc(r.ejemplo)}</div>` : ''}</div>`));
    resolverImgs(card);
    const b = h(`<div class="acciones"><button class="btn" type="button">Entendido, continuar →</button></div>`);
    b.querySelector('button').onclick = async e => { e.target.disabled = true; await api.registrar('intro', [r.id]); vInicio(); };
    card.append(b);
  } else if (sig.tipo === 'palabras') {
    const voc = await api.vocabulario(sig.ids); voc.sort((a, b) => sig.ids.indexOf(a.id) - sig.ids.indexOf(b.id));
    card.append(h(`<div class="etq">${sig.ejercicio ? 'Palabras nuevas' : 'Palabras para volver a aprender'}${sig.pendientes > sig.ids.length ? ` · ${sig.ids.length} de ${sig.pendientes}` : ''}</div>`));
    card.append(h(`<p class="instr">${sig.ejercicio ? 'Antes del ejercicio, conoce estas palabras:' : 'Estas palabras todavía no las dominas. Míralas con calma: volverán en tu repaso.'}</p>`));
    const t = h(`<table class="vocab"></table>`);
    voc.forEach(v => t.append(h(`<tr><td class="ru">${esc(v.lema)}</td><td>${esc(v.traduccion || '')}</td><td class="cat">${esc(v.categoria || '')}</td></tr>`)));
    card.append(t);
    const b = h(`<div class="acciones"><button class="btn" type="button">Ya las vi, continuar →</button></div>`);
    b.querySelector('button').onclick = async e => { e.target.disabled = true; await api.registrar('intro', sig.ids); vInicio(); };
    card.append(b);
  } else if (sig.tipo === 'repasoDia') {
    const e0 = sig.ejercicio;
    card.append(h(`<div class="etq">Repaso de hoy · ${sig.k} de ${sig.n}</div>`));
    card.append(h(`<div>${cabeceraEj(e0, e0.hab)}</div>`));
    card.append(h(`<div class="acciones"><a class="btn" data-flujo href="#/x/${e0.id}">Empezar →</a></div>`));
  } else if (sig.tipo === 'repasoEscrito') {
    card.append(h(`<div class="etq">Repaso de hoy · escritura</div>`));
    if (sig.generado) { try { repasoEscrito(card, JSON.parse(sig.generado), sig.ids, m, vocab); } catch { card.append(h(`<p class="error">No se pudo leer la tarea.</p>`)); } }
    else {
      card.append(h(`<p class="sub">Preparando tu tarea de escritura… ⏳</p>`));
      const hoyS = fechaLocal();
      const pal = sig.ids.filter(x => /^V/.test(x)).map(id => ({ id, lema: vocab[id]?.lema || id, traduccion: vocab[id]?.traduccion || '' }));
      const reg = sig.ids.filter(x => /^[GP]/.test(x)).map(id => ({ id, nombre: m.regla[id]?.nombre || id }));
      const conocidas = [...m.conocidos].filter(x => /^V/.test(x) && vocab[x]).map(x => vocab[x].lema).slice(0, 1500);
      const reglasConocidas = [...m.conocidos].filter(x => /^G/.test(x) && m.regla[x]).map(x => m.regla[x].nombre).slice(0, 80);
      api.generarRepaso({ palabras: pal, reglas: reg, conocidas, reglasConocidas })
        .then(t => api.registrar('escrito', [`${hoyS}|${JSON.stringify(t)}`]))
        .catch(() => api.registrar('escrito', [`${hoyS}|{"fallo":true}`]).catch(() => {}))
        .finally(() => vInicio());
    }
  } else if (sig.tipo === 'tarjetas') {
    card.append(h(`<div class="etq">Repaso de hoy · palabras</div>`));
    card.append(tarjetasRepaso(sig.items, vocab));
  } else {
    const e0 = sig.ejercicio;
    card.append(h(`<div class="etq">${sig.tipo === 'repaso' ? 'Repaso' : 'Siguiente ejercicio'} · ${esc(e0.hab)}</div>`));
    card.append(h(`<div>${cabeceraEj(e0, e0.hab)}</div>`));
    card.append(h(`<div class="acciones"><a class="btn" data-flujo href="#/x/${e0.id}">Empezar →</a></div>`));
  }
  if (ubic === 'ofrecer' && !enFlujo) {
    const o = h(`<div class="tarjeta"><div class="etq">¿Ya sabías ruso de antes?</div><p>Si ya estudiaste ruso, una prueba corta de ubicación (unos 15 minutos) te lleva a la lección que te corresponde, sin repetir lo que ya sabes.</p>
      <div class="acciones"><a class="btn sec" href="#/ubicacion">Hacer la prueba</a><button class="btn sec" type="button">No, sigo desde aquí</button></div></div>`);
    o.querySelector('button').onclick = async ev => { ev.target.disabled = true; try { await api.registrar('ubicacion', ['no']); o.remove(); } catch { ev.target.disabled = false; } };
    $app.append(o);
  }
  if (PLANES_UN_NIVEL.includes(perfil?.plan) && !m.saltados.size && m.nuevasAnteriores.length > 3 && !m.respuestaCambio) { const tc = tarjetaCambioNivel(m); if (tc) $app.append(tc); }
  $app.append(card);
  if (enFlujo && ['regla', 'reglaUbicada', 'palabras', 'tarjetas', 'elegir', 'repasoEscrito'].includes(sig.tipo)) {     // en modo ejercicio: solo la tarea, sin el resto del inicio
    $app.innerHTML = ''; $app.append(h(`<div class="migas"><a href="#/">← Salir</a></div>`), card); return;
  }

  // progreso por habilidad y nivel (sin mostrar el temario)
  const proy = proyeccion(m);
  const pct = Math.round(100 * (proy.frac ?? est.nivelGlobal));
  const pal = resumenPalabras(m);
  const prog = h(`<div class="tarjeta"><h2 style="margin-top:0">Tu progreso</h2>
    <div class="etq">Nivel ${esc(proy.nivel || proy.logrado || 'A1')} · ${pct} % dominado</div><div class="barra-prog" style="max-width:none"><i style="width:${pct}%"></i></div>
    <p class="sub" style="margin:10px 0 0">Palabras que sabes usar: <b>${pal.activas}</b> · palabras que reconoces: <b>${pal.reconocidas}</b></p>
    <div class="cuadricula" style="margin-top:14px"></div></div>`);
  const g = prog.querySelector('.cuadricula');
  for (const hb of HABILIDADES) {
    const r = est.porHab[hb]; const v = r && r.conNota ? Math.round(r.suma / r.conNota) : null;
    g.append(h(`<div><div class="etq">${hb}${r ? ` · ${r.n} ${r.n === 1 ? 'ejercicio' : 'ejercicios'}` : ''}</div><div class="barra-prog"><i style="width:${v ?? 0}%;background:${v == null ? '#ccc' : v >= 70 ? 'var(--ok)' : 'var(--pend)'}"></i></div></div>`));
  }
  $app.append(prog);

  // tareas escritas que la IA no alcanzó a corregir (falla o IA apagada): se reintenta en segundo plano
  const sinCorregir = intentos.filter(i => i.estado === 'pendiente_ia' && i.respuesta?.texto && i.ejercicio_id !== EJ_UBICACION && Date.now() - new Date(i.creado_en) < 14 * 864e5).slice(0, 2);
  if (sinCorregir.length) iaActiva().then(on => on && sinCorregir.forEach(i => api.corregirIA(i.id).catch(() => {})));
  const coment = intentos.filter(i => ['revisado', 'pendiente_docente'].includes(i.estado) && i.feedback && i.ejercicio_id !== EJ_UBICACION).sort((a, b) => new Date(b.creado_en) - new Date(a.creado_en)).slice(0, 3);
  if (coment.length) {
    const c = h(`<div class="tarjeta"><h2 style="margin-top:0">Comentarios sobre tus tareas</h2></div>`);
    coment.forEach(i => c.append(h(`<div class="regla"><b><a href="#/x/${i.ejercicio_id}">Tarea ${esc(i.ejercicio_id)}</a>${i.puntaje != null ? ' · ' + Math.round(i.puntaje) + ' %' : ''}</b>${esc(i.feedback)}</div>`)));
    $app.append(c);
  }
}

async function vEscenario(id) {
  if (perfil?.rol !== 'docente') return vInicio();
  nav('inicio');
  $app.innerHTML = `<p class="cargando">Cargando…</p>`;
  const [ints, evs] = await Promise.all([api.misIntentos(), api.misEventos()]);
  const { m } = await cargarModelo(ints, evs);
  const pan = panorama(m);
  const fila = (x, i) => `<a class="fila" href="#/x/${x.id}"><div class="num">${i + 1}</div><div class="txt"><b>${esc(x.titulo || x.instrucciones)}</b><small>${esc(x.id)} · ${esc(x.hab)}${x.nMostrar ? ` · banco de ${x.itemsBanco.length} preguntas, se muestran ${x.nMostrar}` : ''}</small></div></a>`;
  if (id === '_practica') {
    $app.innerHTML = `<div class="migas"><a href="#/">← Lecciones</a></div><h1>Práctica sin lección asignada</h1><p class="sub">Se usan en repasos y pruebas cuando el alumno ya conoce su regla.</p>`;
    $app.append(h(`<div class="lista">${pan.sinLeccion.map(fila).join('')}</div>`));
    return;
  }
  const [e, mats] = await Promise.all([api.escenario(id), api.materialesEsc(id)]);
  const r = pan.porLeccion.get(id) || { orden: [], practica: [] };
  $app.innerHTML = `<div class="migas"><a href="#/">← Lecciones</a></div><h1>${esc(e.nombre)}</h1><p class="sub">${esc(e.objetivo_comunicativo || '')}</p>`;
  const beE = h(`<button class="btn sec" type="button" style="float:right">✏️ Editar título</button>`);
  beE.onclick = () => editarFila('escenarios', e, [['nombre', 'Título de la lección'], ['objetivo_comunicativo', 'Objetivo (subtítulo)', 'area']], () => vEscenario(id));
  $app.querySelector('.migas').append(beE);
  const textos = mats.filter(x => x.tipo === 'texto' && x.funcion === 'introduccion');
  if (textos.length) {
    const t = h(`<details class="tarjeta"><summary>Textos de la lección (${textos.length})</summary></details>`);
    for (const x of textos) t.append(await bloqueMaterial(x));
    $app.append(t);
  }
  // reglas que se presentan por primera vez en esta lección
  const vistas = new Set();
  for (const s of m.esc) { if (s.id === id) break; for (const x of (pan.porLeccion.get(s.id)?.orden || [])) x.reqReglas.forEach(g => vistas.add(g)); }
  const nuevas = [...new Set(r.orden.flatMap(x => x.reqReglas))].filter(g => !vistas.has(g));
  if (nuevas.length) {
    const todas = new Map((reglasCache || await api.reglas()).map(g => [g.id, g]));
    const t = h(`<details class="tarjeta"><summary>Reglas que se presentan en esta lección (${nuevas.length})</summary><div class="lista"></div></details>`);
    for (const g of nuevas.map(x => todas.get(x)).filter(Boolean)) {
      const f = h(`<div class="fila"><div class="txt"><b>${esc(g.nombre)}</b><small>${esc(g.id)}</small></div><button class="btn sec" type="button">✏️ Editar</button></div>`);
      f.querySelector('button').onclick = () => editarRegla(g, () => vEscenario(id));
      t.querySelector('.lista').append(f);
    }
    $app.append(t);
  }
  $app.append(h(`<h2>Ejercicios de la lección</h2>`));
  $app.append(h(`<p class="sub">Orden para un alumno que empieza de cero. Puedes cambiarlo: arrastra los ejercicios o usa las flechas. Antes de cada ejercicio se siguen presentando las reglas y palabras nuevas que necesita.</p>`));
  const lista = h(`<div class="lista">${r.orden.map(fila).join('')}</div>`);
  const bOrd = h(`<button class="btn sec" type="button">↕ Cambiar orden</button>`);
  bOrd.onclick = () => ordenarLeccion(lista, r.orden, () => vEscenario(id), bOrd);
  $app.append(bOrd, lista);
  if (r.practica.length) {
    $app.append(h(`<h2>Práctica adicional</h2>`));
    $app.append(h(`<p class="sub">No forman parte del camino de la lección: se usan en repasos y pruebas, cuando el alumno ya conoce su regla y sus palabras.</p>`));
    $app.append(h(`<div class="lista">${r.practica.map(fila).join('')}</div>`));
  }
}

async function vEjercicio(id) {
  nav('inicio');
  $app.innerHTML = `<p class="cargando">Cargando…</p>`;
  const ej = await api.ejercicio(id);
  const c = typeof ej.contenido === 'string' ? JSON.parse(ej.contenido) : ej.contenido;
  if (perfil?.rol !== 'docente') {
    if (c.tipo === 'descubrir' && HAY_VOZ && !guiaVista('voz')) return guia('voz', () => vEjercicio(id));
    if (pideTeclado(c, ej.tipo_ejercicio) && !guiaVista('teclado')) return guia('teclado', () => vEjercicio(id));
  }
  const hermanos = (await api.ejerciciosEsc(ej.escenario)).map(x => x.id);
  const pos = hermanos.indexOf(id), sig = hermanos[pos + 1];
  const matIds = [...new Set([...ids(ej.material), ...(c.imagen ? [c.imagen] : [])])];
  const mats = await api.materiales(matIds);
  mats.sort((a, b) => matIds.indexOf(a.id) - matIds.indexOf(b.id));

  $app.innerHTML = perfil.rol === 'docente' ? `<div class="migas"><a href="#/e/${ej.escenario}">← ${esc(ej.escenario)}</a> · ejercicio ${pos + 1} de ${hermanos.length}</div>` : `<div class="migas"><a href="#/">← Salir</a></div>`;
  if (perfil.rol === 'docente') {
    const be = h(`<button class="btn sec" type="button" style="float:right">✏️ Editar</button>`);
    be.onclick = () => editarEjercicio(ej, c);
    $app.querySelector('.migas').append(be);
  }
  const card = h(`<div class="tarjeta">${cabeceraEj(ej)}<div class="media"></div><div class="cuerpo"></div><div class="res"></div><div class="acciones"></div></div>`);
  $app.append(card);
  const media = card.querySelector('.media');
  const esLectura = ['leer'].includes(c.tipo);
  for (const m of mats) if (!(esLectura && m.tipo === 'texto')) media.append(await bloqueMaterial(m));
  if (c.nota) media.append(h(`<p class="nota-video">${esc(c.nota)}</p>`));

  let ejR = ej;
  if (c.n && Array.isArray(c.items) && perfil?.rol !== 'docente') {      // ejercicio-banco: solo las preguntas sorteadas
    const [ints, evs] = await Promise.all([api.misIntentos(), api.misEventos()]);
    const { m } = await cargarModelo(ints, evs, !!perfil?.orales_zoom);
    const e = m.porId.get(id);
    const sel = (e && (seleccionActiva(m, e) || sortearPreguntas(m, e))) || [];
    const items = sel.map(r => itemDeRef(m, r)?.it).filter(Boolean);
    if (items.length) ejR = { ...ej, contenido: { ...c, items } };
  } else if (c.n && perfil?.rol === 'docente') card.querySelector('.instr').insertAdjacentHTML('afterend', `<p class="sub">Banco de ${c.items.length} preguntas${c.grupo ? ` (grupo ${esc(c.grupo)})` : ''}; al alumno se le muestran ${c.n}.</p>`);
  const r = await renderizar(ejR);
  setTimeout(() => resolverImgs(card), 0);
  card.querySelector('.cuerpo').append(r.el);
  if (!r.propio && card.querySelector('.cuerpo input[type=text], .cuerpo textarea')) card.querySelector('.cuerpo').after(tecladoRuso(card));
  const acc = card.querySelector(':scope > .acciones'), res = card.querySelector(':scope > .res');
  const bEnviar = h(`<button class="btn" type="button">${r.abierta ? 'Enviar' : 'Comprobar'}</button>`);
  acc.append(bEnviar);
  if (r.propio) { bEnviar.hidden = true; r.alTerminar = () => bEnviar.onclick(); }   // la actividad tiene sus propios botones
  bEnviar.onclick = async () => {
    bEnviar.disabled = true; res.innerHTML = '';
    try {
      const out = await r.corregir();
      if (out.abierta) {
        if (perfil?.orales_zoom && ORALES.has(ej.tipo_ejercicio)) api.registrar('zoom', [id]).catch(() => {});
        const usarIA = !!out.respuesta?.texto && !ORALES.has(ej.tipo_ejercicio) && await iaActiva();
        const guardado = await api.guardarIntento({ ejercicio_id: id, respuesta: out.respuesta, audio_path: out.audio || null, correcto: null, puntaje: null,
          estado: out.respuesta?.texto && !ORALES.has(ej.tipo_ejercicio) ? 'pendiente_ia' : out.audio || out.respuesta?.texto ? 'pendiente_docente' : 'corregido' });
        if (usarIA) {
          const espera = h(`<div class="resultado pend">Enviado. Revisando tu texto… ⏳</div>`); res.append(espera);
          try {
            const r = await api.corregirIA(guardado.id);
            espera.replaceWith(r?.feedback ? h(`<div class="regla ia"><b>Comentarios${r.puntaje != null ? ` · ${r.puntaje} %` : ''}</b><div style="white-space:pre-wrap">${esc(r.feedback)}</div></div>`) : h(`<div class="resultado pend">${MSG_IA_PENDIENTE}</div>`));
            if (r?.feedback) registrarProduccion(out.respuesta.texto, r.errores);
          } catch (e) { espera.textContent = MSG_IA_PENDIENTE; }
        } else res.append(h(`<div class="resultado pend">${out.respuesta?.texto && !ORALES.has(ej.tipo_ejercicio) ? MSG_IA_PENDIENTE : out.audio || out.respuesta?.texto ? 'Enviado. Tu profesora escuchará la grabación.' : 'Práctica registrada.'}</div>`));
      } else {
        const puntaje = Math.round(100 * out.bien / out.total);
        await api.guardarIntento({ ejercicio_id: id, respuesta: { valores: out.respuesta, detalle: out.detalle }, correcto: puntaje === 100, puntaje, estado: 'corregido' });
        if (out.sinNota) res.append(h(`<div class="resultado ok">${out.aciertos ? `Adivinaste ${out.aciertos} de ${out.total} ${out.total === 1 ? 'palabra' : 'palabras'}: ${out.aciertos === 1 ? 'entra' : 'entran'} a tu repaso. ` : ''}¡Sigue así!</div>`));
        else res.append(h(`<div class="resultado ${puntaje === 100 ? 'ok' : 'mal'}">${puntaje === 100 ? '¡Perfecto! ' : ''}${out.bien} de ${out.total} correctas (${puntaje} %)${out.flexible && puntaje < 100 ? ' · en este ejercicio se aceptan variantes razonables' : ''}</div>`));
        if (puntaje < 100) {
          const reglas = await api.gramatica(ids(ej.gramatica_objetivo));
          for (const g of reglas) res.append(h(`<div class="regla"><b>Repasa: ${esc(g.nombre)}</b>${esc(g.descripcion || '')}${g.ejemplo ? `<div class="ej">${esc(g.ejemplo)}</div>` : ''}</div>`));
        }
      }
      resolverImgs(card);
      acc.innerHTML = '';
      const bOtra = h(`<button class="btn sec" type="button">Intentar de nuevo</button>`); bOtra.onclick = () => vEjercicio(id); acc.append(bOtra);
      acc.append(h(`<a class="btn" data-flujo href="#/">Siguiente tarea →</a>`));
    } catch (err) { res.append(h(`<p class="error">${esc(err.message || 'No se pudo guardar. Revisa tu conexión.')}</p>`)); bEnviar.disabled = false; }
  };
}

// Repaso escrito generado con IA: preguntas o una tarea breve con palabras obligatorias; lo corrige la IA
function repasoEscrito(card, t, ids, m, vocab) {
  card.append(h(`<div><p class="instr">Repaso escrito</p><div class="cat-ej">escritura</div>${t.enunciado ? `<p class="enunciado">${esc(t.enunciado)}</p>` : ''}</div>`));
  const cuerpo = h(`<div></div>`); card.append(cuerpo);
  const resp = (t.items || []).map(it => {
    const b = h(`<div class="item-escrito">${it.pregunta ? `<div class="texto-ru">${esc(it.pregunta)}</div>` : ''}<p class="sub">Palabras obligatorias: ${(it.palabras || []).map(w => `<b class="ru">${esc(w)}</b>`).join(', ')}</p>${(it.reglas || []).length ? `<p class="sub">Regla a practicar: <b>${it.reglas.map(esc).join('</b>, <b>')}</b></p>` : ''}<textarea rows="3" placeholder="Escribe en ruso"></textarea></div>`);
    cuerpo.append(b); return b.querySelector('textarea');
  });
  cuerpo.after(tecladoRuso(card));
  const res = h(`<div class="res"></div>`), acc = h(`<div class="acciones"><button class="btn" type="button">Enviar</button></div>`);
  card.append(res, acc);
  acc.querySelector('button').onclick = async ev => {
    if (resp.some(r => !r.value.trim())) { res.innerHTML = '<p class="error">Responde todas las partes antes de enviar.</p>'; return; }
    ev.target.disabled = true; res.innerHTML = '';
    const texto = (t.items || []).map((it, i) => `${it.pregunta ? it.pregunta + '\n' : ''}${resp[i].value.trim()}`).join('\n\n');
    const objetivos = ids.map(id => ({ id, nombre: /^V/.test(id) ? (vocab[id]?.lema || id) : (m.regla[id]?.nombre || id) }));
    try {
      const g = await api.guardarIntento({ ejercicio_id: EJ_REPASO, respuesta: { texto, tarea: t, objetivos }, audio_path: null, correcto: null, puntaje: null, estado: 'pendiente_ia' });
      const espera = h(`<div class="resultado pend">Enviado. Revisando tu texto… ⏳</div>`); res.append(espera);
      try {
        const r = await api.corregirIA(g.id);
        espera.replaceWith(r?.feedback ? h(`<div class="regla ia"><b>Comentarios${r.puntaje != null ? ` · ${r.puntaje} %` : ''}</b><div style="white-space:pre-wrap">${esc(r.feedback)}</div></div>`) : h(`<div class="resultado pend">${MSG_IA_PENDIENTE}</div>`));
        await registrarProduccion(resp.map(x => x.value).join(' '), r?.errores, new Set(ids));
      } catch (e) { espera.textContent = MSG_IA_PENDIENTE; }
      acc.innerHTML = ''; acc.append(h(`<a class="btn" data-flujo href="#/">Siguiente tarea →</a>`));
    } catch (e) { res.append(h(`<p class="error">${esc(e.message || 'No se pudo guardar.')}</p>`)); ev.target.disabled = false; }
  };
}
// Palabras del curso que el alumno escribió en un texto corregido por IA: cuentan como producción para el repaso espaciado
// (correctas si no aparecen dentro de un error; las palabras objetivo del repaso escrito las evalúa la IA aparte)
async function registrarProduccion(texto, errores, excluir = new Set()) {
  try {
    const formas = formasCache || await fetch('formas.json').then(r => r.json());
    const voc = vocabCache ? new Set(vocabCache.map(v => v.id)) : null;
    const mal = new Set(palabrasEnTexto(formas, (errores || []).map(e => e.original).join(' ')));
    const ids = palabrasEnTexto(formas, texto).filter(id => !excluir.has(id) && (!voc || voc.has(id)));
    if (ids.length) await api.registrar('produccion', ids.map(id => `${id}|${mal.has(id) ? 0 : 1}|p`));
  } catch (e) { /* sin conexión: no se registra */ }
}

// ================================================================ prueba de ubicación (solo planes pagados)
const PLANES_PAGADOS = ['plataforma', 'pro', 'nivel', 'gratuito', 'completo', 'zoom_grupal', 'zoom_individual'];   // reciben la pregunta de ubicación
function necesitaUbicacion(m, intentos, eventos) {
  if (!perfil || perfil.rol === 'docente' || !PLANES_PAGADOS.includes(perfil.plan) || enPrueba()) return false;
  if (eventos.some(v => v.tipo === 'ubicacion')) return false;
  // si ya avanzó más allá de la lección de prueba, no se pregunta. Al empezar (≤ 3 ejercicios) la pregunta es obligatoria;
  // si ya venía avanzando en las primeras lecciones (p. ej. desde la prueba gratis), solo se ofrece en una tarjeta que puede cerrar
  if (intentos.some(i => { const e = m.porId.get(i.ejercicio_id); return e && e.escenario && !LECCIONES_INICIO.includes(e.escenario); })) return false;
  return new Set(intentos.map(i => i.ejercicio_id)).size <= 3 ? 'preguntar' : 'ofrecer';
}
function preguntaUbicacion() {
  $app.innerHTML = '';
  const c = h(`<div class="tarjeta"><h1>¿Ya tienes algún nivel de ruso?</h1>
    <p>Si ya estudiaste ruso antes, haz una prueba corta de ubicación (unos 15 minutos) para no repetir lo que ya sabes. Si empiezas desde cero, sigue directo con las lecciones.</p>
    <div class="acciones"><a class="btn" href="#/ubicacion">Sí, ya sé algo: hacer la prueba</a><button class="btn sec" type="button">No, empiezo desde cero</button></div><p class="error"></p></div>`);
  c.querySelector('button').onclick = async ev => {
    ev.target.disabled = true;
    try { await api.registrar('ubicacion', ['no']); vInicio(); } catch (e) { c.querySelector('.error').textContent = 'No se pudo guardar. Intenta de nuevo.'; ev.target.disabled = false; }
  };
  $app.append(c);
}
async function vUbicacion() {
  nav('inicio');
  $app.innerHTML = `<p class="cargando">Preparando la prueba…</p>`;
  const [intentos, eventos] = await Promise.all([api.misIntentos(), api.misEventos()]);
  if (eventos.some(v => v.tipo === 'ubicacion')) { location.hash = '#/'; return; }
  const { m } = await cargarModelo(intentos, eventos, !!perfil?.orales_zoom);
  const pan = panorama(m);
  // Banco propio de la prueba (ubicacion.json): grupos de lecciones en orden del curso, preguntas de opción múltiple
  // con instrucción clara. Solo cuentan los grupos cuyas lecciones tiene el plan del alumno.
  const banco = await fetch('ubicacion.json').then(r => r.json());
  const orden = new Map(m.esc.map((s0, i) => [s0.id, i]));
  const grupos = banco.grupos.map(g => ({ ...g, lecciones: g.lecciones.filter(id => orden.has(id)), preguntas: barajar(g.preguntas) }))
    .filter(g => g.lecciones.length && g.preguntas.length).sort((x, y) => orden.get(x.lecciones[0]) - orden.get(y.lecciones[0]));
  const lecciones = m.esc.map(s0 => ({ s: s0 }));
  const t0 = Date.now(), MAX_MIN = 5, SEG = 20;
  // Búsqueda rápida: se avanza saltando grupos (1, 2, 4, 8…) mientras acierta; al primer grupo fallado se busca
  // entre el último aprobado y ese (búsqueda binaria). Cada grupo: 2 preguntas; si acierta 1 de 2, decide una 3.ª.
  let lo = 0, hi = grupos.length, paso = 1, gi = 0, galope = true, enGrupo = [];
  let entrada = null; const res = [], log = [];
  const intro = h(`<div class="tarjeta"><h1>Prueba de ubicación</h1>
    <p>Tiene dos partes:</p><ol><li><b>Preguntas</b> (unos ${MAX_MIN} minutos, ${SEG} segundos por pregunta): saltan de lo más fácil a lo más difícil y se detienen solas cuando encuentran tu nivel.</li><li><b>Texto «Sobre mí»</b> (10 minutos): escribe en ruso todo lo que puedas sobre ti.</li></ol>
    <div class="aviso-prueba"><p><b>Importante: hazla sin ayuda.</b> No uses diccionarios, traductores, inteligencia artificial ni otras herramientas externas. La prueba decide desde qué lección empiezas: si te ayudas, te ubicará en lecciones demasiado difíciles, te saltarás cosas que aún no sabes y te costará más aprender después.</p>
    <p>Por el mismo motivo, <b>si no sabes una respuesta, pulsa «No lo sé»</b>. No adivines: un «no sé» honesto vale más que un acierto por suerte.</p></div>
    <div class="acciones"><button class="btn" type="button">Empezar</button><a class="btn sec" href="#/">Ahora no</a></div></div>`);
  intro.querySelector('button').onclick = () => siguiente();
  $app.innerHTML = ''; $app.append(intro);
  let reloj = null;
  function cerrarGrupo(aprobado) {
    if (galope) {
      if (aprobado) { lo = gi + 1; paso *= 2; gi = Math.min(grupos.length - 1, gi + paso); if (lo >= grupos.length) hi = lo; else if (gi < lo) gi = lo; }
      else { hi = gi; galope = false; }
    } else if (aprobado) lo = gi + 1; else hi = gi;
    if (!galope && lo < hi) gi = Math.floor((lo + hi) / 2);
    if (galope && lo >= grupos.length) hi = lo;
    enGrupo = [];
  }
  function siguiente() {
    clearInterval(reloj);
    if (lo >= hi || Date.now() - t0 > MAX_MIN * 60e3) {
      const g = grupos[lo];
      entrada = g ? orden.get(g.lecciones[0]) : lecciones.length;
      return parte2();
    }
    const G = grupos[gi], k = enGrupo.length;
    const it = G.preguntas[k % G.preguntas.length];
    const item = { tipo: 'choice', q: it.q, options: it.o, answer: it.o[0] };
    const r = rItems({ items: [item] });
    const card = h(`<div class="tarjeta"><div class="etq">Parte 1 de 2 · pregunta ${res.length + 1} · <span data-s>${SEG}</span> s</div><p class="instr">${esc(it.i)}</p><div class="cuerpo"></div><div class="acciones"><button class="btn" type="button">Siguiente</button><button class="btn sec" type="button">No lo sé</button></div></div>`);
    if (!it.q) r.el.querySelector('.q')?.remove();
    card.querySelector('.cuerpo').append(r.el);
    const responder = (ok, resp) => {
      clearInterval(reloj);
      enGrupo.push(ok); res.push(ok); log.push({ leccion: G.lecciones.join('–'), q: [it.i, it.q].filter(Boolean).join(' '), respuesta: resp, ok });
      const bien = enGrupo.filter(Boolean).length, mal = enGrupo.length - bien;
      if (bien >= 2) cerrarGrupo(true); else if (mal >= 2) cerrarGrupo(false);
      siguiente();
    };
    const [bS, bN] = card.querySelectorAll('.acciones .btn');
    bS.onclick = () => { const v = card.querySelector('input:checked')?.value; if (v == null) return responder(false, 'no sé'); responder(v === item.answer, v); };
    bN.onclick = () => responder(false, 'no sé');
    const fin = Date.now() + SEG * 1000;
    reloj = setInterval(() => { const q = Math.max(0, Math.ceil((fin - Date.now()) / 1000)); const e = card.querySelector('[data-s]'); if (e) e.textContent = q; if (!q) responder(false, 'sin tiempo'); }, 500);
    $app.innerHTML = ''; $app.append(card);
  }
  function parte2() {
    const saltadas = lecciones.slice(0, entrada).map(L => L.s.id);
    const eEntrada = lecciones[entrada]?.s;
    // reglas a evaluar en el texto: las de la lección de entrada y las 4 siguientes que el alumno aún no tiene.
    // Las que use bien en su texto saltan sus ejercicios más adelante (siguen en el repaso para confirmarlas).
    const ya = new Set(lecciones.slice(0, entrada).flatMap(L => pan.porLeccion.get(L.s.id).orden.flatMap(e => e.reqReglas)));
    const objetivos = [...new Set(lecciones.slice(entrada, entrada + 5).flatMap(L => pan.porLeccion.get(L.s.id).orden.flatMap(e => e.reqG)))]
      .filter(g => /^G/.test(g) && m.regla[g] && !ya.has(g)).slice(0, 16).map(g => ({ id: g, nombre: m.regla[g].nombre }));
    const prueba = { aciertos: res.filter(Boolean).length, total: res.length, entrada: eEntrada ? `${eEntrada.id} · ${eEntrada.nombre}` : 'todas las lecciones dominadas', salidas: 0, log };
    const terminar = async (texto, card) => {
      card.querySelectorAll('button').forEach(b => b.disabled = true);
      card.querySelector('.res').innerHTML = '<p class="sub">Guardando… ⏳</p>';
      try {
        // primero el punto de entrada (parte 1); el texto solo afina qué ejercicios posteriores se saltan
        await api.registrar('ubicacion', [saltadas.join(',') || '-']);
        if (saltadas.length && eEntrada) await api.registrar('escenario', [eEntrada.id]);   // sigue directo con la lección de entrada
        let dominadas = [];
        if (texto) {
          prueba.reglasR = [];
          const g = await api.guardarIntento({ ejercicio_id: EJ_UBICACION, respuesta: { texto, tarea: { enunciado: 'Escribe en ruso todo lo que puedas sobre ti (prueba de ubicación).', items: [{ pregunta: 'Расскажи о себе', palabras: [] }] }, objetivos, prueba }, audio_path: null, correcto: null, puntaje: null, estado: 'pendiente_ia' });
          try {
            const r = await api.corregirIA(g.id);
            dominadas = (r?.objetivos || []).filter(o => o.ok && objetivos.some(x => x.id === o.id)).map(o => o.id);
            if (dominadas.length) await api.registrar('ubicacion', ['R:' + dominadas.join(',')]);
          } catch { /* sin IA: vale solo la parte 1 */ }
        }
        $app.innerHTML = `<div class="tarjeta"><h1>¡Listo! 🎉</h1>${saltadas.length
          ? `<p>${eEntrada ? `Empiezas en <b>${esc(prueba.entrada)}</b>` : 'Ya dominas todas las lecciones disponibles: seguirás con tu repaso diario'}. Damos por sabidas las palabras y reglas de ${saltadas.length === 1 ? 'la lección anterior' : `las ${saltadas.length} lecciones anteriores`}: si más adelante te equivocas en alguna, te la volvemos a presentar y la repasamos contigo.</p>`
          : `<p>Empiezas desde la primera lección: así construyes una base sólida.</p>`}
          ${dominadas.length ? `<p>Además, en tu texto ya usas bien ${dominadas.length === 1 ? 'una regla' : `${dominadas.length} reglas`} de lecciones más avanzadas: te saltarás los ejercicios que solo practican eso.</p>` : ''}
          <div class="acciones"><a class="btn" href="#/">Ir a mis lecciones →</a></div></div>`;
      } catch (e) { card.querySelector('.res').innerHTML = '<p class="error">No se pudo guardar. Intenta de nuevo.</p>'; card.querySelectorAll('button').forEach(b => b.disabled = false); }
    };
    const card = h(`<div class="tarjeta"><div class="etq">Parte 2 de 2 · 10 minutos</div><h2 style="margin-top:4px">Расскажи о себе</h2>
      <p>Escribe en ruso todo lo que puedas sobre ti: quién eres, de dónde eres, tu familia, tu trabajo o estudios, tus gustos, tu día… No importa si cometes errores.</p>
      <p class="sub"><b>Sin diccionario, traductor ni IA:</b> escribe solo con lo que sabes. Si no sabes decir algo, sáltalo. Tiempo restante: <b data-t>10:00</b>. No se puede pegar texto.</p>
      <textarea rows="10" placeholder="Пиши здесь…"></textarea><div class="res"></div>
      <div class="acciones"><button class="btn" type="button">Terminar</button><button class="btn sec" type="button">Todavía no sé escribir en ruso</button></div></div>`);
    const ta = card.querySelector('textarea');
    ta.addEventListener('paste', ev => ev.preventDefault()); ta.addEventListener('drop', ev => ev.preventDefault());
    card.querySelector('textarea').after(tecladoRuso(card));
    const vis = () => { if (document.hidden) prueba.salidas++; }; document.addEventListener('visibilitychange', vis);
    const fin = Date.now() + 10 * 60e3;
    const reloj = setInterval(() => {
      const r = Math.max(0, fin - Date.now()); card.querySelector('[data-t]').textContent = `${Math.floor(r / 60e3)}:${String(Math.floor(r / 1000) % 60).padStart(2, '0')}`;
      if (!r) { clearInterval(reloj); document.removeEventListener('visibilitychange', vis); terminar(ta.value.trim(), card); }
    }, 1000);
    const [bT, bNo] = card.querySelectorAll('.acciones .btn');
    bT.onclick = () => { clearInterval(reloj); document.removeEventListener('visibilitychange', vis); terminar(ta.value.trim(), card); };
    bNo.onclick = () => { clearInterval(reloj); document.removeEventListener('visibilitychange', vis); terminar('', card); };
    $app.innerHTML = ''; $app.append(card);
  }
}

// Ficha docente: resumen y copia de la prueba de ubicación
function fichaUbicacion(m, ints, evs) {
  const ub = evs.filter(v => v.tipo === 'ubicacion');
  if (!ub.length) return [];
  const pr = ints.filter(i => i.ejercicio_id === EJ_UBICACION).sort((a, b) => new Date(b.creado_en) - new Date(a.creado_en))[0];
  const lec = ub.filter(v => !/^[RSNA]:/.test(v.ref)).pop();
  const c = h(`<details class="tarjeta"><summary><b>Prueba de ubicación</b> · ${lec?.ref === 'no' ? 'dijo que empieza desde cero' : lec?.ref === '-' ? 'empieza desde la primera lección' : `saltó ${m.saltados.size} ${m.saltados.size === 1 ? 'lección' : 'lecciones'}`}${m.nuevasAnteriores?.length > 3 ? ' · ⚠️ posible mala ubicación' : ''}</summary></details>`);
  const p = pr?.respuesta?.prueba;
  const nombreR = g => m.regla[g]?.nombre || g;
  const lineas = [];
  if (lec && !['no', '-'].includes(lec.ref)) lineas.push(`<p>Lecciones saltadas: ${esc(lec.ref.replaceAll(',', ', '))}</p>`);
  if (p) lineas.push(`<p>Entrada: <b>${esc(p.entrada)}</b> · aciertos ${p.aciertos}/${p.total} · salió de la página ${p.salidas || 0} ${p.salidas === 1 ? 'vez' : 'veces'} durante el texto · ${new Date(pr.creado_en).toLocaleString()}</p>`);
  if (m.reglasR?.size) lineas.push(`<p>Reglas posteriores que usó bien en su texto (sus ejercicios se saltan): ${esc([...m.reglasR].map(nombreR).join('; '))}</p>`);
  if (m.falsosDominados?.length) lineas.push(`<p>Saltado por la prueba y después usado con error (se volvió a presentar y entró al repaso): ${esc(m.falsosDominados.map(id => /^V/.test(id) ? (vocabCache?.find(v => v.id === id)?.lema || id) : nombreR(id)).join('; '))}</p>`);
  if (m.nuevasAnteriores?.length) lineas.push(`<p>Reglas anteriores que le resultaron nuevas (${m.nuevasAnteriores.length}): ${esc(m.nuevasAnteriores.map(nombreR).join('; '))}</p>`);
  if (m.respuestaCambio) lineas.push(`<p>Sugerencia de cambio de nivel: <b>${m.respuestaCambio === 'cambio' ? 'pidió cambiarse' : 'prefirió seguir'}</b></p>`);
  if (p?.log?.length) lineas.push(`<table style="margin-top:8px"><tr><th>Lección</th><th>Pregunta</th><th>Respuesta</th><th></th></tr>${p.log.map(x => `<tr><td>${esc(x.leccion)}</td><td>${esc(x.q)}</td><td>${esc(x.respuesta || '')}</td><td>${x.ok ? '✓' : '✗'}</td></tr>`).join('')}</table>`);
  if (pr?.respuesta?.texto) lineas.push(`<p style="margin-top:10px"><b>Texto «Расскажи о себе»</b></p><div class="texto-ru" style="white-space:pre-wrap">${esc(pr.respuesta.texto)}</div>${pr.feedback ? `<p class="sub" style="white-space:pre-wrap">Revisión de IA (el alumno no la ve):\n${esc(pr.feedback)}</p>` : '<p class="sub">Sin revisión de IA.</p>'}`);
  c.append(h(`<div>${lineas.join('') || '<p class="sub">Sin detalles.</p>'}</div>`));
  return [c];
}
// Posible mala ubicación: más de 3 reglas anteriores resultaron nuevas. Se avisa a la docente (Reportes) una sola vez.
async function avisarMalaUbicacion(m) {
  const lista = m.nuevasAnteriores.map(g => m.regla[g]?.nombre || g).slice(0, 10).join('; ');
  const porPrueba = m.saltados.size > 0;
  const texto = porPrueba
    ? `⚠️ Posible mala ubicación: ${m.nuevasAnteriores.length} reglas anteriores a su punto de entrada le resultaron nuevas (${lista}). Fue ubicado por la prueba de ubicación: revisa la prueba en su ficha (Panel docente → Alumnos).`
    : `⚠️ Posible nivel equivocado: ${m.nuevasAnteriores.length} reglas de niveles anteriores le resultaron nuevas (${lista}). Eligió el nivel ${perfil?.plan_nivel || ''} por su cuenta; se le sugirió pasar gratis al nivel anterior.`;
  try {
    await api.reportar({ texto, pagina: '#/ubicacion', navegador: 'aviso automático' });
    await api.registrar('ubicacion', ['A:1']);
    m.alertaUbicacion = false;
  } catch { /* se reintenta en el próximo ingreso */ }
}
function tarjetaCambioNivel(m) {
  const N = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], i = N.indexOf(perfil?.plan_nivel);
  const anterior = i > 0 ? N[i - 1] : null;
  if (!anterior) return null;
  const c = h(`<div class="tarjeta"><div class="etq">Sugerencia</div><p>Varias reglas del nivel ${esc(anterior)} te resultaron nuevas. Para que avances con una base sólida, puedes <b>pasarte gratis al nivel ${esc(anterior)}</b> (en lugar de ${esc(perfil.plan_nivel)}). Tu profesora hará el cambio.</p>
    <div class="acciones"><button class="btn" type="button">Sí, quiero pasarme al ${esc(anterior)}</button><button class="btn sec" type="button">Prefiero seguir en ${esc(perfil.plan_nivel)}</button></div></div>`);
  const [bS, bN] = c.querySelectorAll('button');
  bS.onclick = async () => { bS.disabled = bN.disabled = true; await api.reportar({ texto: `🔁 Pide pasar gratis del nivel ${perfil.plan_nivel} al ${anterior} (cámbialo en su ficha: Plan → Un nivel → ${anterior}).`, pagina: '#/', navegador: 'aviso automático' }); await api.registrar('ubicacion', ['A:cambio']); c.innerHTML = `<p>Listo: avisamos a tu profesora. Verás el nivel ${esc(anterior)} cuando haga el cambio.</p>`; };
  bN.onclick = async () => { bS.disabled = bN.disabled = true; await api.registrar('ubicacion', ['A:sigue']); c.remove(); };
  return c;
}

// Cabecera de un ejercicio: título corto, categoría y enunciado (o solo la instrucción si aún no tiene título)
function cabeceraEj(ej, hab) {
  if (!ej.titulo) return `<p class="instr">${esc(ej.instrucciones || '')}</p>`;
  const cat = ej.categoria || hab || '';
  return `<p class="instr">${esc(ej.titulo)}</p>${cat ? `<div class="cat-ej">${esc(cat)}</div>` : ''}${ej.instrucciones ? `<p class="enunciado">${esc(ej.instrucciones)}</p>` : ''}`;
}
const consignaEj = ej => [ej.titulo, ej.instrucciones].filter(Boolean).join('. ');

// Explicación de una regla: texto con párrafos; las líneas que empiezan con «|» forman tablas.
function explicacionHtml(txt) {
  const out = []; let tabla = [];
  const cerrar = () => { if (tabla.length) { out.push(`<table class="tabla-regla">${tabla.map((f, i) => `<tr>${f.map(c => i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`); tabla = []; } };
  for (const l of String(txt).split('\n')) {
    const t = l.trim();
    const mImg = t.match(/^\[img:(M\d+)\]$/);
    if (mImg) { cerrar(); out.push(`<img class="img-regla" data-mat="${mImg[1]}" alt="">`); continue; }
    if (t.startsWith('|')) { const celdas = t.replace(/^\||\|$/g, '').split('|').map(c => c.trim()); if (!celdas.every(c => /^-+$/.test(c))) tabla.push(celdas); continue; }
    cerrar(); if (t) out.push(`<p style="margin:8px 0">${esc(t)}</p>`);
  }
  cerrar(); return out.join('');
}

// ---------------------------------------------------------------- tarjetas de repaso de palabras
function tarjetasRepaso(items, vocab) {
  const el = h(`<div><p class="instr">Escribe en ruso las palabras que sabes usar y elige el significado de las que reconoces.</p>${items.some(i => i.modo === 'p') ? '<p class="sub">Si no recuerdas una palabra, pulsa «No lo sé»: no adivines ni la busques.</p>' : ''}</div>`);
  const todas = Object.values(vocab);
  const filas = items.map(({ id, modo }) => {
    const v = vocab[id] || { lema: id, traduccion: '' };
    let f;
    if (modo === 'p') {
      f = h(`<div class="item"><div class="q">${esc(v.traduccion)}</div><div style="display:flex;gap:8px;align-items:center"><input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="en ruso" style="flex:1"><button type="button" class="btn sec nose">No lo sé</button></div></div>`);
      const inp = f.querySelector('input'), bn = f.querySelector('.nose');
      bn.onclick = () => { const on = !f.classList.contains('nose-on'); f.classList.toggle('nose-on', on); inp.value = ''; inp.disabled = on; bn.textContent = on ? '✓ No lo sé' : 'No lo sé'; };
    }
    else {
      const otras = barajar(todas.filter(x => x.id !== id && x.traduccion && x.traduccion !== v.traduccion)).slice(0, 3).map(x => x.traduccion);
      f = h(`<div class="item"><div class="q" style="font-size:18px;font-weight:600">${esc(v.lema)}</div><select><option value="">— significado —</option>${barajar([v.traduccion, ...otras]).map(o => `<option>${esc(o)}</option>`).join('')}</select></div>`);
    }
    if (modo !== 'p') f.querySelector('.q').append(' ', botonVoz(v.lema));
    el.append(f); return { f, id, modo, v };
  });
  if (items.some(i => i.modo === 'p')) el.append(tecladoRuso(el));
  const acc = h(`<div class="acciones"><button class="btn" type="button">Comprobar</button></div>`); el.append(acc);
  acc.querySelector('button').onclick = async e => {
    e.target.disabled = true;
    const refs = filas.map(({ f, id, modo, v }) => {
      const r = modo === 'p' ? f.querySelector('input').value : f.querySelector('select').value;
      const ok = modo === 'p' ? igual(r, [v.lema]) : r === v.traduccion;
      f.classList.add(ok ? 'ok' : 'mal');
      f.append(h(`<div class="marca-res ${ok ? 'ok' : 'mal'}">${ok ? '✓' : `✗ <span class="correcta">${esc(modo === 'p' ? v.lema : v.traduccion)}</span>`}</div>`));
      if (modo === 'p') f.querySelector('.marca-res').append(' ', botonVoz(v.lema));
      return `${id}|${ok ? 1 : 0}|${modo}`;
    });
    try { await api.registrar('tarjeta', refs); } catch (err) { acc.append(h(`<p class="error">${esc(err.message)}</p>`)); e.target.disabled = false; return; }
    el.querySelectorAll('.nose').forEach(b => b.disabled = true);
    acc.innerHTML = ''; const b = h(`<button class="btn" type="button">Continuar →</button>`); b.onclick = () => vInicio(); acc.append(b);
  };
  return el;
}

// ---------------------------------------------------------------- teclado ruso en pantalla
const FILAS_TECLADO = ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбюё'];
function tecladoRuso(card) {
  let campo = null, mayus = false;
  card.addEventListener('focusin', e => { if (e.target.matches('input[type=text], textarea')) campo = e.target; });
  const caja = h(`<div class="teclado-caja">
    <div style="margin-top:12px"><button class="btn sec" type="button" data-t>⌨ Teclado ruso</button></div>
    <div class="teclado" hidden></div>
    <details class="ayuda-teclado"><summary>¿Cómo escribir en ruso con mi propio teclado?</summary>
      <p><b>Windows:</b> Configuración → Hora e idioma → Idioma y región → Agregar un idioma → Ruso. Cambia de idioma con <b>Windows + Espacio</b>.</p>
      <p><b>Mac:</b> Ajustes del Sistema → Teclado → Fuentes de entrada → Editar → + → Ruso (o «Ruso – PC»). Cambia con <b>Control + Espacio</b> o con 🌐.</p>
      <p><b>Android (Gboard):</b> Ajustes → Idiomas → Añadir teclado → Ruso. Cambia manteniendo pulsada la barra espaciadora o con 🌐.</p>
      <p><b>iPhone/iPad:</b> Ajustes → General → Teclado → Teclados → Añadir teclado → Ruso. Cambia con 🌐.</p>
      <p>Mientras tanto puedes usar botón «⌨ Teclado ruso» de esta página.</p>
    </details></div>`);
  const tec = caja.querySelector('.teclado');
  const pintar = () => {
    tec.innerHTML = '';
    for (const fila of FILAS_TECLADO) {
      const f = h(`<div class="fila-tec"></div>`);
      for (const l of fila) { const k = mayus ? l.toUpperCase() : l; f.append(h(`<button type="button" data-k="${k}">${k}</button>`)); }
      tec.append(f);
    }
    tec.append(h(`<div class="fila-tec"><button type="button" data-a="mayus" class="${mayus ? 'on' : ''}">⇧</button><button type="button" data-k=" " class="espacio">espacio</button><button type="button" data-k="-">-</button><button type="button" data-a="borrar">⌫</button></div>`));
  };
  pintar();
  caja.querySelector('[data-t]').onclick = () => { tec.hidden = !tec.hidden; };
  tec.addEventListener('mousedown', e => e.preventDefault());        // no quitar foco al campo
  tec.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.a === 'mayus') { mayus = !mayus; pintar(); return; }
    if (!campo || !campo.isConnected) campo = card.querySelector('.cuerpo input[type=text], .cuerpo textarea');
    if (!campo) return;
    const i = campo.selectionStart ?? campo.value.length, j = campo.selectionEnd ?? i;
    if (b.dataset.a === 'borrar') {
      const a = i === j ? Math.max(0, i - 1) : i;
      campo.value = campo.value.slice(0, a) + campo.value.slice(j); campo.setSelectionRange(a, a);
    } else {
      campo.value = campo.value.slice(0, i) + b.dataset.k + campo.value.slice(j); campo.setSelectionRange(i + 1, i + 1);
      if (mayus) { mayus = false; pintar(); }
    }
    campo.dispatchEvent(new Event('input', { bubbles: true })); campo.focus();
  });
  return caja;
}

// ---------------------------------------------------------------- panel docente
const TABLAS = { habilidades: 'habilidades', gramatica: 'gramatica', pronunciacion: 'pronunciacion', vocabulario: 'vocabulario', temas: 'temas',
  escenarios: 'escenarios', tipos_ejercicio: 'tipos_ejercicio', materiales: 'materiales', ejercicios: 'ejercicios' };
const COLS = {
  habilidades: ['id','nombre','descripcion','como_se_mide','estandar_a1','estandar_a2','estandar_b1','estandar_b2','estandar_c1'],
  gramatica: ['id','nombre','nivel','descripcion','prerrequisitos','ejemplo','explicacion'], pronunciacion: ['id','nombre','nivel','descripcion','prerrequisitos','ejemplo','explicacion'],
  vocabulario: ['id','lema','traduccion','categoria','nivel','escenarios','temas','uso'], temas: ['id','nombre'],
  escenarios: ['id','nombre','nivel','temas','orden','objetivo_comunicativo','gramatica_foco','pronunciacion_foco'],
  materiales: ['id','titulo','tipo','fuente','inicio','fin','nivel','escenarios','temas','gramatica_presente','transcripcion','licencia','origen','revisado','funcion'],
  tipos_ejercicio: ['id','nombre','descripcion','habilidades_principales','habilidades_secundarias','material','tipos_material_compatibles','generable_ia','equivalente_h5p','nivel_minimo'],
  ejercicios: ['id','tipo_ejercicio','material','escenario','gramatica_objetivo','vocabulario_objetivo','titulo','categoria','instrucciones','contenido','prerrequisitos','orden'],
};
const ORDEN_IMPORT = ['habilidades','gramatica','pronunciacion','temas','vocabulario','escenarios','tipos_ejercicio','materiales','ejercicios'];

async function vDocente(tab = 'alumnos') {
  if (perfil?.rol !== 'docente') return vInicio();
  nav('docente');
  $app.innerHTML = `<h1>Panel docente</h1>`;
  const pes = h(`<div class="pestanas"></div>`);
  [['alumnos', 'Alumnos'], ['revisar', 'Por revisar'], ['examenes', 'Exámenes'], ['reportes', 'Reportes'], ['ajustes', 'IA y ajustes'], ['contenido', 'Contenido y medios']].forEach(([k, t]) => {
    const b = h(`<button class="${k === tab ? 'activo' : ''}">${t}</button>`); b.onclick = () => location.hash = `#/docente/${k}`; pes.append(b);
  });
  $app.append(pes);
  const cuerpo = h(`<div></div>`); $app.append(cuerpo);
  reportesNuevos(tab === 'reportes').then(n => { const b = [...pes.children].find(x => x.textContent === 'Reportes'); if (b && n) b.textContent = `Reportes (${n} sin resolver)`; });
  if (tab !== 'ajustes') avisoEspacio(pes.parentNode.insertBefore(h(`<div></div>`), pes.nextSibling));
  if (tab === 'contenido') return tContenido(cuerpo);
  if (tab === 'revisar') return tRevisar(cuerpo);
  if (tab === 'examenes') return tExamenes(cuerpo);
  if (tab === 'reportes') return tReportes(cuerpo);
  if (tab === 'ajustes') return tAjustes(cuerpo);
  if (tab.startsWith('alumno-')) return tAlumno(cuerpo, tab.slice(7));
  return tAlumnos(cuerpo);
}

async function tAlumnos(el) {
  const [ps] = await Promise.all([api.alumnos()]);
  const al = ps.filter(p => p.rol === 'alumno');
  el.append(h(`<p class="sub">Los alumnos se registran solos desde la página pública (empiezan con la prueba gratis). También puedes crearlos en Supabase → Authentication → Users → Add user. Cambia su plan en su ficha.</p>`));
  if (!al.length) { el.append(h(`<div class="tarjeta">Aún no hay alumnos.</div>`)); return; }
  const lista = h(`<div class="lista"></div>`);
  el.append(lista);
  for (const p of al) {
    const f = h(`<a class="fila" href="#/docente/alumno-${p.id}"><div class="txt"><b>${esc(p.nombre || '(sin nombre)')}</b><small>calculando…</small></div></a>`);
    lista.append(f);
    Promise.all([api.intentosDe(p.id), api.eventosDe(p.id)]).then(async ([ints, evs]) => {
      const { m } = await cargarModelo(ints, evs, !!p.orales_zoom);
      const zoom = [...m.zoomPend].filter(id => !m.zoomOk.has(id)).length;
      f.querySelector('small').textContent = textoProyeccion(proyeccion(m), { alumno: false }) + (p.orales_zoom ? ` · ${zoom} ${zoom === 1 ? 'ejercicio oral' : 'ejercicios orales'} para Zoom` : '');
    }).catch(() => { f.querySelector('small').textContent = ''; });
  }
}

async function tAlumno(el, uid) {
  const [ps, ints, gram, evs] = await Promise.all([api.alumnos(), api.intentosDe(uid), api.gramaticaTodas(), api.eventosDe(uid)]);
  const p0 = ps.find(x => x.id === uid) || {};
  const { m, escenarios } = await cargarModelo(ints, evs, !!p0.orales_zoom);
  const est = estadoAlumno(m);
  const p = ps.find(x => x.id === uid) || {};
  el.append(h(`<div class="migas"><a href="#/docente/alumnos">← Alumnos</a></div>`));
  const nom = h(`<div class="campo"><label>Nombre visible</label><div style="display:flex;gap:8px"><input type="text" value="${esc(p.nombre || '')}"><button class="btn sec" type="button">Guardar</button></div></div>`);
  nom.querySelector('button').onclick = async () => { await api.renombrar(uid, nom.querySelector('input').value.trim()); nom.querySelector('button').textContent = 'Guardado ✓'; };
  el.append(nom);
  const zt = h(`<label style="display:flex;gap:8px;align-items:center;margin:4px 0 10px"><input type="checkbox" ${p.orales_zoom ? 'checked' : ''}> Parte oral por Zoom: los ejercicios orales no se le muestran y van a la lista de la clase</label>`);
  zt.querySelector('input').onchange = async e => { await api.actualizarPerfil(uid, { orales_zoom: e.target.checked }); location.reload(); };
  el.append(zt);
  const PL = [['prueba', 'Prueba gratis (solo primera lección)'], ['plataforma', 'Esencial'], ['pro', 'Pro (con examen y certificado)'], ['nivel', 'Un nivel (pago único, sin vencimiento)'], ['gratuito', 'Acceso gratuito (un nivel, sin pago ni vencimiento)'], ['completo', 'Acceso completo (igual que Esencial, sin vencimiento)'],
    ...[['zoom_grupal', 'Plataforma + Zoom grupal (anterior)'], ['zoom_individual', 'Plataforma + Zoom individual (anterior)']].filter(([k]) => p.plan === k)];
  const pf = h(`<div class="campo" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end"><div><label>Plan</label><select>${PL.map(([k, t]) => `<option value="${k}" ${p.plan === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div data-niv ${PLANES_UN_NIVEL.includes(p.plan) ? '' : 'hidden'}><label>Nivel</label><select>${['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(n => `<option ${p.plan_nivel === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div><label>Pagado hasta</label><input type="date" value="${esc(p.plan_hasta || '')}"></div><button class="btn sec" type="button">Guardar plan</button></div>`);
  const [selPlan, selNiv] = pf.querySelectorAll('select');
  selPlan.onchange = () => { pf.querySelector('[data-niv]').hidden = !PLANES_UN_NIVEL.includes(selPlan.value); };
  pf.querySelector('button').onclick = async () => {
    const cambios = { plan: selPlan.value, plan_hasta: pf.querySelector('input').value || null };
    if (PLANES_UN_NIVEL.includes(selPlan.value)) cambios.plan_nivel = selNiv.value;
    await api.actualizarPerfil(uid, cambios); pf.querySelector('button').textContent = 'Guardado ✓';
  };
  el.append(pf);
  const rz = h(`<div style="margin:0 0 12px"><button class="btn sec" type="button">Reiniciar progreso del alumno</button> <span class="sub"></span></div>`);
  const [bR, sR] = [rz.querySelector('button'), rz.querySelector('span')]; let paso = 0;
  bR.onclick = async () => {
    if (!paso) { paso = 1; bR.textContent = 'Sí, borrar todo su progreso'; bR.classList.add('rojo'); sR.textContent = 'Se borrarán sus intentos, grabaciones registradas, palabras y reglas presentadas y repasos. No se puede deshacer.'; return; }
    bR.disabled = true;
    try { await api.reiniciarAlumno(uid); sR.textContent = 'Progreso borrado ✓'; setTimeout(() => location.reload(), 800); }
    catch (err) { sR.textContent = err.message; bR.disabled = false; }
  };
  el.append(rz);
  el.append(h(`<p class="meta">${esc(textoProyeccion(proyeccion(m), { alumno: false }))}</p>`));
  el.append(...fichaUbicacion(m, ints, evs));
  const certs = [...new Set(evs.filter(e => e.tipo === 'certificado').map(e => e.ref))];
  if (certs.length) el.append(h(`<p class="meta">📜 Pidió certificado de nivel: <b>${esc(certs.join(', '))}</b></p>`));
  // ejercicios orales pendientes para la clase por Zoom
  const pendZoom = [...m.zoomPend].filter(id => !m.zoomOk.has(id)).map(id => m.porId.get(id)).filter(Boolean);
  if (p.orales_zoom || pendZoom.length) {
    const zc = h(`<div class="tarjeta"><b>Para la próxima clase por Zoom (${pendZoom.length})</b></div>`);
    if (!pendZoom.length) zc.append(h(`<p class="sub">No hay ejercicios orales pendientes.</p>`));
    else {
      const tz = h(`<table style="margin-top:8px"></table>`);
      pendZoom.forEach(e => tz.append(h(`<tr><td><input type="checkbox" value="${e.id}"></td><td><a href="#/x/${e.id}">${e.id}</a></td><td>${esc(e.titulo || e.instrucciones)}<br><small class="sub">${esc(m.esc.find(s => s.id === e.escenario)?.nombre || '')}</small></td></tr>`)));
      zc.append(tz);
      const b = h(`<div class="acciones"><button class="btn sec" type="button">Seleccionar todo</button><button class="btn" type="button">Marcar seleccionados como hechos</button><span class="estado sub"></span></div>`);
      const [bTodo, bOk] = b.querySelectorAll('button');
      bTodo.onclick = () => tz.querySelectorAll('input').forEach(i => i.checked = true);
      bOk.onclick = async () => {
        const ids = [...tz.querySelectorAll('input:checked')].map(i => i.value);
        if (!ids.length) return;
        await api.registrarPara(uid, 'zoom_ok', ids, null);
        b.querySelector('.estado').textContent = `Marcados ✓ ${ids.length}. Pásame la transcripción de la clase para registrar la producción.`;
        ids.forEach(id => tz.querySelector(`input[value="${id}"]`).closest('tr').remove());
      };
      zc.append(b);
    }
    el.append(zc);
  }

  const corr = ints.filter(i => i.puntaje != null);
  const media = corr.length ? Math.round(corr.reduce((s, i) => s + Number(i.puntaje), 0) / corr.length) : null;
  const dias = new Set(ints.map(i => new Date(i.creado_en).toDateString())).size;
  const actual = est.actual ? est.fila[est.actual] : null;
  el.append(h(`<div class="tarjeta"><b>${ints.length}</b> intentos en <b>${dias}</b> ${dias === 1 ? 'día' : 'días'} · promedio <b>${media ?? '—'}${media != null ? ' %' : ''}</b> · último: ${ints[0] ? new Date(ints[0].creado_en).toLocaleString() : '—'}<br>
    ${(() => { const pr = proyeccion(m), d = pr.dom; if (!d) return ''; return `Dominio ${esc(pr.nivel)}: <b>${Math.round(100 * d.frac)} %</b> — palabras activas <b>${d.act}</b>/${d.metaAct} · reconocidas <b>${d.rec}</b>/${d.metaRec} · reglas <b>${d.regOk}</b>/${d.metaReg} · habilidades: ${Object.entries(d.hab).map(([k, r]) => `${k} ${r.n}/5${r.n ? ' (' + Math.round(r.suma / r.n) + ' %)' : ''}`).join(', ')}<br>`; })()}
    Trabajando en: <b>${esc(actual ? actual.s.id + ' · ' + actual.s.nombre : '—')}</b> (${actual ? actual.hechos + '/' + actual.total : ''})</div>`));

  // por habilidad
  el.append(h(`<h2>Por habilidad</h2>`));
  const th = h(`<table><tr><th>Habilidad</th><th>Ejercicios</th><th>Promedio</th></tr></table>`);
  for (const hb of HABILIDADES) { const r = est.porHab[hb]; th.append(h(`<tr><td>${hb}</td><td>${r?.n ?? 0}</td><td>${r?.conNota ? Math.round(r.suma / r.conNota) + ' %' : '—'}</td></tr>`)); }
  el.append(th);

  // por regla gramatical (más débiles primero)
  const nomG = Object.fromEntries(gram.map(g => [g.id, g.nombre]));
  const porG = {};
  for (const i of corr) { const e = m.ejs.find(x => x.id === i.ejercicio_id); for (const g of e?.gram || []) { const r = porG[g] ||= { n: 0, s: 0 }; r.n++; r.s += Number(i.puntaje); } }
  const filasG = Object.entries(porG).map(([g, r]) => [g, r.n, Math.round(r.s / r.n)]).sort((a, b) => a[2] - b[2]);
  if (filasG.length) {
    el.append(h(`<h2>Gramática (más débil primero)</h2>`));
    const tg = h(`<table><tr><th>Regla</th><th>Intentos</th><th>Promedio</th></tr></table>`);
    filasG.slice(0, 15).forEach(([g, n, v]) => tg.append(h(`<tr><td>${esc(g)} · ${esc(nomG[g] || '')}</td><td>${n}</td><td><span class="chip ${v >= 70 ? 'ok' : 'mal'}">${v} %</span></td></tr>`)));
    el.append(tg);
  }

  el.append(bloqueClase(uid, m));
  el.append(bloqueProduccion(uid));

  // errores frecuentes
  const errores = [];
  for (const i of corr) for (const d of i.respuesta?.detalle || []) if (!d.ok) errores.push({ ...d, ej: i.ejercicio_id, f: i.creado_en });
  el.append(h(`<h2>Errores recientes</h2>`));
  if (!errores.length) el.append(h(`<p class="sub">Sin errores registrados todavía.</p>`));
  else {
    const te = h(`<table><tr><th>Ejercicio</th><th>Pregunta</th><th>Respondió</th><th>Correcto</th></tr></table>`);
    errores.slice(0, 40).forEach(d => te.append(h(`<tr><td><a href="#/x/${d.ej}">${d.ej}</a></td><td>${esc(d.q)}</td><td class="error">${esc(d.r || '(vacío)')}</td><td class="exito">${esc(d.c)}</td></tr>`)));
    el.append(te);
  }

  el.append(h(`<h2>Últimos intentos</h2>`));
  const t = h(`<table><tr><th>Fecha</th><th>Ejercicio</th><th>Resultado</th></tr></table>`);
  ints.slice(0, 40).forEach(i => t.append(h(`<tr><td>${new Date(i.creado_en).toLocaleString()}</td><td><a href="#/x/${i.ejercicio_id}">${i.ejercicio_id}</a></td><td>${i.puntaje != null ? Math.round(i.puntaje) + ' %' : ''} <span class="chip">${esc(i.estado)}</span></td></tr>`)));
  el.append(t);
}

// Clase grabada (Meet): transcripción con ElevenLabs Scribe v3 → elegir al alumno → análisis con Haiku → vista previa → registro
function turnosDe(words) {
  const t = [];
  for (const w of words || []) {
    if (w.type === 'audio_event') continue;
    const sp = w.speaker_id || '?';
    if (!t.length || t[t.length - 1].sp !== sp) { if (w.type === 'spacing') continue; t.push({ sp, texto: '' }); }
    t[t.length - 1].texto += w.text;
  }
  return t.map(x => ({ ...x, texto: x.texto.replace(/\s+/g, ' ').trim() })).filter(x => x.texto);
}
function bloqueClase(uid, m) {
  const hoy = new Date().toISOString().slice(0, 10);
  const b = h(`<div class="tarjeta"><b>Clase grabada (Meet) → producción del alumno</b>
    <p class="sub" style="margin:6px 0">Elige la grabación (video o audio, hasta 5 GB). Se envía directo a ElevenLabs para transcribirla (~USD 0,20 por hora); no se guarda en la plataforma. Luego eliges quién es el alumno, revisas el resultado y lo registras. Requiere consentimiento para grabar.</p>
    <div class="acciones"><input type="file" accept="video/*,audio/*"><input type="date" value="${hoy}"><button class="btn" type="button">Transcribir</button></div>
    <p class="estado sub"></p><div class="paso"></div></div>`);
  const [inF, inD] = b.querySelectorAll('input'), bT = b.querySelector('button'), est = b.querySelector('.estado'), paso = b.querySelector('.paso');
  let transcripcion = null;
  bT.onclick = async () => {
    const f = inF.files[0]; if (!f) { est.textContent = 'Elige primero la grabación.'; return; }
    bT.disabled = true; paso.innerHTML = '';
    est.textContent = `Enviando y transcribiendo (${Math.round(f.size / 1e6)} MB)… una hora de clase puede tardar unos minutos; no cierres la página. ⏳`;
    try {
      try { transcripcion = await api.transcribirClase(f, true); }
      catch (e) { if (e.status >= 400 && e.status < 500) { est.textContent = 'Reintentando con detección automática de idioma… ⏳'; transcripcion = await api.transcribirClase(f, false); } else throw e; }
      const turnos = turnosDe(transcripcion.words);
      if (!turnos.length) throw new Error('La transcripción salió vacía.');
      est.textContent = `✓ Transcrita: ${Math.round((transcripcion.audio_duration_secs || 0) / 60)} min, ${turnos.length} intervenciones.`;
      elegirAlumno(turnos);
    } catch (e) { est.textContent = '✗ ' + (e.message || 'No se pudo transcribir.'); }
    bT.disabled = false;
  };
  function elegirAlumno(turnos) {
    const hablantes = [...new Set(turnos.map(t => t.sp))];
    const muestras = sp => turnos.filter(t => t.sp === sp && t.texto.split(' ').length >= 4).slice(0, 3);
    paso.innerHTML = '<p class="instr" style="margin-top:12px">¿Quién es el alumno?</p>';
    for (const sp of hablantes) {
      const n = turnos.filter(t => t.sp === sp).length;
      const c = h(`<label class="regla" style="display:block;cursor:pointer"><input type="radio" name="hab" value="${esc(sp)}"> <b style="display:inline">Hablante ${esc(sp.replace(/\D/g, '')) || esc(sp)}</b> · ${n} intervenciones${muestras(sp).map(t => `<div class="texto-ru" style="font-size:15px;margin-top:6px">${esc(t.texto.slice(0, 220))}</div>`).join('')}</label>`);
      paso.append(c);
    }
    const acc = h(`<div class="acciones"><button class="btn" type="button">Analizar lo que dijo el alumno</button><button class="btn sec" type="button">Descargar transcripción (.txt)</button></div>`);
    const [bA, bD] = acc.querySelectorAll('button');
    bD.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([turnos.map(t => `[${t.sp}] ${t.texto}`).join('\n\n')], { type: 'text/plain' })); a.download = `clase-${inD.value}.txt`; a.click(); };
    bA.onclick = async () => {
      const sp = paso.querySelector('input[name=hab]:checked')?.value; if (!sp) { est.textContent = 'Marca quién es el alumno.'; return; }
      bA.disabled = true; est.textContent = 'Analizando con IA… ⏳';
      const texto = turnos.filter(t => t.sp === sp).map(t => t.texto).join('\n');
      const dialogo = turnos.map(t => `${t.sp === sp ? 'ALUMNO' : 'PROFESORA'}: ${t.texto}`).join('\n');
      try {
        // todas las reglas de gramática del curso (no solo las ya presentadas): el alumno puede usar en clase cosas que aún no vio aquí
        const reglas = Object.values(m.regla).filter(g => /^G/.test(g.id)).map(g => ({ id: g.id, nombre: g.nombre }));
        const r = await api.funcionClase({ accion: 'analizar', texto, dialogo, reglas, segundos: transcripcion.audio_duration_secs || 0 });
        await vistaPrevia(texto, r);
      } catch (e) { est.textContent = '✗ ' + (e.message || 'No se pudo analizar.'); }
      bA.disabled = false;
    };
    paso.append(acc);
  }
  async function vistaPrevia(texto, r) {
    const formas = formasCache || await fetch('formas.json').then(x => x.json());
    const voc = vocabCache ? Object.fromEntries(vocabCache.map(v => [v.id, v])) : {};
    // con error = solo las palabras del fragmento que cambian en la corrección (no todo el fragmento)
    const tok = x => String(x || '').toLowerCase().replace(/ё/g, 'е').match(/[а-яё-]+/g) || [];
    const cambiadas = (r.errores || []).flatMap(e => { const ok = new Set(tok(e.correccion)); return tok(e.original).filter(w => !ok.has(w)); });
    const mal = new Set(palabrasEnTexto(formas, cambiadas.join(' ')));
    const pals = palabrasEnTexto(formas, texto).filter(id => voc[id]);
    const filas = [...pals.map(id => ({ id, nombre: voc[id].lema, det: voc[id].traduccion || '', ok: !mal.has(id) })),
      ...(r.reglas || []).map(g => ({ id: g.id, nombre: m.regla[g.id]?.nombre || g.id, det: 'regla', ok: g.ok }))];
    est.textContent = `Revisa y registra: ${pals.length} palabras del curso y ${(r.reglas || []).length} reglas.`;
    const t = h(`<div style="margin-top:12px">${(r.errores || []).length ? `<p class="instr">Errores que detectó la IA</p><ul>${r.errores.map(e => `<li><span class="error">${esc(e.original)}</span> → <span class="exito">${esc(e.correccion)}</span>${e.explicacion ? ` <span class="sub">(${esc(e.explicacion)})</span>` : ''}</li>`).join('')}</ul>` : '<p class="sub">La IA no detectó errores claros.</p>'}
      <p class="instr">Producción a registrar</p><p class="sub">Desmarca lo que no quieras registrar (por ejemplo, una palabra que dijiste tú y quedó asignada al alumno) y corrige «bien / con error» si hace falta.</p>
      <table><tr><th></th><th>Palabra o regla</th><th></th><th>Resultado</th></tr>${filas.map((f, i) => `<tr><td><input type="checkbox" checked data-i="${i}"></td><td><b>${esc(f.nombre)}</b></td><td class="sub">${esc(f.det)}</td><td><select data-i="${i}"><option value="1" ${f.ok ? 'selected' : ''}>bien</option><option value="0" ${f.ok ? '' : 'selected'}>con error</option></select></td></tr>`).join('')}</table>
      <div class="acciones"><button class="btn" type="button">Registrar producción del ${esc(inD.value)}</button><span class="ok-msg"></span></div></div>`);
    t.querySelector('.acciones .btn').onclick = async ev => {
      const refs = filas.map((f, i) => t.querySelector(`input[data-i="${i}"]`).checked ? `${f.id}|${t.querySelector(`select[data-i="${i}"]`).value}|p` : null).filter(Boolean);
      if (!refs.length) return;
      ev.target.disabled = true;
      try {
        await api.registrarPara(uid, 'produccion', refs, new Date(inD.value + 'T12:00:00').toISOString());
        t.querySelector('.ok-msg').textContent = `✓ Registrado: ${refs.filter(x => x.includes('|1|')).length} bien, ${refs.filter(x => x.includes('|0|')).length} con error. Cuentan para su repaso.`;
      } catch (e) { t.querySelector('.ok-msg').textContent = '✗ ' + e.message; ev.target.disabled = false; }
    };
    paso.querySelector('.vista')?.remove(); t.classList.add('vista'); paso.append(t);
  }
  return b;
}

// Producción revisada por el docente (ensayos, clases de conversación): lista de IDs V…/G…
// Formato libre: se toman todos los códigos V1234 / G12; «V1234:0» marca un error.
function leerProduccion(texto) {
  const out = new Map();
  for (const linea of String(texto || '').split(/\n/)) {
    const mal = /(:|=)\s*0\s*$|✗/.test(linea.trim());       // «:0» al final de la línea o ✗ = producido con error
    for (const m of linea.matchAll(/\b([VGP]\d{2,4})\b/g)) out.set(m[1], mal ? 0 : 1);
  }
  return [...out].map(([id, ok]) => `${id}|${ok}|p`);
}
function bloqueProduccion(uid, { titulo = 'Registrar producción (ensayo o clase de conversación)', conFecha = true } = {}) {
  const hoy = new Date().toISOString().slice(0, 10);
  const b = h(`<div class="tarjeta"><b>${titulo}</b>
    <p class="sub" style="margin:6px 0">Pega la lista de palabras y reglas que el alumno produjo correctamente (códigos V… y G…; agrega «:0» al final de la línea de las que produjo mal). Cuentan para su calendario de repaso.</p>
    <div class="buscador-prod"><input type="text" placeholder="Buscar regla o palabra por nombre: acusativo, prepositivo, книга, casa…" autocomplete="off"><div class="sug"></div></div>
    <textarea placeholder="V0643 привет&#10;V0931 я&#10;G07 Меня зовут…&#10;V0330 как:0"></textarea>
    <div class="acciones">${conFecha ? `<input type="date" value="${hoy}">` : ''}<button class="btn" type="button">Guardar producción</button><span class="estado sub"></span></div></div>`);
  // buscador: al escribir un nombre muestra reglas (G/P) y palabras (V); ✓ agrega la línea, ✗ la agrega como producida con error
  const busc = b.querySelector('.buscador-prod input'), sug = b.querySelector('.sug'), ta = b.querySelector('textarea');
  const sinTilde = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ё/g, 'е');
  let tb = null;
  busc.oninput = () => {
    clearTimeout(tb);
    tb = setTimeout(async () => {
      const q = sinTilde(busc.value.trim()); sug.innerHTML = '';
      if (q.length < 2) return;
      const reglas = reglasCache || await api.reglas().catch(() => []);
      const voc = vocabCache || [];
      const res = [...reglas.filter(g => sinTilde(g.id + ' ' + g.nombre).includes(q)).slice(0, 12).map(g => ({ id: g.id, t: g.nombre, d: /^P/.test(g.id) ? 'pronunciación' : 'regla' })),
        ...voc.filter(v => sinTilde(v.lema + ' ' + v.traduccion).includes(q)).slice(0, 8).map(v => ({ id: v.id, t: v.lema, d: v.traduccion || 'palabra' }))];
      if (!res.length) { sug.innerHTML = '<p class="sub">Sin resultados.</p>'; return; }
      for (const x of res) {
        const f = h(`<div class="fila-sug"><span><b>${esc(x.t)}</b> <small class="sub">${esc(x.id)} · ${esc(x.d)}</small></span><span><button type="button" class="btn sec" title="Producida bien">✓</button><button type="button" class="btn sec" title="Producida con error">✗</button></span></div>`);
        const [bOk, bMal] = f.querySelectorAll('button');
        const agregar = mal => { ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + `${x.id} ${x.t}${mal ? ':0' : ''}`; busc.value = ''; sug.innerHTML = ''; busc.focus(); };
        bOk.onclick = () => agregar(false); bMal.onclick = () => agregar(true);
        sug.append(f);
      }
    }, 200);
  };
  b.querySelector('.acciones .btn').onclick = async () => {
    const refs = leerProduccion(b.querySelector('textarea').value), est = b.querySelector('.estado');
    if (!refs.length) { est.textContent = 'No encontré códigos V…, G… o P… en el texto.'; return; }
    const f = b.querySelector('input[type=date]')?.value;
    try {
      await api.registrarPara(uid, 'produccion', refs, f && f !== hoy ? new Date(f + 'T12:00:00').toISOString() : null);
      est.textContent = `Guardado ✓ ${refs.filter(r => r.includes('|1|')).length} correctas, ${refs.filter(r => r.includes('|0|')).length} con error.`;
      b.querySelector('textarea').value = '';
    } catch (err) { est.textContent = err.message; }
  };
  return b;
}

async function tRevisar(el) {
  const [pend, ps] = await Promise.all([api.pendientes(), api.alumnos()]);
  const nombre = id => ps.find(p => p.id === id)?.nombre || id.slice(0, 8);
  if (!pend.length) { el.append(h(`<div class="tarjeta">No hay tareas pendientes. 🎉</div>`)); return; }
  const ejs = {}; for (const i of pend) ejs[i.ejercicio_id] ||= await api.ejercicio(i.ejercicio_id);
  for (const i of pend) {
    const ej = ejs[i.ejercicio_id]; const c = typeof ej.contenido === 'string' ? JSON.parse(ej.contenido) : ej.contenido;
    const card = h(`<div class="tarjeta"><div class="etq">${esc(nombre(i.alumno_id))} · ${new Date(i.creado_en).toLocaleString()} · <a href="#/x/${ej.id}">${ej.id}</a></div>
      ${cabeceraEj(ej)}${c.criterios ? `<p class="sub">Criterios: ${esc(c.criterios)}</p>` : ''}
      ${i.respuesta?.prueba ? `<p class="sub">Prueba de ubicación · parte 1: ${i.respuesta.prueba.aciertos} de ${i.respuesta.prueba.total} aciertos · empieza en: <b>${esc(i.respuesta.prueba.entrada)}</b>${i.respuesta.prueba.salidas ? ` · salió de la pestaña ${i.respuesta.prueba.salidas} veces durante el texto` : ''}</p>` : ''}
      ${i.respuesta?.texto ? `<div class="texto-ru">${esc(i.respuesta.texto)}</div>` : ''}<div class="aud"></div>
      <div class="campo"><label>Comentario para el alumno</label><textarea class="fb"></textarea></div>
      <div class="campo"><label>Producción correcta para el calendario (opcional: códigos V… y G…, «:0» = error)</label><textarea class="prod" style="min-height:70px"></textarea></div>
      <div class="acciones"><input type="number" min="0" max="100" placeholder="Puntaje 0–100" style="width:150px"><button class="btn" type="button">Guardar revisión</button></div></div>`);
    if (i.audio_path) { const u = await api.url('grabaciones', i.audio_path); if (u) card.querySelector('.aud').append(h(`<audio controls src="${esc(u)}"></audio>`)); }
    card.querySelector('button').onclick = async () => {
      const pts = card.querySelector('input').value;
      const refs = leerProduccion(card.querySelector('.prod').value);
      if (refs.length) await api.registrarPara(i.alumno_id, 'produccion', refs, null);
      await api.revisar(i.id, { feedback: card.querySelector('.fb').value, puntaje: pts === '' ? null : Number(pts), correcto: pts === '' ? null : Number(pts) >= 60, estado: 'revisado' });
      card.replaceWith(h(`<div class="tarjeta exito">Revisión guardada ✓</div>`));
    };
    el.append(card);
  }
}

// ---------------------------------------------------------------- edición de contenido desde el panel docente
// Orden manual de los ejercicios de una lección: arrastrar (computadora) o flechas (celular)
function ordenarLeccion(lista, orden, alGuardar, bOrd) {
  bOrd.hidden = true;
  let ids = orden.map(e => e.id); const porId = new Map(orden.map(e => [e.id, e]));
  const barra = h(`<div class="acciones"><button class="btn" type="button">Guardar orden</button><button class="btn sec" type="button">Cancelar</button><span class="ok-msg"></span></div>`);
  lista.before(barra);
  let arrastrado = null;
  const pintar = () => {
    lista.innerHTML = '';
    ids.forEach((id, i) => {
      const e = porId.get(id);
      const f = h(`<div class="fila ordenable" draggable="true"><span class="asa">☰</span><div class="num">${i + 1}</div><div class="txt"><b>${esc(e.titulo || e.instrucciones || '')}</b><small>${esc(e.id)} · ${esc(e.hab)}</small></div>
        <span class="flechas"><button type="button" class="btn sec" data-d="-1" ${i ? '' : 'disabled'}>↑</button><button type="button" class="btn sec" data-d="1" ${i < ids.length - 1 ? '' : 'disabled'}>↓</button></span></div>`);
      f.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { const j = i + Number(b.dataset.d); [ids[i], ids[j]] = [ids[j], ids[i]]; pintar(); });
      f.ondragstart = ev => { arrastrado = id; f.classList.add('arrastrando'); try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', id); } catch {} };
      f.ondragend = () => f.classList.remove('arrastrando');
      f.ondragover = ev => { ev.preventDefault(); f.classList.add('destino'); };
      f.ondragleave = () => f.classList.remove('destino');
      f.ondrop = ev => { ev.preventDefault(); f.classList.remove('destino'); if (!arrastrado || arrastrado === id) return; ids = ids.filter(x => x !== arrastrado); ids.splice(ids.indexOf(id), 0, arrastrado); pintar(); };
      lista.append(f);
    });
  };
  pintar();
  const [bG, bC] = barra.querySelectorAll('.btn'), msg = barra.querySelector('.ok-msg');
  bC.onclick = alGuardar;
  bG.onclick = async () => {
    bG.disabled = true; msg.textContent = 'Guardando…';
    try {
      const cambios = ids.map((id, i) => [id, i + 1]).filter(([id, n]) => Number(porId.get(id).orden) !== n);
      for (let i = 0; i < cambios.length; i += 10) await Promise.all(cambios.slice(i, i + 10).map(([id, n]) => api.actualizar('ejercicios', id, { orden: n })));
      msg.textContent = '✓ Orden guardado.'; setTimeout(alGuardar, 500);
    } catch (e) { msg.textContent = '✗ ' + e.message; bG.disabled = false; }
  };
}
// Formulario genérico: campos = [[columna, etiqueta, 'area'?]]
function editarFila(tabla, fila, campos, alGuardar, extra) {
  const f = h(`<div class="tarjeta editor"><h2 style="margin-top:0">Editar ${esc(fila.id)}</h2><div class="campos"></div><div class="extra"></div>
    <div class="acciones"><button class="btn" type="button">Guardar</button><button class="btn sec" type="button">Cancelar</button></div><p class="ok-msg"></p></div>`);
  for (const [k, et, tipo] of campos) {
    const v = fila[k] ?? '';
    if (Array.isArray(tipo)) { const ops = tipo.map(o => typeof o === 'string' ? { v: o, t: o } : o); f.querySelector('.campos').append(h(`<div class="campo"><label>${esc(et)}</label><select data-k="${k}"><option value="">${k === 'categoria' ? '(automática)' : '—'}</option>${ops.map(o => `<option value="${esc(o.v)}"${o.v === v ? ' selected' : ''}>${esc(o.t)}</option>`).join('')}</select></div>`)); continue; }
    f.querySelector('.campos').append(h(`<div class="campo"><label>${esc(et)}</label>${tipo === 'area' || String(v).length > 70 ? `<textarea data-k="${k}" rows="${Math.min(14, 2 + String(v).split('\n').length)}">${esc(v)}</textarea>` : `<input type="text" data-k="${k}" value="${esc(v)}">`}</div>`));
  }
  if (extra) f.querySelector('.extra').append(extra.el);
  const [bG, bC] = f.querySelectorAll('.acciones .btn'), msg = f.querySelector('.ok-msg');
  bC.onclick = () => f.remove();
  bG.onclick = async () => {
    bG.disabled = true; msg.textContent = 'Guardando…';
    try {
      const cambios = {};
      f.querySelectorAll('.campos [data-k]').forEach(i => { if (i.value !== String(fila[i.dataset.k] ?? '')) cambios[i.dataset.k] = i.value.trim() === '' ? null : i.value; });
      if (extra) Object.assign(cambios, extra.valor());
      if ('escenario' in cambios) cambios.orden = null;
      if (!Object.keys(cambios).length) { msg.textContent = 'No hay cambios.'; bG.disabled = false; return; }
      await api.actualizar(tabla, fila.id, cambios);
      reglasCache = null;
      msg.textContent = '✓ Guardado.'; setTimeout(alGuardar, 400);
    } catch (e) { msg.textContent = '✗ ' + e.message; bG.disabled = false; }
  };
  $app.prepend(f); f.scrollIntoView({ behavior: 'smooth' });
  return f;
}

// Textos del contenido de un ejercicio, como campos sueltos (sin tocar JSON)
const NOM_CAMPO = { items: 'Pregunta', q: 'enunciado', options: 'opciones (una por línea)', answers: 'respuestas aceptadas (una por línea)', answer: 'respuesta correcta',
  pairs: 'parejas (izquierda | derecha, una por línea)', tarjetas: 'Tarjeta', ru: 'ruso', es: 'español', tr: 'transcripción', nota: 'nota', elementos: 'elementos (uno por línea)',
  textos: 'textos (uno por línea)', criterios: 'criterios para la corrección con IA', modelo: 'ejemplo de respuesta', tiles: 'fichas (una por línea)', preguntas: 'preguntas (una por línea)',
  texto: 'texto', categorias: 'categoría', respuestas: 'respuestas' };
const NO_EDITAR = new Set(['tipo', 'img', 'imagen', 'grupo', 'fuente', 'temas', 'banco', 'n', 'id', 'ref']);
function camposContenido(c) {
  const out = [];
  const esStrs = a => Array.isArray(a) && a.every(x => typeof x === 'string');
  const walk = (x, path, etq) => {
    if (typeof x === 'string') return out.push({ path, etq, kind: 'str', v: x });
    if (esStrs(x)) return out.push({ path, etq, kind: 'lineas', v: x.join('\n') });
    if (Array.isArray(x) && x.every(esStrs)) return out.push({ path, etq, kind: 'pares', v: x.map(p => p.join(' | ')).join('\n') });
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, [...path, i], `${etq ? etq + ' ' : ''}${i + 1}`));
    if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) {
      if (NO_EDITAR.has(k)) continue;
      const nk = path.at(-1) === 'categorias' ? `«${k}»` : (NOM_CAMPO[k] || k);
      walk(y, [...path, k], etq ? `${etq} · ${nk}` : nk);
    }
  };
  walk(c, [], '');
  return out;
}
function editorContenido(c) {
  const campos = camposContenido(c);
  const el = h(`<div><details ${campos.length <= 12 ? 'open' : ''}><summary><b>Textos del ejercicio (${campos.length})</b></summary>
    <p class="sub">Si cambias una opción que es la respuesta correcta, cámbiala también en «respuestas aceptadas».</p><div class="cc"></div></details>
    <details style="margin-top:10px"><summary>Avanzado: editar como JSON</summary><p class="sub">Solo si necesitas cambiar la estructura (agregar preguntas, categorías…). Si escribes aquí, se usa esto en lugar de los campos de arriba.</p><textarea class="json" rows="12" spellcheck="false"></textarea></details></div>`);
  const cc = el.querySelector('.cc');
  campos.forEach((f, i) => cc.append(h(`<div class="campo"><label>${esc(f.etq)}</label>${f.kind === 'str' && f.v.length <= 70 ? `<input type="text" data-i="${i}" value="${esc(f.v)}">` : `<textarea data-i="${i}" rows="${Math.min(10, 1 + f.v.split('\n').length)}">${esc(f.v)}</textarea>`}</div>`)));
  const json = el.querySelector('.json'), original = JSON.stringify(c, null, 1);
  json.value = original;
  return { el, valor() {
    if (json.value.trim() !== original.trim()) {
      try { return JSON.parse(json.value); } catch (e) { throw new Error('El JSON no es válido: ' + e.message); }
    }
    const n = structuredClone(c); let cambio = false;
    cc.querySelectorAll('[data-i]').forEach(inp => {
      const f = campos[inp.dataset.i]; if (inp.value === f.v) return;
      cambio = true;
      const val = f.kind === 'str' ? inp.value : f.kind === 'lineas' ? inp.value.split('\n').map(x => x.trim()).filter(Boolean)
        : inp.value.split('\n').filter(x => x.trim()).map(l => l.split('|').map(x => x.trim()));
      let o = n; f.path.slice(0, -1).forEach(k => o = o[k]); o[f.path.at(-1)] = val;
    });
    return cambio ? n : null;
  } };
}
let LECCIONES = [];
async function editarEjercicio(ej, c) {
  if (!LECCIONES.length) LECCIONES = (await api.todosEscenarios()).map(e => ({ v: e.id, t: `${e.id} · ${e.nombre}` }));
  const ed = editorContenido(c);
  const caja = h(`<div></div>`); caja.append(editorImagenes(ej, c), ed.el);
  editarFila('ejercicios', ej, [['titulo', 'Título (corto)'], ['categoria', 'Tipo de ejercicio', HABILIDADES], ['escenario', 'Lección (vacío = práctica sin lección)', LECCIONES], ['instrucciones', 'Enunciado (subtítulo, letra más pequeña)', 'area']], () => vEjercicio(ej.id),
    { el: caja, valor: () => { const n = ed.valor(); return n ? { contenido: n } : {}; } });
}
// Imágenes del ejercicio: reemplazar el archivo manteniendo el mismo nombre (Mxxx.jpg)
function editorImagenes(ej, c) {
  const idsImg = new Set([...ids(ej.material), ...(c.imagen ? [c.imagen] : [])]);
  const recoger = x => { if (Array.isArray(x)) x.forEach(recoger); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (k === 'img' && /^M\d+$/.test(v)) idsImg.add(v); else recoger(v); } };
  recoger(c);
  const el = h(`<details style="margin-bottom:10px"><summary><b>Imágenes del ejercicio</b> <span class="sub">(cargando…)</span></summary><p class="sub">«Reemplazar» borra la imagen anterior y sube la nueva con el mismo nombre. Se convierte a JPG automáticamente. Los alumnos la verán en unos minutos.</p><div class="imgs"></div></details>`);
  (async () => {
    const mats = (await api.materiales([...idsImg])).filter(m => m.tipo === 'imagen');
    el.querySelector('summary .sub').textContent = `(${mats.length})`;
    if (!mats.length) el.querySelector('.imgs').append(h(`<p class="sub">Este ejercicio no usa imágenes.</p>`));
    for (const m of mats) {
      const fila = h(`<div class="fila-img"><img alt=""><div><b>${esc(m.id)}</b> <span class="sub">${esc(m.titulo || '')}</span><br><input type="file" accept="image/*"> <button class="btn sec" type="button">Reemplazar</button> <span class="ok-msg"></span></div></div>`);
      const img = fila.querySelector('img'), msg = fila.querySelector('.ok-msg');
      api.url('materiales', `img/${m.id}.jpg`).then(u => { if (u) img.src = u; });
      fila.querySelector('button').onclick = async ev => {
        const file = fila.querySelector('input').files[0]; if (!file) { msg.textContent = 'Elige un archivo primero.'; return; }
        ev.target.disabled = true; msg.textContent = 'Subiendo…';
        try {
          const jpg = await aJpg(file);
          await api.subirMedio(jpg, `img/${m.id}.jpg`, '60');
          img.src = URL.createObjectURL(jpg); msg.textContent = '✓ Reemplazada.';
        } catch (e) { msg.textContent = '✗ ' + e.message; }
        ev.target.disabled = false;
      };
      el.querySelector('.imgs').append(fila);
    }
  })();
  return el;
}
// convierte cualquier imagen a JPG (máx. 1600 px de lado) para guardarla como Mxxx.jpg
async function aJpg(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(bmp, 0, 0, cv.width, cv.height);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
  return new File([blob], 'imagen.jpg', { type: 'image/jpeg' });
}
function editarRegla(g, alGuardar) {
  const tabla = /^P/.test(g.id) ? 'pronunciacion' : 'gramatica';
  const prev = h(`<div><div class="sub" style="margin-top:8px">Vista previa:</div><div class="regla"></div></div>`);
  const f = editarFila(tabla, g, [['nombre', 'Título de la regla'], ['descripcion', 'Descripción breve (se usa si no hay explicación)', 'area'],
    ['explicacion', 'Explicación: líneas que empiezan con «|» forman tablas (| a | b |); [img:M123] inserta una imagen', 'area'], ['ejemplo', 'Ejemplo en ruso', 'area']], alGuardar, { el: prev, valor: () => ({}) });
  const pintar = () => {
    const v = k => f.querySelector(`[data-k="${k}"]`).value;
    prev.querySelector('.regla').innerHTML = `<b style="font-size:18px">${esc(v('nombre'))}</b>${v('explicacion') ? explicacionHtml(v('explicacion')) : `<p>${esc(v('descripcion'))}</p>`}${v('ejemplo') ? `<div class="texto-ru">${esc(v('ejemplo'))}</div>` : ''}`;
    resolverImgs(prev);
  };
  f.querySelectorAll('[data-k]').forEach(i => i.oninput = pintar); pintar();
}

// Descarga del contenido actual de la plataforma, con las mismas hojas y columnas que la importación
const NOMBRE_HOJA = { habilidades: 'Habilidades', gramatica: 'Gramatica', pronunciacion: 'Pronunciacion', vocabulario: 'Vocabulario', temas: 'Temas',
  escenarios: 'Escenarios', tipos_ejercicio: 'Tipos_ejercicio', materiales: 'Materiales', ejercicios: 'Ejercicios' };
async function descargarContenido(out) {
  const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
  const wb = XLSX.utils.book_new();
  for (const t of ORDEN_IMPORT) {
    out(`Leyendo ${t}…`);
    const filas = (await api.tablaCompleta(TABLAS[t])).map(r => Object.fromEntries(COLS[t].map(c => {
      const v = r[c]; return [c, v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v];
    })));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas, { header: COLS[t] }), NOMBRE_HOJA[t]);
  }
  const f = new Date(), nombre = `contenido-plataforma-${f.toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, nombre);
  out(`✓ Descargado ${nombre}.`);
}

async function tContenido(el) {
  el.append(h(`<div class="tarjeta"><h2 style="margin-top:0">Descargar contenido actual</h2>
    <p class="sub">Todo el contenido tal como está ahora en la plataforma, con tus ediciones (mismas hojas y columnas que la importación). Úsalo como copia y como base para cambios grandes: lo editas o me lo envías, y luego lo vuelves a importar abajo.</p>
    <button class="btn" id="bd" type="button">Descargar .xlsx</button></div>`));
  el.append(h(`<div class="tarjeta"><h2 style="margin-top:0">Editar reglas</h2><p class="sub">Busca por nombre o código (G…, P…). Los ejercicios se editan desde Lecciones → ejercicio → ✏️ Editar.</p>
    <input id="br" placeholder="Ej.: genitivo, G045, ы"><div class="lista" id="lr" style="margin-top:8px"></div></div>`));
  el.append(h(`<div class="tarjeta"><h2 style="margin-top:0">Editar palabras</h2><p class="sub">Lo que se muestra en las tarjetas de palabras nuevas y de repaso. Busca en ruso, en español o por código (V…).</p>
    <input id="bv" placeholder="Ej.: это, casa, V0123"><div class="lista" id="lv" style="margin-top:8px"></div></div>`));
  el.append(h(`<div class="tarjeta"><h2 style="margin-top:0">Importar hoja de contenido</h2>
    <p class="sub">Sube un .xlsx con las hojas del contenido (el descargado arriba, o la hoja de Google: Archivo → Descargar → Microsoft Excel). Actualiza filas existentes y agrega las nuevas. Ojo: lo que importes reemplaza las ediciones hechas aquí en esas mismas filas.</p>
    <input type="file" accept=".xlsx" id="fx"> <button class="btn" id="bx" type="button">Importar</button></div>`));
  el.append(h(`<div class="tarjeta"><h2 style="margin-top:0">Subir audios e imágenes</h2>
    <p class="sub">Selecciona todos los archivos de las carpetas <b>audio</b>, <b>img</b> y <b>video</b> (nombres tipo M003.mp3, M004.jpg, M455.mp4). Se guardan en Supabase y los alumnos los ven sin cuenta de Google.</p>
    <input type="file" multiple accept=".mp3,.jpg,.jpeg,.png,.webp,.mp4" id="fm"> <button class="btn" id="bm" type="button">Subir</button></div>`));
  const log = h(`<div class="log" hidden></div>`); el.append(log);
  const out = s => { log.hidden = false; log.textContent += s + '\n'; log.scrollTop = log.scrollHeight; };
  el.querySelector('#bd').onclick = async e => { e.target.disabled = true; try { await descargarContenido(out); } catch (er) { out('✗ ' + er.message); } e.target.disabled = false; };
  const lr = el.querySelector('#lr'); let reglas = null;
  const lv = el.querySelector('#lv'); let tv = null;
  el.querySelector('#bv').oninput = ev => {
    clearTimeout(tv); const q = ev.target.value.trim();
    tv = setTimeout(async () => {
      lv.innerHTML = ''; if (q.length < 2) return;
      for (const v of await api.buscarVocab(q)) {
        const f = h(`<div class="fila"><div class="txt"><b>${esc(v.lema)}</b><small>${esc(v.id)} · ${esc(v.traduccion || '')}${v.uso ? ' · ' + esc(v.uso) : ''}</small></div><button class="btn sec" type="button">✏️ Editar</button></div>`);
        f.querySelector('button').onclick = () => editarFila('vocabulario', v, [['lema', 'Palabra en ruso (con tilde de acento si quieres: заво́д)'], ['traduccion', 'Traducción'], ['categoria', 'Categoría gramatical'],
          ['uso', 'Uso en el curso', [{ v: 'activo', t: 'activo (el alumno debe producirla)' }, { v: 'pasivo', t: 'pasivo (solo reconocerla)' }]]], () => { vocabCache = null; vDocente('contenido'); });
        lv.append(f);
      }
    }, 300);
  };
  el.querySelector('#br').oninput = async ev => {
    reglas ??= reglasCache || await api.reglas();
    const q = ev.target.value.trim().toLowerCase(); lr.innerHTML = '';
    if (q.length < 2) return;
    for (const g of reglas.filter(g => (g.id + ' ' + g.nombre).toLowerCase().includes(q)).slice(0, 15)) {
      const f = h(`<div class="fila"><div class="txt"><b>${esc(g.nombre)}</b><small>${esc(g.id)}</small></div><button class="btn sec" type="button">✏️ Editar</button></div>`);
      f.querySelector('button').onclick = () => editarRegla(g, () => vDocente('contenido'));
      lr.append(f);
    }
  };

  el.querySelector('#bx').onclick = async () => {
    const f = el.querySelector('#fx').files[0]; if (!f) return out('Elige el archivo .xlsx primero.');
    out('Leyendo ' + f.name + '…');
    const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
    const wb = XLSX.read(await f.arrayBuffer());
    const hojas = {}; wb.SheetNames.forEach(n => hojas[n.toLowerCase().trim()] = wb.Sheets[n]);
    for (const t of ORDEN_IMPORT) {
      const sh = hojas[t]; if (!sh) { out(`· ${t}: no encontrada, se omite`); continue; }
      const filas = XLSX.utils.sheet_to_json(sh, { defval: '', raw: false }).map(r => {
        const o = {}; for (const [k, v] of Object.entries(r)) o[k.toLowerCase().trim()] = v; return o;
      }).filter(r => String(r.id || '').trim());
      const limpias = []; let malas = 0;
      for (const r of filas) {
        const o = {}; for (const c of COLS[t]) if (c in r) o[c] = r[c] === '' ? null : r[c];   // columnas que no están en la hoja no se tocan
        o.id = String(o.id).trim();
        if ('orden' in o) o.orden = o.orden == null ? null : Number(o.orden);
        if (t === 'ejercicios' && 'contenido' in o) { try { o.contenido = o.contenido ? JSON.parse(o.contenido) : null; } catch { malas++; continue; } }
        limpias.push(o);
      }
      try {
        for (let i = 0; i < limpias.length; i += 500) await api.upsert(TABLAS[t], limpias.slice(i, i + 500));
        out(`✓ ${t}: ${limpias.length} filas${malas ? ` (${malas} con JSON inválido omitidas)` : ''}`);
      } catch (e) { out(`✗ ${t}: ${e.message}`); }
    }
    out('Importación terminada.');
  };

  el.querySelector('#bm').onclick = async () => {
    const files = [...el.querySelector('#fm').files]; if (!files.length) return out('Elige los archivos primero.');
    let ok = 0, err = 0;
    for (const f of files) {
      const carpeta = /\.mp3$/i.test(f.name) ? 'audio' : /\.mp4$/i.test(f.name) ? 'video' : 'img';
      try { await api.subirMedio(f, `${carpeta}/${f.name}`); ok++; if (ok % 10 === 0) out(`… ${ok} de ${files.length}`); }
      catch (e) { err++; out(`✗ ${f.name}: ${e.message}`); }
    }
    out(`Listo: ${ok} subidos${err ? `, ${err} con error` : ''}.`);
  };
}

// ---------------------------------------------------------------- arranque y rutas

// ================================================================ página pública, registro y planes
const NIVELES_TODOS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const COND = {
  mensual: ['Todas las lecciones de todos los niveles disponibles', 'Repaso diario y corrección de escritura con IA', 'Se renueva cada mes; cancelas cuando quieras', 'Reembolso total dentro de los primeros 15 días'],
  anual: ['Todas las lecciones de todos los niveles disponibles', 'Repaso diario y corrección de escritura con IA', 'Un solo pago al año; te avisamos 7 días antes de renovar', 'Reembolso total en 15 días; luego, proporcional a los meses no usados'],
};
function seccionPlanes() {
  const ops = NIVELES_TODOS.map(n => `<option value="${n}" ${NIVELES_A_LA_VENTA.includes(n) ? '' : 'disabled'}>${n}${NIVELES_A_LA_VENTA.includes(n) ? '' : ' (próximamente)'}</option>`).join('');
  const el = h(`<div><div class="planes">
    <div class="plan"><h3>Prueba gratis</h3><div class="precio">$0</div><div class="sub">Sin tarjeta</div>
      <ul><li>Primera lección completa: alfabeto, sonidos, letra cursiva y primeras palabras</li><li>Ejercicios con corrección inmediata</li><li>Repaso de palabras con voz rusa</li></ul>
      <a class="btn sec" href="#/registro">Empieza gratis</a></div>
    <div class="plan dest"><div class="etq">Suscripción</div><h3>Esencial</h3>
      <div class="campo"><select data-per aria-label="Periodo"><option value="mensual">Pago mensual</option><option value="anual">Pago anual</option></select></div>
      <div class="precio" data-precio></div><div class="sub" data-nota></div><ul data-cond></ul>
      <a class="btn" data-elegir>Elegir</a></div>
    <div class="plan"><div class="etq">Compra única</div><h3>Un nivel</h3>
      <div class="campo"><select data-niv aria-label="Nivel">${ops}</select></div>
      <div class="precio">${esc(PRECIOS.nivel.precio)}<span>${esc(PRECIOS.nivel.periodo)}</span></div><div class="sub">Sin renovaciones</div>
      <ul><li>Acceso para siempre a todas las lecciones del nivel elegido: lo terminas a tu ritmo</li><li>Repaso diario y corrección de escritura con IA</li><li>Si ya sabes algo de ruso: prueba de ubicación después del pago</li><li>Cubre solo ese nivel, aunque lo empieces desde la mitad</li></ul>
      <a class="btn" data-nivel>Comprar nivel</a></div>
    <div class="plan"><div class="etq">Muy pronto</div><h3>Pro</h3><div class="precio" style="font-size:1.4rem">Próximamente</div>
      <ul><li>Todo lo de Esencial</li><li>Corrección de pronunciación con IA</li><li>Conversación con avatar</li><li>Examen y certificado de nivel</li></ul>
      <span class="btn sec" aria-disabled="true" style="opacity:.6;cursor:default">Muy pronto</span></div></div>
    <p class="sub"><b>¿Suscripción o un nivel?</b> Con la suscripción avanzas por todos los niveles mientras pagas. Con un nivel pagas una sola vez y lo terminas cuando quieras, sin pagos mensuales.</p></div>`);
  const per = el.querySelector('[data-per]'), niv = el.querySelector('[data-niv]');
  const pintar = () => {
    const p = PRECIOS[per.value];
    el.querySelector('[data-precio]').innerHTML = `${esc(p.precio)}<span>${esc(p.periodo)}</span>`;
    el.querySelector('[data-nota]').textContent = p.nota || 'Sin permanencia';
    el.querySelector('[data-cond]').innerHTML = COND[per.value].map(x => `<li>${esc(x)}</li>`).join('');
    el.querySelector('[data-elegir]').href = `#/pagar?plan=${per.value}`;
    el.querySelector('[data-nivel]').href = `#/pagar?plan=nivel&nivel=${niv.value}`;
    el.querySelector('[data-nivel]').textContent = `Comprar nivel ${niv.value}`;
  };
  per.onchange = niv.onchange = pintar; pintar();
  return el;
}
function vPublico() {
  nav();
  $app.innerHTML = `<section class="heroe"><h1>Aprende ruso desde cero, a tu ritmo</h1>
    <p class="grande">Curso para hispanohablantes: lecciones cortas que se ordenan solas según lo que ya sabes, repaso inteligente de palabras y corrección inmediata de lo que escribes.</p>
    <div class="acciones"><a class="btn" href="#/registro">Prueba gratis la primera lección</a><a class="btn sec" href="#/entrar">Ya tengo cuenta</a></div></section>
    <section class="ventajas">
      <div><b>🧭 Ruta personal</b><p>La plataforma decide la siguiente tarea según tu avance: nunca ves una palabra o regla que no te hayan enseñado.</p></div>
      <div><b>🔁 Repaso que no olvida</b><p>Cada día empiezas por lo que estás a punto de olvidar. Ves en cuántos días tendrás tu nivel.</p></div>
      <div><b>✍️ Escribir de verdad</b><p>Tus textos se corrigen al instante, y el repaso diario te pide usar en frases propias las palabras que estás a punto de olvidar.</p></div>
      <div><b>📜 Certificado</b><p>Con el plan Pro (muy pronto): al dominar un nivel rindes un examen de 5 partes y recibes un certificado verificable en línea.</p></div>
    </section>
    <h2>Planes</h2><div id="secplanes"></div>
    <p class="sub"><a href="#/verificar">Verificar un certificado</a></p>`;
  $app.querySelector('#secplanes').append(seccionPlanes());
}
// Página «Tu plan»: resumen del plan elegido (el pago en línea se conectará aquí)
function vPagar() {
  nav();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const plan = q.get('plan') || 'mensual', nivel = NIVELES_A_LA_VENTA.includes(q.get('nivel')) ? q.get('nivel') : NIVELES_A_LA_VENTA[0];
  const per = plan === 'anual' ? 'anual' : 'mensual';
  const desc = plan === 'nivel' ? `Un nivel (${nivel}) · ${PRECIOS.nivel.precio} pago único` : `Esencial ${per} · ${PRECIOS[per].precio}${PRECIOS[per].periodo}`;
  const aviso = plan === 'nivel' ? `<p class="sub">La compra de un nivel cubre solo las lecciones del nivel ${nivel}, sin vencimiento, mientras la plataforma esté en funcionamiento. Después del pago puedes hacer una prueba de ubicación: si ya dominas parte del nivel, empiezas desde ese punto y el precio es el mismo; si tu nivel es otro, puedes cambiar de nivel antes de empezar o pedir el reembolso dentro de 15 días.</p>` : '';
  $app.innerHTML = `<div class="tarjeta"><h1>Tu plan</h1><p><b>${esc(desc)}</b></p>${aviso}
    <p>El pago en línea estará disponible muy pronto.</p>
    ${sesion ? '' : `<p>Mientras tanto, crea tu cuenta gratis y empieza con la primera lección: tu progreso se guarda.</p><div class="acciones"><a class="btn" href="#/registro">Crear cuenta</a><a class="btn sec" href="#/entrar">Ya tengo cuenta</a></div>`}
    <p class="sub"><a href="#/planes">← Ver todos los planes</a></p></div>`;
}

function vRegistro(msg = '') {
  nav();
  $app.innerHTML = '';
  const f = h(`<form class="tarjeta login"><h1>Crea tu cuenta</h1><p class="sub">Gratis: incluye la primera lección completa.</p>
    <div class="campo"><label>Tu nombre</label><input required autocomplete="name"></div>
    <div class="campo"><label>Correo</label><input type="email" required autocomplete="email"></div>
    <div class="campo"><label>Contraseña (mínimo 8 caracteres)</label><input type="password" required minlength="8" autocomplete="new-password"></div>
    <label class="sub acepto"><input type="checkbox" style="width:auto;margin-top:4px"> <span>Acepto los <a href="#/terminos" data-terminos>Términos y la Política de privacidad</a>.</span></label>
    <p class="sub aviso-ia">Tus tareas escritas las corrige una inteligencia artificial (Anthropic, Estados Unidos), sin tu nombre ni tu correo y sin revisión de una persona. Es parte del servicio: sin aceptarlo no se crea la cuenta.</p>
    <p class="error">${esc(msg)}</p><button class="btn" type="submit" disabled>Crear cuenta</button>
    <p class="sub">¿Ya tienes cuenta? <a href="#/entrar">Entrar</a></p></form>`);
  const casilla = f.querySelector('.acepto input'), bCrear = f.querySelector('button[type=submit]');
  casilla.onchange = () => { bCrear.disabled = !casilla.checked; };
  f.querySelector('[data-terminos]').onclick = ev => { ev.preventDefault(); verTerminos(); };
  f.onsubmit = async e => {
    e.preventDefault(); const [nom, em, pw] = f.querySelectorAll('input');
    if (!casilla.checked) return;
    bCrear.disabled = true;
    try {
      const r = await api.registro(nom.value.trim(), em.value.trim(), pw.value);
      if (r?.session) return iniciar();
      $app.innerHTML = `<div class="tarjeta login"><h1>Revisa tu correo 📬</h1><p>Te enviamos un enlace para confirmar tu cuenta a <b>${esc(em.value.trim())}</b>. Ábrelo y vuelve aquí para entrar.</p><a class="btn" href="#/entrar">Ir a entrar</a></div>`;
    } catch (err) { vRegistro(/registered|exists/i.test(err.message || '') ? 'Ese correo ya tiene cuenta. Entra o recupera tu contraseña.' : 'No se pudo crear la cuenta: ' + (err.message || 'inténtalo de nuevo.')); }
  };
  $app.append(f);
}

function vRecuperar(msg = '') {
  nav();
  $app.innerHTML = '';
  const f = h(`<form class="tarjeta login"><h1>Recuperar contraseña</h1><p class="sub">Te enviaremos un enlace para crear una nueva.</p>
    <div class="campo"><label>Correo</label><input type="email" required autocomplete="email"></div>
    <p class="error">${esc(msg)}</p><button class="btn" type="submit">Enviar enlace</button><p class="sub"><a href="#/entrar">Volver</a></p></form>`);
  f.onsubmit = async e => {
    e.preventDefault(); f.querySelector('button').disabled = true;
    try { await api.recuperar(f.querySelector('input').value.trim()); $app.innerHTML = `<div class="tarjeta login"><h1>Listo</h1><p>Si el correo tiene cuenta, recibirás un enlace en unos minutos.</p></div>`; }
    catch (err) { vRecuperar('No se pudo enviar: ' + (err.message || '')); }
  };
  $app.append(f);
}

function vNuevaClave() {
  $app.innerHTML = '';
  const f = h(`<form class="tarjeta login"><h1>Nueva contraseña</h1><div class="campo"><label>Contraseña nueva (mínimo 8 caracteres)</label><input type="password" required minlength="8" autocomplete="new-password"></div>
    <p class="error"></p><button class="btn" type="submit">Guardar</button></form>`);
  f.onsubmit = async e => {
    e.preventDefault();
    try { await api.nuevaClave(f.querySelector('input').value); location.hash = '#/'; }
    catch (err) { f.querySelector('.error').textContent = err.message || 'No se pudo guardar.'; }
  };
  $app.append(f);
}

// Plan del alumno: 'prueba' solo abre la primera lección (alfabeto). LECCIONES_INICIO = las que no cuentan como «ya avanzó» para la prueba de ubicación
const LECCIONES_PRUEBA = ['E01'];
const PLANES_UN_NIVEL = ['nivel', 'gratuito'];   // 'gratuito' = acceso gratuito que habilita la docente: solo las lecciones de plan_nivel, sin vencimiento
const LECCIONES_INICIO = ['E01', 'E03'];
function enPrueba() {
  if (!perfil || perfil.rol === 'docente') return false;
  if (perfil.plan === 'prueba') return true;
  if (!['completo', 'nivel', 'gratuito'].includes(perfil.plan) && perfil.plan_hasta && new Date(perfil.plan_hasta + 'T23:59:59') < new Date()) return true;   // plan vencido (un nivel comprado no vence)
  return false;
}
function tarjetaFinPrueba() {
  const vencido = perfil?.plan && perfil.plan !== 'prueba';
  return h(`<div class="tarjeta"><div class="etq">${vencido ? 'Tu plan terminó' : 'Terminaste tu prueba gratis 🎉'}</div>
    <h2 style="margin-top:4px">${vencido ? 'Renueva para seguir avanzando' : '¡Ya sabes leer en ruso!'}</h2>
    <p>Para seguir con las siguientes lecciones y el repaso diario, elige una suscripción o compra un nivel. Tu progreso se guarda.</p>
    <div class="acciones"><a class="btn" href="#/planes">Ver planes</a></div></div>`);
}

// ================================================================ términos y privacidad (texto en terminos.html)
const TERMINOS_CUENTA = '2026-11-21';   // al cambiar terminos.html, cambia esta fecha: se pide de nuevo la aceptación
const MSG_IA_PENDIENTE = 'Enviado. Tu texto quedó guardado: la corrección automática lo revisará pronto y verás los comentarios en tu inicio.';
async function textoTerminos() {
  const r = await fetch('terminos.html', { cache: 'no-cache' });
  const d = new DOMParser().parseFromString(await r.text(), 'text/html');
  return d.querySelector('main')?.innerHTML || '';
}
async function verTerminos() {      // ventana superpuesta: no se sale del formulario
  const o = h(`<div class="felicidades ventana-legal"><div class="caja"><div class="legal"><p class="cargando">Cargando…</p></div><div class="acciones"><button class="btn" type="button">Cerrar</button></div></div></div>`);
  o.querySelector('button').onclick = () => o.remove();
  o.onclick = e => { if (e.target === o) o.remove(); };
  document.body.append(o);
  try { o.querySelector('.legal').innerHTML = await textoTerminos(); } catch { o.querySelector('.legal').innerHTML = '<p class="error">No se pudo cargar el documento.</p>'; }
}
async function vTerminos() {
  nav();
  $app.innerHTML = `<div class="tarjeta legal"><p class="cargando">Cargando…</p></div>`;
  try { $app.querySelector('.legal').innerHTML = await textoTerminos(); } catch { $app.querySelector('.legal').innerHTML = '<p class="error">No se pudo cargar el documento.</p>'; }
}
async function vAceptarTerminos() {   // alumnos que aún no aceptaron esta versión (acceso gratuito recién habilitado, cuentas anteriores o términos nuevos)
  nav();
  $app.innerHTML = `<div class="tarjeta"><h1 style="margin-top:0">Términos y privacidad</h1><p class="sub">Antes de seguir, lee y acepta los términos de uso y la política de privacidad de tu cuenta.</p>
    <div class="legal caja-legal"><p class="cargando">Cargando…</p></div>
    <label class="sub acepto"><input type="checkbox" style="width:auto;margin-top:4px"> <span>Acepto los Términos y la Política de privacidad, incluida la corrección de mis tareas escritas con inteligencia artificial, sin revisión de una persona.</span></label>
    <p class="error"></p><div class="acciones"><button class="btn" type="button" disabled>Aceptar y continuar</button><a class="btn sec" href="#/salir">Salir</a></div></div>`;
  try { $app.querySelector('.legal').innerHTML = await textoTerminos(); } catch { $app.querySelector('.legal').innerHTML = '<p class="error">No se pudo cargar el documento. Recarga la página.</p>'; }
  const c = $app.querySelector('.acepto input'), b = $app.querySelector('.acciones button');
  c.onchange = () => { b.disabled = !c.checked; };
  b.onclick = async () => {
    b.disabled = true;
    try { await api.aceptar('cuenta', TERMINOS_CUENTA); perfil.faltaTerminos = false; router(); }
    catch (e) { $app.querySelector('.error').textContent = 'No se pudo guardar: ' + (e.message || 'inténtalo de nuevo.'); b.disabled = false; }
  };
}

// ================================================================ mi cuenta: nombre, correo, contraseña
const NOMBRE_PLAN = { prueba: 'Prueba gratis', plataforma: 'Esencial', pro: 'Pro', nivel: 'Un nivel', gratuito: 'Acceso gratuito', completo: 'Acceso completo', zoom_grupal: 'Plataforma + Zoom grupal', zoom_individual: 'Plataforma + Zoom individual' };
function vCuenta() {
  nav('cuenta');
  const p = perfil || {};
  const plan = `${NOMBRE_PLAN[p.plan] || p.plan || '—'}${PLANES_UN_NIVEL.includes(p.plan) && p.plan_nivel ? ' ' + p.plan_nivel : ''}${p.plan_hasta && !['nivel', 'gratuito', 'completo'].includes(p.plan) ? ` · hasta el ${new Date(p.plan_hasta + 'T12:00:00').toLocaleDateString('es')}` : ''}`;
  $app.innerHTML = `<div class="migas"><a href="#/">← Inicio</a></div><h1>Mi cuenta</h1>
    <div class="tarjeta"><p><b>Correo:</b> ${esc(sesion.user.email)}<br><b>Plan:</b> ${esc(plan)}</p>${p.plan === 'prueba' ? '<a class="btn sec" href="#/planes">Ver planes</a>' : ''}</div>`;
  const forma = (titulo, campos, boton, accion) => {
    const f = h(`<form class="tarjeta"><h2 style="margin-top:0">${titulo}</h2>${campos}<p class="error"></p><p class="ok-msg"></p><button class="btn" type="submit">${boton}</button></form>`);
    f.onsubmit = async e => {
      e.preventDefault(); const b = f.querySelector('button'), er = f.querySelector('.error'), ok = f.querySelector('.ok-msg');
      er.textContent = ok.textContent = ''; b.disabled = true;
      try { ok.textContent = await accion(f); } catch (err) { er.textContent = err.message || 'No se pudo guardar.'; }
      b.disabled = false;
    };
    $app.append(f);
  };
  forma('Nombre', `<div class="campo"><label>Tu nombre (aparece en la plataforma y, si rindes el examen, en el certificado)</label><input type="text" required maxlength="80" value="${esc(p.nombre || '')}" autocomplete="name"></div>`, 'Guardar nombre', async f => {
    const n = f.querySelector('input').value.trim(); await api.cambiarNombre(n); perfil.nombre = n; nav('cuenta'); return '✓ Nombre guardado.';
  });
  forma('Correo', `<div class="campo"><label>Correo nuevo</label><input type="email" required autocomplete="email"></div><p class="sub">Te enviaremos un enlace de confirmación. El cambio rige cuando lo abras (si se te pide, confirma también desde tu correo actual).</p>`, 'Cambiar correo', async f => {
    const em = f.querySelector('input').value.trim();
    if (em.toLowerCase() === sesion.user.email.toLowerCase()) throw new Error('Ese ya es tu correo.');
    await api.cambiarCorreo(em); f.reset(); return `✓ Revisa ${em} y abre el enlace para confirmar el cambio.`;
  });
  forma('Contraseña', `<div class="campo"><label>Contraseña actual</label><input type="password" required autocomplete="current-password"></div><div class="campo"><label>Contraseña nueva (mínimo 8 caracteres)</label><input type="password" required minlength="8" autocomplete="new-password"></div><div class="campo"><label>Repite la contraseña nueva</label><input type="password" required minlength="8" autocomplete="new-password"></div>`, 'Cambiar contraseña', async f => {
    const [a, n1, n2] = [...f.querySelectorAll('input')].map(i => i.value);
    if (n1 !== n2) throw new Error('Las contraseñas nuevas no coinciden.');
    if (n1 === a) throw new Error('La contraseña nueva debe ser distinta de la actual.');
    await api.cambiarClave(a, n1); f.reset(); return '✓ Contraseña cambiada.';
  });
  const borrar = h(`<div class="tarjeta"><h2 style="margin-top:0">Borrar mi cuenta</h2><p class="sub">Se borran tu cuenta y tu progreso en un máximo de 15 días; te confirmamos por correo. Las facturas se conservan por obligación legal.</p><button class="btn sec" type="button">Pedir que borren mi cuenta</button><p class="ok-msg"></p></div>`);
  let paso = 0; const bB = borrar.querySelector('button');
  bB.onclick = async () => {
    if (!paso) { paso = 1; bB.textContent = 'Sí, quiero borrar mi cuenta'; bB.classList.add('rojo'); return; }
    bB.disabled = true;
    try { await api.reportar({ texto: `🗑 Pide borrar su cuenta (${sesion.user.email}).`, pagina: '#/cuenta', navegador: 'solicitud del alumno' }); borrar.querySelector('.ok-msg').textContent = '✓ Solicitud enviada. Te escribiremos para confirmar.'; }
    catch { borrar.querySelector('.ok-msg').textContent = 'No se pudo enviar. Usa «Reportar un problema técnico».'; bB.disabled = false; }
  };
  $app.append(borrar);
}

// ================================================================ reportar un problema técnico
function botonReporte() {
  if (document.getElementById('reportar')) return;
  const b = h(`<button id="reportar" type="button" class="reportar">⚠️ Reportar un problema técnico</button>`);
  b.onclick = () => {
    const o = h(`<div class="felicidades"><form class="caja" style="text-align:left"><h2 style="margin-top:0">Reportar un problema técnico</h2>
      <p class="sub">Cuéntanos qué pasó: qué estabas haciendo, qué esperabas y qué salió. Incluimos automáticamente la página en la que estás.</p>
      <textarea required minlength="3" placeholder="Ej.: En el ejercicio de las letras, el botón Comprobar no hace nada."></textarea>
      <p class="error"></p><div class="acciones"><button class="btn" type="submit">Enviar</button><button class="btn sec" type="button" data-x>Cancelar</button></div></form></div>`);
    o.querySelector('[data-x]').onclick = () => o.remove();
    o.querySelector('form').onsubmit = async e => {
      e.preventDefault(); const bt = o.querySelector('[type=submit]'); bt.disabled = true;
      try {
        await api.reportar({ texto: o.querySelector('textarea').value.trim(), pagina: location.hash || '#/', navegador: navigator.userAgent.slice(0, 300) });
        o.querySelector('.caja').innerHTML = `<h2 style="margin-top:0">¡Gracias! ✓</h2><p>Recibimos tu reporte y lo revisaremos pronto.</p><div class="acciones"><button class="btn" type="button">Cerrar</button></div>`;
        o.querySelector('button').onclick = () => o.remove();
      } catch (err) { o.querySelector('.error').textContent = 'No se pudo enviar. Escríbele a tu profesora.'; bt.disabled = false; }
    };
    document.body.append(o); o.querySelector('textarea').focus();
  };
  document.body.append(b);
}

async function tReportes(el) {
  const [rs, ps] = await Promise.all([api.reportes(), api.alumnos()]);
  const nombre = id => ps.find(p => p.id === id)?.nombre || (id || '').slice(0, 8);
  if (!rs.length) { el.append(h(`<div class="tarjeta">No hay reportes. 🎉</div>`)); return; }
  for (const r of rs) {
    const c = h(`<div class="tarjeta ${r.estado === 'resuelto' ? 'hecho' : ''}"><div class="etq">${esc(nombre(r.usuario))} · ${new Date(r.creado_en).toLocaleString()} · ${esc(r.pagina || '')} · ${r.estado === 'resuelto' ? '✓ resuelto' : '🆕 nuevo'}</div>
      <p style="white-space:pre-wrap">${esc(r.texto)}</p><p class="sub">${esc(r.navegador || '')}</p>${r.estado === 'resuelto' ? '' : '<div class="acciones"><button class="btn sec" type="button">Marcar resuelto</button></div>'}</div>`);
    const b = c.querySelector('button'); if (b) b.onclick = async () => { await api.resolverReporte(r.id); c.classList.add('hecho'); b.remove(); cacheReportes = null; };
    el.append(c);
  }
}

// ================================================================ ajustes: interruptor de IA
// ---------- espacio usado en Supabase (plan gratuito: base 500 MB, archivos 1 GB) ----------
const LIMITES = { base: 500e6, archivos: 1e9 };
const AVISO = 0.8;
const mb = b => (b / 1e6 >= 1000 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB');
async function resumenEspacio() {
  const filas = await api.espacio();
  const base = filas.filter(f => f.tipo === 'base').reduce((s, f) => s + Number(f.bytes), 0);
  const carpetas = filas.filter(f => f.tipo === 'archivos');
  const arch = carpetas.reduce((s, f) => s + Number(f.bytes), 0);
  return { base, arch, carpetas, pBase: base / LIMITES.base, pArch: arch / LIMITES.archivos };
}
function tarjetaEspacio(e) {
  const barra = (t, usado, lim, p) => `<div class="espacio"><div class="espacio-t"><b>${t}</b> <span>${mb(usado)} de ${mb(lim)} · ${Math.round(p * 100)} %</span></div>
    <div class="espacio-b"><div style="width:${Math.min(100, p * 100)}%" class="${p >= 1 ? 'lleno' : p >= AVISO ? 'alto' : ''}"></div></div></div>`;
  const NOM = { materiales: 'materiales del curso (imágenes, audios, videos)', grabaciones: 'grabaciones orales de alumnos', examenes: 'fotos de cámara de exámenes' };
  return h(`<div class="tarjeta"><h2 style="margin-top:0">Espacio en Supabase (plan gratuito)</h2>
    ${barra('Base de datos', e.base, LIMITES.base, e.pBase)}${barra('Archivos', e.arch, LIMITES.archivos, e.pArch)}
    <table class="tabla"><tr><th>Carpeta</th><th>Archivos</th><th>Tamaño</th></tr>${e.carpetas.sort((a, b) => b.bytes - a.bytes).map(f => `<tr><td>${esc(NOM[f.nombre] || f.nombre)}</td><td>${f.archivos ?? ''}</td><td>${mb(Number(f.bytes))}</td></tr>`).join('')}</table>
    <p class="sub">Aviso al llegar al ${AVISO * 100} %. Fotos de cámara de exámenes se borran solas a los 30 días. Para liberar más espacio: borra grabaciones antiguas (Supabase → Storage), o comprime videos antes de subirlos. Las descargas mensuales (límite 5 GB) solo se ven en Supabase → Usage.</p></div>`);
}
async function avisoEspacio(el) {
  try {
    const e = await resumenEspacio();
    const p = Math.max(e.pBase, e.pArch);
    if (p >= AVISO) el.prepend(h(`<div class="tarjeta aviso-espacio">⚠️ <b>Espacio de Supabase al ${Math.round(p * 100)} %</b> (${e.pArch >= e.pBase ? 'archivos' : 'base de datos'}). Revisa «IA y ajustes» para liberar espacio antes de llegar al límite del plan gratuito.</div>`));
  } catch (err) { /* sin SQL 09 todavía: no se muestra aviso */ }
}

async function tAjustes(el) {
  try { el.append(tarjetaEspacio(await resumenEspacio())); } catch (err) { el.append(h(`<div class="tarjeta sub">Para ver el espacio usado, ejecuta el SQL 09 en Supabase.</div>`)); }
  const [aj, uso] = await Promise.all([api.ajustes(), api.usoIA()]);
  const A = Object.fromEntries(aj.map(r => [r.clave, r.valor]));
  const gasto = uso.reduce((s, r) => s + Number(r.costo_usd || 0), 0);
  const c = h(`<div class="tarjeta"><h2 style="margin-top:0">Inteligencia artificial</h2>
    <p class="sub">Interruptor general: al apagarlo, ninguna función de IA se ejecuta en toda la plataforma y no hay gasto.</p>
    <label class="interruptor"><input type="checkbox" ${A.ia_activa === true ? 'checked' : ''}> <b>IA activa: corrección de escritura y repasos escritos generados</b></label>
    <label class="interruptor" style="margin-top:8px"><input type="checkbox" data-pron ${A.pronunciacion_activa === true ? 'checked' : ''}> <b>Piloto: evaluación de pronunciación con Azure</b> <span class="sub">(requiere AZURE_SPEECH_KEY y AZURE_SPEECH_REGION en Supabase y la función «pronunciacion»)</span></label>
    <div class="campo" style="max-width:260px;margin-top:14px"><label>Tope de gasto mensual (USD)</label><input type="number" min="0" step="0.5" value="${Number(A.ia_tope_mensual_usd ?? 5)}"></div>
    <p>Gasto de este mes: <b>$${gasto.toFixed(4)}</b></p>${tablaGastos(uso)}
    <p class="sub">Requiere la clave de Anthropic guardada como secreto en Supabase (ANTHROPIC_API_KEY) y la función «corregir» desplegada. Las correcciones quedan en «Por revisar» para que las confirmes.</p>
    <div class="acciones"><button class="btn" type="button">Guardar</button></div><p class="ok-msg"></p></div>`);
  c.querySelector('button').onclick = async () => {
    await api.guardarAjuste('ia_activa', c.querySelector('[type=checkbox]').checked);
    await api.guardarAjuste('pronunciacion_activa', c.querySelector('[data-pron]').checked); pronActivaCache = null;
    await api.guardarAjuste('ia_tope_mensual_usd', Number(c.querySelector('[type=number]').value || 0));
    c.querySelector('.ok-msg').textContent = 'Guardado ✓';
  };
  el.append(c);
}
// gasto del mes por proveedor (según el modelo registrado en cada uso)
function tablaGastos(uso) {
  const prov = r => /^claude/.test(r.modelo || '') ? 'Anthropic API (Claude)' : /^scribe/.test(r.modelo || '') ? 'ElevenLabs API (transcripción)' : /azure/.test(r.modelo || '') ? 'Microsoft Azure (pronunciación)' : 'Otro';
  const NOM = { escritura: 'corrección de textos', generar_repaso: 'repasos escritos', analisis_clase: 'análisis de clases', transcripcion_clase: 'transcripción de clases', pronunciacion: 'evaluación de pronunciación' };
  const g = new Map();
  for (const r of uso) { const k = prov(r); const x = g.get(k) || { n: 0, usd: 0, tareas: new Map() }; x.n++; x.usd += Number(r.costo_usd || 0); x.tareas.set(r.tarea, (x.tareas.get(r.tarea) || 0) + 1); g.set(k, x); }
  if (!g.size) return '<p class="sub">Aún no hay usos este mes.</p>';
  return `<table class="tabla"><tr><th>Proveedor</th><th>Usos</th><th>USD (mes)</th></tr>${[...g].sort((a, b) => b[1].usd - a[1].usd).map(([k, x]) => `<tr><td>${esc(k)}<br><small class="sub">${[...x.tareas].map(([t, n]) => `${esc(NOM[t] || t || '—')}: ${n}`).join(' · ')}</small></td><td>${x.n}</td><td>$${x.usd.toFixed(4)}</td></tr>`).join('')}</table>
    <p class="sub">ElevenLabs: monto estimado (USD 0,20 por hora de audio). Si tu plan de ElevenLabs incluye créditos de API, se descuentan de ahí y no se cobra aparte.</p>`;
}
// examen y certificado: solo plan Pro
const planConCertificado = () => perfil?.plan === 'pro' || location.search.includes('demo');
let pronActivaCache = null;
async function pronunciacionActiva() {
  if (pronActivaCache !== null) return pronActivaCache;
  try { const aj = await api.ajustes(); const A = Object.fromEntries(aj.map(r => [r.clave, r.valor])); pronActivaCache = A.ia_activa === true && A.pronunciacion_activa === true; } catch { pronActivaCache = false; }
  return pronActivaCache;
}
// grabación del navegador (webm/ogg) → WAV PCM 16 kHz mono en base64, el formato que acepta Azure
async function aWav16k(blob) {
  const ctx = new AudioContext(); const buf = await ctx.decodeAudioData(await blob.arrayBuffer()); ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const dv = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, t) => [...t].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  const bytes = new Uint8Array(dv.buffer); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
let iaActivaCache = null;
async function iaActiva() {
  if (iaActivaCache !== null) return iaActivaCache;
  try { const aj = await api.ajustes(); iaActivaCache = aj.find(r => r.clave === 'ia_activa')?.valor === true; } catch { iaActivaCache = false; }
  return iaActivaCache;
}

// ================================================================ examen de suficiencia (tipo ТРКИ)
const PARTES = [
  ['lexico', 'Léxico y gramática', 30], ['lectura', 'Lectura', 25], ['audicion', 'Comprensión auditiva', 20],
  ['escritura', 'Expresión escrita', 30], ['oral', 'Expresión oral', 15]];
const NOTA_MINIMA = 66;


// Arma una prueba de 5 partes a partir de los bancos de preguntas del nivel.
// Nivel de cada ejercicio: el de su lección; si no tiene lección (bancos de práctica), el nivel más alto de sus reglas.
async function generarExamen(nivel, opc = {}) {
  const [ints, evs] = await Promise.all([api.misIntentos(), api.misEventos()]);
  const { m } = await cargarModelo(ints, evs);
  const NIV = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const nivEsc = Object.fromEntries(m.esc.map(s => [s.id, s.nivel || 'A1']));
  const nivEj = e => e.escenario ? nivEsc[e.escenario] || 'A1' : (e.reqG || []).map(g => m.regla[g]?.nivel || 'A1').sort((x, y) => NIV.indexOf(y) - NIV.indexOf(x))[0] || 'A1';
  const del = m.ejs.filter(e => nivEj(e) === nivel);
  const cont = e => { try { return typeof e.contenido === 'string' ? JSON.parse(e.contenido) : e.contenido; } catch { return {}; } };
  const cerradas = e => (cont(e).items || []).filter(i => ['choice', 'input'].includes(i.tipo) && !i.img);
  // léxico y gramática: preguntas sueltas de los bancos de vocabulario y gramática, como máximo 2 por ejercicio para variar los temas
  const lex = barajar(del.filter(e => ['vocabulario', 'gramática'].includes(e.hab) && !e.material && !cont(e).texto && cerradas(e).length))
    .flatMap(e => barajar(cerradas(e)).slice(0, 2).map(i => ({ ...i, de: e.id, instr: consignaEj(e) })));
  const lexico = lex.slice(0, opc.lexico || 30);
  const elegir = (hab, n) => barajar(del.filter(e => e.hab === hab && e.material && (cont(e).items || []).some(i => ['choice', 'input'].includes(i.tipo)))).slice(0, n).map(e => e.id);
  const abiertas = (oral) => barajar(del.filter(e => cont(e).tipo === 'abierta' && (oral ? ORALES.has(e.tipo_ejercicio) : !ORALES.has(e.tipo_ejercicio)))).slice(0, 1).map(e => e.id);
  return { lexico: { items: lexico }, lectura: elegir('lectura', 2), audicion: elegir('escucha', 2), escritura: abiertas(false), oral: abiertas(true) };
}

// el examen solo se rinde en computadora (no celular ni tablet; el iPad se presenta como Mac pero tiene pantalla táctil)
function esComputadora() {
  if (navigator.userAgentData?.mobile) return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Tablet/i.test(ua)) return false;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return false;
  return true;
}
async function vExamen() {
  if (!planConCertificado()) { nav('inicio'); $app.innerHTML = `<div class="tarjeta"><h1>Examen de suficiencia</h1><p>El examen y el certificado son parte del plan <b>Pro</b>, que estará disponible muy pronto.</p><div class="acciones"><a class="btn sec" href="#/">← Volver</a></div></div>`; return; }
  nav('inicio');
  const nivel = new URLSearchParams(location.hash.split('?')[1] || '').get('nivel') || 'A1';
  if (!esComputadora()) { $app.innerHTML = `<div class="migas"><a href="#/">← Inicio</a></div><div class="tarjeta"><h1 style="margin-top:0">Examen de suficiencia · nivel ${esc(nivel)}</h1><p>💻 El examen solo se puede rendir <b>desde una computadora</b> (Windows, Mac o Linux) con cámara. Entra a la plataforma desde una computadora para empezarlo o continuarlo.</p><div class="acciones"><a class="btn sec" href="#/">← Volver</a></div></div>`; return; }
  const previos = await api.examenes();
  const enCurso = previos.find(x => x.estado === 'en_curso' && x.nivel === nivel);
  if (!enCurso) {
    $app.innerHTML = `<div class="migas"><a href="#/">← Inicio</a></div><div class="tarjeta"><h1 style="margin-top:0">Examen de suficiencia · nivel ${esc(nivel)}</h1>
      <p>El examen tiene 5 partes, como el ТРКИ: ${PARTES.map(p => `<b>${p[1]}</b> (${p[2]} min)`).join(', ')}. Para aprobar necesitas al menos <b>${NOTA_MINIMA} %</b> en cada parte.</p>
      <h3>Vigilancia automática</h3><ul>
      <li>Se usa tu cámara durante todo el examen y se guardan fotos cada minuto para revisión. Las fotos se borran automáticamente 30 días después del examen (plazo para revisión o apelación).</li>
      <li>El examen se hace en pantalla completa. Salir de ella, cambiar de pestaña o abrir otro programa queda registrado como incidencia.</li>
      <li>No se puede copiar ni pegar. No uses diccionarios, traductores ni ayuda de otras personas.</li>
      <li><b>Sin cámara no hay examen:</b> si no das permiso a la cámara, el examen no empieza; si la cámara se apaga durante el examen, la prueba se bloquea hasta que la vuelvas a activar (el tiempo sigue corriendo).</li>
      <li>Solo desde computadora (no celular ni tablet), con cámara, en un lugar tranquilo y con buena luz. Las partes escrita y oral las califica tu profesora.</li></ul>
      <label class="sub" style="display:flex;gap:8px"><input type="checkbox" id="acepto" style="width:auto"> Acepto las condiciones y la grabación de fotos de la cámara durante el examen.</label>
      <p class="error"></p><div class="acciones"><button class="btn" type="button" disabled>Empezar examen</button></div></div>`;
    const bt = $app.querySelector('.acciones .btn'), ch = $app.querySelector('#acepto');
    ch.onchange = () => bt.disabled = !ch.checked;
    bt.onclick = async () => {
      bt.disabled = true;
      // la cámara es obligatoria: se pide el permiso antes de crear el examen
      try { (await navigator.mediaDevices.getUserMedia({ video: true, audio: false })).getTracks().forEach(t => t.stop()); }
      catch (e) { $app.querySelector('.error').innerHTML = 'Sin cámara no se puede rendir el examen. Permite el acceso a la cámara en tu navegador (ícono 🔒 o 📷 junto a la dirección) y en tu sistema, y vuelve a pulsar «Empezar examen».'; bt.disabled = false; return; }
      try {
        const preguntas = await generarExamen(nivel);
        if (!preguntas.lexico.items.length) throw new Error('Aún no hay suficiente contenido de este nivel para armar el examen.');
        await api.crearExamen({ nivel, preguntas, respuestas: {}, notas: {} });
        await api.registrar('examen', [nivel]).catch(() => {});
        vExamen();
      } catch (err) { $app.querySelector('.error').textContent = err.message || 'No se pudo iniciar.'; bt.disabled = false; }
    };
    return;
  }
  return correrExamen(enCurso);
}

async function correrExamen(ex) {
  const vig = await iniciarVigilancia(ex);
  const resp = ex.respuestas || {};
  const pendientes = PARTES.filter(([k]) => !(k in resp));
  if (!pendientes.length) return entregarExamen(ex, vig);
  const [k, titulo, minutos] = pendientes[0];
  $app.innerHTML = `<div class="examen-cab"><b>${esc(titulo)}</b> · parte ${PARTES.findIndex(p => p[0] === k) + 1} de 5 <span class="reloj"></span></div>`;
  const cont = h(`<div></div>`); $app.append(cont);
  const bloques = [];
  if (k === 'lexico') {
    // preguntas agrupadas por ejercicio de origen, cada grupo con su instrucción
    const grupos = new Map();
    for (const i of ex.preguntas.lexico.items) { const g = i.de || '_'; if (!grupos.has(g)) grupos.set(g, []); grupos.get(g).push(i); }
    const card = h(`<div class="tarjeta"><p class="instr">Elige o escribe la respuesta correcta.</p></div>`);
    let n = 0;
    for (const [, its] of grupos) {
      const r = rItems({ items: its });
      const g = h(`<div class="grupo-lex"><p class="sub"><b>${its.length > 1 ? `${n + 1}–${n + its.length}` : n + 1}.</b> ${esc(its[0].instr || '')}</p></div>`); n += its.length;
      g.append(r.el); card.append(g); bloques.push(r);
    }
    cont.append(card);
    if (card.querySelector('input[type=text]')) card.append(tecladoRuso(card));
  } else {
    for (const id of ex.preguntas[k] || []) {
      const ej = await api.ejercicio(id); const c = typeof ej.contenido === 'string' ? JSON.parse(ej.contenido) : ej.contenido;
      const card = h(`<div class="tarjeta">${cabeceraEj(ej)}<div class="media"></div><div class="cuerpo"></div></div>`);
      for (const m of await api.materiales(ids(ej.material))) card.querySelector('.media').append(await bloqueMaterial(m, true));
      const r = await renderizar(ej); card.querySelector('.cuerpo').append(r.el); bloques.push(r); cont.append(card);
      if (card.querySelector('input[type=text], textarea')) card.append(tecladoRuso(card));
      setTimeout(() => resolverImgs(card), 0);
    }
    if (!bloques.length) cont.append(h(`<div class="tarjeta">Esta parte no tiene preguntas en este nivel todavía; se califica con la profesora.</div>`));
  }
  const acc = h(`<div class="acciones"><button class="btn" type="button">Terminar esta parte →</button></div><p class="error"></p>`); cont.append(acc);
  const fin = Date.now() + minutos * 60000;
  const reloj = $app.querySelector('.reloj');
  const tick = setInterval(() => { const s = Math.max(0, Math.round((fin - Date.now()) / 1000)); reloj.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (!s) terminar(true); }, 1000);
  let hecho = false;
  async function terminar(porTiempo = false) {
    if (hecho) return; hecho = true; clearInterval(tick);
    const out = [];
    for (const b of bloques) { try { out.push(await b.corregir()); } catch (e) { out.push({ vacio: true, error: e.message }); } }
    const auto = out.filter(o => !o.abierta && o.total);
    const bien = auto.reduce((s, o) => s + o.bien, 0), total = auto.reduce((s, o) => s + o.total, 0);
    resp[k] = { porTiempo, auto: total ? Math.round(100 * bien / total) : null, abiertas: out.filter(o => o.abierta).map(o => ({ texto: o.respuesta?.texto || '', audio: o.audio || null })) };
    await api.actualizarExamen(ex.id, { respuestas: resp, incidencias: vig.incidencias });
    ex.respuestas = resp; correrExamen(ex);
  }
  acc.querySelector('button').onclick = () => terminar(false);
}

async function iniciarVigilancia(ex) {
  if (window.__vig && window.__vig.id === ex.id) return window.__vig;
  const vig = { id: ex.id, incidencias: ex.incidencias || [], stream: null, timer: null };
  const nota = (tipo) => { vig.incidencias.push({ tipo, t: new Date().toISOString() }); };
  // cámara obligatoria: sin ella el examen queda bloqueado (al empezar o si se apaga a mitad)
  const v = h(`<video class="cam" autoplay muted playsinline></video>`); document.body.append(v);
  const bloqueo = (msg) => new Promise(resolve => {
    const o = h(`<div class="felicidades bloqueo-cam"><div class="caja"><div class="copa">📷</div><h2>La cámara es obligatoria</h2><p>${msg}</p>
      <p class="sub">Permite el acceso a la cámara en tu navegador (ícono 🔒 o 📷 junto a la dirección) y en tu sistema. ${ex.respuestas && Object.keys(ex.respuestas).length ? 'El tiempo de la parte sigue corriendo.' : ''}</p>
      <p class="error"></p><div class="acciones" style="justify-content:center"><button class="btn" type="button">Activar cámara y continuar</button></div></div></div>`);
    o.querySelector('button').onclick = async () => {
      try { await conectar(); o.remove(); resolve(); }
      catch (e) { o.querySelector('.error').textContent = 'Todavía no hay acceso a la cámara.'; }
    };
    document.body.append(o);
  });
  const conectar = async () => {
    vig.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
    v.srcObject = vig.stream;
    vig.stream.getVideoTracks()[0].onended = () => { nota('camara_apagada'); bloqueo('Tu cámara se apagó. Actívala para seguir con el examen.'); };
  };
  try { await conectar(); }
  catch (e) { nota('sin_camara'); await bloqueo('Sin cámara no se puede continuar el examen.'); }
  const foto = async () => {
    try {
      if (!vig.stream?.active) throw new Error('sin cámara');
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240; cv.getContext('2d').drawImage(v, 0, 0, 320, 240);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.6));
      await api.subirFotoExamen(blob, `${sesion.user.id}/${ex.id}/${Date.now()}.jpg`);
    } catch (e) { nota('foto_fallida'); }
  };
  setTimeout(foto, 3000); vig.timer = setInterval(foto, 60000);
  try { await document.documentElement.requestFullscreen?.(); } catch (e) { nota('sin_pantalla_completa'); }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) nota('salio_de_pantalla_completa'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) nota('cambio_de_pestana_o_programa'); });
  window.addEventListener('blur', () => nota('ventana_sin_foco'));
  ['copy', 'paste', 'cut', 'contextmenu'].forEach(t => document.addEventListener(t, e => { if (window.__vig) { e.preventDefault(); nota('intento_' + t); } }));
  window.__vig = vig; return vig;
}

async function entregarExamen(ex, vig) {
  clearInterval(vig?.timer); vig?.stream?.getTracks().forEach(t => t.stop()); document.querySelector('.cam')?.remove();
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (e) {}
  window.__vig = null;
  const notas = Object.fromEntries(PARTES.map(([k]) => [k, ex.respuestas[k]?.auto ?? null]));
  await api.actualizarExamen(ex.id, { estado: 'entregado', entregado_en: new Date().toISOString(), notas, incidencias: vig?.incidencias || [] });
  $app.innerHTML = `<div class="tarjeta"><h1 style="margin-top:0">Examen entregado ✓</h1>
    <p>Resultados automáticos: ${PARTES.filter(([k]) => notas[k] != null).map(([k, t]) => `${t}: <b>${notas[k]} %</b>`).join(' · ') || '—'}.</p>
    <p>Tu profesora calificará la expresión escrita y oral y revisará la vigilancia. Si apruebas todas las partes con ${NOTA_MINIMA} % o más, tu certificado aparecerá en tu inicio.</p>
    <a class="btn" href="#/">Volver al inicio</a></div>`;
}

async function tExamenes(el) {
  const [exs, ps] = await Promise.all([api.examenes(true), api.alumnos()]);
  const nombre = id => ps.find(p => p.id === id)?.nombre || id.slice(0, 8);
  if (!exs.length) { el.append(h(`<div class="tarjeta">Aún no hay exámenes.</div>`)); return; }
  for (const ex of exs) {
    const n = ex.notas || {};
    const card = h(`<div class="tarjeta"><div class="etq">${esc(nombre(ex.usuario))} · nivel ${esc(ex.nivel)} · ${esc(ex.estado)} · ${new Date(ex.iniciado_en).toLocaleString()}</div>
      <p class="sub">Incidencias de vigilancia: ${(ex.incidencias || []).length ? esc([...new Set((ex.incidencias || []).map(i => i.tipo))].map(t => `${t} ×${ex.incidencias.filter(i => i.tipo === t).length}`).join(' · ')) : 'ninguna'}</p>
      <div class="fotos"></div><div class="abiertas"></div>
      <div class="notas">${PARTES.map(([k, t]) => `<label>${t}<input type="number" min="0" max="100" data-k="${k}" value="${n[k] ?? ''}"></label>`).join('')}</div>
      <div class="acciones"><button class="btn" type="button">Guardar calificación</button><button class="btn sec" type="button" data-anular>Anular</button><button class="btn sec" type="button" data-fotos>Ver fotos de cámara</button></div><p class="ok-msg"></p></div>`);
    for (const k of ['escritura', 'oral']) for (const a of ex.respuestas?.[k]?.abiertas || []) {
      const d = h(`<div class="regla"><b>${k === 'oral' ? 'Expresión oral' : 'Expresión escrita'}</b>${a.texto ? `<div class="texto-ru">${esc(a.texto)}</div>` : ''}</div>`);
      if (a.audio) { const u = await api.url('grabaciones', a.audio); if (u) d.append(h(`<audio controls src="${esc(u)}"></audio>`)); }
      card.querySelector('.abiertas').append(d);
    }
    card.querySelector('[data-fotos]').onclick = async e => {
      e.target.disabled = true;
      const fs = await api.fotosExamen(ex.usuario, ex.id);
      for (const u of fs) card.querySelector('.fotos').append(h(`<img src="${esc(u)}" alt="" class="foto-cam">`));
      if (!fs.length) card.querySelector('.fotos').append(h(`<p class="sub">Sin fotos. Se borran automáticamente 30 días después del examen.</p>`));
    };
    card.querySelector('.acciones .btn').onclick = async () => {
      const notas = {}; card.querySelectorAll('[data-k]').forEach(i => notas[i.dataset.k] = i.value === '' ? null : Number(i.value));
      const completas = PARTES.every(([k]) => notas[k] != null);
      const aprobado = completas && PARTES.every(([k]) => notas[k] >= NOTA_MINIMA);
      await api.actualizarExamen(ex.id, { notas, aprobado: completas ? aprobado : null, estado: completas ? 'calificado' : ex.estado, calificado_en: completas ? new Date().toISOString() : null });
      card.querySelector('.ok-msg').textContent = completas ? (aprobado ? 'Aprobado ✓ — el certificado se emitió automáticamente.' : 'Calificado: no aprobado.') : 'Notas guardadas (faltan partes).';
    };
    card.querySelector('[data-anular]').onclick = async () => { await api.actualizarExamen(ex.id, { estado: 'anulado' }); card.querySelector('.ok-msg').textContent = 'Examen anulado.'; };
    el.append(card);
  }
}

// ================================================================ certificados
async function vCertificado(codigo) {
  nav('inicio');
  const cs = await api.certificados();
  const c = cs.find(x => x.codigo === codigo);
  if (!c) { $app.innerHTML = `<div class="tarjeta">Certificado no encontrado.</div>`; return; }
  const url = `${location.origin}${location.pathname}#/verificar/${c.codigo}`;
  const n = c.notas || {};
  $app.innerHTML = `<div class="migas no-imprimir"><a href="#/">← Inicio</a> · <a href="javascript:print()">Imprimir o guardar como PDF</a></div>
    <div class="certificado"><div class="sello">🎓</div><p class="cert-escuela">${esc(NOMBRE_CURSO)}</p><h1>Certificado de nivel ${esc(c.nivel)}</h1>
    <p>Se certifica que</p><p class="cert-nombre">${esc(c.nombre)}</p>
    <p>aprobó el examen de suficiencia de lengua rusa de nivel <b>${esc(c.nivel)}</b> (Marco Común Europeo de Referencia), con al menos ${NOTA_MINIMA} % en cada parte:</p>
    <p class="cert-notas">${PARTES.map(([k, t]) => `${t}: <b>${n[k] ?? '—'} %</b>`).join(' · ')}</p>
    <p>Emitido el ${new Date(c.emitido_en + 'T12:00:00').toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
    <p class="sub">Código de verificación: <b>${esc(c.codigo)}</b> · ${esc(url)}</p>
    <p class="sub">Este certificado acredita el nivel demostrado en el examen de la plataforma. No equivale al examen estatal ТРКИ: su aceptación para un trámite depende de la entidad que lo reciba.</p></div>`;
}

async function vVerificar(codigo = '') {
  nav();
  $app.innerHTML = `<div class="tarjeta login"><h1>Verificar certificado</h1><div class="campo"><label>Código</label><input value="${esc(codigo)}" placeholder="RU-A1-XXXXXX"></div>
    <button class="btn" type="button">Verificar</button><div class="res"></div></div>`;
  const ir = async () => {
    const res = $app.querySelector('.res'); res.textContent = '…';
    try {
      const r = await api.verificar($app.querySelector('input').value);
      res.innerHTML = r ? `<div class="resultado ok">✓ Válido: <b>${esc(r.nombre)}</b> · nivel ${esc(r.nivel)} · emitido el ${esc(r.emitido_en)}</div><p class="sub">El certificado acredita el nivel demostrado en el examen de la plataforma. No equivale al examen estatal ТРКИ; cada entidad decide si lo acepta.</p>` : `<div class="resultado mal">No existe un certificado con ese código.</div>`;
    } catch (e) { res.innerHTML = `<div class="resultado mal">No se pudo verificar ahora.</div>`; }
  };
  $app.querySelector('button').onclick = ir; if (codigo) ir();
}

async function router() {
  const [, r, p] = location.hash.split('?')[0].replace(/^#\/?/, '#/').split('/');
  try {
    if (r === 'verificar') return await vVerificar(decodeURIComponent(p || ''));
    if (r === 'nueva-clave') return vNuevaClave();
    if (r === 'pagar') return vPagar();
    if (r === 'terminos') return await vTerminos();
    if (!sesion) {
      if (r === 'registro') return vRegistro();
      if (r === 'recuperar') return vRecuperar();
      if (r === 'entrar') return vLogin();
      return vPublico();
    }
    if (perfil?.faltaTerminos && r !== 'salir') return await vAceptarTerminos();
    botonReporte();
    if (r === 'planes') return vPublico();
    if (r === 'examen') return await vExamen();
    if (r === 'ubicacion') return await vUbicacion();
    if (r === 'cuenta') return vCuenta();
    if (r === 'certificado' && p) return await vCertificado(p);
    if (['entrar', 'registro', 'recuperar'].includes(r)) { location.hash = '#/'; return; }
    if (r === 'salir') { await api.logout(); sesion = null; perfil = null; document.getElementById('reportar')?.remove(); location.hash = '#/'; return vPublico(); }
    if (r === 'e' && p) return await vEscenario(p);
    if (r === 'x' && p) return await vEjercicio(p);
    if (r === 'docente') return await vDocente(p || 'alumnos');
    return await vInicio();
  } catch (e) {
    console.error(e);
    $app.innerHTML = ''; $app.append(h(`<div class="tarjeta error">Algo salió mal: ${esc(e.message || e)}</div>`));
  }
}
async function iniciar() {
  sesion = await api.sesion();
  if (sesion) {
    try { perfil = await api.perfil(sesion.user.id); }
    catch { perfil = { rol: 'alumno', nombre: '' }; }
    if (perfil?.rol !== 'docente') {
      try { const a = await api.misAceptaciones(); perfil.faltaTerminos = !a.some(x => x.documento === 'cuenta' && x.version === TERMINOS_CUENTA); }
      catch { /* tabla aún no creada (SQL 20): no se bloquea */ }
    }
  }
  router();
}
window.addEventListener('hashchange', router);
iniciar();
