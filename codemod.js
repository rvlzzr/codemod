// remix-to-tanstack-transformer.FINAL-v8.js

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

  // --- 2. Find Declarations (const/function) for loader and action ---
  const findDeclaration = (name) => {
    let declPath = null;
    root.find(j.VariableDeclarator, { id: { name } }).forEach(p => { declPath = p; });
    if (!declPath) {
      root.find(j.FunctionDeclaration, { id: { name } }).forEach(p => { declPath = p; });
    }
    return declPath;
  };
  
  const findExportPath = (name) => {
      let exportPath = null;
      root.find(j.ExportNamedDeclaration).forEach(path => {
          if (path.node.declaration) {
              const decl = path.node.declaration;
              if (decl.type === 'FunctionDeclaration' && decl.id.name === name) exportPath = path;
              if (decl.type === 'VariableDeclaration' && decl.declarations.some(d => d.id.name === name)) exportPath = path;
          }
      });
      if (!exportPath) {
          root.find(j.ExportSpecifier, { exported: { name } }).forEach(path => { exportPath = path; });
      }
      return exportPath;
  };

  const loaderDeclarationPath = findDeclaration('loader');
  const actionDeclarationPath = findDeclaration('action');
  const defaultExportPathCollection = root.find(j.ExportDefaultDeclaration);

  if (defaultExportPathCollection.length === 0 && !loaderDeclarationPath && !actionDeclarationPath) {
    return root.toSource({ quote: 'single' });
  }

  // --- 3. LOGIC: Process as either a UI Route or an API Route ---

  // CASE A: This is a UI-Centric File
  if (defaultExportPathCollection.length > 0) {
    addTanstackImport('createFileRoute', '@tanstack/react-router');
    const defaultExportPath = defaultExportPathCollection.at(0);
    const defaultExportNodePath = defaultExportPath.get(0);
    let componentDeclaration = defaultExportNodePath.node.declaration;
    
    if (componentDeclaration.type === 'Identifier') {
        const decl = findDeclaration(componentDeclaration.name);
        if (decl) componentDeclaration = decl.node.init || decl.node;
    }

    const componentName = (componentDeclaration.id && componentDeclaration.id.name) || 'RouteComponent';
    const routeOptions = [j.property('init', j.identifier('component'), j.identifier(componentName))];

    // Handle the loader
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

    // Handle the action: add a TODO comment
    if (actionDeclarationPath) {
      const actionExportPath = findExportPath('action');
      if (actionExportPath) {
         const comment = j.commentBlock(' TODO FIX THIS: This action needs to be refactored into a server function. ', true, false);
         j(actionExportPath).insertBefore(comment);
      }
    }
    
    // Assemble the new UI Route
    const uiRouteDeclaration = j.exportNamedDeclaration(j.variableDeclaration('const', [j.variableDeclarator(j.identifier('Route'), j.callExpression(j.identifier('createFileRoute'), [j.objectExpression(routeOptions)]))]));
    root.get().node.program.body.push(uiRouteDeclaration);

    // ✅ SAFER CLEANUP for the component
    // Replace the `export default ...` with a standard `function ...` in one atomic step.
    const newComponentFunction = j.functionDeclaration(j.identifier(componentName), componentDeclaration.params, componentDeclaration.body);
    defaultExportPath.replaceWith(newComponentFunction);

    // If the original component was a variable, remove its declaration statement
    if (componentDeclaration.id) {
        const originalCompDecl = findDeclaration(componentDeclaration.id.name);
        if(originalCompDecl) j(originalCompDecl).closest(j.Statement).remove();
    }
    // Remove the original loader (now that its body has been copied)
    if (loaderDeclarationPath) {
      j(loaderDeclarationPath).closest(j.Statement).remove();
      root.find(j.ExportSpecifier, { exported: { name: 'loader' } }).remove();
    }

  // CASE B: This is an API-Only File
  } else {
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
        
        // Cleanup for API routes
        if (loaderDeclarationPath) {
            j(loaderDeclarationPath).closest(j.Statement).remove();
            root.find(j.ExportSpecifier, { exported: { name: 'loader' } }).remove();
        }
        if (actionDeclarationPath) {
            j(actionDeclarationPath).closest(j.Statement).remove();
            root.find(j.ExportSpecifier, { exported: { name: 'action' } }).remove();
        }
    }
  }

  // --- 4. Finalize Imports ---
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

  root.find(j.ExportNamedDeclaration).filter(path => path.node.specifiers && path.node.specifiers.length === 0 && !path.node.declaration).remove();

  return root.toSource({ quote: 'single' });
}
