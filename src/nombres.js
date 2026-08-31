/**
 * Nombres y números para los clientes de mentira.
 *
 * Crear veinte clientes a mano —inventando nombre y número cada vez— es el tipo
 * de trabajo que hace que nadie pruebe con veinte clientes. Así que el
 * formulario llega escrito y solo se toca cuando quieres a alguien concreto.
 *
 * Todos los nombres son inventados y los números caen en el rango que la UIT
 * reserva para ficción (555-01xx), así que no hay forma de que uno de estos
 * coincida con el teléfono de una persona real.
 */
const PILA = [
  "Rosa", "Juana", "Camila", "Dilenia", "Yamilet", "Altagracia", "Mariela", "Nicole",
  "Yudith", "Esperanza", "Fior", "Ramona", "Clara", "Lucía", "Bianca", "Perla",
  "Pedro", "Marcos", "Elías", "Ramón", "Wilfredo", "Julio", "Aneudy", "Franklin",
  "Radhamés", "Bienvenido", "Ambiorix", "Starling", "Yunior", "Domingo", "Rafelito", "Kelvin",
];
const APELLIDOS = [
  "Peralta", "Guzmán", "Brito", "Marte", "Reyes", "Almonte", "Tejada", "Santana",
  "Ureña", "Mejía", "Paulino", "Contreras", "Feliz", "Cabrera", "Bautista", "Rosario",
  "Encarnación", "Del Orbe", "Pimentel", "Aquino", "Valdez", "Then", "Cuevas", "Sosa",
];

const alAzar = (lista) => lista[Math.floor(Math.random() * lista.length)];

/**
 * Un cliente que todavía no existe en ese número.
 *
 * `yaExiste` decide: se le pasa la comprobación contra la base y se prueba
 * hasta encontrar hueco. Con 555-0100 a 555-0999 hay novecientos, y si el rango
 * se llenara se dice en vez de devolver un repetido a la brava.
 */
export function clienteInventado(yaExiste) {
  for (let intento = 0; intento < 200; intento++) {
    // 1 809 555-01xx: reservado para ficción, nunca es de nadie.
    const telefono = "18095550" + String(100 + Math.floor(Math.random() * 900));
    if (yaExiste(telefono)) continue;
    return { nombre: `${alAzar(PILA)} ${alAzar(APELLIDOS)}`, telefono };
  }
  return null;
}
