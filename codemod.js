// remix-to-tanstack-transformer.v2.js
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
    // ✅ IMPROVED: This function is more robust and handles TypeScript type annotations.
    const findDeclaration = (name) => {
        let declPath = null;
        // Handles `const loader = ...` AND `const loader: LoaderArgs = ...`
        root.find(j.VariableDeclarator, {
            id: {
                type: 'Identifier',
                name: name
            }
        }).forEach(p => {
            declPath = p;
        });
        if (!declPath) {
            // Handles `function loader() {}`
            root.find(j.FunctionDeclaration, {
                id: {
                    name: name
                }
            }).forEach(p => {
                declPath = p;
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

    // CASE A: This is a UI-Centric File (has a default export)
    if (defaultExportPathCollection.length > 0) {
        addTanstackImport('createFileRoute', '@tanstack/react-router');
        const defaultExportPath = defaultExportPathCollection.at(0);
        const defaultExportNodePath = defaultExportPath.get(0);
        let componentDeclaration = defaultExportNodePath.node.declaration;

        // Handle `export default MyComponentIdentifier` by finding its declaration
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
                    j.property('init', j.identifier('params'), j.identifier('params'), false, true),
                    j.property('init', j.identifier('search'), j.identifier('search'), false, true),
                ])],
                loaderFuncBody,
                true
            );
            routeOptions.unshift(j.property('init', j.identifier('loader'), uiLoaderFunc));
        }

        // Handle the action: Safely add a TODO comment to the declaration
        if (actionDeclarationPath) {
            const comment = j.commentBlock(' TODO: This action needs to be refactored into a server function. ', true, false);
            j(actionDeclarationPath).closest(j.Statement).insertBefore(comment);
        }

        // Assemble the new UI Route
        const uiRouteDeclaration = j.exportNamedDeclaration(j.variableDeclaration('const', [j.variableDeclarator(j.identifier('Route'), j.callExpression(j.identifier('createFileRoute'), [j.objectExpression(routeOptions)]))]));

        // ✅ SAFER: Add a TODO comment to warn about manual refactoring needed for the loader.
        if (loaderDeclarationPath) {
            const comment = j.commentBlock(' TODO: Manually refactor this loader! The signature has changed from Remix\'s ({ request }) to TanStack\'s ({ params, search }). You may need to update how you access search parameters (from `request.url` to the `search` object) and remove the `json` helper, returning data directly. ', true, false);
            uiRouteDeclaration.comments = [comment];
        }

        root.get().node.program.body.push(uiRouteDeclaration);

        // This handles arrow functions with implicit returns (e.g. `() => <div />`)
        const body = componentDeclaration.body.type === 'BlockStatement' ?
            componentDeclaration.body :
            j.blockStatement([j.returnStatement(componentDeclaration.body)]);

        const newComponentFunction = j.functionDeclaration(j.identifier(componentName), componentDeclaration.params, body);
        defaultExportPath.replaceWith(newComponentFunction);

        // If the original component was a variable that was NOT exported by name, remove it.
        if (componentDeclaration.id) {
            const originalCompDecl = findDeclaration(componentDeclaration.id.name);
            if (originalCompDecl) {
                const isExported = j(originalCompDecl).closest(j.ExportNamedDeclaration).length > 0;
                if (!isExported) {
                    j(originalCompDecl).closest(j.Statement).remove();
                }
            }
        }

        // Remove the original loader (now that its body has been copied)
        if (loaderDeclarationPath) {
            j(loaderDeclarationPath).closest(j.Statement).remove();
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
            // ✅ FIXED: Corrected `j.callExpression` typo
            const serverRouteDeclaration = j.exportNamedDeclaration(j.variableDeclaration('const', [j.variableDeclarator(j.identifier('ServerRoute'), j.callExpression(j.memberExpression(j.callExpression(j.identifier('createServerFileRoute'), []), j.identifier('methods')), [j.objectExpression(serverMethods)]))]));
            root.get().node.program.body.push(serverRouteDeclaration);

            // Cleanup for API routes
            if (loaderDeclarationPath) j(loaderDeclarationPath).closest(j.Statement).remove();
            if (actionDeclarationPath) j(actionDeclarationPath).closest(j.Statement).remove();
        }
    }

    // --- 4. Finalize Imports & Cleanup ---
    // Remove old named exports for loader/action if they exist (e.g., `export { loader }`)
    root.find(j.ExportSpecifier)
        .filter(path => ['loader', 'action'].includes(path.node.exported.name))
        .remove();

    // Add new TanStack imports
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

    // Remove any `export {}` statements that are now empty
    root.find(j.ExportNamedDeclaration).filter(path => path.node.specifiers && path.node.specifiers.length === 0 && !path.node.declaration).remove();

    return root.toSource({ quote: 'single' });
}
