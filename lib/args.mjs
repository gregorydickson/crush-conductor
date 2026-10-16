/** Parse CLI arguments against a flag spec. Values come from "--flag value" or "--flag=value". */
export function parseArgs(argv, spec, { stopAtFirstPositional = false } = {}) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") { rest.push(...argv.slice(i + 1)); break; }
    if (token.startsWith("-") && token !== "-") {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      const entry = Object.entries(spec).find(([flag, def]) => name === flag || (def.aliases ?? []).includes(name));
      if (!entry) throw new Error(`Unknown option ${name}`);
      const [, def] = entry;
      if (def.type === "bool") {
        flags[def.key] = eq === -1 ? true : token.slice(eq + 1) !== "false";
      } else if (eq !== -1) {
        flags[def.key] = token.slice(eq + 1);
      } else if (i + 1 < argv.length) {
        flags[def.key] = argv[++i];
      } else {
        throw new Error(`Option ${name} requires a value`);
      }
    } else {
      if (stopAtFirstPositional) { rest.push(...argv.slice(i)); break; }
      rest.push(token);
    }
  }
  return { flags, rest };
}
