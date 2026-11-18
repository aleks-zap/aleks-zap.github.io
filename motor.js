// ============================================================
// Motor de progresión adaptativa
//  · Cada ejercicio declara prerrequisitos: palabras (V…), reglas de
//    gramática (G…) y pronunciación (P…), y ejercicios previos (EJ…).
//  · Antes de un ejercicio se presenta explícitamente toda regla y
//    palabra que el alumno aún no conoce (con las reglas previas que
//    exige cada regla, según hojas Gramática y Pronunciación).
//  · Dentro de un escenario se elige el ejercicio que menos cosas
//    nuevas exige, alternando habilidades.
//  · Solo al terminar un escenario el alumno elige el siguiente entre
//    2–3 opciones con poca carga nueva respecto a lo que ya sabe.
//  · Se intercalan repasos de lo fallado y de lo aprendido hace tiempo.
// ============================================================

export const HABILIDAD = {
  H01: 'vocabulario', H02: 'gramática', H03: 'lectura', H04: 'lectura', H05: 'escucha',
  H06: 'escritura', H07: 'habla', H08: 'escritura', H09: 'pronunciación',
};
export const HABILIDADES = ['pronunciación', 'vocabulario', 'gramática', 'lectura', 'escritura', 'escucha', 'habla'];

const APROBADO = 70;            // puntaje para considerar hecho un ejercicio
const DOMINIO_ESCENARIO = 0.8;  // fracción de ejercicios aprobados para terminar un escenario
const REPASO_CADA = 4;          // reintento de lo fallado: 1 de cada N tareas
const INTERVALOS_DIAS = [1, 3, 7, 21, 60];
const PESO_REGLA = 12;          // una regla nueva "pesa" como 12 palabras nuevas
export const PALABRAS_POR_TARJETA = 12;

