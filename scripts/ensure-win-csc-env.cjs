/**
 * If dev PFX exists and CSC_LINK / WIN_CSC_LINK are unset, set CSC_LINK so
 * electron-builder signs without having to export CSC_LINK every time.
 *
 * Only sets CSC_LINK when CSC_KEY_PASSWORD or WIN_CSC_KEY_PASSWORD is set.
 * Otherwise SignTool gets an empty PFX password and fails ("The specified PFX
 * password is not correct"). Omitting CSC_LINK yields an unsigned local build.
 */
const fs = require('fs');
const path = require('path');

const pfx = path.resolve(__dirname, '..', 'certs', 'dev-code-signing.pfx');
const hasPfxPassword = Boolean(
  process.env.CSC_KEY_PASSWORD || process.env.WIN_CSC_KEY_PASSWORD
);

if (
  fs.existsSync(pfx) &&
  !process.env.CSC_LINK &&
  !process.env.WIN_CSC_LINK
) {
  if (hasPfxPassword) {
    process.env.CSC_LINK = pfx;
  } else {
    console.warn(
      '[ensure-win-csc-env] Found certs/dev-code-signing.pfx but CSC_KEY_PASSWORD is not set; skipping auto CSC_LINK (build will be unsigned). To sign: set CSC_KEY_PASSWORD to the PFX export password (default from cert:win:dev is dev-only-change-me).'
    );
  }
}
