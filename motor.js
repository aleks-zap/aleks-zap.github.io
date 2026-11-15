// ============================================================
// Motor de progresión adaptativa
// Decide la próxima tarea del alumno a partir de su historial:
//  · avanza por los escenarios en orden (un escenario se abre cuando
//    el anterior está dominado al 80 %),
//  · alterna habilidades (pronunciación, vocabulario, gramática,
//    lectura, escritura, escucha, habla),
//  · intercala repasos de lo que salió mal o se aprendió hace tiempo,
//  · ofrece 2–3 opciones temáticas que practican lo mismo.
// ============================================================

export const HABILIDAD = {
  H01: 'vocabulario', H02: 'gramática', H03: 'lectura', H04: 'lectura', H05: 'escucha',
  H06: 'escritura', H07: 'habla', H08: 'escritura', H09: 'pronunciación',
};
export const HABILIDADES = ['pronunciación', 'vocabulario', 'gramática', 'lectura', 'escritura', 'escucha', 'habla'];

const APROBADO = 70;            // puntaje para considerar hecho un ejercicio
const DOMINIO_ESCENARIO = 0.8;  // fracción de ejercicios hechos para abrir el siguiente
const VENTANA = 5;              // cuántos ejercicios nuevos se consideran a la vez
const REPASO_CADA = 4;          // 1 repaso cada N tareas
const INTERVALOS_DIAS = [1, 3, 7, 21, 60];

const lista = s => String(s || '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
const DIA = 864e5;

export function prepararModelo({ escenarios, ejercicios, tipos, intentos, temas }) {
  const tipoHab = Object.fromEntries(tipos.map(t => [t.id, HABILIDAD[lista(t.habilidades_principales)[0]] || 'gramática']));
  const nombreTema = Object.fromEntries((temas || []).map(t => [t.id, t.nombre]));
  const porEj = new Map();                       // historial por ejercicio
  for (const i of [...intentos].sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en))) {
    const h = porEj.get(i.ejercicio_id) || { n: 0, exitos: 0, ultimo: null, ultimoPuntaje: null, abierto: false };
    h.n++; h.ultimo = new Date(i.creado_en).getTime();
    if (i.puntaje != null) { h.ultimoPuntaje = Number(i.puntaje); if (h.ultimoPuntaje >= APROBADO) h.exitos++; }
    else h.abierto = true;                       // tarea abierta / oral enviada
    porEj.set(i.ejercicio_id, h);
  }
  const ejs = ejercicios.map(e => ({ ...e, hab: tipoHab[e.tipo_ejercicio] || 'gramática', gram: lista(e.gramatica_objetivo) }));
  const esc = escenarios.filter(s => ejs.some(e => e.escenario === s.id)).sort((a, b) => (a.orden ?? 999) - (b.orden ?? 999));
  const hecho = e => { const h = porEj.get(e.id); return !!h && (h.abierto || (h.ultimoPuntaje ?? 0) >= APROBADO || h.exitos > 0); };
  return { ejs, esc, porEj, hecho, nombreTema };
}

export function estadoAlumno(m) {
  const filas = m.esc.map(s => {
    const propios = m.ejs.filter(e => e.escenario === s.id);
    const h = propios.filter(m.hecho).length;
    return { s, total: propios.length, hechos: h, frac: propios.length ? h / propios.length : 1 };
  });
  let actual = filas.findIndex(f => f.frac < DOMINIO_ESCENARIO);
  if (actual < 0) actual = filas.length - 1;
  const abiertos = filas.slice(0, actual + 1).map(f => f.s.id);
  // habilidades: promedio de último puntaje por habilidad
  const porHab = {};
  for (const e of m.ejs) {
    const h = m.porEj.get(e.id); if (!h) continue;
    const r = porHab[e.hab] ||= { n: 0, suma: 0, conNota: 0 };
    r.n++; if (h.ultimoPuntaje != null) { r.suma += h.ultimoPuntaje; r.conNota++; }
  }
  const nivelGlobal = filas.length ? filas.reduce((s, f) => s + f.hechos, 0) / filas.reduce((s, f) => s + f.total, 0) : 0;
  return { filas, actual, abiertos, porHab, nivelGlobal };
}

