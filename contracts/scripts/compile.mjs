// Compiles every .sol under src/ and test/mocks/ with the bundled solc-js
// (no binary download needed) and writes ABI + bytecode to out/.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Shanghai keeps PUSH0 but avoids newer opcodes: runs on Monad and in Ganache.
const EVM_VERSION = "shanghai";

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? collect(join(dir, e.name)) : e.name.endsWith(".sol") ? [join(dir, e.name)] : [],
  );
}

const files = [...collect(join(root, "src")), ...collect(join(root, "test", "mocks"))];
const sources = Object.fromEntries(
  files.map((f) => [relative(root, f), { content: readFileSync(f, "utf8") }]),
);

const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources,
      settings: {
        evmVersion: EVM_VERSION,
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      },
    }),
  ),
);

const errors = (output.errors ?? []).filter((e) => e.severity === "error");
for (const e of output.errors ?? []) console[e.severity === "error" ? "error" : "warn"](e.formattedMessage);
if (errors.length) process.exit(1);

mkdirSync(join(root, "out"), { recursive: true });
for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    writeFileSync(
      join(root, "out", `${name}.json`),
      JSON.stringify({ contractName: name, sourceName: file, abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }, null, 2),
    );
  }
}
console.log(`Compiled ${files.length} files with solc ${solc.version()} (evm ${EVM_VERSION})`);
