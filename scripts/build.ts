export {};
const r = await Bun.build({
  entrypoints: ['src/cli.ts'],
  compile: { outfile: 'dist/agent-console' },
  minify: true,
  sourcemap: 'linked',
});
if (!r.success) { for (const l of r.logs) console.error(l); process.exit(1); }
console.log('built dist/agent-console');
