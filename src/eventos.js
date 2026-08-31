/**
 * El bus de eventos hacia la interfaz, por SSE.
 *
 * Antes la interfaz SONDEABA: mensajes cada 2,5 s, «escribiendo…» cada 1,2 s,
 * entregas cada 2,5 s… 59 requests en un minuto con la pantalla quieta. Un chat
 * de verdad no pregunta si pasó algo: se le avisa. Con EventSource el servidor
 * empuja «pasó esto» y la interfaz pide UNA vez justo lo que cambió; si la
 * conexión se cae, EventSource se reconecta solo, y queda un sondeo lento de
 * respaldo por si acaso.
 *
 * SSE y no socket.io a propósito: aquí el tráfico va en un solo sentido
 * (servidor → pantalla), y para eso EventSource viene en el navegador, sin
 * dependencias, sin handshake propio y reconectándose gratis.
 */
const oyentes = new Set();   // { res, dueno }

/**
 * Cada evento lleva su dueño y solo lo oyen las pantallas de ese dueño.
 *
 * Hoy el sandbox es interno y el dueño es siempre el mismo, pero la idea es
 * exponerlo como feature: cada cliente ensayando en el suyo. Un bus que
 * transmite todo a todos sería, ese día, un cliente viendo los ensayos de
 * otro. Filtrar cuesta una línea ahora y una migración después.
 */
export function avisar(evento, dueno = "local") {
  const linea = `data: ${JSON.stringify(evento)}\n\n`;
  for (const o of oyentes) {
    if (o.dueno !== dueno) continue;
    try { o.res.write(linea); } catch { oyentes.delete(o); }
  }
}

/* Cada pantalla abierta es una conexión viva con su latido. Sin tope, una sola
   clave podía abrir miles y quedarse con la memoria del servidor. */
const MAXIMO_POR_DUENO = 12;

export function conectarSSE(req, res, dueno = "local") {
  let abiertas = 0;
  for (const o of oyentes) if (o.dueno === dueno) abiertas++;
  if (abiertas >= MAXIMO_POR_DUENO) {
    res.writeHead(429, { "content-type": "text/plain" });
    return res.end("demasiadas pantallas abiertas");
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Sin esto, un nginx por delante acumula los eventos en su buffer y la
    // pantalla los recibe todos juntos… cuando ya no importan.
    "x-accel-buffering": "no",
  });
  res.write(":hola\n\n");
  const oyente = { res, dueno };
  oyentes.add(oyente);
  // Un latido cada 25 s mantiene vivos los proxies que cierran conexiones mudas.
  const latido = setInterval(() => { try { res.write(":latido\n\n"); } catch { /* ya se fue */ } }, 25000);
  req.on("close", () => { clearInterval(latido); oyentes.delete(oyente); });
}