export const ALFABETO = [['EJ0003', 'АОКМТ'], ['EJ0007', 'СРУВХЕН'], ['EJ0013', 'БИЛГПДФЗЭ'], ['EJ0018', 'ЖЧЦШЩЮЯЁЙЫЬЪ']];
export const ORALES = new Set(['TE01', 'TE15', 'TE17']);   // escuchar y repetir, producción oral, leer en voz alta
const lista = s => String(s || '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
const DIA = 864e5;

export function prepararModelo({ escenarios, ejercicios, tipos, intentos, eventos = [], reglas = [], temas, formas = { f: {}, m: {} }, vocab = {}, ahora = Date.now(), oralesZoom = false }) {
  const tipoHab = Object.fromEntries(tipos.map(t => [t.id, HABILIDAD[lista(t.habilidades_principales)[0]] || 'gramática']));
  const nombreTema = Object.fromEntries((temas || []).map(t => [t.id, t.nombre]));
  const regla = Object.fromEntries(reglas.map(r => [r.id, r]));
  const porEj = new Map();
  const ordenados = [...intentos].sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en));
  for (const i of ordenados) {
    const h = porEj.get(i.ejercicio_id) || { n: 0, exitos: 0, ultimo: null, ultimoPuntaje: null, abierto: false };
    h.n++; h.ultimo = new Date(i.creado_en).getTime();
    if (i.puntaje != null) { h.ultimoPuntaje = Number(i.puntaje); if (h.ultimoPuntaje >= APROBADO) h.exitos++; }
    else h.abierto = true;
    porEj.set(i.ejercicio_id, h);
  }
  // cierre de reglas: cada regla arrastra sus prerrequisitos (orden: primero las bases)
  const memo = new Map();
  const cierre = (ids) => {
    const out = [], vis = new Set();
    const visitar = (g, prof = 0) => {
      if (vis.has(g) || prof > 30) return; vis.add(g);
      for (const q of lista(regla[g]?.prerrequisitos)) visitar(q, prof + 1);
      out.push(g);
    };
    ids.forEach(g => visitar(g));
    return out;
  };
  const ejs = ejercicios.map(e => {
    const pr = lista(e.prerrequisitos);
    const gp = pr.filter(x => /^[GP]\d/.test(x));
    return {
      ...e, hab: (HABILIDADES.includes(e.categoria) && e.categoria) || tipoHab[e.tipo_ejercicio] || 'gramática', gram: lista(e.gramatica_objetivo),
      reqEj: pr.filter(x => /^EJ/.test(x)), reqReglas: cierre(gp), reqV: pr.filter(x => /^V\d/.test(x)),
      reqG: [...new Set([...lista(e.gramatica_objetivo), ...pr.filter(x => /^G\d/.test(x))])],
    };
  });
  // Ninguna regla se presenta antes de conocer las letras que usan sus ejemplos y explicación:
  // cada ejercicio hereda como prerrequisito los grupos del alfabeto que piden sus reglas.
  const alf = ALFABETO.filter(([id]) => ejs.some(e => e.id === id)).map(([id]) => id);
  const grupoDe = {}; ALFABETO.forEach(([id, ls]) => [...ls].forEach(l => grupoDe[l] = id));
  const gruposRegla = g => {
    const r = regla[g]; if (!r) return [];
    const txt = [r.nombre, r.descripcion, r.ejemplo, r.explicacion].join(' ').toUpperCase();
    const k = Math.max(-1, ...[...new Set(txt.match(/[А-ЯЁ]/g) || [])].map(l => alf.indexOf(grupoDe[l])));
    return alf.slice(0, k + 1);
  };
  for (const e of ejs) {
    if (alf.includes(e.id)) { e.reqReglas = []; continue; }        // las letras se presentan sin reglas previas
    const extra = e.reqReglas.flatMap(gruposRegla);
    if (extra.length) e.reqEj = [...new Set([...e.reqEj, ...extra])];
  }
  const ctx = { formas };
  for (const e of ejs) Object.assign(e, focoEjercicio(ctx, e));
  const porId = new Map(ejs.map(e => [e.id, e]));
  // lo que el alumno ya conoce: lo presentado + lo que exigían los ejercicios que ya hizo
  const conocidos = new Set(eventos.filter(v => v.tipo === 'intro').map(v => v.ref));
  for (const id of porEj.keys()) { const e = porId.get(id); if (e) { e.reqReglas.forEach(x => conocidos.add(x)); e.reqV.forEach(x => conocidos.add(x)); (e.ensena || []).forEach(x => conocidos.add(x)); } }
  const elegidos = eventos.filter(v => v.tipo === 'escenario').sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en)).map(v => v.ref);
  const esc = escenarios.filter(s => ejs.some(e => e.escenario === s.id)).sort((a, b) => (a.orden ?? 999) - (b.orden ?? 999));
  // ejercicios orales que se hacen en la clase por Zoom (pendientes o ya hechos)
  const zoomPend = new Set(eventos.filter(v => v.tipo === 'zoom').map(v => v.ref));
  const zoomOk = new Set(eventos.filter(v => v.tipo === 'zoom_ok').map(v => v.ref));
  const enZoom = id => zoomPend.has(id) || zoomOk.has(id);
  const intentado = id => porEj.has(id) || enZoom(id);
  const base = new Set(ejs.flatMap(e => e.reqEj));               // ejercicios de los que dependen otros (alfabeto)
  for (const e of ejs) { e.oral = ORALES.has(e.tipo_ejercicio); e.base = base.has(e.id); }
  const hecho = e => { if (enZoom(e.id)) return true; const h = porEj.get(e.id); return !!h && (h.abierto || (h.ultimoPuntaje ?? 0) >= APROBADO || h.exitos > 0); };
  const ultimoHab = ordenados.length ? porId.get(ordenados[ordenados.length - 1].ejercicio_id)?.hab : null;
  // bancos: ejercicios con el mismo «grupo» comparten preguntas; «n» = cuántas mostrar
  const grupos = new Map();
  for (const e of ejs) {
    const c = contenidoDe(e); e.nMostrar = c.n || null; e.grupo = c.grupo || null;
    e.itemsBanco = (c.items || []).map((it, i) => ({ ej: e.id, i, it, temas: lista((it.temas || []).join(';')), v: [...new Set(idsEnTexto(ctx, [it.q, ...(it.answers || []), it.answer, ...(it.options || [])].filter(Boolean).join(' '), new Set(e.reqV)))] }));
    if (e.grupo) { if (!grupos.has(e.grupo)) grupos.set(e.grupo, []); grupos.get(e.grupo).push(...e.itemsBanco); }
  }
  const vistos = new Set();                                       // preguntas ya presentadas a este alumno (por texto)
  for (const i of ordenados) for (const d of i.respuesta?.detalle || []) vistos.add(normW(d.q));
  const sorteos = new Map();                                      // última selección de preguntas por ejercicio
  for (const v of eventos) if (v.tipo === 'sorteo') { const [id, sel] = v.ref.split('|'); sorteos.set(id, { sel: sel.split(',').filter(Boolean), t: Date.parse(v.creado_en) }); }
  const m = { ejs, porId, esc, porEj, hecho, grupos, vistos, sorteos, nombreTema, regla, conocidos, elegidos, ultimoHab, totalIntentos: intentos.length, memo,
    formas, vocab, eventos, intentosOrd: ordenados, ahora, oralesZoom, zoomPend, zoomOk, intentado };
  m.mem = memoria(m);
  return m;
}

