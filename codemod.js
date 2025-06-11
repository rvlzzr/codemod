// remix-to-tanstack-transformer.FINAL-v10.js

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

    // 1) plain `const name = …;`
    root.find(j.VariableDeclarator, { id: { name } })
      .forEach(p => { declPath = p; });

    if (!declPath) {
      // 2) `export const name = …;` or `export const name: Type = …;`
      root.find(j.ExportNamedDeclaration, {
        declaration: { type: 'VariableDeclaration' }
      }).forEach(exportPath => {
        const decl = exportPath.node.declaration;
        decl.declarations.forEach(d => {
          if (d.id.name === name) {
            const dPath = j(exportPath)
              .find(j.VariableDeclarator, { id: { name } })
              .paths()[0];
            declPath = dPath;
          }
        });
      });
    }

    if (!declPath) {
      // 3) plain `function name() { … }`
      root.find(j.FunctionDeclaration, { id: { name } })
        .forEach(p => { declPath = p; });
    }

    if (!declPath) {
      // 4) `export function name() { … }`
      root.find(j.ExportNamedDeclaration, { declaration: { type: 'FunctionDeclaration' } })
        .forEach(exportPath => {
          const fn = exportPath.node.declaration;
          if (fn.id && fn.id.name === name) {
            const fnPath = j(exportPath)
              .find(j.FunctionDeclaration, { id: { name } })
              .paths()[0];
            declPath = fnPath;
          }
        });
    }

    return declPath;
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

    // Handle `export default MyComponentIdentifier`
    if (componentDeclaration.type === 'Identifier') {
      const decl = findDeclaration(componentDeclaration.name);
      if (decl) componentDeclaration = decl.node.init || decl.node;
    }

    const componentName = (componentDeclaration.id && componentDeclaration.id.name) || 'RouteComponent';
    const routeOptions = [
      j.property('init', j.identifier('component'), j.identifier(componentName))
    ];

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

    // Handle the action
    if (actionDeclarationPath) {
      const comment = j.commentBlock(
        ' TODO FIX THIS: This action needs to be refactored into a server function. ',
        true,
        false
      );
      j(actionDeclarationPath).closest(j.Statement).insertBefore(comment);
    }

    // Assemble the new UI Route
    const uiRouteDeclaration = j.exportNamedDeclaration(
      j.variableDeclaration('const', [
        j.variableDeclarator(
          j.identifier('Route'),
          j.callExpression(j.identifier('createFileRoute'), [
            j.objectExpression(routeOptions)
          ])
        )
      ])
    );
    root.get().node.program.body.push(uiRouteDeclaration);

    // ✅ SAFER Component Creation
    const body = componentDeclaration.body.type === 'BlockStatement'
      ? componentDeclaration.body
      : j.blockStatement([j.returnStatement(componentDeclaration.body)]);

    const newComponentFunction = j.functionDeclaration(
      j.identifier(componentName),
      componentDeclaration.params,
      body
    );
    defaultExportPath.replaceWith(newComponentFunction);

    // Remove the original component declaration if it wasn’t exported
    if (componentDeclaration.id) {
      const originalCompDecl = findDeclaration(componentDeclaration.id.name);
      if (originalCompDecl) {
        const isExported = j(originalCompDecl).closest(j.ExportNamedDeclaration).length > 0;
        if (!isExported) {
          j(originalCompDecl).closest(j.Statement).remove();
        }
      }
    }

    // Remove the original loader export
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
      const serverRouteDeclaration = j.exportNamedDeclaration(
        j.variableDeclaration('const', [
          j.variableDeclarator(
            j.identifier('ServerRoute'),
            j.callExpression(
              j.memberExpression(
                j.callExpression(j.identifier('createServerFileRoute'), []),
                j.identifier('methods')
              ),
              [j.objectExpression(serverMethods)]
            )
          )
        ])
      );
      root.get().node.program.body.push(serverRouteDeclaration);

      // Cleanup for API routes
      if (loaderDeclarationPath) {
        j(loaderDeclarationPath).closest(j.Statement).remove();
      }
      if (actionDeclarationPath) {
        j(actionDeclarationPath).closest(j.Statement).remove();
      }
      root.find(j.ExportSpecifier, {
        exported: { name: n => n === 'loader' || n === 'action' }
      }).remove();
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
    root.get().node.program.body.unshift(
      j.importDeclaration(specifiers, j.literal(path))
    );
  });

  root.find(j.ExportNamedDeclaration)
    .filter(path => path.node.specifiers && path.node.specifiers.length === 0 && !path.node.declaration)
    .remove();

  return root.toSource({ quote: 'single' });
}
