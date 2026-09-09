import net from "node:net";

const [name, mode] = process.argv.slice(2);
const server = net.createServer();
server.once("error", (error) => { process.send?.({ status: error.code === "EADDRINUSE" ? "locked" : "error" }); process.exit(1); });
server.listen({ path: `\0${name}`, exclusive: true }, () => {
  process.send?.({ status: "owner" });
  if (mode === "once") server.close(() => process.exit(0));
  else process.on("message", (message) => { if (message === "release") server.close(() => process.exit(0)); });
});
