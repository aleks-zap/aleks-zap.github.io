// Datos públicos del proyecto Supabase (la clave publishable puede ir en el código).
export const SUPABASE_URL = 'https://tuntcevtgpzaucvxvlzd.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_J7MbunuyfPi4snFEIg7nvQ_UfEtW3nl';
export const NOMBRE_CURSO = 'Ruso desde cero';

// Precios de la página pública (se editan aquí).
export const PRECIOS = {
  mensual: { precio: '$14,90', periodo: ' / mes' },
  anual: { precio: '$129', periodo: ' / año', nota: 'equivale a $10,75 al mes (ahorras 28 %)' },
  nivel: { precio: '$79', periodo: ' pago único' },
};
// Niveles que ya se pueden comprar; los demás aparecen como «próximamente».
export const NIVELES_A_LA_VENTA = ['A1'];
