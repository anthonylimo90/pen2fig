#!/usr/bin/env node
// pen2fig CLI. Plain Node (type stripping), no dependencies.
//
//   pen2fig snippet <id…> [--components] [--no-variables]   JS to run with the Pencil MCP `execute` tool
//   pen2fig bundle <pencil-output> --page <name> [--pen-dir <dir>] [--keep-positions] [--no-variables] [-o bundle.json]
//   pen2fig serve [--port 7331]                 job queue + image server the Figma plugin polls
//   pen2fig push <bundle.json> [--wait] [--server <url>]
//   pen2fig report <jobId> [--server <url>]

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute, extname } from "node:path";
import { randomUUID } from "node:crypto";

const BUNDLE_VERSION = 1;
const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name: string, def?: string) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const die = (m: string): never => { process.stderr.write(m + "\n"); process.exit(1); };

// ── snippet ──────────────────────────────────────────────────────────────────
/**
 * Pencil's `execute` has no return; output goes through Print. Each node is printed on one line as
 * `@@{kind, h: bounds, s: node}`; variables as `@@{kind:"variables", v}`. The padding line forces the
 * MCP to save large output to a file instead of truncating it.
 */
function snippet(ids: string[], withComponents: boolean, withVariables: boolean): string {
  return `const IDS=${JSON.stringify(ids)};const WITH=${withComponents};
${withVariables ? 'Print("@@"+JSON.stringify({kind:"variables",v:GetVariables()}));' : ""}
const bounds=(id)=>Get(id,(n,c)=>{c.skipChildren();return c.depth===0?{w:Math.round(c.bounds.width),h:Math.round(c.bounds.height),x:Math.round(c.bounds.x),y:Math.round(c.bounds.y)}:undefined})[0];
const refs=(n,acc)=>{if(!n||typeof n!=="object")return acc;if(n.type==="ref"&&n.ref)acc.push(n.ref);for(const c of n.children||[])refs(c,acc);if(n.descendants)for(const d of Object.values(n.descendants))refs(d,acc);return acc;};
const done=new Set();
const comp=(id)=>{if(done.has(id))return;done.add(id);const s=Get(id,{includePathGeometry:true});for(const r of refs(s,[]))comp(r);Print("@@"+JSON.stringify({kind:"component",h:bounds(id),s}));};
for(const id of IDS){const s=Get(id,{includePathGeometry:true});if(WITH)for(const r of refs(s,[]))comp(r);Print("@@"+JSON.stringify({kind:"screen",h:bounds(id),s}));}
Print("PAD"+"x".repeat(120000));`;
}

// ── bundle ───────────────────────────────────────────────────────────────────
interface Entry { id: string; bounds: { w: number; h: number; x?: number; y?: number }; node: any }

function readPencilOutput(file: string): string {
  const raw = readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    // Some MCP clients save tool results as a JSON array of content parts.
    try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map((x: any) => x?.text ?? "").join("\n"); } catch {}
  }
  return raw;
}

function makeBundle(file: string, page: string, penDir: string | undefined, keepPositions: boolean, withVariables: boolean) {
  const screens: Entry[] = [], components: Entry[] = [];
  let variables: { variables: Record<string, unknown>; themes?: Record<string, string[]> } | undefined;
  for (const line of readPencilOutput(file).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("@@{")) continue;
    const o = JSON.parse(t.slice(2));
    const kind = o.kind ?? "screen";
    if (kind === "variables") { if (withVariables && o.v?.variables) variables = o.v; continue; }
    const e: Entry = { id: o.s.id, bounds: o.h, node: o.s };
    const list = kind === "component" ? components : screens;
    if (!list.some((x) => x.id === e.id)) list.push(e);
  }
  if (!screens.length) die(`No @@ lines in ${file}. Run the output of \`pen2fig snippet\` with the Pencil MCP execute tool first.`);
  // Screens keep their arrangement, moved so the top-left one starts at 0,0.
  if (!keepPositions) {
    const minX = Math.min(...screens.map((s) => s.bounds.x ?? 0)), minY = Math.min(...screens.map((s) => s.bounds.y ?? 0));
    for (const s of screens) { s.bounds.x = (s.bounds.x ?? 0) - minX; s.bounds.y = (s.bounds.y ?? 0) - minY; }
  }
  // Every image fill becomes a key the server can resolve: a URL, or a path next to the .pen file.
  const images: Record<string, { url?: string; path?: string }> = {};
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    for (const f of [n.fill].flat()) {
      if (f && typeof f === "object" && f.type === "image" && f.url && !images[f.url]) {
        images[f.url] = /^(https?:|data:)/.test(f.url) ? { url: f.url } : { path: resolve(penDir ?? ".", f.url) };
      }
    }
    for (const c of n.children ?? []) walk(c);
    for (const d of Object.values(n.descendants ?? {})) walk(d);
  };
  for (const e of [...components, ...screens]) walk(e.node);
  const missing = Object.entries(images).filter(([, v]) => v.path && !existsSync(v.path));
  if (missing.length) process.stderr.write(`warning: ${missing.length} local image(s) not found — pass --pen-dir <folder of the .pen file>\n`);
  return { version: BUNDLE_VERSION, source: { file, exportedAt: new Date().toISOString() }, page, ...(variables && { variables }), components, screens, images };
}

// ── serve ────────────────────────────────────────────────────────────────────
interface Job { id: string; bundle: any; state: "queued" | "running" | "done"; report?: any; created: number }

