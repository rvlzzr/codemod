export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // 1) Only proceed if there's a default export (i.e. a UI route component)
  if (root.find(j.ExportDefaultDeclaration).size() === 0) {
    return null;
  }

  // 2) Find the `loader` export and get a path reference to it.
  const fnLoaderCollection = root.find(j.ExportNamedDeclaration, {
    declaration: { type: 'FunctionDeclaration', id: { name: 'loader' } }
  });
  const varLoaderCollection = root.find(j.ExportNamedDeclaration, {
    declaration: { type: 'VariableDeclaration' }
  }).filter(path => {
    return path.value.declaration.declarations.some(
      d => d.id.type === 'Identifier' && d.id.name === 'loader'
    );
  });

  if (fnLoaderCollection.size() === 0 && varLoaderCollection.size() === 0) {
    // No loader to migrate
    return null;
  }

  const loaderExportPath = fnLoaderCollection.size() > 0 ?
    fnLoaderCollection.get() :
    varLoaderCollection.get();

  // 3) Extract the loader implementation into an ArrowFunctionExpression
  let loaderFnExpr;
  if (fnLoaderCollection.size() > 0) {
    const fnDecl = fnLoaderCollection.get().node.declaration;
    loaderFnExpr = j.arrowFunctionExpression(
      fnDecl.params,
      fnDecl.body,
      false
    );
    loaderFnExpr.async = fnDecl.async;
  } else {
    // This handles `export const loader = ...`
    const vd = varLoaderCollection.get().node.declaration;
    const decl = vd.declarations.find(d => d.id.name === 'loader');
    loaderFnExpr = decl.init;
  }

  // 4) NEW: Remove `json()` wrappers from return statements in the loader.
  // TanStack Router loaders return data directly.
  j(loaderFnExpr)
    .find(j.CallExpression, { callee: { name: 'json' } })
    .forEach(path => {
      // Replace `json(data)` with just `data`
      if (path.node.arguments.length > 0) {
        path.replace(path.node.arguments[0]);
      }
    });

  // 5) NEW: Clean up `json` import and replace @remix-run/* paths.
  root.find(j.ImportDeclaration, {
    source: { value: v => /@remix-run\/(node|react|server-runtime)/.test(v) }
  }).forEach(path => {
    const sourceValue = path.node.source.value;

    // Part A: Clean up the `json` import specifier
    const remainingSpecifiers = path.node.specifiers.filter(
      s => !(s.type === 'ImportSpecifier' && s.imported.name === 'json')
    );

    // If `json` was the only thing imported, remove the entire import statement.
    if (remainingSpecifiers.length === 0) {
      j(path).remove();
      return; // Continue to next import declaration
    }
    
    // Otherwise, update the specifiers list.
    path.node.specifiers = remainingSpecifiers;

    // Part B: Replace the source path to the polyfill location
    if (sourceValue === '@remix-run/node') {
        path.node.source = j.stringLiteral('~/remix/node');
    } else if (sourceValue === '@remix-run/react') {
        path.node.source = j.stringLiteral('~/remix/react');
    }
  });


  // 6) Compute the route path from the file path
  function computeRoutePath(fp) {
    // strip up to /routes
    let p = fp.replace(/.*\/routes/, '')
      // drop extension
      .replace(/\.(tsx|ts|jsx|js)$/, '')
      // convert /index → /
      .replace(/\/index$/, '/')
      // convert _layout → /_layout
      .replace(/^_/, '/_')
      // convert /_index -> /
      .replace(/\/_index$/, '/')
      // convert $param → :param
      .replace(/\$([^/]+)/g, ':$1');
    return p === '' ? '/' : p;
  }
  const routePath = computeRoutePath(file.path);

  // 7) Ensure we import `createFileRoute` from TanStack Router
  const hasImport = root.find(j.ImportDeclaration, {
    source: { value: '@tanstack/react-router' }
  }).filter(path =>
    path.node.specifiers.some(s =>
      s.imported && s.imported.name === 'createFileRoute'
    )
  ).size() > 0;

  if (!hasImport) {
    // Add import to the top of the file
    root.get().node.program.body.unshift(
      j.importDeclaration(
        [j.importSpecifier(j.identifier('createFileRoute'))],
        j.stringLiteral('@tanstack/react-router')
      )
    );
  }

  // 8) Build the new `export const Route = createFileRoute(...)({...})`
  const routeDecl = j.exportNamedDeclaration(
    j.variableDeclaration('const', [
      j.variableDeclarator(
        j.identifier('Route'),
        j.callExpression(
          j.callExpression(
            j.identifier('createFileRoute'),
            [j.stringLiteral(routePath)]
          ),
          [
            j.objectExpression([
              j.property(
                'init',
                j.identifier('loader'),
                loaderFnExpr
              )
            ])
          ]
        )
      )
    ])
  );

  // 9) NEW: Replace the old loader export with the new Route export
  // This preserves the original position in the file.
  j(loaderExportPath).replaceWith(routeDecl);

  return root.toSource({ quote: 'single', trailingComma: true });
}
