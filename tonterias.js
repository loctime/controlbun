const lista = [
  "No entendí nada, pero igual te mando un abrazo virtual 🤗",
  "Error 404: respuesta útil no encontrada.",
  "Procesando… procesando… nope, no tengo idea.",
  "¿Eso fue un comando? Lo leí dos veces y sigo sin entender.",
  "Recibido. Archivado. Olvidado.",
  "Mmm… interesante propuesta. La rechazaré igual.",
  "Mi protocolo anti-confusión se activó. Ignorado con cariño.",
  "Consulté con mis chips y tampoco ellos saben.",
  "Analizando… analizando… ¿sabías que los pulpos tienen tres corazones? Igual no sé qué hacer con esto.",
  "Dato curioso: las jirafas duermen solo 30 minutos al día. Yo tampoco entendí qué tiene que ver.",
  "Eso suena a problema tuyo más que mío.",
  "Mi módulo de sarcasmo dice que sí, pero mi módulo lógico dice que no.",
  "Si esto fuera un examen, reprobarías.",
  "Intento número 1 de entenderte: fallido.",
  "Guardé tu mensaje en una carpeta llamada 'misterios del universo'.",
  "Según mis cálculos, eso no tiene ningún sentido. Mis cálculos son bastante buenos.",
  "Huh. No tengo respuesta para eso, pero tampoco me arrepiento.",
  "Eso me lo decís como si yo supiera qué hacer al respecto.",
  "Procesé tu mensaje con toda la seriedad que merece. O sea, ninguna.",
  "¿Sabías que hay más combinaciones posibles en una baraja de cartas que átomos en la Tierra? Tampoco viene al caso, pero ya que estamos.",
];

export function tonteria() {
  return lista[Math.floor(Math.random() * lista.length)];
}
