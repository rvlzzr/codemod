// remix-to-tanstack-transformer.FINAL-v6.js

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

  // --- 2. NEW ROBUST DISCOVERY: Find declarations and their exports ---
  // This helper finds the declaration (const or function) for a given name.
  const findDeclaration = (name) => {
    let declarationPath = null;
    root.find(j.VariableDeclarator, { id: { name } }).forEach(path => { declarationPath = path; });
    if (declarationPath) return declarationPath;
    root.find(j.FunctionDeclaration, { id: { name } }).forEach(path => { declarationPath = path; });
    return declarationPath;
  };
  
  // This helper finds how a variable is exported.
  const findExportPath = (name) => {
      let exportPath = null;
      // Find `export function/const loader ...`
      root.find(j.ExportNamedDeclaration).forEach(path => {
          if (path.node.declaration) {
              const decl = path.node.declaration;
              if (decl.type === 'FunctionDeclaration' && decl.id.name === name) exportPath = path;
              if (decl.type === 'VariableDeclaration' && decl.declarations.some(d => d.id.name === name)) exportPath = path;
          }
      });
      // Find `export { loader }`
      if (!exportPath) {
          root.find(j.ExportSpecifier, { exported: { name } }).forEach(path => { exportPath = path; });
      }
      return exportPath;
  };

  const loaderDeclarationPath = findDeclaration('loader');
  const actionDeclarationPath = findDeclaration('action');
  const defaultExportPath = root.find(j.ExportDefaultDeclaration).at(0); // This is a NodePath collection

  // Exit if there's nothing to transform
  if (defaultExportPath.length === 0 && !loaderDeclarationPath && !actionDeclarationPath) {
    return root.toSource();
  }

  // --- 3. LOGIC: Process as either a UI Route or an API Route ---

  // CASE A: This is a UI-Centric File
  if (defaultExportPath.length > 0) {
    addTanstackImport('createFileRoute', '@tanstack/react-router');
    const defaultExportNodePath = defaultExportPath.get(0);
    let componentDeclaration = defaultExportNodePath.node.declaration;
    
    // Handle `export default MyComponentIdentifier`
    if (componentDeclaration.type === 'Identifier') {
        const componentName = componentDeclaration.name;
        const foundDecl = findDeclaration(componentName);
        if(foundDecl) componentDeclaration = foundDecl.node.init || foundDecl.node;
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
      
      // Remove original loader declaration and its export
      j(loaderDeclarationPath).closest(j.VariableDeclarationStatement).remove();
      j(loaderDeclarationPath).closest(j.FunctionDeclaration).remove();
      const loaderExportPath = findExportPath('loader');
      if(loaderExportPath) j(loaderExportPath).remove();
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

    // Cleanup the old default export and its declaration if needed
    if (componentDeclaration.id) { // It was a named function/const
        const componentDeclPath = findDeclaration(componentDeclaration.id.name);
        if (componentDeclPath) j(componentDeclPath).closest(j.VariableDeclarationStatement).remove();
    }
    j(defaultExportNodePath).replaceWith(j.functionDeclaration(j.identifier(componentName), componentDeclaration.params, componentDeclaration.body));

  // CASE B: This is an API-Only File
  } else {
    addTanstackImport('createServerFileRoute', '@tanstack/start/server');
    const serverMethods = [];

    if (loaderDeclarationPath) {
        const loaderFunc = loaderDeclarationPath.node.init || loaderDeclarationPath.node;
        serverMethods.push(j.property('init', j.identifier('GET'), loaderFunc));
        j(loaderDeclarationPath).closest(j.VariableDeclarationStatement).remove();
        j(loaderDeclarationPath).closest(j.FunctionDeclaration).remove();
        const loaderExportPath = findExportPath('loader');
        if(loaderExportPath) j(loaderExportPath).remove();
    }
    if (actionDeclarationPath) {
        const actionFunc = actionDeclarationPath.node.init || actionDeclarationPath.node;
        serverMethods.push(j.property('init', j.identifier('POST'), actionFunc));
        j(actionDeclarationPath).closest(j.VariableDeclarationStatement).remove();
        j(actionDeclarationPath).closest(j.FunctionDeclaration).remove();
        const actionExportPath = findExportPath('action');
        if(actionExportPath) j(actionExportPath).remove();
    }

    if (serverMethods.length > 0) {
        const serverRouteDeclaration = j.exportNamedDeclaration(j.variableDeclaration('const', [j.variableDeclarator(j.identifier('ServerRoute'), j.callExpression(j.memberExpression(j.callExpression(j.identifier('createServerFileRoute'), []), j.identifier('methods')), [j.objectExpression(serverMethods)]))]));
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

  // Clean up empty export blocks like `export {}`
  root.find(j.ExportNamedDeclaration).filter(path => path.node.specifiers.length === 0 && !path.node.declaration).remove();

  return root.toSource({ quote: 'single' });
}
