export default function transformer(file, api) {
    const j = api.jscodeshift;
    const root = j(file.source);

    const hasDefaultExport = root.find(j.ExportDefaultDeclaration).size() > 0;
    const loaderCollection = findNamedExport(j, root, 'loader');
    const actionCollection = findNamedExport(j, root, 'action');
    const shouldRevalidateCollection = findNamedExport(j, root, 'shouldRevalidate');

    // Nothing to process
    if (
        loaderCollection.size() === 0 &&
        actionCollection.size() === 0 &&
        shouldRevalidateCollection.size() === 0
    ) {
        return null;
    }

    // Process all `@remix-run/*` imports first
    cleanRemixImports(j, root);

    // Handle and remove shouldRevalidate without leaving a comment
    if (shouldRevalidateCollection.size() > 0) {
        shouldRevalidateCollection.remove();
    }

    if (hasDefaultExport) {
        // --- Case 1: This is a UI Route. We only care about the loader. ---
        if (loaderCollection.size() === 0) {
            // If there's no loader but there was a shouldRevalidate, we might have modified the file.
            return shouldRevalidateCollection.size() > 0 ? root.toSource({ quote: 'single', trailingComma: true }) : null;
        }
        // MODIFIED: This function now implements the server function pattern.
        transformUiRouteWithServerFn(j, root, loaderCollection, file.path);
    } else {
        // --- Case 2: This is an API Route. Process loader and/or action. ---
        if (loaderCollection.size() > 0 || actionCollection.size() > 0) {
            transformApiRoute(j, root, loaderCollection, actionCollection, file.path);
        }
    }

    // If we've made changes, return the new source code.
    return root.toSource({ quote: 'single', trailingComma: true });
}


// --- MODIFIED `transformUiRoute` is now `transformUiRouteWithServerFn` ---
/**
 * Transforms a UI route by creating a `createServerFn` for the loader
 * and a `createFileRoute` that calls it.
 */
function transformUiRouteWithServerFn(j, root, loaderCollection, filePath) {
    const loaderFnExpr = extractFunctionExpression(j, loaderCollection, 'loader');
    if (!loaderFnExpr) return; // Skip if function extraction failed

    const routePath = computeRoutePath(filePath);

    // 1. Ensure all necessary imports are present
    ensureImport(j, root, 'createFileRoute', '@tanstack/react-router');
    ensureImport(j, root, 'createServerFn', '@tanstack/react-start');

    // 2. Create the server function declaration
    // export const loaderFn = createServerFn('GET').handler(async ({ params, ... }) => { ... })
    const serverFnIdentifier = j.identifier('loaderFn'); // Use a distinct name
    const serverFnDecl = j.exportNamedDeclaration(
        j.variableDeclaration('const', [
            j.variableDeclarator(
                serverFnIdentifier,
                j.callExpression(
                    j.memberExpression(
                        j.callExpression(
                            j.identifier('createServerFn'),
                            [
                                j.objectExpression([
                                    j.property('init', j.identifier('method'), j.stringLiteral('GET'))
                                ])
                            ]
                        ),
                        j.identifier('handler')
                    ),
                    [loaderFnExpr]
                )
            )
        ])
    );

    // 3. Create the client-side loader that calls the server function
    // loader: async (context) => loaderFn(context)
    const contextIdentifier = j.identifier('context');
    const clientLoader = j.arrowFunctionExpression(
        [contextIdentifier],
        j.callExpression(serverFnIdentifier, [contextIdentifier])
    );
    clientLoader.async = true;

    // 4. Create the main Route declaration
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
                            j.property('init', j.identifier('loader'), clientLoader)
                        ])
                    ]
                )
            )
        ])
    );

    // 5. Replace the old loader export with BOTH the new server function and the new Route export
    j(loaderCollection.get()).replaceWith([serverFnDecl, routeDecl]);
}


// --- All other helper functions remain the same ---

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
function extractFunctionExpression(j, collection, name) {
    if (collection.size() === 0) return null;

    const exportPath = collection.get();
    if (!exportPath || !exportPath.node) return null;

    const decl = exportPath.node.declaration;
    if (!decl) return null;

    let fnExpr;

    if (decl.type === 'FunctionDeclaration') {
        if (!decl.body) return null; // Guard against invalid AST
        fnExpr = j.arrowFunctionExpression(decl.params, decl.body, false);
        fnExpr.async = decl.async;
    } else if (decl.type === 'VariableDeclaration') {
        if (!decl.declarations) return null;
        const varDeclarator = decl.declarations.find(d => d.id.name === name);
        if (!varDeclarator || !varDeclarator.init) return null;
        fnExpr = varDeclarator.init;
    } else {
        return null; // Don't know how to handle this declaration type
    }

    // Unwrap json() calls from the function body
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
 * Transforms an API route with a loader and/or action.
 */
function transformApiRoute(j, root, loaderCollection, actionCollection, filePath) {
    const methods = [];

    const loaderFnExpr = extractFunctionExpression(j, loaderCollection, 'loader');
    if (loaderFnExpr) {
        methods.push(j.property('init', j.identifier('GET'), loaderFnExpr));
    }

    const actionFnExpr = extractFunctionExpression(j, actionCollection, 'action');
    if (actionFnExpr) {
        methods.push(j.property('init', j.identifier('POST'), actionFnExpr));
    }

    if (methods.length === 0) return;

    // This function doesn't exist in the original code, but is needed for API routes
    // For this example, we assume `createServerFileRoute` is the right tool for API routes.
    ensureImport(j, root, 'createServerFileRoute', '@tanstack/react-router'); 
    const routePath = computeRoutePath(filePath);

    const serverRouteDecl = j.exportNamedDeclaration(
        j.variableDeclaration('const', [
            j.variableDeclarator(
                j.identifier('ServerRoute'), // Can be named anything
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
    
    // Replace the first found export, and remove any others.
    const allPaths = [...loaderCollection.paths(), ...actionCollection.paths()];
    const uniquePaths = [...new Set(allPaths)];

    if (uniquePaths.length > 0) {
        j(uniquePaths[0]).replaceWith(serverRouteDecl);
        for (let i = 1; i < uniquePaths.length; i++) {
            j(uniquePaths[i]).remove();
        }
    }
}
