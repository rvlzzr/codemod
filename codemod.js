/**
 * jscodeshift codemod: Convert Remix loaders → TanStack Router createFileRoute loaders
 *
 * Usage:
 *   jscodeshift -t remix-to-tanstack-loader.js 'app/routes/**/*.{ts,tsx,js,jsx}'
 */

export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // 1) Only proceed if there's a default export (i.e. a UI route)
  if (root.find(j.ExportDefaultDeclaration).size() === 0) {
    return null;
  }

  // 2) Find any of the three loader export forms:
  const fnLoader = root.find(j.ExportNamedDeclaration, {
    declaration: { type: 'FunctionDeclaration', id: { name: 'loader' } }
  });
  const varLoader = root.find(j.ExportNamedDeclaration, {
    declaration: {
      type: 'VariableDeclaration'
    }
  }).filter(path => {
    return path.value.declaration.declarations.some(
      d => d.id.type === 'Identifier' && d.id.name === 'loader'
    );
  });

  if (fnLoader.size() + varLoader.size() === 0) {
    // No loader to migrate
    return null;
  }

  // 3) Extract the loader implementation into an ArrowFunctionExpression
  let loaderFnExpr;
  if (fnLoader.size() > 0) {
    const fnDecl = fnLoader.get().node.declaration;
    loaderFnExpr = j.arrowFunctionExpression(
      fnDecl.params,
      fnDecl.body,
      false
    );
    loaderFnExpr.async = fnDecl.async;
    fnLoader.remove();
  } else {
    // export const loader = ...;
    const vd = varLoader.get().node.declaration;
    const decl = vd.declarations.find(d => d.id.name === 'loader');
    loaderFnExpr = decl.init;
    varLoader.remove();
  }

  // 4) Compute the route path from the file path
  function computeRoutePath(fp) {
    // strip up to /routes
    let p = fp.replace(/.*\/routes/, '')
      // drop extension
      .replace(/\.(tsx|ts|jsx|js)$/, '')
      // convert /index → /
      .replace(/\/index$/, '/')
      // convert $param → :param
      .replace(/\$([^/]+)/g, ':$1');
    return p === '' ? '/' : p;
  }
  const routePath = computeRoutePath(file.path);

  // 5) Ensure we import createFileRoute
  const hasImport = root.find(j.ImportDeclaration, {
    source: { value: '@tanstack/react-router' }
  }).filter(path =>
    path.node.specifiers.some(s =>
      s.imported && s.imported.name === 'createFileRoute'
    )
  ).size() > 0;

  if (!hasImport) {
    root.get().node.program.body.unshift(
      j.importDeclaration(
        [ j.importSpecifier(j.identifier('createFileRoute')) ],
        j.stringLiteral('@tanstack/react-router')
      )
    );
  }

  // 6) Append the new `export const Route = createFileRoute(...)({...})`
  const routeDecl = j.exportNamedDeclaration(
    j.variableDeclaration('const', [
      j.variableDeclarator(
        j.identifier('Route'),
        j.callExpression(
          j.callExpression(
            j.identifier('createFileRoute'),
            [ j.stringLiteral(routePath) ]
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

  root.get().node.program.body.push(routeDecl);

  return root.toSource({ quote: 'single', trailingComma: true });
}
