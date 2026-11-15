import { SUPABASE_URL, SUPABASE_KEY, NOMBRE_CURSO } from './config.js';
import { prepararModelo, estadoAlumno, siguienteTarea, etiquetaTema, HABILIDADES, HABILIDAD } from './motor.js';

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
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  const ok = r => { if (r.error) throw r.error; return r.data; };
  return {
    async sesion() { return (await sb.auth.getSession()).data.session; },
    async login(email, password) { ok(await sb.auth.signInWithPassword({ email, password })); },
    async logout() { await sb.auth.signOut(); },
    async perfil(uid) { return ok(await sb.from('perfiles').select('*').eq('id', uid).single()); },
    async todosEscenarios() { return ok(await sb.from('escenarios').select('*').order('orden')); },
    async ejerciciosLigeros() { return ok(await sb.from('ejercicios').select('id,tipo_ejercicio,escenario,gramatica_objetivo,instrucciones').order('id')); },
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
    async misIntentos() { return ok(await sb.from('intentos').select('ejercicio_id,correcto,puntaje,estado,feedback,creado_en').eq('alumno_id', sesion.user.id)); },
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
    async subirMedio(file, path) { ok(await sb.storage.from('materiales').upload(path, file, { upsert: true, contentType: file.type || undefined })); },
    async alumnos() { return ok(await sb.from('perfiles').select('*').order('nombre')); },
    async renombrar(id, nombre) { ok(await sb.from('perfiles').update({ nombre }).eq('id', id)); },
    async intentosDe(uid) { return ok(await sb.from('intentos').select('*').eq('alumno_id', uid).order('creado_en', { ascending: false })); },
    async pendientes() { return ok(await sb.from('intentos').select('*').in('estado', ['pendiente_docente', 'pendiente_ia']).order('creado_en')); },
    async revisar(id, campos) { ok(await sb.from('intentos').update(campos).eq('id', id)); },
  };
}

async function crearDemo() {
  const d = await (await fetch('demo/demo.json')).json();
  const intentos = JSON.parse(sessionStorage.getItem('demo_intentos') || '[]');
  const by = (t, id) => d[t].find(x => x.id === id);
  return {
    async sesion() { return { user: { id: 'demo', email: 'demo@demo' } }; },
    async login() {}, async logout() {},
    async perfil() { return { id: 'demo', nombre: 'Alumno de prueba', rol: new URLSearchParams(location.search).get('demo') === 'docente' ? 'docente' : 'alumno' }; },
    async todosEscenarios() { return d.escenarios; },
    async ejerciciosLigeros() { return d.ejercicios; },
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
    async upsert() {}, async subirMedio() {}, async alumnos() { return []; }, async intentosDe() { return []; }, async pendientes() { return []; }, async revisar() {}, async renombrar() {},
  };
}

