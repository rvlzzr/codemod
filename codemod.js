// remix-to-tanstack-transformer.FINAL-v7.js

export default function transformer(file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  // --- Universal Setup ---
  const tanstackImports = new Set();
  const addTanstackImport = (specifier, path) => tanstackImports.add(`${specifier}:${path}`);
  let hasMadeChanges = false;

  // --- 1. Change Remix import paths ---
  root.find(j.ImportDeclaration).forEach(path => {
    const source = path.node.source;
    if (source.value === '@remix-run/node') { source.value = '~/remix/node'; hasMadeChanges = true; }
    if (source.value === '@remix-run/react') { source.value = '~/remix/react'; hasMadeChanges = true; }
  });

  // --- 2. Find Declarations (const/function) for loader and action ---
  const findDeclaration = (name) => {
    let declPath = null;
    // Find `const name = ...` or `let name = ...`
    root.find(j.VariableDeclarator, { id: { name } }).forEach(p => { declPath = p; });
    // Find `function name() {}`
    if (!declPath) {
      root.find(j.FunctionDeclaration, { id: { name } }).forEach(p => { declPath = p; });
    }
    return declPath;
  };

  const loaderDeclarationPath = findDeclaration('loader');
  const actionDeclarationPath = findDeclaration('action');
  const defaultExportPath = root.find(j.ExportDefaultDeclaration).at(0);

  if (defaultExportPath.length === 0 && !loaderDeclarationPath && !actionDeclarationPath) {
    return hasMadeChanges ? root.toSource({ quote: 'single' }) : null;
  }

  // --- 3. LOGIC: Process as either a UI Route or an API Route ---

  // CASE A: This is a UI-Centric File
  if (defaultExportPath.length > 0) {
    hasMadeChanges = true;
    addTanstackImport('createFileRoute', '@tanstack/react-router');
    const defaultExportNodePath = defaultExportPath.get(0);
    let componentDeclaration = defaultExportNodePath.node.declaration;
    
    if (componentDeclaration.type === 'Identifier') {
        const decl = findDeclaration(componentDeclaration.name);
        if (decl) componentDeclaration = decl.node.init || decl.node;
    }

    const componentName = (componentDeclaration.id && componentDeclaration.id.name) || 'RouteComponent';
    const routeOptions = [j.property('init', j.identifier('component'), j.identifier(componentName))];

    if (loaderDeclarationPath) {
      const loaderFuncBody = (loaderDeclarationPath.node.init || loaderDeclarationPath.node).body;
      const uiLoaderFunc = j.arrowFunctionExpression(
          [j.objectPattern([
              j.property('init', j.identifier('params'), j.identifier('params')),
              j.property('init', j.identifier('search'), j.identifier('search')),
          ])],
          loaderFuncBody,
          true
      );
      routeOptions.unshift(j.property('init', j.identifier('loader'), uiLoaderFunc));
    }

    if (actionDeclarationPath) {
      const actionExportPath = root.find(j.ExportNamedDeclaration).filter(p => p.node.declaration && p.node.declaration.id && p.node.declaration.id.name === 'action');
      if (actionExportPath.length > 0) {
        const comment = j.commentBlock(' TODO FIX THIS: This action needs to be refactored into a server function. ', true, false);
        actionExportPath.insertBefore(comment);
      }
    }
    
    const uiRouteDeclaration = j.exportNamedDeclaration(j.variableDeclaration('const', [j.variableDeclarator(j.identifier('Route'), j.callExpression(j.identifier('createFileRoute'), [j.objectExpression(routeOptions)]))]));
    root.get().node.program.body.push(uiRouteDeclaration);
    root.get().node.program.body.push(j.functionDeclaration(j.identifier(componentName), componentDeclaration.params, componentDeclaration.body));

  // CASE B: This is an API-Only File
  } else {
    hasMadeChanges = true;
    addTanstackImport('createServerFileRoute', '@tanstack/start/server');
    const serverMethods = [];

    if (loaderDeclarationPath) {
        const loaderFunc = loaderDeclarationPath.node.init || loaderDeclarationPath.node;
        serverMethods.push(j.property('init', j.identifier('GET'), loaderFunc));
    }
    if (actionDeclarationPath) {
        const actionFunc = actionDeclarationPath.node.init || actionDeclarationPath.node;
        serverMethods.push(j.property('init', j.identifier('POST'), actionFunc));
    }

    if (serverMethods.length > 0) {
        const serverRouteDeclaration = j.exportNamedDeclaration(j.variableDeclaration('const', [j.variableDeclarator(j.identifier('ServerRoute'), j.callExpression(j.memberExpression(j.callExpression(j.identifier('createServerFileRoute'), []), j.identifier('methods')), [j.objectExpression(serverMethods)]))]));
        root.get().node.program.body.push(serverRouteDeclaration);
    }
  }

  // --- 4. SAFER CLEANUP ---
  // Now that the new code is added, we can safely remove the old declarations and exports.
  if (loaderDeclarationPath && (defaultExportPath.length === 0 || !actionDeclarationPath)) {
      j(loaderDeclarationPath).closest(j.Statement).remove();
      root.find(j.ExportSpecifier, { exported: { name: 'loader' } }).remove();
  }
   if (actionDeclarationPath && defaultExportPath.length === 0) {
       j(actionDeclarationPath).closest(j.Statement).remove();
       root.find(j.ExportSpecifier, { exported: { name: 'action' } }).remove();
   }
   if (defaultExportPath.length > 0) {
       const path = defaultExportPath.get(0);
       const decl = path.node.declaration;
       if (decl.type === 'Identifier') {
           const declPath = findDeclaration(decl.name);
           if (declPath) j(declPath).closest(j.Statement).remove();
       }
       j(path).remove();
   }


  // --- 5. Finalize Imports ---
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

  // Clean up empty export blocks like `export {}` that might result from removing specifiers.
  root.find(j.ExportNamedDeclaration).filter(path => path.node.specifiers && path.node.specifiers.length === 0 && !path.node.declaration).remove();

  return root.toSource({ quote: 'single' });
}
