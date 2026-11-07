// Filled in by tools/build.mjs. In an unbuilt tree (serving src/) the
// placeholders stay, BUILT is false and no service worker is registered.
export const APP_VERSION = "0.1.20";
export const BUILT = APP_VERSION !== '__BUILD' + '_VERSION__';
// There is no pinned wasm engine any more (the Firo engine is ordinary signed release files).
// Kept as null so older imports keep loading; nothing fills it.
export const ENGINE_LOCK = null;
export const RELEASE_PUBLIC_JWK = {"kty":"EC","crv":"P-256","x":"IBYdPwiOE1bGU9-SZHlgx3iwDmlcsgIeXk-hDE-DW3Q","y":"MW3DhEKtl4oh8dGwH57rQZCagrX4gkKMjwBES6QxcUE"};
// The service worker's content-addressed file name (sw-<sha256 prefix>.js). Its
// bytes never change under that name, so a change there is a warning sign.
export const LOADER = "sw-889ae1aed8521703.js";
// What that loader does to pages (release.json loader_compat). A running loader with the
// same value serves this release's pages with the same headers (lib/loader.js loaderBehind).
export const LOADER_COMPAT = "b04895e1394ba5c481b59072b7cf0ea8e681ec2cb74ade365af0b3cea760c4ba";