// ---------- repetición espaciada ----------
const normW = s => String(s ?? '').toLowerCase().replace(/\u0301/g, '').replace(/ё/g, 'е');
function idsEnTexto(ctx, texto, permitidos) {
  const out = [], t = normW(texto);
  if (!t) return out;
  const ok = id => !permitidos || permitidos.has(id);
  for (const [frase, id] of Object.entries(ctx.formas.m || {})) if (ok(id) && t.includes(frase)) out.push(id);
  for (const w of t.match(/[а-я]+(?:-[а-я]+)*/g) || []) {
    let c = ctx.formas.f[w]; if (!c) continue;
    if (!Array.isArray(c)) c = [c];
    const id = c.find(x => ok(x)); if (id) out.push(id);
  }
  return out;
}
const AUTOCORREGIBLE = new Set(['items', 'match', 'order', 'clasificar', 'conjunto', 'descubrir', 'trazo']);
function contenidoDe(e) { try { return typeof e.contenido === 'string' ? JSON.parse(e.contenido) : (e.contenido || {}); } catch { return {}; } }
// palabras que un ejercicio hace practicar: focoV (reconocer o producir) y focoP (producir escribiendo)
function focoEjercicio(ctx, e) {
  const c = contenidoDe(e), perm = new Set(e.reqV), tipo = c.tipo || (c.items ? 'items' : '');
  const ver = [], prod = [];
  for (const it of c.items || []) {
    ver.push(it.q);                                   // solo lo que queda registrado en el detalle (pregunta y respuesta)
    if (it.tipo === 'choice') ver.push(it.answer); else prod.push((it.answers || [])[0]);
  }
  for (const p of c.pairs || []) ver.push(p[0]);
  ver.push(...(c.tiles || []), ...Object.values(c.categorias || {}).flat());
  // tarjetas para descubrir: enseñan sus palabras (no son prerrequisito) y se practican como reconocimiento
  const ensena = tipo === 'descubrir' ? [...new Set((c.tarjetas || []).flatMap(t => idsEnTexto(ctx, t.ru, null)))] : [];
  ver.push(...(c.tarjetas || []).map(t => t.ru));
  if (tipo === 'conjunto') prod.push(...(c.answers || []).map(a => Array.isArray(a) ? a[0] : a));
  const focoP = new Set(prod.flatMap(t => idsEnTexto(ctx, t, perm)));
  const permV = new Set([...perm, ...ensena]);
  const focoV = new Set([...ver.flatMap(t => idsEnTexto(ctx, t, permV)), ...focoP]);
  const n = (c.items || c.pairs || c.tiles || c.answers || []).length || Object.values(c.categorias || {}).flat().length;
  return { tipoC: tipo, autoc: AUTOCORREGIBLE.has(tipo), focoV, focoP, nItems: n || (c.tarjetas || c.elementos || []).length, ensena };
}
// estado de memoria por palabra y regla: { reps, due }
function memoria(m, hasta = Infinity) {
  const evs = [];
  for (const v of m.eventos) {
    if (v.tipo === 'intro') evs.push({ id: v.ref, t: Date.parse(v.creado_en), intro: true });
    if (v.tipo === 'tarjeta' || v.tipo === 'produccion') { const [id, ok, modo] = v.ref.split('|'); evs.push({ id, t: Date.parse(v.creado_en), ok: ok === '1', prod: modo === 'p' }); }
  }
  for (const i of m.intentosOrd) {
    const e = m.porId.get(i.ejercicio_id); if (!e) continue;
    const t = Date.parse(i.creado_en);
    if (i.puntaje != null) for (const g of e.reqG) evs.push({ id: g, t, ok: Number(i.puntaje) >= APROBADO, prod: true });
    const perm = new Set([...e.reqV, ...(e.ensena || [])]);
    for (const d of i.respuesta?.detalle || []) {
      for (const id of idsEnTexto(m, d.c, perm)) evs.push({ id, t, ok: !!d.ok, prod: !!d.p });
      for (const id of idsEnTexto(m, d.q, perm)) evs.push({ id, t, ok: !!d.ok, prod: false });
    }
  }
  evs.sort((a, b) => a.t - b.t);
  const st = new Map();
  for (const ev of evs) {
    if (ev.t > hasta) break;
    let s = st.get(ev.id);
    if (!s) { s = { reps: 0, due: ev.t + DIA, ult: ev.t, diasOk: new Set(), ultimos: [] }; st.set(ev.id, s); }
    if (ev.intro) continue;
    const activa = m.vocab[ev.id]?.uso === 'activo';
    if (activa && !ev.prod && ev.ok) continue;                  // reconocer una palabra activa no basta
    // historial para medir dominio (independiente del calendario): días con acierto y últimos 5 resultados
    if (ev.ok) s.diasOk.add(Math.floor(ev.t / DIA));
    s.ultimos.push(!!ev.ok); if (s.ultimos.length > 5) s.ultimos.shift();
    if (!ev.ok) { s.reps = 0; s.due = ev.t + DIA; }
    else if (s.reps === 0 || ev.t >= s.due) { s.reps++; s.due = ev.t + INTERVALOS_DIAS[Math.min(s.reps - 1, INTERVALOS_DIAS.length - 1)] * DIA; }
    s.ult = ev.t;
  }
  return st;
}
// dominio robusto: aciertos en al menos 2 días distintos y ≥ 80 % de aciertos en los últimos intentos
const tasa = s => s.ultimos.length ? s.ultimos.filter(Boolean).length / s.ultimos.length : 0;
export const dominada = s => !!s && s.diasOk.size >= 2 && tasa(s) >= 0.8;
export const reconocida = s => !!s && s.diasOk.size >= 1 && tasa(s) >= 0.6;
export function resumenPalabras(m, mem = m.mem) {
  let activas = 0, reconocidas = 0;
  for (const [id, s] of mem) {
    if (!/^V/.test(id) || !reconocida(s)) continue;
    reconocidas++;
    if (m.vocab[id]?.uso === 'activo' && dominada(s)) activas++;
  }
  return { activas, reconocidas };
}
export const fechaLocal = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const MAX_V_DIA = 25, MAX_G_DIA = 3, MAX_EJ_DIA = 3;
// Freno de material nuevo cuando se acumula repaso (como Anki)
const UMBRAL_ATRASO = 50;       // palabras y reglas vencidas a partir de las cuales se frena lo nuevo
const MAX_RONDAS_DIA = 3;       // rondas de repaso por día como máximo
const NUEVOS_CON_FRENO = 3;     // ejercicios nuevos permitidos por día mientras haya atraso
export function atraso(m) {
  const fin = new Date(m.ahora); fin.setHours(23, 59, 59, 999);
  let n = 0;
  for (const [id, s] of m.mem) if (/^[VG]/.test(id) && s.due <= +fin && m.conocidos.has(id)) n++;
  return n;
}
// Repaso del día: lo que toca según calendario, consolidado en pocos ejercicios ya conocidos + tarjetas de palabras
export function planRepaso(m) {
  const fin = new Date(m.ahora); fin.setHours(23, 59, 59, 999);
  const vencidos = [...m.mem.entries()].filter(([id, s]) => s.due <= +fin && m.conocidos.has(id)).sort((a, b) => a[1].due - b[1].due);
  const V = vencidos.filter(([id]) => /^V/.test(id)).slice(0, MAX_V_DIA).map(([id]) => id);
  const G = vencidos.filter(([id]) => /^G/.test(id)).slice(0, MAX_G_DIA).map(([id]) => id);
  if (!V.length && !G.length) return null;
  const pend = new Set([...V, ...G]);
  // ejercicios-banco: valen si tienen suficientes preguntas solo con palabras conocidas (las del libro de práctica entran aquí)
  const conocidosBanco = e => (e.grupo ? m.grupos.get(e.grupo) : e.itemsBanco).filter(x => x.v.every(id => m.conocidos.has(id)));
  const cand = m.ejs.filter(e => e.autoc && disponible(m, e) && !nuevoDe(m, e).reglas.length &&
    (e.nMostrar ? conocidosBanco(e).length >= e.nMostrar : !nuevoDe(m, e).palabras.length));
  const cubre = e => {
    if (e.nMostrar) { const V = new Set(conocidosBanco(e).flatMap(x => x.v)); return [...pend].filter(id => /^[GP]/.test(id) ? e.reqG.includes(id) : V.has(id)); }
    return [...pend].filter(id => /^[GP]/.test(id) ? e.reqG.includes(id) : (m.vocab[id]?.uso === 'activo' ? e.focoP.has(id) : e.focoV.has(id)));
  };
  const ejercicios = [];
  while (ejercicios.length < MAX_EJ_DIA && pend.size) {
    let mejor = null, mg = [];
    for (const e of cand) {
      if (ejercicios.includes(e.id)) continue;
      const g = cubre(e);
      const reciente = (m.porEj.get(e.id)?.ultimo || 0) > m.ahora - DIA;
      if (g.length > mg.length || (g.length === mg.length && mejor && !reciente && e.nItems < mejor.nItems)) { mejor = e; mg = g; }
    }
    if (!mejor || mg.length < 2) break;
    ejercicios.push(mejor.id); mg.forEach(id => pend.delete(id));
  }
  const tarjetas = [...pend].filter(id => /^V/.test(id) && m.vocab[id]);
  return { ejercicios, tarjetas };
}

