import { spawn } from "child_process";

let proc = null;

export function startTunnel() {
  const token = process.env.CF_TUNNEL_TOKEN;
  if (!token) {
    console.log("[TUNNEL] Sin CF_TUNNEL_TOKEN — túnel desactivado");
    return;
  }

  function launch() {
    // --protocol http2: QUIC daba jitter constante (timeouts UDP, MTU mismatch entre
    // Contabo Frankfurt y Cloudflare edge). HTTP/2 es más estable bajo redes ruidosas
    // a costo de ~10-30ms de latencia adicional. Cloudflare lo recomienda en esos casos.
    proc = spawn("cloudflared", ["tunnel", "run", "--protocol", "http2", "--token", token], { stdio: "pipe" });
    proc.stderr.on("data", (d) => {
      const line = d.toString().trim();
      // Skipear ruido transitorio de cloudflared. Dejamos pasar solo señales útiles:
      // Registered/Unregistered (conexión sube/baja), errores que NO sean QUIC/datagram
      // transitorios, y disconnected definitivos.
      const skipTransient =
        line.includes("DNS local resolver") ||
        line.includes("system root certificate") ||
        line.includes("ICMP proxy") ||
        line.includes("ping_group_range") ||
        line.includes("failed to run the datagram handler") ||
        line.includes("failed to accept incoming stream requests") ||
        line.includes("Failed to dial a quic connection") ||
        line.includes("Connection terminated") ||
        line.includes("failed to serve tunnel connection") ||
        line.includes("Serve tunnel error");
      if (skipTransient) return;
      if (line.includes("Registered") || line.includes("Unregistered") || line.includes("ERR") || line.includes("error") || line.includes("disconnected")) {
        console.log(`[TUNNEL] ${line}`);
      }
    });
    proc.on("exit", (code) => {
      if (code !== 0) {
        console.log(`[TUNNEL] Salió con código ${code}, reiniciando en 15s…`);
        setTimeout(launch, 15000);
      }
    });
  }

  launch();
}
