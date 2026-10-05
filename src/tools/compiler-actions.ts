// Compiler edits are previewed as immutable artifacts, then hash-checked at application.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { extname } from "node:path";
import { getDB } from "../core/db.js";
import { resolveProjectPath } from "../core/path-guard.js";
import { workspaceState } from "../core/evidence-state.js";
import { persistArtifact, readArtifact, buildArtifactId } from "../core/artifacts.js";
import { queryTypeScriptCompiler } from "../core/typescript-reference-process.js";
import { pythonOperation } from "../core/python-language-server.js";
import { captureSource, assertSourceUnchanged, publishSource, withSourceMutation } from "../core/source-mutation.js";
import { createRestorePoint } from "../git/shadow.js";
import { assertRenameName } from "./symbolic-edit.js";
import { invalidateSearchCache } from "./semantic-search.js";
import { invalidateIdentifierSearchCache } from "./semantic-identifiers.js";

const typescript = (file: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function languageFiles(root: string, python: boolean): Promise<string[]> {
  return (await getDB(root)).getAllFiles().filter(file=>python ? file.path.endsWith(".py") : typescript(file.path))
    .map(file=>resolveProjectPath(root,file.path));
}
export async function compilerDiagnostics(options: { rootDir: string; files: string[] }) {
  const tsFiles = options.files.filter(typescript).map(file=>resolveProjectPath(options.rootDir,file));
  const pyFiles = options.files.filter(file=>file.endsWith(".py")).map(file=>resolveProjectPath(options.rootDir,file));
  const unsupported = options.files.filter(file=>!typescript(file) && !file.endsWith(".py"));
  const results = [];
  if(tsFiles.length) results.push(await queryTypeScriptCompiler({rootDir:options.rootDir,files:tsFiles,operation:"diagnostics"}));
  if(pyFiles.length) results.push(await pythonOperation({rootDir:options.rootDir,files:pyFiles,operation:"diagnostics"}));
  return { results, unsupported, execution: "compiler diagnostics only; tests were not executed" };
}
interface Preview {
  root: string; stateDigest: string; revision: string | null; engine: string; warnings: string[];
  files: Array<{ file: string; hash: string; next: string; edits: Array<{start:number;length:number;text:string}> }>;
}
export async function previewRename(options: { rootDir: string; file: string; line: number; column: number; newName: string; maxTokens?: number }) {
  const root = await realpath(options.rootDir), file = resolveProjectPath(root,options.file);
  const python = extname(file)===".py";
  if (!python && !typescript(file)) throw new Error("Compiler rename supports TS/JS and Python. Other languages retain the explicit textual rename tool.");
  assertRenameName(options.newName,file);
  const state = await workspaceState(root);
  const input = {rootDir:root,files:await languageFiles(root,python),file,line:options.line,column:options.column,newName:options.newName,operation:"rename" as const};
  const result = python ? await pythonOperation(input) : await queryTypeScriptCompiler(input);
  const current = await workspaceState(root);
  if(state.digest!==current.digest || state.revision!==current.revision) throw new Error("Workspace changed during rename analysis; retry.");
  const files: Preview["files"] = [];
  const paths = [...new Set(result.edits?.map(edit=>edit.file) ?? [])];
  if(paths.length>100 || (result.edits?.length ?? 0)>5000) throw new Error("Rename exceeds 100 files or 5,000 edits; narrow the operation.");
  for(const path of paths) {
    const snapshot = captureSource(root,path);
    if(snapshot.content===null || !snapshot.hash) throw new Error(`Missing rename source: ${path}`);
    const before = state.files.find(item=>item.file===path);
    if(!before || before.hash!==snapshot.hash) throw new Error(`Rename touches excluded or changed source: ${path}`);
    const edits = result.edits!.filter(edit=>edit.file===path).sort((a,b)=>b.start-a.start);
    let next=snapshot.content, boundary=next.length;
    for(const edit of edits) {
      if(edit.start<0 || edit.length<0 || edit.start+edit.length>boundary) throw new Error("Overlapping or invalid compiler edits.");
      next=next.slice(0,edit.start)+edit.text+next.slice(edit.start+edit.length);boundary=edit.start;
    }
    files.push({file:path,hash:snapshot.hash,next,edits:edits.map(({start,length,text})=>({start,length,text}))});
  }
  if(!files.length) throw new Error("No compiler rename edits.");
  const payload: Preview={root,stateDigest:state.digest,revision:state.revision,engine:result.engine,warnings:result.warnings,files};
  if(Buffer.byteLength(JSON.stringify(payload))>8*1024*1024) throw new Error("Rename preview exceeds 8 MiB; narrow the operation.");
  const artifact=await persistArtifact({rootDir:root,kind:"rename_preview",key:digest(payload),payload,immutable:true});
  const summary={artifact,engine:result.engine,warnings:result.warnings,files:files.map(({file,hash,edits})=>({file,hash,edits}))};
  const text=JSON.stringify(summary);
  const budget=(options.maxTokens??4000)*4;
  if(Buffer.byteLength(text)<=budget) return text;
  const compact={artifact:{id:artifact.id},engine:result.engine,fileCount:files.length,files:[] as string[],omittedFileCount:files.length,
    omitted:"Edit details and additional paths may exceed the response budget; inspect artifact_read before applying."};
  for(const {file} of files) {
    const next={...compact,files:[...compact.files,file],omittedFileCount:compact.omittedFileCount-1};
    if(Buffer.byteLength(JSON.stringify(next))>budget) break;
    Object.assign(compact,next);
  }
  return JSON.stringify(compact);
}
export async function applyRename(options: { rootDir: string; previewId: string }) {
  const root=await realpath(options.rootDir);
  return withSourceMutation(root,async()=>{
    const artifact=await readArtifact<Preview>(root,options.previewId);
    if(!artifact || artifact.kind!=="rename_preview" || artifact.payload.root!==root
      || artifact.id!==buildArtifactId("rename_preview",digest(artifact.payload))) throw new Error("Invalid rename preview for this workspace.");
    const state=await workspaceState(root);
    if(state.digest!==artifact.payload.stateDigest || state.revision!==artifact.payload.revision) throw new Error("Rename preview is stale; create a new preview.");
    const staged=artifact.payload.files.map(file=>({ ...file,snapshot:captureSource(root,file.file) }));
    for(const item of staged) if(item.snapshot.hash!==item.hash) throw new Error(`Rename source changed: ${item.file}`);
    const restore=await createRestorePoint(root,staged.map(item=>item.file),`Compiler rename ${artifact.id}`);
    for(const item of staged) assertSourceUnchanged(root,item.snapshot);
    const completed:string[]=[];
    try {
      for(const item of staged) {await publishSource(root,item.snapshot,item.next);completed.push(item.file);}
    } catch(error) {throw new Error(`Rename stopped: ${(error as Error).message}. Updated: ${completed.join(", ")||"none"}. Restore point: ${restore.id}`);}
    finally {invalidateSearchCache();invalidateIdentifierSearchCache();}
    return {updated:completed,restorePoint:restore.id,engine:artifact.payload.engine,verification:"Run validate_scope and the recommended checks; applying edits does not prove correctness."};
  });
}