// ---------- estado ----------
export function estadoAlumno(m) {
  const filas = m.esc.map(s => {
    const propios = m.ejs.filter(e => e.escenario === s.id);
    const h = propios.filter(m.hecho).length, intentados = propios.filter(e => m.intentado(e.id)).length;
    const frac = propios.length ? h / propios.length : 1;
    return { s, total: propios.length, hechos: h, intentados, frac, terminado: intentados === propios.length && frac >= DOMINIO_ESCENARIO };
  });
  const fila = Object.fromEntries(filas.map(f => [f.s.id, f]));
  // escenario actual: el último elegido que no esté terminado; si no hay, el último con actividad sin terminar
  let actual = [...m.elegidos].reverse().find(id => fila[id] && !fila[id].terminado) || null;
  if (!actual) actual = filas.find(f => f.intentados > 0 && !f.terminado)?.s.id || null;
  const porHab = {};
  for (const e of m.ejs) {
    const h = m.porEj.get(e.id); if (!h) continue;
    const r = porHab[e.hab] ||= { n: 0, suma: 0, conNota: 0 };
    r.n++; if (h.ultimoPuntaje != null) { r.suma += h.ultimoPuntaje; r.conNota++; }
  }
  const tot = filas.reduce((s, f) => s + f.total, 0);
  const nivelGlobal = tot ? filas.reduce((s, f) => s + f.hechos, 0) / tot : 0;
  return { filas, fila, actual, porHab, nivelGlobal };
}

