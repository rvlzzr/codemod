// remix-to-tanstack-transformer.FINAL-v5.js

export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // --- Universal Setup ---
  const tanstackImports = new Set();
  const addTanstackImport = (specifier, path) => tanstackImports.add(`${specifier}:${path}`);

  // --- 1. Change Remix import paths ---
  root.find(j.ImportDeclaration).forEach(path => {
    const source = path.node.source;
    if (source.value === '@remix-run/node') source.value = '~/remix/node';
    if (source.value === '@remix-run/react') source.value = '~/remix/react';
  });

  // --- 2. NEW: Safely find all relevant top-level exports ---
  // This new approach avoids crashing on `export type` statements.
  let defaultExportPath = null;
  let loaderExportPath = null;
  let actionExportPath = null;

  root.find(j.ExportDeclaration).forEach(path => {
    // Find `export default ...`
    if (path.node.type === 'ExportDefaultDeclaration') {
      defaultExportPath = path;
      return;
    }

    // Find `export function loader() {}` or `export function action() {}`
    if (path.node.type === 'ExportNamedDeclaration' && path.node.declaration && path.node.declaration.type === 'FunctionDeclaration') {
      const functionName = path.node.declaration.id.name;
      if (functionName === 'loader') {
        loaderExportPath = path;
      } else if (functionName === 'action') {
        actionExportPath = path;
      }
    }
  });

  // Exit if there's nothing for us to do
  if (!defaultExportPath && !loaderExportPath && !actionExportPath) {
    return root.toSource();
  }

  // --- 3. LOGIC: Process as either a UI Route or an API Route ---

  // CASE A: This is a UI-Centric File (it has a component)
  if (defaultExportPath) {
    addTanstackImport('createFileRoute', '@tanstack/react-router');
    const componentDeclaration = defaultExportPath.node.declaration;
    const componentName = (componentDeclaration.id && componentDeclaration.id.name) || 'RouteComponent';
    const routeOptions = [j.property('init', j.identifier('component'), j.identifier(componentName))];

    // Handle the loader: move it inside the Route definition
    if (loaderExportPath) {
      const loaderFunc = loaderExportPath.node.declaration;
      const uiLoaderFunc = j.arrowFunctionExpression(
          [j.objectPattern([
              j.property('init', j.identifier('params'), j.identifier('params')),
              j.property('init', j.identifier('search'), j.identifier('search')),
          ])],
          loaderFunc.body,
          true
      );
      routeOptions.unshift(j.property('init', j.identifier('loader'), uiLoaderFunc));
      // Remove the original loader export
      j(loaderExportPath).remove();
    }

    // Handle the action: LEAVE IT ALONE, but add a TODO comment
    if (actionExportPath) {
      const comment = j.commentBlock(' TODO FIX THIS: This action needs to be refactored into a server function. ', true, false);
      j(actionExportPath).insertBefore(comment);
    }
    
    // Assemble and add the new UI Route definition
    const uiRouteDeclaration = j.exportNamedDeclaration(
      j.variableDeclaration('const', [
        j.variableDeclarator(j.identifier('Route'), j.callExpression(j.identifier('createFileRoute'), [j.objectExpression(routeOptions)]))
      ])
    );
    root.get().node.program.body.push(uiRouteDeclaration);

    // Replace the default export with a standard named function/component
    if (componentDeclaration.id) {
        j(defaultExportPath).replaceWith(componentDeclaration);
    } else {
        j(defaultExportPath).replaceWith(j.functionDeclaration(j.identifier(componentName), componentDeclaration.params, componentDeclaration.body.type === 'BlockStatement' ? componentDeclaration.body : j.blockStatement([j.returnStatement(componentDeclaration.body)])));
    }

  // CASE B: This is an API-Only File (no component)
  } else {
    addTanstackImport('createServerFileRoute', '@tanstack/start/server');
    const serverMethods = [];
    if (loaderExportPath) {
        const loaderFunc = loaderExportPath.node.declaration;
        serverMethods.push(j.property('init', j.identifier('GET'), loaderFunc));
        j(loaderExportPath).remove();
    }
    if (actionExportPath) {
        const actionFunc = actionExportPath.node.declaration;
        serverMethods.push(j.property('init', j.identifier('POST'), actionFunc));
        j(actionExportPath).remove();
    }

    if (serverMethods.length > 0) {
        const serverRouteDeclaration = j.exportNamedDeclaration(
            j.variableDeclaration('const', [
                j.variableDeclarator(j.identifier('ServerRoute'), j.callExpression(j.memberExpression(j.callExpression(j.identifier('createServerFileRoute'), []), j.identifier('methods')), [j.objectExpression(serverMethods)]))
            ])
        );
        root.get().node.program.body.push(serverRouteDeclaration);
    }
  }

  // --- 4. Final Cleanup: Add Imports ---
  const importsToAdd = {};
  tanstackImports.forEach(imp => {
      const [specifier, path] = imp.split(':');
      if (!importsToAdd[path]) importsToAdd[path] = [];
      importsToAdd[path].push(specifier);
  });
  Object.keys(importsToAdd).forEach(path => {
      const specifiers = importsToAdd[path].map(name => j.importSpecifier(j.identifier(name)));
      root.get().node.program.body.unshift(j.importDeclaration(specifiers, j.literal(path)));
  });

  return root.toSource({ quote: 'single' });
}
