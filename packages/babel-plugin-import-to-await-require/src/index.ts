import type { NodePath } from '@babel/traverse';
import { t } from '@umijs/utils';
import { extname, isAbsolute } from 'path';

type TLibs = (RegExp | string)[];

interface IAlias {
  [key: string]: string;
}

export interface IOpts {
  libs?: TLibs;
  matchAll?: boolean;
  remoteName: string;
  alias?: IAlias;
  webpackAlias?: IAlias;
  onTransformDeps?: Function;
  exportAllMembers?: Record<string, string[]>;
}

export function specifiersToProperties(specifiers: any[]) {
  return specifiers.reduce(
    (memo, s) => {
      if (t.isImportDefaultSpecifier(s)) {
        memo.properties.push(
          t.objectProperty(t.identifier('default'), s.local),
        );
      } else if (t.isExportDefaultSpecifier(s)) {
        memo.properties.push(
          t.objectProperty(t.identifier('default'), s.exported),
        );
      } else if (t.isExportSpecifier(s)) {
        memo.properties.push(t.objectProperty(s.local, s.exported));
      } else if (t.isImportNamespaceSpecifier(s)) {
        memo.namespaceIdentifier = s.local;
      } else {
        memo.properties.push(t.objectProperty(s.imported, s.local));
      }
      return memo;
    },
    { properties: [], namespaceIdentifier: null },
  );
}

const RE_NODE_MODULES = /node_modules/;
const RE_UMI_LOCAL_DEV = /umi\/packages\//;

function getAlias(opts: { path: string; webpackAlias: IAlias }) {
  for (const key of Object.keys(opts.webpackAlias)) {
    const path = isJSFile(opts.webpackAlias[key]) ? key : addLastSlash(key);
    if (opts.path.startsWith(path)) {
      return opts.webpackAlias[key];
    }
  }
  return null;
}

function isJSFile(path: string) {
  return ['.js', '.jsx', '.ts', '.tsx'].includes(extname(path));
}

function addLastSlash(path: string) {
  return path.endsWith('/') ? path : `${path}/`;
}

function isMatchLib(
  path: string,
  libs: TLibs | undefined,
  matchAll: boolean | undefined,
  alias: IAlias,
  webpackAlias: IAlias,
) {
  if (matchAll) {
    if (path === 'umi' || path === 'dumi') return false;

    if (isAbsolute(path)) {
      return RE_NODE_MODULES.test(path) || RE_UMI_LOCAL_DEV.test(path);
    } else if (path.charAt(0) === '.') {
      return false;
    } else {
      const aliasPath = getAlias({ path, webpackAlias });
      if (aliasPath) {
        return (
          RE_NODE_MODULES.test(aliasPath) || RE_UMI_LOCAL_DEV.test(aliasPath)
        );
      }
      return true;
    }
  }

  return (libs || []).concat(Object.keys(alias)).some((lib) => {
    if (typeof lib === 'string') {
      return lib === path;
    } else if (lib instanceof RegExp) {
      return lib.test(path);
    } else {
      throw new Error('Unsupported lib format.');
    }
  });
}

function getPath(path: string, alias: IAlias) {
  const keys = Object.keys(alias);
  for (const key of keys) {
    if (path.startsWith(key)) {
      return path.replace(key, alias[key]);
    }
  }
  return path;
}