// lo nuevo que exige un ejercicio para este alumno
export function nuevoDe(m, e) {
  const sel = seleccionActiva(m, e);
  const V = sel ? [...new Set(sel.flatMap(r => itemDeRef(m, r)?.v || []))] : e.reqV;
  return { reglas: e.reqReglas.filter(x => !m.conocidos.has(x)), palabras: V.filter(x => !m.conocidos.has(x)) };
}
// ---------- bancos de preguntas ----------
export function itemDeRef(m, ref) { const [id, i] = ref.split('.'); return m.porId.get(id)?.itemsBanco?.[Number(i)]; }
// selección vigente: la sorteada para este ejercicio y aún no usada en un intento
export function seleccionActiva(m, e) {
  const s = m.sorteos.get(e.id); if (!s) return null;
  const usado = m.intentosOrd.some(i => i.ejercicio_id === e.id && Date.parse(i.creado_en) >= s.t);
  return usado ? null : s.sel;
}
function temasInteres(m) {
  const actual = estadoAlumno(m).actual;
  const tAct = new Set(lista(m.esc.find(s => s.id === actual)?.temas));
  const tInt = new Set(m.elegidos.flatMap(id => lista(m.esc.find(s => s.id === id)?.temas)));
  return { tAct, tInt };
}
const hashStr = s => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
// Elige las preguntas a mostrar: primero no vistas, luego con menos palabras desconocidas,
// luego las del tema del escenario actual y de los temas elegidos por el alumno, y las que cubren repaso pendiente.
export function sortearPreguntas(m, e, { cubrir = new Set() } = {}) {
  if (!e.nMostrar || !e.itemsBanco.length) return null;
  const pool = e.grupo ? m.grupos.get(e.grupo) : e.itemsBanco;
  const { tAct, tInt } = temasInteres(m);
  const dia = fechaLocal(m.ahora);
  // Orden estricto por niveles:
  //  1) no vistas, solo con palabras conocidas, del tema del escenario actual o de temas elegidos
  //  2) no vistas, solo con palabras conocidas (otros temas)
  //  3) ya vistas, solo con palabras conocidas (si no alcanza)
  //  4) con menos palabras nuevas (que se presentan antes del ejercicio)
  const nivel = x => {
    const nueva = !m.vistos.has(normW(x.it.q));
    const conocidas = x.v.every(id => m.conocidos.has(id));
    const tema = x.temas.some(t => tAct.has(t) || tInt.has(t));
    if (nueva && conocidas && tema) return 0;
    if (nueva && conocidas) return 1;
    if (conocidas) return 2;
    return 3;
  };
  const desempate = x => {
    let p = 0;
    p -= 12 * x.v.filter(id => !m.conocidos.has(id)).length;
    p += 2 * x.temas.filter(t => tAct.has(t)).length + x.temas.filter(t => tInt.has(t)).length;
    p += 3 * x.v.filter(id => cubrir.has(id)).length;      // en repaso, las que cubren lo que toca
    return p + hashStr(x.ej + x.i + dia);                    // desempate estable durante el día
  };
  const elegidos = [...pool].map(x => ({ x, n: nivel(x), d: desempate(x) }))
    .sort((a, b) => a.n - b.n || b.d - a.d).slice(0, e.nMostrar).map(o => o.x);
  return elegidos.map(x => `${x.ej}.${x.i}`);
}
const costo = (m, e) => { const n = nuevoDe(m, e); return n.reglas.length * PESO_REGLA + n.palabras.length; };
const disponible = (m, e) => e.reqEj.every(id => m.intentado(id));

// carga nueva de un escenario completo (para elegir el siguiente)
export function cargaEscenario(m, sId) {
  const R = new Set(), V = new Set(); let bloqueado = false;
  for (const e of m.ejs.filter(x => x.escenario === sId && !m.intentado(x.id))) {
    if (!e.reqEj.every(id => m.intentado(id) || m.porId.get(id)?.escenario === sId)) bloqueado = true;
    const n = nuevoDe(m, e); n.reglas.forEach(x => R.add(x)); n.palabras.forEach(x => V.add(x));
  }
  return { reglas: [...R], palabras: V.size, costo: R.size * PESO_REGLA + V.size, bloqueado };
}

function opcionesEscenario(m, est) {
  const pend = est.filas.filter(f => !f.terminado && f.intentados === 0);
  const noRepaso = pend.filter(f => !/^repaso/i.test(f.s.nombre || ''));
  let base = noRepaso.length ? noRepaso : pend;            // el repaso general va al final
  // primero se terminan las lecciones del nivel más bajo pendiente; al acabarlas sigue el siguiente nivel
  // (A1 → A2 → B1…) sin esperar a dominar el anterior: el repaso diario continúa en paralelo
  const nivMin = Math.min(...base.map(f => nivelIdx(f.s.nivel)));
  base = base.filter(f => nivelIdx(f.s.nivel) === nivMin);
  let c = base.map(f => ({ s: f.s, ...cargaEscenario(m, f.s.id) })).filter(x => !x.bloqueado);
  if (!c.length) return [];
  c.sort((a, b) => a.costo - b.costo || (a.s.orden ?? 999) - (b.s.orden ?? 999));
  const min = c[0].costo;
  // siempre al menos 2 opciones (si existen); la 3.ª solo si su carga no es excesiva
  return c.filter((x, i) => i < 2 || x.costo <= Math.max(min * 1.6, min + 20)).slice(0, 3);
}

function repasosPendientes(m, est) {
  const ahora = Date.now();
  const vistos = new Set(est.filas.filter(f => f.intentados > 0).map(f => f.s.id));
  return m.ejs.filter(e => vistos.has(e.escenario)).filter(e => {
    const h = m.porEj.get(e.id); if (!h || h.abierto || h.ultimoPuntaje == null) return false;
    return h.ultimoPuntaje < APROBADO && ahora - h.ultimo > 10 * 60e3;              // falló: repetir tras 10 min
  }).sort((a, b) => (m.porEj.get(a.id).ultimoPuntaje ?? 0) - (m.porEj.get(b.id).ultimoPuntaje ?? 0));
}

