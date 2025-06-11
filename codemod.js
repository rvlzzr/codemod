export default function transformer(file, api) {
    const j = api.jscodeshift;
    const root = j(file.source);

    const hasDefaultExport = root.find(j.ExportDefaultDeclaration).size() > 0;
    const loaderCollection = findNamedExport(j, root, 'loader');
    const actionCollection = findNamedExport(j, root, 'action');

    // Nothing to process
    if (loaderCollection.size() === 0 && actionCollection.size() === 0) {
        return null;
    }

    // Process all `@remix-run/*` imports first
    cleanRemixImports(j, root);

    if (hasDefaultExport) {
        // --- Case 1: This is a UI Route. We only care about the loader. ---
        if (loaderCollection.size() === 0) {
            return null; // No loader to migrate
        }
        transformUiRoute(j, root, loaderCollection, file.path);
    } else {
        // --- Case 2: This is an API Route. Process loader and/or action. ---
        transformApiRoute(j, root, loaderCollection, actionCollection, file.path);
    }

    return root.toSource({ quote: 'single', trailingComma: true });
}

/**
 * Finds a named export, whether it's a function or a variable declaration.
 */
function findNamedExport(j, root, name) {
    const fnCollection = root.find(j.ExportNamedDeclaration, {
        declaration: { type: 'FunctionDeclaration', id: { name } }
    });
    if (fnCollection.size() > 0) return fnCollection;

    return root.find(j.ExportNamedDeclaration, {
        declaration: { type: 'VariableDeclaration' }
    }).filter(path =>
        path.value.declaration.declarations.some(
            d => d.id.type === 'Identifier' && d.id.name === name
        )
    );
}

/**
 * Extracts a function expression from an export declaration path.
 */
function extractFunctionExpression(j, collection) {
    if (collection.size() === 0) return null;

    const exportPath = collection.get();
    const decl = exportPath.node.declaration;
    let fnExpr;

    if (decl.type === 'FunctionDeclaration') {
        fnExpr = j.arrowFunctionExpression(decl.params, decl.body, false);
        fnExpr.async = decl.async;
    } else { // VariableDeclaration
        const varDeclarator = decl.declarations.find(d => d.id.name === 'loader' || d.id.name === 'action');
        fnExpr = varDeclarator.init;
    }

    // Unwrap json() calls
    j(fnExpr)
        .find(j.CallExpression, { callee: { name: 'json' } })
        .forEach(path => {
            if (path.node.arguments.length > 0) {
                path.replace(path.node.arguments[0]);
            }
        });

    return fnExpr;
}

/**
 * Computes the TanStack Route path from the file path.
 */
function computeRoutePath(fp) {
    let p = fp.replace(/.*\/routes/, '')
        .replace(/\.(tsx|ts|jsx|js)$/, '')
        .replace(/\/index$/, '/')
        .replace(/^_/, '/_')
        .replace(/\/_index$/, '/')
        .replace(/\$([^/]+)/g, ':$1');
    return p === '' ? '/' : p;
}

/**
 * Ensures a named import exists, adding it to the top if it doesn't.
 */
function ensureImport(j, root, importName, source) {
    const hasImport = root.find(j.ImportDeclaration, {
        source: { value: source }
    }).filter(path =>
        path.node.specifiers.some(s => s.imported && s.imported.name === importName)
    ).size() > 0;

    if (!hasImport) {
        root.get().node.program.body.unshift(
            j.importDeclaration(
                [j.importSpecifier(j.identifier(importName))],
                j.stringLiteral(source)
            )
        );
    }
}

/**
 * Cleans up `json` import and replaces @remix-run/* paths.
 */
function cleanRemixImports(j, root) {
    root.find(j.ImportDeclaration, {
        source: { value: v => /@remix-run\/(node|react|server-runtime)/.test(v) }
    }).forEach(path => {
        const sourceValue = path.node.source.value;

        // Part A: Clean up the `json` import specifier
        const remainingSpecifiers = path.node.specifiers.filter(
            s => !(s.type === 'ImportSpecifier' && s.imported.name === 'json')
        );

        if (remainingSpecifiers.length === 0) {
            j(path).remove();
            return;
        }
        path.node.specifiers = remainingSpecifiers;

        // Part B: Replace the source path to the polyfill location
        if (sourceValue === '@remix-run/node') {
            path.node.source = j.stringLiteral('~/remix/node');
        } else if (sourceValue === '@remix-run/react') {
            path.node.source = j.stringLiteral('~/remix/react');
        }
    });
}


/**
 * Transforms a UI route with a loader.
 */
function transformUiRoute(j, root, loaderCollection, filePath) {
    const loaderFnExpr = extractFunctionExpression(j, loaderCollection);
    const routePath = computeRoutePath(filePath);
    ensureImport(j, root, 'createFileRoute', '@tanstack/react-router');

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
                            j.property('init', j.identifier('loader'), loaderFnExpr)
                        ])
                    ]
                )
            )
        ])
    );

    // Replace the old loader export with the new Route export
    j(loaderCollection.get()).replaceWith(routeDecl);
}

/**
 * Transforms an API route with a loader and/or action.
 */
function transformApiRoute(j, root, loaderCollection, actionCollection, filePath) {
    const methods = [];

    const loaderFnExpr = extractFunctionExpression(j, loaderCollection);
    if (loaderFnExpr) {
        methods.push(j.property('init', j.identifier('GET'), loaderFnExpr));
    }

    const actionFnExpr = extractFunctionExpression(j, actionCollection);
    if (actionFnExpr) {
        methods.push(j.property('init', j.identifier('POST'), actionFnExpr));
    }

    if (methods.length === 0) return;

    const routePath = computeRoutePath(filePath);
    ensureImport(j, root, 'createServerFileRoute', '@tanstack/react-router');

    const serverRouteDecl = j.exportNamedDeclaration(
        j.variableDeclaration('const', [
            j.variableDeclarator(
                j.identifier('ServerRoute'),
                j.callExpression(
                    j.callExpression(
                        j.identifier('createServerFileRoute'),
                        [j.stringLiteral(routePath)]
                    ),
                    [j.objectExpression([
                        j.property(
                            'init',
                            j.identifier('methods'),
                            j.objectExpression(methods)
                        )
                    ])]
                )
            )
        ])
    );

    // Remove old exports and add the new one at the end
    loaderCollection.remove();
    actionCollection.remove();
    root.get().program.body.push(serverRouteDecl);
}