function recientes(m, n = 3) {
  return [...m.porEj.entries()].sort((a, b) => b[1].ultimo - a[1].ultimo).slice(0, n)
    .map(([id]) => m.ejs.find(e => e.id === id)?.hab).filter(Boolean);
}

function repasosPendientes(m, abiertos) {
  const ahora = Date.now();
  return m.ejs.filter(e => abiertos.includes(e.escenario)).filter(e => {
    const h = m.porEj.get(e.id); if (!h || h.abierto || h.ultimoPuntaje == null) return false;
    if (h.ultimoPuntaje < APROBADO) return ahora - h.ultimo > 10 * 60e3;                 // falló: repetir tras 10 min
    if (!['vocabulario', 'gramática'].includes(e.hab)) return false;                    // repaso espaciado solo de V y G
    const intervalo = INTERVALOS_DIAS[Math.min(h.exitos - 1, INTERVALOS_DIAS.length - 1)] * DIA;
    return ahora - h.ultimo > intervalo;
  }).sort((a, b) => (m.porEj.get(a.id).ultimoPuntaje ?? 0) - (m.porEj.get(b.id).ultimoPuntaje ?? 0));
}

// Devuelve { tipo:'nuevo'|'repaso'|'fin', opciones:[ejercicio...] }
export function siguienteTarea(m) {
  const est = estadoAlumno(m);
  const totalIntentos = [...m.porEj.values()].reduce((s, h) => s + h.n, 0);
  const rep = repasosPendientes(m, est.abiertos);
  const tocaRepaso = rep.length && totalIntentos % REPASO_CADA === REPASO_CADA - 1;

  const escActual = est.filas[est.actual]?.s.id;
  const nuevos = m.ejs.filter(e => est.abiertos.includes(e.escenario) && !m.hecho(e) && !m.porEj.get(e.id))
    .sort((a, b) => (a.escenario === escActual) - (b.escenario === escActual) || a.id.localeCompare(b.id));
  // primero lo pendiente de escenarios anteriores, luego el actual en orden del libro
  const ventana = nuevos.slice(0, VENTANA);

  if (tocaRepaso || !ventana.length) {
    if (rep.length) return { tipo: 'repaso', opciones: opcionesSimilares(m, rep[0], rep, est) };
    const fallados = m.ejs.filter(e => est.abiertos.includes(e.escenario) && !m.hecho(e));
    if (fallados.length) return { tipo: 'repaso', opciones: [fallados[0]] };
    if (!ventana.length) return { tipo: 'fin', opciones: [] };
  }
  // alternar habilidades: preferir la que no se practicó en las últimas tareas
  const rec = recientes(m);
  const elegido = ventana.find(e => !rec.includes(e.hab)) || ventana.find(e => e.hab !== rec[0]) || ventana[0];
  // para elegir tema se aceptan también ejercicios equivalentes del escenario siguiente
  const cercanos = new Set(est.filas.slice(0, est.actual + 2).map(f => f.s.id));
  const pool = m.ejs.filter(e => cercanos.has(e.escenario) && !m.porEj.get(e.id));
  return { tipo: 'nuevo', opciones: opcionesSimilares(m, elegido, pool, est) };
}

// Alternativas que practican lo mismo (misma regla gramatical y habilidad, o mismo tipo) con otro tema.
function opcionesSimilares(m, base, pool, est) {
  const misma = e => e.id !== base.id && e.hab === base.hab &&
    (base.gram.length ? e.gram.some(g => base.gram.includes(g)) : e.tipo_ejercicio === base.tipo_ejercicio);
  const otros = pool.filter(misma).filter(e => e.escenario !== base.escenario);
  const vistos = new Set([base.escenario]); const res = [base];
  for (const e of otros) { if (res.length >= 3) break; if (!vistos.has(e.escenario)) { vistos.add(e.escenario); res.push(e); } }
  return res;
}

export function etiquetaTema(m, e, escenarios) {
  const s = escenarios.find(x => x.id === e.escenario);
  const t = lista(s?.temas).map(id => m.nombreTema[id]).filter(Boolean);
  return t.length ? t.join(' · ') : (s?.nombre || '');
}