// ---------------------------------------------------------------- medios
function rutasMedio(m) {
  if (m.tipo === 'audio') {
    if (/lento:/i.test(m.fuente || '')) return [['Versión lenta', `audio/${m.id}-lento.mp3`], ['Versión normal', `audio/${m.id}-rapido.mp3`]];
    return [['', `audio/${m.id}.mp3`]];
  }
  if (m.tipo === 'imagen') return [['', `img/${m.id}.jpg`]];
  return [];
}
async function bloqueMaterial(m, { mostrarTexto = true } = {}) {
  const div = h(`<div class="material"></div>`);
  if (m.tipo === 'audio') {
    for (const [etq, p] of rutasMedio(m)) {
      const u = await api.url('materiales', p);
      div.append(h(`<div>${etq ? `<div class="etq">${esc(etq)}</div>` : ''}${u ? `<audio controls preload="none" src="${esc(u)}"></audio>` : `<p class="error">Audio no disponible (${esc(p)})</p>`}</div>`));
    }
    if (m.transcripcion) div.append(h(`<details><summary>Ver transcripción</summary><div class="texto-ru">${esc(m.transcripcion)}</div></details>`));
  } else if (m.tipo === 'imagen') {
    const u = await api.url('materiales', `img/${m.id}.jpg`);
    div.append(u ? h(`<img loading="lazy" alt="${esc(m.titulo)}" src="${esc(u)}">`) : h(`<p class="error">Imagen no disponible</p>`));
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
    const f = h(`<div class="item"><div class="q">${esc(it.q)}</div></div>`);
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
        det.push({ q: it.q, r: v, c: correcta, ok });
        f.append(h(`<div class="marca-res ${ok ? 'ok' : 'mal'}">${ok ? '✓ Correcto' : `✗ Respuesta: <span class="correcta">${esc(correcta)}</span>`}</div>`));
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
    const det = resp.map(r => ({ q: 'palabra', r, c: '', ok: c.answers.some(g => igual(r, g)) }));
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
async function renderizar(ej) {
  const c = typeof ej.contenido === 'string' ? JSON.parse(ej.contenido) : ej.contenido;
  switch (c.tipo) {
    case 'match': return rMatch(c);
    case 'order': return rOrder(c);
    case 'clasificar': return rClasificar(c);
    case 'conjunto': return rConjunto(c);
    case 'repetir': case 'leer': return rOral(c, ej);
    case 'abierta': return rAbierta(c, ej);
    default: return rItems(c);
  }
}

// ---------------------------------------------------------------- vistas
function nav(activa) {
  if (!sesion) { $nav.innerHTML = ''; return; }
  const links = [['#/', 'Inicio', 'inicio']];
  if (perfil?.rol === 'docente') links.push(['#/docente', 'Panel docente', 'docente']);
  $nav.innerHTML = links.map(([u, t, k]) => `<a href="${u}" class="${k === activa ? 'activo' : ''}">${t}</a>`).join('') +
    `<span class="chip">${esc(perfil?.nombre || sesion.user.email)}</span>` + (DEMO ? '<span class="chip pend">demo</span>' : '<a href="#/salir">Salir</a>');
}

function vLogin(msg = '') {
  nav();
  $app.innerHTML = '';
  const f = h(`<form class="tarjeta login"><h1>${esc(NOMBRE_CURSO)}</h1><p class="sub">Entra con el correo y la contraseña que te dio tu profesor.</p>
    <div class="campo"><label>Correo</label><input type="email" required autocomplete="username"></div>
    <div class="campo"><label>Contraseña</label><input type="password" required autocomplete="current-password"></div>
    <p class="error">${esc(msg)}</p><button class="btn" type="submit">Entrar</button></form>`);
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

async function cargarModelo(intentos) {
  const [escenarios, ejercicios, tipos, temas] = await Promise.all([api.todosEscenarios(), api.ejerciciosLigeros(), api.tipos(), api.temas()]);
  return { m: prepararModelo({ escenarios, ejercicios, tipos, intentos, temas }), escenarios };
}

async function vInicio() {
  nav('inicio');
  $app.innerHTML = `<p class="cargando">Preparando tu próxima tarea…</p>`;
  const intentos = await api.misIntentos();
  const { m, escenarios } = await cargarModelo(intentos);
  const est = estadoAlumno(m), sig = siguienteTarea(m);
  const hoy = intentos.filter(i => new Date(i.creado_en).toDateString() === new Date().toDateString()).length;
  $app.innerHTML = `<h1>Привет${perfil?.nombre ? ', ' + esc(perfil.nombre) : ''}!</h1>
    <p class="sub">${hoy ? `Hoy llevas ${hoy} ${hoy === 1 ? 'tarea' : 'tareas'}. ¡Sigue así!` : 'Tu plan avanza paso a paso según lo que ya dominas.'}</p>`;

  const card = h(`<div class="tarjeta"></div>`);
  if (sig.tipo === 'fin') card.append(h(`<p class="instr">¡Completaste todo el contenido disponible! 🎉 Tu profesor agregará más pronto.</p>`));
  else {
    const e0 = sig.opciones[0];
    card.append(h(`<div class="etq">${sig.tipo === 'repaso' ? 'Repaso' : 'Siguiente paso'} · ${esc(e0.hab)}</div>`));
    if (sig.opciones.length === 1) {
      card.append(h(`<p class="instr">${esc(e0.instrucciones)}</p>`));
      card.append(h(`<div class="acciones"><a class="btn" href="#/x/${e0.id}">Empezar →</a></div>`));
    } else {
      card.append(h(`<p class="instr">Elige el tema con el que prefieres practicar:</p>`));
      const l = h(`<div class="lista"></div>`);
      sig.opciones.forEach(o => l.append(h(`<a class="fila" href="#/x/${o.id}"><div class="txt"><b>${esc(etiquetaTema(m, o, escenarios))}</b><small>${esc(o.instrucciones)}</small></div><span class="btn sec">Elegir</span></a>`)));
      card.append(l);
    }
  }
  $app.append(card);

  // progreso por habilidad y nivel (sin mostrar el temario)
  const pct = Math.round(100 * est.nivelGlobal);
  const prog = h(`<div class="tarjeta"><h2 style="margin-top:0">Tu progreso</h2>
    <div class="etq">Nivel A1 · ${pct} % completado</div><div class="barra-prog" style="max-width:none"><i style="width:${pct}%"></i></div>
    <div class="cuadricula" style="margin-top:14px"></div></div>`);
  const g = prog.querySelector('.cuadricula');
  for (const hb of HABILIDADES) {
    const r = est.porHab[hb]; const v = r && r.conNota ? Math.round(r.suma / r.conNota) : null;
    g.append(h(`<div><div class="etq">${hb}${r ? ` · ${r.n} ${r.n === 1 ? 'ejercicio' : 'ejercicios'}` : ''}</div><div class="barra-prog"><i style="width:${v ?? 0}%;background:${v == null ? '#ccc' : v >= 70 ? 'var(--ok)' : 'var(--pend)'}"></i></div></div>`));
  }
  $app.append(prog);

  const coment = intentos.filter(i => i.estado === 'revisado' && i.feedback).sort((a, b) => new Date(b.creado_en) - new Date(a.creado_en)).slice(0, 3);
  if (coment.length) {
    const c = h(`<div class="tarjeta"><h2 style="margin-top:0">Comentarios de tu profesor</h2></div>`);
    coment.forEach(i => c.append(h(`<div class="regla"><b><a href="#/x/${i.ejercicio_id}">Tarea ${esc(i.ejercicio_id)}</a>${i.puntaje != null ? ' · ' + Math.round(i.puntaje) + ' %' : ''}</b>${esc(i.feedback)}</div>`)));
    $app.append(c);
  }
  if (perfil.rol === 'docente') {
    const l = h(`<details class="tarjeta"><summary>Vista docente: recorrer las lecciones</summary><div class="lista" style="margin-top:10px"></div></details>`);
    est.filas.forEach(f => l.querySelector('.lista').append(h(`<a class="fila" href="#/e/${f.s.id}"><div class="txt"><b>${esc(f.s.id)} · ${esc(f.s.nombre)}</b><small>${f.total} ejercicios</small></div></a>`)));
    $app.append(l);
  }
}

async function vEscenario(id) {
  if (perfil?.rol !== 'docente') return vInicio();
  nav('inicio');
  $app.innerHTML = `<p class="cargando">Cargando…</p>`;
  const [e, ejs, mats, hechos] = await Promise.all([api.escenario(id), api.ejerciciosEsc(id), api.materialesEsc(id), progreso()]);
  $app.innerHTML = `<div class="migas"><a href="#/">← Mis lecciones</a></div><h1>${esc(e.nombre)}</h1><p class="sub">${esc(e.objetivo_comunicativo || '')}</p>`;
  const textos = mats.filter(m => m.tipo === 'texto' && m.funcion === 'introduccion');
  if (textos.length) {
    const t = h(`<details class="tarjeta"><summary>Textos de la lección (${textos.length})</summary></details>`);
    for (const m of textos) t.append(await bloqueMaterial(m));
    $app.append(t);
  }
  $app.append(h(`<h2>Ejercicios</h2>`));
  const lista = h(`<div class="lista"></div>`);
  ejs.forEach((x, i) => {
    const r = hechos.get(x.id);
    const chip = !r ? '' : r.estado?.startsWith('pendiente') ? '<span class="chip pend">enviado</span>' : r.estado === 'revisado' ? `<span class="chip ok">revisado</span>` : `<span class="chip ${r.correcto ? 'ok' : 'mal'}">${Math.round(r.puntaje ?? 0)} %</span>`;
    lista.append(h(`<a class="fila" href="#/x/${x.id}"><div class="num">${i + 1}</div><div class="txt"><b>${esc(x.instrucciones)}</b></div>${chip}</a>`));
  });
  $app.append(lista);
}

async function vEjercicio(id) {
  nav('inicio');
  $app.innerHTML = `<p class="cargando">Cargando…</p>`;
  const ej = await api.ejercicio(id);
  const c = typeof ej.contenido === 'string' ? JSON.parse(ej.contenido) : ej.contenido;
  const hermanos = (await api.ejerciciosEsc(ej.escenario)).map(x => x.id);
  const pos = hermanos.indexOf(id), sig = hermanos[pos + 1];
  const matIds = [...new Set([...ids(ej.material), ...(c.imagen ? [c.imagen] : [])])];
  const mats = await api.materiales(matIds);
  mats.sort((a, b) => matIds.indexOf(a.id) - matIds.indexOf(b.id));

  $app.innerHTML = perfil.rol === 'docente' ? `<div class="migas"><a href="#/e/${ej.escenario}">← ${esc(ej.escenario)}</a> · ejercicio ${pos + 1} de ${hermanos.length}</div>` : `<div class="migas"><a href="#/">← Inicio</a></div>`;
  const card = h(`<div class="tarjeta"><p class="instr">${esc(ej.instrucciones)}</p><div class="media"></div><div class="cuerpo"></div><div class="res"></div><div class="acciones"></div></div>`);
  $app.append(card);
  const media = card.querySelector('.media');
  const esLectura = ['leer'].includes(c.tipo);
  for (const m of mats) if (!(esLectura && m.tipo === 'texto')) media.append(await bloqueMaterial(m));

  const r = await renderizar(ej);
  card.querySelector('.cuerpo').append(r.el);
  const acc = card.querySelector('.acciones'), res = card.querySelector('.res');
  const bEnviar = h(`<button class="btn" type="button">${r.abierta ? 'Enviar' : 'Comprobar'}</button>`);
  acc.append(bEnviar);
  bEnviar.onclick = async () => {
    bEnviar.disabled = true; res.innerHTML = '';
    try {
      const out = await r.corregir();
      if (out.abierta) {
        await api.guardarIntento({ ejercicio_id: id, respuesta: out.respuesta, audio_path: out.audio || null, correcto: null, puntaje: null,
          estado: (out.respuesta?.texto || out.audio) ? 'pendiente_docente' : 'corregido' });
        res.append(h(`<div class="resultado pend">${out.audio || out.respuesta?.texto ? 'Enviado. Tu profesor lo revisará y verás sus comentarios aquí.' : 'Práctica registrada.'}</div>`));
      } else {
        const puntaje = Math.round(100 * out.bien / out.total);
        await api.guardarIntento({ ejercicio_id: id, respuesta: { valores: out.respuesta, detalle: out.detalle }, correcto: puntaje === 100, puntaje, estado: 'corregido' });
        res.append(h(`<div class="resultado ${puntaje === 100 ? 'ok' : 'mal'}">${puntaje === 100 ? '¡Perfecto! ' : ''}${out.bien} de ${out.total} correctas (${puntaje} %)${out.flexible && puntaje < 100 ? ' · en este ejercicio se aceptan variantes razonables' : ''}</div>`));
        if (puntaje < 100) {
          const reglas = await api.gramatica(ids(ej.gramatica_objetivo));
          for (const g of reglas) res.append(h(`<div class="regla"><b>Repasa: ${esc(g.nombre)}</b>${esc(g.descripcion || '')}${g.ejemplo ? `<div class="ej">${esc(g.ejemplo)}</div>` : ''}</div>`));
        }
      }
      acc.innerHTML = '';
      const bOtra = h(`<button class="btn sec" type="button">Intentar de nuevo</button>`); bOtra.onclick = () => vEjercicio(id); acc.append(bOtra);
      acc.append(h(`<a class="btn" href="#/">Siguiente tarea →</a>`));
    } catch (err) { res.append(h(`<p class="error">${esc(err.message || 'No se pudo guardar. Revisa tu conexión.')}</p>`)); bEnviar.disabled = false; }
  };
}

// ---------------------------------------------------------------- panel docente
const TABLAS = { habilidades: 'habilidades', gramatica: 'gramatica', pronunciacion: 'pronunciacion', vocabulario: 'vocabulario', temas: 'temas',
  escenarios: 'escenarios', tipos_ejercicio: 'tipos_ejercicio', materiales: 'materiales', ejercicios: 'ejercicios' };
const COLS = {
  habilidades: ['id','nombre','descripcion','como_se_mide','estandar_a1','estandar_a2','estandar_b1','estandar_b2','estandar_c1'],
  gramatica: ['id','nombre','nivel','descripcion','prerrequisitos','ejemplo'], pronunciacion: ['id','nombre','nivel','descripcion','prerrequisitos','ejemplo'],
  vocabulario: ['id','lema','traduccion','categoria','nivel','escenarios','temas'], temas: ['id','nombre'],
  escenarios: ['id','nombre','nivel','temas','orden','prerrequisitos','objetivo_comunicativo','gramatica_foco','pronunciacion_foco'],
  materiales: ['id','titulo','tipo','fuente','inicio','fin','nivel','escenarios','temas','gramatica_presente','transcripcion','licencia','origen','revisado','funcion'],
  tipos_ejercicio: ['id','nombre','descripcion','habilidades_principales','habilidades_secundarias','material','tipos_material_compatibles','generable_ia','equivalente_h5p','nivel_minimo'],
  ejercicios: ['id','tipo_ejercicio','material','escenario','gramatica_objetivo','vocabulario_objetivo','instrucciones','contenido'],
};
const ORDEN_IMPORT = ['habilidades','gramatica','pronunciacion','temas','vocabulario','escenarios','tipos_ejercicio','materiales','ejercicios'];

async function vDocente(tab = 'alumnos') {
  if (perfil?.rol !== 'docente') return vInicio();
  nav('docente');
  $app.innerHTML = `<h1>Panel docente</h1>`;
  const pes = h(`<div class="pestanas"></div>`);
  [['alumnos', 'Alumnos'], ['revisar', 'Por revisar'], ['contenido', 'Contenido y medios']].forEach(([k, t]) => {
    const b = h(`<button class="${k === tab ? 'activo' : ''}">${t}</button>`); b.onclick = () => location.hash = `#/docente/${k}`; pes.append(b);
  });
  $app.append(pes);
  const cuerpo = h(`<div></div>`); $app.append(cuerpo);
  if (tab === 'contenido') return tContenido(cuerpo);
  if (tab === 'revisar') return tRevisar(cuerpo);
  if (tab.startsWith('alumno-')) return tAlumno(cuerpo, tab.slice(7));
  return tAlumnos(cuerpo);
}

async function tAlumnos(el) {
  const [ps] = await Promise.all([api.alumnos()]);
  const al = ps.filter(p => p.rol === 'alumno');
  el.append(h(`<p class="sub">Para agregar un alumno: Supabase → Authentication → Users → Add user (marca «Auto Confirm User»). Aparecerá aquí automáticamente y empezará por el principio; la plataforma decide cada tarea según su avance.</p>`));
  if (!al.length) { el.append(h(`<div class="tarjeta">Aún no hay alumnos.</div>`)); return; }
  const lista = h(`<div class="lista"></div>`);
  al.forEach(p => lista.append(h(`<a class="fila" href="#/docente/alumno-${p.id}"><div class="txt"><b>${esc(p.nombre || '(sin nombre)')}</b><small>nivel ${esc(p.nivel || '')}</small></div></a>`)));
  el.append(lista);
}

async function tAlumno(el, uid) {
  const [ps, ints, gram] = await Promise.all([api.alumnos(), api.intentosDe(uid), api.gramaticaTodas()]);
  const { m, escenarios } = await cargarModelo(ints);
  const est = estadoAlumno(m);
  const p = ps.find(x => x.id === uid) || {};
  el.append(h(`<div class="migas"><a href="#/docente/alumnos">← Alumnos</a></div>`));
  const nom = h(`<div class="campo"><label>Nombre visible</label><div style="display:flex;gap:8px"><input type="text" value="${esc(p.nombre || '')}"><button class="btn sec" type="button">Guardar</button></div></div>`);
  nom.querySelector('button').onclick = async () => { await api.renombrar(uid, nom.querySelector('input').value.trim()); nom.querySelector('button').textContent = 'Guardado ✓'; };
  el.append(nom);

  const corr = ints.filter(i => i.puntaje != null);
  const media = corr.length ? Math.round(corr.reduce((s, i) => s + Number(i.puntaje), 0) / corr.length) : null;
  const dias = new Set(ints.map(i => new Date(i.creado_en).toDateString())).size;
  const actual = est.filas[est.actual];
  el.append(h(`<div class="tarjeta"><b>${ints.length}</b> intentos en <b>${dias}</b> ${dias === 1 ? 'día' : 'días'} · promedio <b>${media ?? '—'}${media != null ? ' %' : ''}</b> · último: ${ints[0] ? new Date(ints[0].creado_en).toLocaleString() : '—'}<br>
    Avance A1: <b>${Math.round(100 * est.nivelGlobal)} %</b> · trabajando en: <b>${esc(actual ? actual.s.id + ' · ' + actual.s.nombre : '—')}</b> (${actual ? actual.hechos + '/' + actual.total : ''})</div>`));

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

async function tRevisar(el) {
  const [pend, ps] = await Promise.all([api.pendientes(), api.alumnos()]);
  const nombre = id => ps.find(p => p.id === id)?.nombre || id.slice(0, 8);
  if (!pend.length) { el.append(h(`<div class="tarjeta">No hay tareas pendientes. 🎉</div>`)); return; }
  const ejs = {}; for (const i of pend) ejs[i.ejercicio_id] ||= await api.ejercicio(i.ejercicio_id);
  for (const i of pend) {
    const ej = ejs[i.ejercicio_id]; const c = typeof ej.contenido === 'string' ? JSON.parse(ej.contenido) : ej.contenido;
    const card = h(`<div class="tarjeta"><div class="etq">${esc(nombre(i.alumno_id))} · ${new Date(i.creado_en).toLocaleString()} · <a href="#/x/${ej.id}">${ej.id}</a></div>
      <p class="instr">${esc(ej.instrucciones)}</p>${c.criterios ? `<p class="sub">Criterios: ${esc(c.criterios)}</p>` : ''}
      ${i.respuesta?.texto ? `<div class="texto-ru">${esc(i.respuesta.texto)}</div>` : ''}<div class="aud"></div>
      <div class="campo"><label>Comentario para el alumno</label><textarea></textarea></div>
      <div class="acciones"><input type="number" min="0" max="100" placeholder="Puntaje 0–100" style="width:150px"><button class="btn" type="button">Guardar revisión</button></div></div>`);
    if (i.audio_path) { const u = await api.url('grabaciones', i.audio_path); if (u) card.querySelector('.aud').append(h(`<audio controls src="${esc(u)}"></audio>`)); }
    card.querySelector('button').onclick = async () => {
      const pts = card.querySelector('input').value;
      await api.revisar(i.id, { feedback: card.querySelector('textarea').value, puntaje: pts === '' ? null : Number(pts), correcto: pts === '' ? null : Number(pts) >= 60, estado: 'revisado' });
      card.replaceWith(h(`<div class="tarjeta exito">Revisión guardada ✓</div>`));
    };
    el.append(card);
  }
}

async function tContenido(el) {
  el.append(h(`<div class="tarjeta"><h2 style="margin-top:0">1 · Importar la hoja de contenido</h2>
    <p class="sub">En Google Sheets: Archivo → Descargar → Microsoft Excel (.xlsx). Sube ese archivo aquí. Puedes repetirlo cada vez que cambies la hoja: actualiza filas existentes y agrega las nuevas.</p>
    <input type="file" accept=".xlsx" id="fx"> <button class="btn" id="bx" type="button">Importar</button></div>`));
  el.append(h(`<div class="tarjeta"><h2 style="margin-top:0">2 · Subir audios e imágenes</h2>
    <p class="sub">Selecciona todos los archivos de las carpetas <b>audio</b> e <b>img</b> (nombres tipo M003.mp3, M004.jpg). Se guardan en Supabase y los alumnos los ven sin cuenta de Google.</p>
    <input type="file" multiple accept=".mp3,.jpg,.jpeg,.png,.webp" id="fm"> <button class="btn" id="bm" type="button">Subir</button></div>`));
  const log = h(`<div class="log" hidden></div>`); el.append(log);
  const out = s => { log.hidden = false; log.textContent += s + '\n'; log.scrollTop = log.scrollHeight; };

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
        const o = {}; for (const c of COLS[t]) o[c] = r[c] === '' ? null : r[c] ?? null;
        o.id = String(o.id).trim();
        if (t === 'escenarios') o.orden = o.orden == null ? null : Number(o.orden);
        if (t === 'ejercicios') { try { o.contenido = o.contenido ? JSON.parse(o.contenido) : null; } catch { malas++; continue; } }
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
      const carpeta = /\.mp3$/i.test(f.name) ? 'audio' : 'img';
      try { await api.subirMedio(f, `${carpeta}/${f.name}`); ok++; if (ok % 10 === 0) out(`… ${ok} de ${files.length}`); }
      catch (e) { err++; out(`✗ ${f.name}: ${e.message}`); }
    }
    out(`Listo: ${ok} subidos${err ? `, ${err} con error` : ''}.`);
  };
}

// ---------------------------------------------------------------- arranque y rutas
async function router() {
  const [, r, p] = location.hash.replace(/^#\/?/, '#/').split('/');
  try {
    if (!sesion) return vLogin();
    if (r === 'salir') { await api.logout(); sesion = null; perfil = null; location.hash = '#/'; return vLogin(); }
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
  }
  router();
}
window.addEventListener('hashchange', router);
iniciar();
