// Compiler-parsed declaration boundaries preserve multiline API contracts without function bodies.
import ts from "typescript";

export function typescriptSkeleton(content: string, file: string): {
  signatures: Map<string, string>; exported: Set<string>;
} | null {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return null;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const signatures = new Map<string, string>();
  const exported = new Set<string>();
  const nameOf = (node: ts.Node): string | undefined => {
    const name = (node as ts.NamedDeclaration).name;
    return name?.getText(source);
  };
  for (const statement of source.statements) {
    if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) exported.add(d.name.getText(source));
      else if (nameOf(statement)) exported.add(nameOf(statement)!);
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) exported.add((item.propertyName ?? item.name).text);
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) exported.add(statement.expression.text);
  }
  const visit = (node: ts.Node): void => {
    const name = nameOf(node);
    let signature: string | undefined;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
      signature = content.slice(node.getStart(source), node.body?.getStart(source) ?? node.end).trim().replace(/;$/, "");
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      signature = node.getText(source);
    } else if (ts.isPropertyDeclaration(node) && node.type) {
      signature = content.slice(node.getStart(source), node.type.end) + ";";
    }
    if (name && signature) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      signatures.set(`${line}:${name}`, signature.replace(/\s+/g, " "));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { signatures, exported };
}
