import { spawn } from "child_process";

let proc = null;

export function startTunnel() {
  const token = process.env.CF_TUNNEL_TOKEN;
  if (!token) {
    console.log("[TUNNEL] Sin CF_TUNNEL_TOKEN — túnel desactivado");
    return;
  }

  function launch() {
    proc = spawn("cloudflared", ["tunnel", "run", "--token", token], { stdio: "pipe" });
    proc.stderr.on("data", (d) => {
      const line = d.toString().trim();
      const skip = line.includes("DNS local resolver") || line.includes("system root certificate") || line.includes("ICMP proxy");
      if (!skip && (line.includes("Registered") || line.includes("ERR") || line.includes("error") || line.includes("disconnected"))) {
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
