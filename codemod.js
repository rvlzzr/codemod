// remix-to-tanstack-transformer.FINAL-v11.js

export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // --- Universal Setup ---
  const tanstackImports = new Set();
  const addTanstackImport = (specifier, source) =>
    tanstackImports.add(`${specifier}:${source}`);

  // --- 1. Remap Remix imports ---
  root.find(j.ImportDeclaration).forEach(path => {
    const v = path.node.source.value;
    if (v === '@remix-run/node') path.node.source.value = '~/remix/node';
    if (v === '@remix-run/react') path.node.source.value = '~/remix/react';
  });

  // --- 2. Helper: find ANY declaration of a given name ---
  function findDeclaration(name) {
    let found = null;

    // a) plain `const name = …;`
    root.find(j.VariableDeclarator, { id: { name } })
      .forEach(p => { found = p; });

    // b) exported `const name…`
    if (!found) {
      root.find(j.ExportNamedDeclaration)
        .filter(p => p.node.declaration && p.node.declaration.declarations)
        .forEach(exp => {
          exp.node.declaration.declarations.forEach(d => {
            if (d.id.name === name) {
              const p = j(exp)
                .find(j.VariableDeclarator, { id: { name } })
                .paths()[0];
              if (p) found = p;
            }
          });
        });
    }

    // c) plain `function name() {…}`
    if (!found) {
      root.find(j.FunctionDeclaration, { id: { name } })
        .forEach(p => { found = p; });
    }

    // d) exported `function name() {…}`
    if (!found) {
      root.find(j.ExportNamedDeclaration)
        .filter(p => p.node.declaration && p.node.declaration.type === 'FunctionDeclaration')
        .forEach(exp => {
          const fn = exp.node.declaration;
          if (fn.id && fn.id.name === name) {
            const p = j(exp)
              .find(j.FunctionDeclaration, { id: { name } })
              .paths()[0];
            if (p) found = p;
          }
        });
    }

    return found;
  }

  const loaderPath = findDeclaration('loader');
  const actionPath = findDeclaration('action');
  const defaultExports = root.find(j.ExportDefaultDeclaration);

  // nothing to do?
  if (!loaderPath && !actionPath && defaultExports.size() === 0) {
    return root.toSource({ quote: 'single' });
  }

  // --- 3A. UI route (has a default export) ---
  if (defaultExports.size() > 0) {
    addTanstackImport('createFileRoute', '@tanstack/react-router');

    // Grab the component that was default-exported:
    const def = defaultExports.at(0);
    let comp = def.get().node.declaration;
    if (comp.type === 'Identifier') {
      const decl = findDeclaration(comp.name);
      if (decl) comp = decl.node.init || decl.node;
    }
    const compName = comp.id?.name || 'RouteComponent';

    // Build options array:
    const opts = [
      j.property('init', j.identifier('component'), j.identifier(compName))
    ];

    // If there's a loader, inline its body into a React-style loader fn:
    if (loaderPath) {
      const fn = loaderPath.node.init || loaderPath.node;
      const uiLoader = j.arrowFunctionExpression(
        [
          j.objectPattern([
            j.property('init', j.identifier('params'), j.identifier('params')),
            j.property('init', j.identifier('search'), j.identifier('search')),
          ])
        ],
        fn.body,
        true
      );
      opts.unshift(j.property('init', j.identifier('loader'), uiLoader));
    }

    // If there's an action, tack on a TODO comment above it:
    if (actionPath) {
      const stmt = j(actionPath).closest(j.Statement).get();
      if (stmt && stmt.node) {
        stmt.node.leadingComments = stmt.node.leadingComments || [];
        stmt.node.leadingComments.unshift({
          type: 'CommentBlock',
          value: ' TODO FIX THIS: This action needs to be refactored into a server function. '
        });
      }
    }

    // 3A-1. Emit the new `export const Route = createFileRoute({…})`
    const routeDecl = j.exportNamedDeclaration(
      j.variableDeclaration('const', [
        j.variableDeclarator(
          j.identifier('Route'),
          j.callExpression(
            j.identifier('createFileRoute'),
            [j.objectExpression(opts)]
          )
        )
      ])
    );
    root.get().node.program.body.push(routeDecl);

    // 3A-2. Replace `export default …` with a named `function COMPONENT_NAME (…) {…}`
    const body = comp.body.type === 'BlockStatement'
      ? comp.body
      : j.blockStatement([j.returnStatement(comp.body)]);
    const fnDecl = j.functionDeclaration(
      j.identifier(compName),
      comp.params,
      body
    );
    def.replace(fnDecl);

    // 3A-3. Remove the old loader export (if any)
    if (loaderPath) {
      j(loaderPath).closest(j.Statement).remove();
      root.find(j.ExportSpecifier, { exported: { name: 'loader' } }).remove();
    }

  // --- 3B. API route (no default export) ---
  } else {
    addTanstackImport('createServerFileRoute', '@tanstack/start/server');

    const methods = [];
    if (loaderPath) {
      methods.push(
        j.property('init', j.identifier('GET'), loaderPath.node.init || loaderPath.node)
      );
    }
    if (actionPath) {
      methods.push(
        j.property('init', j.identifier('POST'), actionPath.node.init || actionPath.node)
      );
    }

    if (methods.length) {
      const serverDecl = j.exportNamedDeclaration(
        j.variableDeclaration('const', [
          j.variableDeclarator(
            j.identifier('ServerRoute'),
            j.callExpression(
              j.memberExpression(
                j.callExpression(j.identifier('createServerFileRoute'), []),
                j.identifier('methods')
              ),
              [j.objectExpression(methods)]
            )
          )
        ])
      );
      root.get().node.program.body.push(serverDecl);

      if (loaderPath) j(loaderPath).closest(j.Statement).remove();
      if (actionPath) j(actionPath).closest(j.Statement).remove();
      root.find(j.ExportSpecifier, {
        exported: { name: n => n === 'loader' || n === 'action' }
      }).remove();
    }
  }

  // --- 4. Prepend any needed tanstack imports ---
  const importsMap = {};
  tanstackImports.forEach(imp => {
    const [spec, src] = imp.split(':');
    importsMap[src] = importsMap[src] || [];
    importsMap[src].push(spec);
  });
  Object.entries(importsMap).forEach(([src, specs]) => {
    const nodes = specs.map(s => j.importSpecifier(j.identifier(s)));
    root.get().node.program.body.unshift(
      j.importDeclaration(nodes, j.literal(src))
    );
  });

  // Remove any empty `export { … }` stubs
  root.find(j.ExportNamedDeclaration)
    .filter(p => !p.node.declaration && p.node.specifiers.length === 0)
    .remove();

  return root.toSource({ quote: 'single' });
}
