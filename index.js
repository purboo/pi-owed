// pi extension entry. npm installs ship dist/; git installs run TypeScript sources (Node >= 22.19).
import { existsSync } from 'node:fs';

const dist = new URL('./dist/extension.js', import.meta.url);
const { default: extension } = await import(existsSync(dist) ? dist.href : new URL('./src/extension.ts', import.meta.url).href);
export default extension;
