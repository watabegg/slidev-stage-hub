function replaceRequired(code, signature, replacement, label) {
  if (!code.includes(signature)) throw new Error(`Slidev ${label} signature changed`);
  return code.replace(signature, replacement);
}

/** Keep immutable release URLs origin-rooted while retaining the runtime base for other paths. */
export function preserveReleaseAssetInLayoutHelper(code) {
  const signature = 'return import.meta.env.BASE_URL + url.slice(1)';
  return replaceRequired(
    code,
    signature,
    "return url.startsWith('/releases/') ? url : import.meta.env.BASE_URL + url.slice(1)",
    'layout-helper asset URL',
  );
}

/** Keep preloaded immutable release assets outside the versioned runtime namespace. */
export function preserveReleaseAssetInPreloader(code) {
  const signature = "return `${base}${url.startsWith('/') ? url : `/${url}`}`";
  return replaceRequired(
    code,
    signature,
    "return url.startsWith('/releases/') ? url : `${base}${url.startsWith('/') ? url : `/${url}`}`",
    'image preloader URL',
  );
}
