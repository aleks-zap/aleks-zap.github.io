// Datos públicos del proyecto Supabase (la clave publishable puede ir en el código).
export const SUPABASE_URL = 'https://tuntcevtgpzaucvxvlzd.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_J7MbunuyfPi4snFEIg7nvQ_UfEtW3nl';
export const NOMBRE_CURSO = 'Ruso desde cero';

// Planes y precios de la página pública. «pago»: enlace de pago del proveedor (vacío = botón «Empieza gratis»).
export const PLANES = [
  { nombre: 'Plataforma', precio: '$19', periodo: ' / mes', anual: 'o $149 al año (ahorras 35 %)', pago: '',
    incluye: ['Todas las lecciones A1–B1 a tu ritmo', 'Repaso diario inteligente', 'Corrección automática de escritura', 'Examen y certificado incluidos en el plan anual'] },
  { nombre: 'Plataforma + clase grupal', precio: '$59', periodo: ' / mes', destacado: true, pago: '',
    incluye: ['Todo lo de Plataforma', 'Clase semanal de conversación por Zoom (grupo de 3–5)', 'Revisión de tus grabaciones por la profesora', 'Examen y certificado incluidos'] },
  { nombre: 'Plataforma + clase individual', precio: '$119', periodo: ' / mes', pago: '',
    incluye: ['Todo lo de Plataforma', 'Clase individual semanal de 50 min por Zoom', 'Plan de estudio ajustado a tus metas', 'Examen y certificado incluidos'] },
];