function serve(port: number) {
  const jobs: Job[] = [];
  const cors = (res: ServerResponse) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
  };
  const json = (res: ServerResponse, code: number, body: unknown) => { cors(res); res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const body = (req: IncomingMessage) => new Promise<string>((ok, bad) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s)); req.on("error", bad); });
  const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
      if (req.method === "POST" && url.pathname === "/jobs") {
        const bundle = JSON.parse(await body(req));
        if (bundle.version !== BUNDLE_VERSION) return json(res, 400, { error: `bundle version ${bundle.version}, expected ${BUNDLE_VERSION}` });
        const job: Job = { id: randomUUID().slice(0, 8), bundle, state: "queued", created: Date.now() };
        jobs.push(job);
        log(`queued ${job.id}: ${bundle.screens.length} screen(s) → “${bundle.page}”`);
        return json(res, 201, { id: job.id });
      }
      if (req.method === "GET" && url.pathname === "/next") {
        const job = jobs.find((j) => j.state === "queued");
        if (!job) { cors(res); res.writeHead(204); return res.end(); }
        job.state = "running";
        log(`plugin picked up ${job.id}`);
        return json(res, 200, { id: job.id, bundle: job.bundle });
      }
      if (req.method === "POST" && url.pathname.startsWith("/report/")) {
        const job = jobs.find((j) => j.id === url.pathname.slice(8));
        if (!job) return json(res, 404, { error: "no such job" });
        job.report = JSON.parse(await body(req)); job.state = "done";
        log(`report ${job.id}: ${job.report.error ?? `${job.report.screens?.length} screens, ${job.report.issues?.length} issues`}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
        const job = jobs.find((j) => j.id === url.pathname.slice(6));
        return job ? json(res, 200, { id: job.id, state: job.state, report: job.report }) : json(res, 404, { error: "no such job" });
      }
      if (req.method === "GET" && url.pathname === "/image") {
        const key = url.searchParams.get("key") ?? "";
        const src = [...jobs].reverse().map((j) => j.bundle.images?.[key]).find(Boolean) ?? (/^https?:/.test(key) ? { url: key } : undefined);
        if (!src) return json(res, 404, { error: "unknown image " + key });
        cors(res);
        if (src.path) {
          if (!existsSync(src.path)) return json(res, 404, { error: "missing file " + src.path });
          res.writeHead(200, { "content-type": MIME[extname(src.path).toLowerCase()] ?? "application/octet-stream" });
          return res.end(readFileSync(src.path));
        }
        const r = await fetch(src.url);
        if (!r.ok) return json(res, 502, { error: `upstream ${r.status}` });
        res.writeHead(200, { "content-type": r.headers.get("content-type") ?? "application/octet-stream" });
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, jobs: jobs.length });
      json(res, 404, { error: "not found" });
    } catch (e: any) { json(res, 500, { error: e.message }); }
  }).listen(port, () => log(`pen2fig serve on http://localhost:${port} — open the pen2fig plugin in Figma and leave it running`));
  function log(m: string) { process.stdout.write(`[${new Date().toLocaleTimeString()}] ${m}\n`); }
}

// ── push / report ────────────────────────────────────────────────────────────
async function push(file: string, server: string, wait: boolean) {
  const r = await fetch(server + "/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: readFileSync(file, "utf8") }).catch(() => die(`No server at ${server}. Start it with: pen2fig serve`));
  const { id, error } = await (r as Response).json();
  if (error) die(error);
  if (!wait) { process.stdout.write(id + "\n"); return; }
  process.stderr.write(`job ${id} queued; waiting for the Figma plugin…\n`);
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 1500));
    const j = await (await fetch(`${server}/jobs/${id}`)).json();
    if (j.state === "done") { process.stdout.write(JSON.stringify(j.report, null, 2) + "\n"); process.exit(j.report?.error || j.report?.screens?.some((s: any) => s.status.startsWith("ERROR")) ? 2 : 0); }
  }
}

const SERVER = () => flag("--server", "http://localhost:7331")!;
switch (cmd) {
  case "snippet": {
    const withC = bool("--components");
    const noVars = bool("--no-variables");
    if (!args.length) die("usage: pen2fig snippet <pencil-node-id…> [--components] [--no-variables]");
    process.stdout.write(snippet(args, withC, !noVars) + "\n");
    break;
  }
  case "bundle": {
    const page = flag("--page") ?? die("--page <Figma page name> is required");
    const out = flag("-o", "bundle.json")!;
    const penDir = flag("--pen-dir");
    const keep = bool("--keep-positions");
    const noVars = bool("--no-variables");
    const file = args[0] ?? die("usage: pen2fig bundle <pencil-output.txt> --page <name>");
    const b = makeBundle(isAbsolute(file) ? file : resolve(file), page, penDir, keep, !noVars);
    writeFileSync(out, JSON.stringify(b));
    const nv = b.variables ? Object.keys(b.variables.variables).length : 0;
    process.stdout.write(`${out}: ${b.screens.length} screen(s), ${b.components.length} component(s), ${Object.keys(b.images).length} image(s), ${nv} variable(s)\n`);
    break;
  }
  case "serve": serve(parseInt(flag("--port", "7331")!, 10)); break;
  case "push": { const s = SERVER(); const w = bool("--wait"); await push(args[0] ?? die("usage: pen2fig push <bundle.json> [--wait]"), s, w); break; }
  case "report": { const s = SERVER(); const r = await (await fetch(`${s}/jobs/${args[0]}`)).json(); process.stdout.write(JSON.stringify(r, null, 2) + "\n"); break; }
  default:
    process.stdout.write(`pen2fig — port Pencil designs into Figma

  snippet <id…> [--components]   print JS for the Pencil MCP execute tool  [--no-variables]
  bundle <output> --page <name>  turn that output into bundle.json  [--pen-dir dir] [-o file] [--no-variables]
  serve [--port 7331]            job server the Figma plugin polls
  push <bundle.json> [--wait]    queue a build; --wait prints the plugin's report
  report <jobId>                 show a job's report
`);
}