// antes de un ejercicio: presentar primero reglas (de una en una) y luego palabras (en tarjetas)
function conPresentacion(m, e, tipo) {
  // ejercicios-banco: primero se fija qué preguntas tocan, así solo se presentan sus palabras
  if (e.nMostrar && !seleccionActiva(m, e)) {
    const cubrir = new Set(tipo === 'repaso' || tipo === 'repasoDia' ? [...m.mem].filter(([, s]) => s.due <= m.ahora + DIA).map(([id]) => id) : []);
    const sel = sortearPreguntas(m, e, { cubrir });
    if (sel) return { tipo: 'sortear', ref: `${e.id}|${sel.join(',')}` };
  }
  const n = nuevoDe(m, e);
  if (n.reglas.length) return { tipo: 'regla', regla: m.regla[n.reglas[0]] || { id: n.reglas[0], nombre: n.reglas[0] }, pendientes: n.reglas.length, ejercicio: e, despues: tipo };
  if (n.palabras.length) return { tipo: 'palabras', ids: n.palabras.slice(0, PALABRAS_POR_TARJETA), pendientes: n.palabras.length, ejercicio: e, despues: tipo };
  return { tipo, ejercicio: e };
}

// Devuelve uno de:
//  { tipo:'iniciar', escenario }                  primer escenario (sin elección)
//  { tipo:'elegir', opciones:[{s, reglas, palabras}] }   al terminar un escenario
//  { tipo:'regla', regla, ejercicio } | { tipo:'palabras', ids, ejercicio }   presentación previa
//  { tipo:'nuevo'|'repaso', ejercicio }
//  { tipo:'descanso', pendiente }   suficiente por hoy: mucho repaso acumulado
//  { tipo:'planificar', ref } | { tipo:'repasoDia', ejercicio, k, n } | { tipo:'tarjetas', items }   repaso diario
//  { tipo:'fin' }
export function siguienteTarea(m) {
  const est = estadoAlumno(m);
  // 1) el día empieza con el repaso que toca según el calendario
  const hoy = fechaLocal(m.ahora);
  const planesHoy = m.eventos.filter(v => v.tipo === 'repaso' && v.ref.startsWith(hoy + '|'));
  const plan = planesHoy[planesHoy.length - 1];
  if (!plan) {
    const p = planRepaso(m);
    if (p && (p.ejercicios.length || p.tarjetas.length)) return { tipo: 'planificar', ref: `${hoy}|${p.ejercicios.join(',')}|${p.tarjetas.join(',')}` };
  } else {
    const [, ej = '', tj = ''] = plan.ref.split('|'), t0 = Date.parse(plan.creado_en);
    const ejs = ej.split(',').filter(Boolean), tjs = tj.split(',').filter(Boolean);
    const pendEj = ejs.filter(id => !m.intentosOrd.some(i => i.ejercicio_id === id && Date.parse(i.creado_en) >= t0));
    if (pendEj.length) {
      const e0 = m.porId.get(pendEj[0]);
      if (e0?.nMostrar && !seleccionActiva(m, e0)) { const r = conPresentacion(m, e0, 'repasoDia'); if (r.tipo === 'sortear') return r; }
      return { tipo: 'repasoDia', ejercicio: e0, k: ejs.length - pendEj.length + 1, n: ejs.length + (tjs.length ? 1 : 0) };
    }
    const pendT = tjs.filter(id => !m.eventos.some(v => v.tipo === 'tarjeta' && v.ref.startsWith(id + '|') && Date.parse(v.creado_en) >= t0));
    if (pendT.length) return { tipo: 'tarjetas', items: pendT.map(id => ({ id, modo: m.vocab[id]?.uso === 'activo' ? 'p' : 'r' })) };
    // ronda terminada: si sigue habiendo mucho atraso, otra ronda de repaso antes de lo nuevo
    const pendiente = atraso(m);
    if (pendiente > UMBRAL_ATRASO) {
      if (planesHoy.length < MAX_RONDAS_DIA) {
        const p = planRepaso(m);
        if (p && (p.ejercicios.length || p.tarjetas.length)) return { tipo: 'planificar', ref: `${hoy}|${p.ejercicios.join(',')}|${p.tarjetas.join(',')}` };
      }
      const ini = new Date(m.ahora); ini.setHours(0, 0, 0, 0);
      const vistos = new Set(), nuevosHoy = new Set();
      for (const i of m.intentosOrd) { if (!vistos.has(i.ejercicio_id) && Date.parse(i.creado_en) >= +ini) nuevosHoy.add(i.ejercicio_id); vistos.add(i.ejercicio_id); }
      planesHoy.forEach(v => (v.ref.split('|')[1] || '').split(',').forEach(id => nuevosHoy.delete(id)));
      if (nuevosHoy.size >= NUEVOS_CON_FRENO) return { tipo: 'descanso', pendiente };
    }
  }
  const rep = repasosPendientes(m, est);
  const tocaRepaso = rep.length && m.totalIntentos % REPASO_CADA === REPASO_CADA - 1;
  if (tocaRepaso) return conPresentacion(m, rep[0], 'repaso');

  if (!est.actual) {
    const ops = opcionesEscenario(m, est);
    if (!ops.length) return rep.length ? conPresentacion(m, rep[0], 'repaso') : { tipo: 'fin' };
    const alguno = est.filas.some(f => f.intentados > 0);
    if (!alguno) return { tipo: 'iniciar', escenario: ops[0].s };
    return { tipo: 'elegir', opciones: ops };
  }
  const propios = m.ejs.filter(e => e.escenario === est.actual);
  const libres = propios.filter(e => !m.intentado(e.id) && disponible(m, e));
  if (libres.length) {
    libres.sort((a, b) => costo(m, a) - costo(m, b) || (a.hab === m.ultimoHab) - (b.hab === m.ultimoHab) || a.id.localeCompare(b.id));
    // alumno con parte oral por Zoom: los ejercicios orales pasan a la lista del docente (salvo los de base, como el alfabeto)
    if (m.oralesZoom && libres[0].oral && !libres[0].base) return { tipo: 'zoom', ejercicio: libres[0] };
    return conPresentacion(m, libres[0], 'nuevo');
  }
  // todo intentado pero sin llegar al 80 %: volver sobre lo fallado del escenario
  const fallados = propios.filter(e => !m.hecho(e) && disponible(m, e));
  if (fallados.length) return conPresentacion(m, fallados[0], 'repaso');
  if (rep.length) return conPresentacion(m, rep[0], 'repaso');
  return { tipo: 'fin' };
}

