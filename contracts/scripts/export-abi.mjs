// Writes the vault ABI into the web app as a typed `as const` module.
import { readFileSync, writeFileSync } from "node:fs";

const { abi } = JSON.parse(readFileSync(new URL("../out/AlphaScrollSessionVault.json", import.meta.url)));
const target = new URL("../../web/src/lib/web3/vaultAbi.ts", import.meta.url);
writeFileSync(
  target,
  `// Generated from contracts/out/AlphaScrollSessionVault.json by \`npm run abi\` in contracts/.\nexport const vaultAbi = ${JSON.stringify(abi, null, 2)} as const;\n`,
);
console.log(`Wrote ${target.pathname}`);
