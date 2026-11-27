import pkg from '../package.json';

/** The app version. package.json is the source; the build puts it into the binary and the page. */
export const VERSION: string = pkg.version;
