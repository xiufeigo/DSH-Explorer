/**
 * DSH-Explorer browser half — stylesheet loader.
 * Importing explorer.module.css inlines a <style data-plugin="dsh-explorer">
 * tag into the client factory (the shell removes those tags on unload).
 * Tokens ride `--dsw-alias-*`. Class names stay global `dshx-*`.
 */

import './explorer.module.css'

/** Side-effect import above installs the sheet at factory evaluation.
 *  Fiber dispose is a no-op: the loader already tears down plugin style tags. */
export function injectStyles(): () => void {
  return () => {}
}
