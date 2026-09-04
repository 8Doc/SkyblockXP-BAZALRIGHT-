/** A three-line static server for `dist`, so the built page can be opened in a browser preview. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const port = Number(process.env.PORT ?? 4173);

createServer(async (req, res) => {
  const name = (req.url ?? "/").split("?")[0];
  const file = name === "/" ? "skyblock-xp-planner.html" : name.replace(/^\//, "");
  try {
    // Read first, then write the header. Writing 200 up front means a miss — a browser asking for
    // /favicon.ico is enough — lands in the catch with the headers already sent, and the throw from
    // the second writeHead is unhandled and takes the whole server down mid-session.
    const body = await readFile(join(root, file));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`serving dist on http://localhost:${port}`));
