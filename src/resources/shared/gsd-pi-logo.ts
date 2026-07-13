/**
 * Shared Forge block-letter ASCII logo (symbol names keep the GSD_PI_ prefix
 * until the deep rename — M0 rebrands values only, D11).
 *
 * Lives under src/resources so extension builds can import it without
 * crossing tsconfig.resources rootDir. Re-exported from src/logo.ts for
 * loader, onboarding, installer, and welcome screen.
 */

/** Display name for product branding in banners and prompts. */
export const GSD_PI_BRAND = 'Forge'

/** Raw Forge wordmark lines — no ANSI codes, no leading newline. */
export const GSD_PI_LOGO: readonly string[] = [
  ' ███████╗ ██████╗ ██████╗  ██████╗ ███████╗',
  ' ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝',
  ' █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ',
  ' ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ',
  ' ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗',
  ' ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
]