export default function () {
  return {
    visitor: {
      Program: {
        exit(path: NodePath<t.Program>, { opts }: { opts: IOpts }) {
          const variableDeclarations = [];
          let index = path.node.body.length - 1;
          while (index >= 0) {
            const d = path.node.body[index];

            if (t.isImportDeclaration(d)) {
              const isMatch = isMatchLib(
                d.source.value,
                opts.libs,
                opts.matchAll,
                opts.alias || {},
                opts.webpackAlias || {},
              );
              opts.onTransformDeps?.({
                source: d.source.value,
                // @ts-ignore
                file: path.hub.file.opts.filename,
                isMatch,
              });

              if (isMatch) {
                const { properties, namespaceIdentifier } =
                  specifiersToProperties(d.specifiers);
                const id = t.objectPattern(properties);
                const init = t.awaitExpression(
                  t.callExpression(t.import(), [
                    t.stringLiteral(
                      `${opts.remoteName}/${getPath(
                        d.source.value,
                        opts.alias || {},
                      )}`,
                    ),
                  ]),
                );
                if (namespaceIdentifier) {
                  if (properties.length) {
                    variableDeclarations.unshift(
                      t.variableDeclaration('const', [
                        t.variableDeclarator(id, namespaceIdentifier),
                      ]),
                    );
                  }
                  variableDeclarations.unshift(
                    t.variableDeclaration('const', [
                      t.variableDeclarator(namespaceIdentifier, init),
                    ]),
                  );
                } else {
                  variableDeclarations.unshift(
                    t.variableDeclaration('const', [
                      t.variableDeclarator(id, init),
                    ]),
                  );
                }
                path.node.body.splice(index, 1);
              }
            }

            // export * from 'foo';
            if (t.isExportAllDeclaration(d) && d.source) {
              const isMatch = isMatchLib(
                d.source.value,
                opts.libs,
                opts.matchAll,
                opts.alias || {},
                opts.webpackAlias || {},
              );
              opts.onTransformDeps?.({
                source: d.source.value,
                // @ts-ignore
                file: path.hub.file.opts.filename,
                isMatch: false,
                isExportAllDeclaration: true,
              });

              if (isMatch && opts.exportAllMembers?.[d.source.value]) {
                const id = t.identifier('__all_exports');
                const init = t.awaitExpression(
                  t.callExpression(t.import(), [
                    t.stringLiteral(
                      `${opts.remoteName}/${getPath(
                        d.source.value,
                        opts.alias || {},
                      )}`,
                    ),
                  ]),
                );
                variableDeclarations.unshift(
                  t.variableDeclaration('const', [
                    t.variableDeclarator(id, init),
                  ]),
                );

                // replace node with export const { a, b, c } = __all_exports
                // a, b, c was declared from opts.exportAllMembers
                path.node.body[index] = t.exportNamedDeclaration(
                  t.variableDeclaration('const', [
                    t.variableDeclarator(
                      t.objectPattern(
                        opts.exportAllMembers[d.source.value].map((m) =>
                          t.objectProperty(t.identifier(m), t.identifier(m)),
                        ),
                      ),
                      t.identifier('__all_exports'),
                    ),
                  ]),
                );
              }
            }

            // export { bar } from 'foo';
            if (t.isExportNamedDeclaration(d) && d.source) {
              const isMatch = isMatchLib(
                d.source.value,
                opts.libs,
                opts.matchAll,
                opts.alias || {},
                opts.webpackAlias || {},
              );
              opts.onTransformDeps?.({
                source: d.source.value,
                // @ts-ignore
                file: path.hub.file.opts.filename,
                isMatch,
              });

              if (isMatch) {
                const { properties } = specifiersToProperties(d.specifiers);
                const id = t.objectPattern(properties);
                const init = t.awaitExpression(
                  t.callExpression(t.import(), [
                    t.stringLiteral(
                      `${opts.remoteName}/${getPath(
                        d.source.value,
                        opts.alias || {},
                      )}`,
                    ),
                  ]),
                );
                variableDeclarations.unshift(
                  t.variableDeclaration('const', [
                    t.variableDeclarator(id, init),
                  ]),
                );
                d.source = null;
              }
            }

            index -= 1;
          }
          path.node.body = [...variableDeclarations, ...path.node.body];
        },
      },

      CallExpression: {
        exit(path: NodePath<t.CallExpression>, { opts }: { opts: IOpts }) {
          const { node } = path;
          if (
            t.isImport(node.callee) &&
            node.arguments.length === 1 &&
            node.arguments[0].type === 'StringLiteral'
          ) {
            const value = node.arguments[0].value;
            const isMatch = isMatchLib(
              value,
              opts.libs,
              opts.matchAll,
              opts.alias || {},
              opts.webpackAlias || {},
            );
            opts.onTransformDeps?.({
              source: value,
              // @ts-ignore
              file: path.hub.file.opts.filename,
              isMatch,
            });
            if (isMatch) {
              node.arguments[0] = t.stringLiteral(
                `${opts.remoteName}/${getPath(value, opts.alias || {})}`,
              );
            }
          }
        },
      },
    },
  };
}