// ---------- proyección: en cuántos días tendrá el nivel con su ritmo actual ----------
export const NIVELES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const TARJETAS_POR_EJERCICIO = 18;
const MIN_EJERCICIOS_PROYECCION = 5;     // antes de esto la cifra es muy inestable
// ---------- nivel por dominio ----------
// Un nivel se logra al dominar: palabras activas (meta oficial), palabras pasivas del nivel,
// reglas del nivel que enseña el curso y cada habilidad comunicativa con evidencia suficiente.
const META_ACTIVAS = { A1: 780, A2: 1300, B1: 2300, B2: 6000, C1: 7000, C2: 7000 };
const PROP_PASIVAS = 0.9, PROP_REGLAS = 0.9, MIN_EVIDENCIA = 5;
const HAB_COMUNICATIVAS = ['lectura', 'escucha', 'escritura', 'habla'];
const nivelIdx = n => Math.max(0, NIVELES.indexOf(n || 'A1'));
export function dominio(m, nivel, hasta = Infinity) {
  const mem = hasta === Infinity ? m.mem : memoria(m, hasta);
  const k = nivelIdx(nivel);
  const nivelEsc = Object.fromEntries(m.esc.map(s => [s.id, s.nivel || 'A1']));
  const ejsNivel = m.ejs.filter(e => e.escenario && nivelIdx(nivelEsc[e.escenario] || 'A1') <= k);   // solo la trayectoria (no los bancos de práctica)
  // palabras
  const pal = new Set(ejsNivel.flatMap(e => e.reqV).filter(id => m.vocab[id]));
  let act = 0, rec = 0;
  for (const id of pal) { const st = mem.get(id); if (!reconocida(st)) continue; rec++; if (m.vocab[id]?.uso === 'activo' && dominada(st)) act++; }
  const metaAct = Math.min(META_ACTIVAS[nivel] || 780, [...pal].filter(id => m.vocab[id]?.uso === 'activo').length || Infinity);
  const metaRec = Math.ceil(pal.size * PROP_PASIVAS);
  // reglas del nivel que el curso enseña
  const reglas = new Set(ejsNivel.flatMap(e => e.reqG).filter(g => nivelIdx(m.regla[g]?.nivel || 'A1') <= k));
  let regOk = 0; for (const g of reglas) if (dominada(mem.get(g))) regOk++;
  const metaReg = Math.ceil(reglas.size * PROP_REGLAS);
  // habilidades comunicativas: al menos MIN_EVIDENCIA ejercicios con promedio ≥ APROBADO
  const hab = {};
  for (const h of HAB_COMUNICATIVAS) if (ejsNivel.some(e => e.hab === h)) hab[h] = { n: 0, suma: 0 };
  const ultimo = new Map();
  for (const i of m.intentosOrd) if (Date.parse(i.creado_en) <= hasta && i.puntaje != null) ultimo.set(i.ejercicio_id, Number(i.puntaje));
  for (const v of m.eventos) if (v.tipo === 'zoom_ok' && Date.parse(v.creado_en) <= hasta) ultimo.set(v.ref, 100);
  for (const [id, pts] of ultimo) { const e = m.porId.get(id); if (e && hab[e.hab] && ejsNivel.includes(e)) { hab[e.hab].n++; hab[e.hab].suma += pts; } }
  const fracHab = Object.values(hab).map(r => r.n ? Math.min(1, r.n / MIN_EVIDENCIA) * Math.min(1, (r.suma / r.n) / APROBADO) : 0);
  const partes = [Math.min(1, act / metaAct), Math.min(1, rec / (metaRec || 1)), Math.min(1, regOk / (metaReg || 1)),
    fracHab.length ? fracHab.reduce((a, b) => a + b, 0) / fracHab.length : 1];
  const PESOS = [0.4, 0.25, 0.25, 0.1];                          // palabras activas, reconocidas, reglas, habilidades
  const frac = partes.reduce((a, b, i) => a + b * PESOS[i], 0);
  return { nivel, frac, partes, logrado: partes.every(x => x >= 1), act, metaAct, rec, metaRec, regOk, metaReg, hab, hayContenido: ejsNivel.some(e => nivelIdx(nivelEsc[e.escenario] || 'A1') === k) };
}
export function proyeccion(m) {
  // nivel actual: el primero no logrado
  let logrado = null, actual = null, d = null;
  for (const n of NIVELES) {
    d = dominio(m, n);
    if (d.logrado && d.hayContenido) { logrado = n; continue; }
    actual = n; break;
  }
  if (!d.hayContenido) return { completo: true, logrado, siguiente: actual, frac: 1 };
  const hechos = new Set(m.intentosOrd.map(i => i.ejercicio_id)).size;   // solo ejercicios hechos (los orales en espera de Zoom no cuentan)
  if (hechos < MIN_EJERCICIOS_PROYECCION) return { nivel: actual, logrado, dias: null, hechos, frac: d.frac, dom: d };
  // ritmo de avance del dominio en los últimos 14 días (incluye el efecto del repaso)
  const todos = [...m.intentosOrd.map(i => Date.parse(i.creado_en)), ...m.eventos.filter(v => ['tarjeta', 'zoom'].includes(v.tipo)).map(v => Date.parse(v.creado_en))];
  const inicio = Math.min(...todos);
  const ventana = Math.max(1, Math.min(28, (m.ahora - inicio) / DIA));
  const antes = ventana >= 14 ? dominio(m, actual, m.ahora - ventana * DIA).partes : [0, 0, 0, 0];
  // el nivel se logra cuando se completan todas las partes: manda la que más tardará
  let dias = 0, ritmo = (d.frac - (ventana >= 14 ? antes.reduce((a, b, i) => a + b * [0.4, 0.25, 0.25, 0.1][i], 0) : 0)) / ventana;
  d.partes.forEach((x, i) => {
    if (x >= 1) return;
    const r = (x - antes[i]) / ventana;
    if (r > 0) dias = Math.max(dias, (1 - x) / r);
    else if (x < 0.85) dias = Infinity;                          // casi completo: una oscilación no frena la estimación
  });
  dias = Number.isFinite(dias) ? Math.max(1, Math.ceil(dias)) : null;
  return { nivel: actual, logrado, dias, hechos, frac: d.frac, dom: d, ritmo };
}
export function textoProyeccion(p, { alumno = true } = {}) {
  const pre = p.logrado ? `¡${alumno ? 'Ya tienes' : 'Ya tiene'} el nivel ${p.logrado} de ruso! 🎉 ` : '';
  if (p.completo) return `${pre}${p.siguiente ? `El nivel ${p.siguiente} llegará pronto.` : ''}`;
  if (p.dias == null && p.hechos >= MIN_EJERCICIOS_PROYECCION) return `${pre}${alumno ? 'Sigue practicando y te diremos' : 'Sin avance reciente para calcular'} cuándo ${alumno ? 'tendrás' : 'tendrá'} el nivel ${p.nivel}.`;
  if (p.dias == null) {
    const n = p.hechos || 0;
    if (!alumno) return `${pre}${n} ${n === 1 ? 'ejercicio hecho' : 'ejercicios hechos'}; estimación desde ${MIN_EJERCICIOS_PROYECCION}`;
    if (!n) return `${pre}Haz tus primeras tareas y te diremos cuándo tendrás el nivel ${p.nivel}.`;
    return `${pre}Llevas ${n} ${n === 1 ? 'ejercicio' : 'ejercicios'}. ¡Buen comienzo! Al llegar a ${MIN_EJERCICIOS_PROYECCION} te diremos cuándo tendrás el nivel ${p.nivel}.`;
  }
  return alumno ? `${pre}Con este ritmo, tendrás el nivel ${p.nivel} de ruso en ${p.dias} ${p.dias === 1 ? 'día' : 'días'} 🚀`
    : `${pre}${p.nivel} en ~${p.dias} ${p.dias === 1 ? 'día' : 'días'}`;
}

