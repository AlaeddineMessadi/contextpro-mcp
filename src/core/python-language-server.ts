// Optional configured Pyright process. No installation, shell execution or runtime downloads.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node.js";
import pLimit from "p-limit";
import { resolveProjectPath } from "./path-guard.js";
import type { CompilerResult } from "./typescript-references.js";
import { sharedCompute } from "./local-daemon.js";
import { pythonRuntimeIdentity } from "./python-runtime-identity.js";
import { evidenceConfigurationFiles } from "./evidence-state.js";

interface Position { line: number; character: number }
interface Range { start: Position; end: Position }
interface Location { uri: string; range: Range }
interface Diagnostic { range: Range; message: string; severity?: number; code?: number | string }
interface WorkspaceEdit { changes?: Record<string, Array<{ range: Range; newText: string }>>; documentChanges?: Array<{ textDocument?: { uri: string }; edits?: Array<{ range: Range; newText: string }>; kind?: string }> }
interface Session {
  process: ChildProcessWithoutNullStreams; connection: MessageConnection; identity: string;
  opened: Map<string, { version: number; text: string }>;
  diagnostics: Map<string, { version?: number; diagnostics: Diagnostic[] }>;
  idle?: NodeJS.Timeout;
}
const sessions = new Map<string, Session>(), limit = pLimit(1);
export const pythonLanguageServerConfigured = () => !!process.env.CONTEXTPRO_PYRIGHT_COMMAND;
export function closePythonLanguageServers(): void {
  for (const session of sessions.values()) { clearTimeout(session.idle); session.connection.dispose(); session.process.kill(); }
  sessions.clear();
}
function close(root: string): void {
  const session = sessions.get(root);
  if (session) { clearTimeout(session.idle); session.connection.dispose(); session.process.kill(); sessions.delete(root); }
}
async function sessionFor(root: string): Promise<Session> {
  const command = process.env.CONTEXTPRO_PYRIGHT_COMMAND;
  if (!command) throw new Error("Configure CONTEXTPRO_PYRIGHT_COMMAND to an installed pyright-langserver executable. No runtime downloads are performed.");
  const config = await Promise.all((await evidenceConfigurationFiles(root)).map(async file => [file, (await readFile(resolveProjectPath(root, file))).toString("base64")]));
  const identity = createHash("sha256").update(await pythonRuntimeIdentity()).update(process.env.CONTEXTPRO_PYTHON_PATH ?? "").update(JSON.stringify(config)).digest("hex");
  const previous = sessions.get(root);
  if (previous?.identity === identity) { clearTimeout(previous.idle); return previous; }
  if (previous) close(root);
  // ponytail: two cached Python projects; the serial queue prevents active-session eviction.
  if (sessions.size >= 2) close(sessions.keys().next().value!);
  const child = spawn(command, ["--stdio"], { cwd: root, shell: false, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=1024` } });
  const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  const session: Session = { process: child, connection, identity, opened: new Map(), diagnostics: new Map() };
  sessions.set(root, session);
  child.stderr.resume();
  child.on("error", () => { if (sessions.get(root) === session) close(root); });
  child.on("exit", () => { if (sessions.get(root) === session) close(root); });
  connection.onRequest("workspace/configuration", (params: {items:Array<{section?:string}>}) => params.items.map(item => item.section === "python"
    ? { pythonPath: process.env.CONTEXTPRO_PYTHON_PATH } : { diagnosticMode: "openFilesOnly" }));
  connection.onRequest("client/registerCapability", () => null);
  connection.onNotification("textDocument/publishDiagnostics", (params: {uri:string;version?:number;diagnostics:Diagnostic[]}) => session.diagnostics.set(params.uri, params));
  connection.listen();
  await connection.sendRequest("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href,
    workspaceFolders: [{uri:pathToFileURL(root).href,name:root}], capabilities: { workspace: { configuration: true }, textDocument: { publishDiagnostics: { versionSupport: true } } } });
  await connection.sendNotification("initialized", {});
  return session;
}
const offset = (text: string, position: Position): number => {
  const lines = text.split("\n");
  if (position.line < 0 || position.line >= lines.length || position.character < 0 || position.character > lines[position.line].length) throw new Error("Language server returned an invalid edit range.");
  return lines.slice(0,position.line).reduce((size,line)=>size+line.length+1,0)+position.character;
};

type PythonResult = CompilerResult & { references?: Array<{file:string;line:number;column:number;context:string;isDefinition:boolean}> };
export async function pythonOperation(input: { rootDir: string; files: string[]; operation: "diagnostics" | "rename" | "references"; file?: string; line?: number; column?: number; newName?: string }): Promise<PythonResult> {
  const shared = await sharedCompute<PythonResult>("python", input);
  if (shared) return shared.value;
  if (limit.pendingCount >= 16) throw new Error("Python queue capacity exceeded; narrow the request.");
  return limit(async () => {
    const root = await realpath(input.rootDir);
    const canonicalFile = (file: string) => resolveProjectPath(root, relative(resolve(input.rootDir), resolveProjectPath(input.rootDir, file)));
    let deadline: NodeJS.Timeout;
    const work = async () => {
      const session = await sessionFor(root), connection = session.connection;
      const files = [...new Set([...input.files, ...input.file ? [input.file] : []].map(canonicalFile))];
      if (files.length > 1000) throw new Error("Python operation exceeds 1,000 files; narrow the workspace.");
      for (const file of files) {
        const path = resolveProjectPath(root,file), uri = pathToFileURL(path).href;
        const text = await readFile(path,"utf8"), previous = session.opened.get(uri);
        if (previous?.text === text) continue;
        const version = (previous?.version ?? 0)+1;
        session.diagnostics.delete(uri);
        session.opened.set(uri,{text,version});
        if (previous) await connection.sendNotification("textDocument/didChange",{textDocument:{uri,version},contentChanges:[{text}]});
        else await connection.sendNotification("textDocument/didOpen",{textDocument:{uri,version,languageId:"python",text}});
      }
      // Close removed files so deleted callers cannot survive in the server's overlay.
      const active = new Set(files.map(file=>pathToFileURL(resolveProjectPath(root,file)).href));
      for (const uri of session.opened.keys()) if (!active.has(uri)) {
        await connection.sendNotification("textDocument/didClose",{textDocument:{uri}}); session.opened.delete(uri); session.diagnostics.delete(uri);
      }
      const file = input.file ? canonicalFile(input.file) : undefined;
      const textDocument = file ? {uri:pathToFileURL(file).href} : undefined;
      const position = {line:(input.line ?? 1)-1,character:(input.column ?? 1)-1};
      const result: CompilerResult & {references?:Array<{file:string;line:number;column:number;context:string;isDefinition:boolean}>} = {engine:"pyright",warnings:[]};
      if (input.operation === "references") {
        const references = await connection.sendRequest<Location[]>("textDocument/references",{textDocument,position,context:{includeDeclaration:true}});
        const definitions = await connection.sendRequest<Location | Location[] | null>("textDocument/definition",{textDocument,position});
        const definitionList = definitions ? Array.isArray(definitions) ? definitions : [definitions] : [];
        result.references = [];
        for (const location of references ?? []) {
          let path;
          try { path = resolveProjectPath(root,fileURLToPath(location.uri)); } catch { result.warnings.push("External Python references omitted."); continue; }
          const text = session.opened.get(location.uri)?.text ?? await readFile(path,"utf8");
          result.references.push({file:relative(root,path),line:location.range.start.line+1,column:location.range.start.character+1,
            context:(text.split("\n")[location.range.start.line]??"").trim().slice(0,160),
            isDefinition:definitionList.some(item=>item.uri===location.uri && item.range.start.line===location.range.start.line && item.range.start.character===location.range.start.character)});
        }
      } else if (input.operation === "rename") {
        if (!await connection.sendRequest("textDocument/prepareRename",{textDocument,position})) throw new Error("Python language server cannot rename this target.");
        const response = await connection.sendRequest<WorkspaceEdit | null>("textDocument/rename",{textDocument,position,newName:input.newName});
        if (!response) throw new Error("Python language server cannot rename this target.");
        const changes = Object.entries(response.changes ?? {});
        for (const change of response.documentChanges ?? []) {
          if (change.kind || !change.textDocument || !change.edits) throw new Error("Rename includes unsupported file operations.");
          changes.push([change.textDocument.uri,change.edits]);
        }
        result.edits = [];
        for (const [uri,edits] of changes) {
          const path = resolveProjectPath(root,fileURLToPath(uri),"Python rename");
          const text = session.opened.get(uri)?.text ?? await readFile(path,"utf8");
          for (const edit of edits) {
            const start=offset(text,edit.range.start), end=offset(text,edit.range.end);
            if(end<start) throw new Error("Invalid Python rename edit.");
            result.edits.push({file:relative(root,path),start,length:end-start,text:edit.newText});
          }
        }
        if (!result.edits.length) throw new Error("Python language server returned no rename edits.");
      } else {
        const end = Date.now()+15_000;
        while ([...active].some(uri=> !session.diagnostics.has(uri) || (session.diagnostics.get(uri)?.version !== undefined && session.diagnostics.get(uri)?.version !== session.opened.get(uri)?.version))) {
          if(Date.now()>end) throw new Error("Python diagnostics incomplete; server did not report all requested file versions.");
          await new Promise(done=>setTimeout(done,25));
        }
        result.diagnostics = [...active].flatMap(uri => session.diagnostics.get(uri)!.diagnostics.map(item => ({file:relative(root,fileURLToPath(uri)),line:item.range.start.line+1,
          column:item.range.start.character+1,severity:item.severity===1?"error":"warning",code:String(item.code??""),message:item.message.slice(0,1500)})));
        if(result.diagnostics.length>500) {result.diagnostics=result.diagnostics.slice(0,500);result.warnings.push("Diagnostics capped at 500; narrow files.");}
      }
      session.idle = setTimeout(()=>close(root),60_000); session.idle.unref(); childUnref(session);
      return result;
    };
    try { return await Promise.race([work(), new Promise<never>((_,reject)=> {deadline=setTimeout(()=>{close(root);reject(new Error("Python language server timed out."));},30_000);})]); }
    catch(error) {close(root);throw error;}
    finally {clearTimeout(deadline!);}
  });
}
function childUnref(session:Session):void {
  session.process.unref();
  for(const stream of [session.process.stdin,session.process.stdout,session.process.stderr]) (stream as unknown as {unref?:()=>void}).unref?.();
}
