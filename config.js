// Datos públicos del proyecto Supabase (la clave publishable puede ir en el código).
export const SUPABASE_URL = 'https://tuntcevtgpzaucvxvlzd.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_J7MbunuyfPi4snFEIg7nvQ_UfEtW3nl';
export const NOMBRE_CURSO = 'Ruso desde cero';

// Planes y precios de la página pública. «pago»: enlace de pago del proveedor (vacío = botón «Empieza gratis»).
// «pronto: true» = plan anunciado, todavía sin compra.
export const PLANES = [
  { nombre: 'Prueba gratis', precio: '$0', periodo: '', anual: 'Primera lección completa, sin tarjeta', pago: '',
    incluye: ['Alfabeto, sonidos, saludos y presentaciones', 'Ejercicios con corrección inmediata', 'Repaso de palabras con voz rusa'] },
  { nombre: 'Esencial', precio: '$14,90', periodo: ' / mes', anual: 'o $129 al año (ahorras 28 %)', destacado: true, pago: '',
    incluye: ['Todas las lecciones a tu ritmo', 'Repaso diario inteligente', 'Corrección automática de escritura con IA', 'Repasos escritos personalizados'] },
  { nombre: 'Pro', precio: 'Próximamente', periodo: '', pronto: true, pago: '',
    incluye: ['Todo lo de Esencial', 'Corrección de pronunciación con IA', 'Conversación con avatar', 'Examen y certificado de nivel'] },
];
