/**
 * Stand-in for optional dependencies that are never used at runtime.
 *
 * See the `UNUSED_OPTIONAL_MODULES` note in next.config.ts. Webpack can alias those to `false`;
 * Turbopack needs a real file, which is what this is.
 */
export default {};
