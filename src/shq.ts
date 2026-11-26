// Quote one argument for a POSIX shell. The result is one literal word.
export function shq(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// Quote each argument and join them with spaces.
export function shJoin(args: string[]): string {
  return args.map(shq).join(' ');
}