// ---------- vista docente: orden sugerido dentro de cada lección y práctica adicional ----------
// Recorre las lecciones por su orden y, dentro de cada una, elige primero lo disponible que menos cosas nuevas exige
// (igual que el motor para un alumno que empieza de cero).
export function panorama(m) {
  const hechos = new Set(), K = new Set(), res = new Map();
  for (const s of m.esc) {
    const rest = m.ejs.filter(e => e.escenario === s.id), orden = [];
    while (rest.length) {
      const disp = rest.filter(e => e.reqEj.every(id => hechos.has(id) || !m.porId.get(id)?.escenario));
      const pool = disp.length ? disp : rest;
      const c = e => e.reqReglas.filter(x => !K.has(x)).length * PESO_REGLA + e.reqV.filter(x => !K.has(x)).length;
      pool.sort((a, b) => c(a) - c(b) || a.id.localeCompare(b.id));
      const e = pool[0]; orden.push(e); hechos.add(e.id); e.reqReglas.forEach(x => K.add(x)); e.reqV.forEach(x => K.add(x));
      rest.splice(rest.indexOf(e), 1);
    }
    res.set(s.id, { orden, practica: [] });
  }
  // práctica adicional (bancos sin lección): se muestra en la primera lección que enseña su regla principal
  const primeraLeccion = {};
  for (const s of m.esc) for (const e of res.get(s.id).orden) for (const g of e.reqG) primeraLeccion[g] ??= s.id;
  const sinLeccion = [];
  for (const e of m.ejs.filter(x => !x.escenario)) {
    const sId = e.gram.map(g => primeraLeccion[g]).find(Boolean);
    if (sId) res.get(sId).practica.push(e); else sinLeccion.push(e);
  }
  return { porLeccion: res, sinLeccion };
}

export function etiquetaTema(m, s) {
  const t = lista(s?.temas).map(id => m.nombreTema[id]).filter(Boolean);
  return t.join(' · ');
}
