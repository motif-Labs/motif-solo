// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { Store } from "./store.js";
import { canonical, git, hash, slash, within } from "./util.js";

const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const TEXT =
  /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|sh|sql|prisma|graphql|gql|md|json|ya?ml|toml|css|scss|html)$/i;
const SKIP =
  /(^|\/)(?:node_modules|\.git|\.rex|\.local|dist|build|coverage|vendor|\.next|\.venv|target)(\/|$)|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)|(?:^|\/)(?:\.env(?:\..*)?|credentials[^/]*|.*\.(?:pem|key|p12))$/i;
export function repositoryFiles(root: string): string[] {
  const tracked = git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  let names: string[] = [];
  if (tracked !== undefined) names = tracked.split("\0").filter(Boolean);
  else {
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name),
          rel = slash(path.relative(root, full));
        if (SKIP.test(rel) || e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) names.push(rel);
      }
    };
    walk(root);
  }
  const ignores = fs.existsSync(path.join(root, ".rexignore"))
    ? fs
        .readFileSync(path.join(root, ".rexignore"), "utf8")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"))
    : [];
  // Deliberately simple: repo-relative exact files or directory prefixes. No ambiguous negation.
  return [...new Set(names)]
    .filter(
      (p) =>
        TEXT.test(p) &&
        !SKIP.test(p) &&
        !ignores.some(
          (x) => p === x || p.startsWith(`${x.replace(/\/$/, "")}/`),
        ),
    )
    .filter((p) => {
      try {
        const f = path.join(root, p);
        return (
          within(root, canonical(f)) &&
          fs.lstatSync(f).isFile() &&
          fs.statSync(f).size < 1_000_000
        );
      } catch {
        return false;
      }
    })
    .sort();
}
export function indexCode(store: Store) {
  const files = repositoryFiles(store.root);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noResolve: false,
    noLib: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
  };
  const config = ts.findConfigFile(store.root, ts.sys.fileExists);
  if (config && within(store.root, config)) {
    const result = ts.readConfigFile(config, ts.sys.readFile);
    if (!result.error)
      Object.assign(
        options,
        ts.parseJsonConfigFileContent(
          result.config,
          ts.sys,
          path.dirname(config),
        ).options,
        { noLib: true, allowJs: true },
      );
  }
  const sourceFiles = files.filter((f) => SOURCE.test(f));
  const program = ts.createProgram(
    sourceFiles.map((f) => path.join(store.root, f)),
    options,
  );
  const checker = program.getTypeChecker();
  const declarations = new Map<ts.Node, string>();
  const scopes = new Map<ts.Node, string>();
  let symbols = 0,
    imports = 0,
    calls = 0,
    unresolvedImports = 0;
  store.db.transaction(() => {
    store.db
      .prepare(
        "UPDATE nodes SET active=0 WHERE kind IN ('file','function','class','method','interface','type','variable','package')",
      )
      .run();
    store.db
      .prepare(
        "DELETE FROM search WHERE id IN (SELECT id FROM nodes WHERE active=0)",
      )
      .run();
    store.db
      .prepare(
        "DELETE FROM edges WHERE kind IN ('DEFINES','IMPORTS','CALLS','TESTS','DEPENDS_ON')",
      )
      .run();
    for (const file of files) {
      const text = fs.readFileSync(path.join(store.root, file), "utf8");
      const test = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(
        file,
      );
      store.put({
        id: `file:${file}`,
        kind: "file",
        label: file,
        path: file,
        hash: hash(text),
        data: {
          language: path.extname(file).slice(1),
          test,
          structural: SOURCE.test(file),
        },
      });
      const sf = program.getSourceFile(path.join(store.root, file));
      if (!sf) continue;
      const occurrences = new Map<string, number>();
      const visit = (node: ts.Node, parents: string[]) => {
        let kind: string | undefined, name: string | undefined;
        if (ts.isFunctionDeclaration(node)) {
          kind = "function";
          name = node.name?.text ?? "default";
        } else if (ts.isClassDeclaration(node)) {
          kind = "class";
          name = node.name?.text ?? "default";
        } else if (
          ts.isMethodDeclaration(node) ||
          ts.isGetAccessor(node) ||
          ts.isSetAccessor(node)
        ) {
          kind = "method";
          name = node.name.getText(sf);
        } else if (ts.isInterfaceDeclaration(node)) {
          kind = "interface";
          name = node.name.text;
        } else if (ts.isTypeAliasDeclaration(node)) {
          kind = "type";
          name = node.name.text;
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) ||
            ts.isFunctionExpression(node.initializer))
        ) {
          kind = "function";
          name = node.name.text;
        }
        let next = parents;
        if (kind && name) {
          const qualified = [...parents, name].join(".");
          const n = occurrences.get(qualified) ?? 0;
          occurrences.set(qualified, n + 1);
          const id = `symbol:${file}#${qualified}${n ? `~${n}` : ""}`;
          const start =
            sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const end = sf.getLineAndCharacterOfPosition(node.end).line + 1;
          store.put({
            id,
            kind,
            label: qualified,
            path: file,
            start,
            end,
            hash: hash(node.getText(sf)),
            body: `${file} ${qualified.replace(/([a-z])([A-Z])/g, "$1 $2")}`,
            data: { test },
          });
          store.edge(`file:${file}`, id, "DEFINES");
          declarations.set(node, id);
          scopes.set(node, id);
          if (ts.isVariableDeclaration(node) && node.initializer)
            scopes.set(node.initializer, id);
          next = [...parents, name];
          symbols++;
        }
        ts.forEachChild(node, (child) => visit(child, next));
      };
      visit(sf, []);
    }
    const resolveDeclaration = (expr: ts.Node): string | undefined => {
      let symbol = checker.getSymbolAtLocation(expr);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        try {
          symbol = checker.getAliasedSymbol(symbol);
        } catch {
          return undefined;
        }
      }
      return symbol?.declarations
        ?.map((d) => declarations.get(d))
        .find(Boolean);
    };
    for (const file of sourceFiles) {
      const sf = program.getSourceFile(path.join(store.root, file));
      if (!sf) continue;
      const visit = (node: ts.Node, owner: string) => {
        owner = scopes.get(node) ?? owner;
        const spec =
          ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
            ? node.moduleSpecifier
            : undefined;
        if (spec && ts.isStringLiteral(spec)) {
          const resolved = ts.resolveModuleName(
            spec.text,
            sf.fileName,
            options,
            ts.sys,
          ).resolvedModule;
          const rel = resolved
            ? slash(path.relative(store.root, resolved.resolvedFileName))
            : undefined;
          if (rel && files.includes(rel)) {
            store.edge(`file:${file}`, `file:${rel}`, "IMPORTS", {
              specifier: spec.text,
            });
            imports++;
            if (store.get(`file:${file}`)?.data.test)
              store.edge(`file:${file}`, `file:${rel}`, "TESTS", {
                basis: "imports; does not prove coverage",
              });
          } else if (!spec.text.startsWith(".") && !spec.text.startsWith("/")) {
            const name = spec.text.startsWith("@")
              ? spec.text.split("/").slice(0, 2).join("/")
              : spec.text.split("/")[0];
            store.put({ id: `package:${name}`, kind: "package", label: name });
            store.edge(`file:${file}`, `package:${name}`, "DEPENDS_ON");
          } else unresolvedImports++;
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const expr = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name
            : node.expression;
          const target = resolveDeclaration(expr);
          if (target) {
            store.edge(owner, target, "CALLS", {
              line:
                sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              basis: "typescript-resolved",
            });
            calls++;
          }
        }
        ts.forEachChild(node, (child) => visit(child, owner));
      };
      visit(sf, `file:${file}`);
    }
    store.setMeta("indexedAt", new Date().toISOString());
    store.setMeta("head", git(store.root, ["rev-parse", "HEAD"]) ?? "unborn");
  })();
  return {
    files: files.length,
    structuralFiles: sourceFiles.length,
    symbols,
    imports,
    calls,
    unresolvedImports,
  };
}
