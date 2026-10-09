// Conservative: differing compiler/configuration inputs get separate graphs.
// Presentation labels are supplied through each deck's runtime config facade.
const runtimeOnlyFields = new Set([
  'title',
  'slidesTitle',
  'titleTemplate',
  'author',
  'keywords',
  'info',
  'seoMeta',
]);
export function compileContract(options) {
  const config = Object.fromEntries(
    Object.entries(options.data.config).filter(([key]) => !runtimeOnlyFields.has(key)),
  );
  return {
    features: options.data.features,
    config,
    roots: options.roots,
    clientRoot: options.clientRoot,
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
