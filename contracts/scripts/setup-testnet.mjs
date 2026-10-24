// One-command Monad testnet setup: test DEX + memecoins with liquidity + vault.
//
//   DEPLOYER_PRIVATE_KEY=0x... npm run setup:testnet
//
// Deploys WMON, AlphaTestRouter, one TestToken per feed token (seeded with
// LIQUIDITY_MON each), and AlphaScrollSessionVault on that router. Writes
// deployments/<chainId>.json (read by the video worker) and sets
// NEXT_PUBLIC_CHAIN_ID / NEXT_PUBLIC_VAULT_ADDRESS in web/.env.local.
//
// Re-running resumes: contracts already recorded in the deployment file are
// reused. Delete a field (e.g. "vault") from the file to redeploy just that.
//
// Optional env: RPC_URL, LIQUIDITY_MON (default 0.2), TOKEN_SUPPLY (default 1e9),
// DEPLOYMENTS_DIR, WEB_ENV_PATH (both used by the tests).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatEther, getAddress, http, maxUint256, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Same symbols as the worker's MOCK_TOKENS, so reels map onto real pools.
const TOKENS = [
  ["MOLANDAK", "Molandak"],
  ["CHOG", "Chog"],
  ["MOYAKI", "Moyaki"],
  ["PURPLE", "Purple Frog"],
  ["GMONAD", "Gmonad"],
  ["NADS", "Nad Army"],
];

const { DEPLOYER_PRIVATE_KEY } = process.env;
const RPC_URL = process.env.RPC_URL || monadTestnet.rpcUrls.default.http[0];
const LIQUIDITY = parseEther(process.env.LIQUIDITY_MON || "0.2");
const SUPPLY = parseEther(process.env.TOKEN_SUPPLY || "1000000000");
const DEPLOYMENTS_DIR = resolve(process.env.DEPLOYMENTS_DIR || join(root, "deployments"));
const WEB_ENV_PATH = resolve(process.env.WEB_ENV_PATH || join(root, "..", "web", ".env.local"));

if (!DEPLOYER_PRIVATE_KEY) {
  console.error("Set DEPLOYER_PRIVATE_KEY (a Monad testnet wallet with MON from https://faucet.monad.xyz).");
  process.exit(1);
}

const artifact = (name) => JSON.parse(readFileSync(join(root, "out", `${name}.json`), "utf8"));
const [Wmon, Router, Token, Vault] = ["WMON", "AlphaTestRouter", "TestToken", "AlphaScrollSessionVault"].map(artifact);

const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
const transport = http(RPC_URL);
const chainId = await createPublicClient({ transport }).getChainId();
const chain =
  chainId === monadTestnet.id
    ? monadTestnet
    : defineChain({ id: chainId, name: `Chain ${chainId}`, nativeCurrency: monadTestnet.nativeCurrency, rpcUrls: { default: { http: [RPC_URL] } } });
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

const deploymentPath = join(DEPLOYMENTS_DIR, `${chainId}.json`);
const state = existsSync(deploymentPath) ? JSON.parse(readFileSync(deploymentPath, "utf8")) : {};
state.chainId = chainId;
state.tokens ??= [];
const save = () => {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  writeFileSync(deploymentPath, JSON.stringify(state, null, 2) + "\n");
};

const hasCode = async (address) => !!address && ((await pub.getCode({ address })) ?? "0x") !== "0x";

let lastTxBlock = 0n;

async function confirm(hash, what) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  lastTxBlock = receipt.blockNumber;
  if (receipt.status !== "success") throw new Error(`${what} reverted (${hash})`);
  return receipt;
}

// Monad reserve balance: an EOA may only send value that takes it below
// 10 MON if it sent no other tx in the past 3 blocks; otherwise the tx
// reverts with "reserve balance violation". Wait out the window when needed.
// https://docs.monad.xyz/developer-essentials/reserve-balance
const RESERVE = parseEther("10");
const RESERVE_WINDOW = 3n;

async function respectReserve(value) {
  if (!value || chainId !== monadTestnet.id) return;
  if ((await pub.getBalance({ address: account.address })) - value >= RESERVE) return;
  while ((await pub.getBlockNumber()) <= lastTxBlock + RESERVE_WINDOW) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function deploy(art, args, what) {
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
  const contractAddress = getAddress((await confirm(hash, what)).contractAddress);
  console.log(`  ${what.padEnd(22)} ${contractAddress}`);
  return contractAddress;
}

async function write(address, abi, functionName, args, value, what) {
  await respectReserve(value);
  return confirm(await wallet.writeContract({ address, abi, functionName, args, value }), what);
}

// ---------------------------------------------------------------------------

const balance = await pub.getBalance({ address: account.address });
const pendingPools = TOKENS.filter(([symbol]) => !state.tokens.find((t) => t.symbol === symbol && t.seeded)).length;
// Measured on Monad testnet: ~0.7M gas per token (deploy + approve + seed), ~2.6M for WMON + router + vault.
// Monad bills the full gas limit, so budget for the limit rather than for gas used.
const gas = (BigInt(pendingPools) * 700_000n + 2_600_000n) * (await pub.getGasPrice());
const needed = LIQUIDITY * BigInt(pendingPools) + gas;
console.log(`Deployer ${account.address} on ${chain.name} (${chainId}): ${formatEther(balance)} MON`);
if (balance < needed) {
  console.error(
    `Need about ${formatEther(needed)} MON (${pendingPools} pools x ${formatEther(LIQUIDITY)} MON + ~${formatEther(gas)} gas).\n` +
      `Get testnet MON at https://faucet.monad.xyz, or lower LIQUIDITY_MON (e.g. LIQUIDITY_MON=0.05).`,
  );
  // exitCode instead of exit(): exiting with an open HTTP socket trips a libuv assertion on Windows.
  process.exitCode = 1;
} else {
  await setup();
}

async function setup() {
  if (!(await hasCode(state.wrappedNative))) {
    state.wrappedNative = await deploy(Wmon, [], "WMON");
    delete state.router; // a router is bound to its WMON
    save();
  }
  if (!(await hasCode(state.router))) {
    state.router = await deploy(Router, [state.wrappedNative], "AlphaTestRouter");
    state.tokens = []; // pools live in the router
    delete state.vault; // the vault is bound to its router
    save();
  }

  for (const [symbol, name] of TOKENS) {
    let entry = state.tokens.find((t) => t.symbol === symbol);
    if (!entry || !(await hasCode(entry.address))) {
      const address = await deploy(Token, [name, symbol, SUPPLY], `$${symbol}`);
      state.tokens = state.tokens.filter((t) => t.symbol !== symbol);
      entry = { symbol, name, address, seeded: false };
      state.tokens.push(entry);
      save();
    }
    if (!entry.seeded) {
      // Seed half the supply: price = LIQUIDITY / (SUPPLY / 2) MON per token.
      const tokenAmount = SUPPLY / 2n;
      await write(entry.address, Token.abi, "approve", [state.router, maxUint256], 0n, `approve $${symbol}`);
      await write(state.router, Router.abi, "addLiquidity", [entry.address, tokenAmount], LIQUIDITY, `seed $${symbol}`);
      entry.seeded = true;
      save();
      console.log(`  pool $${symbol.padEnd(17)} ${formatEther(LIQUIDITY)} MON / ${formatEther(tokenAmount)} ${symbol}`);
    }
  }

  if (!(await hasCode(state.vault))) {
    state.vault = await deploy(Vault, [state.router], "SessionVault");
    save();
  }

  setEnv(WEB_ENV_PATH, { NEXT_PUBLIC_CHAIN_ID: chainId, NEXT_PUBLIC_VAULT_ADDRESS: state.vault });

  console.log(`\nDone. Wrote ${deploymentPath}`);
  console.log(`Updated ${WEB_ENV_PATH}: NEXT_PUBLIC_CHAIN_ID=${chainId}, NEXT_PUBLIC_VAULT_ADDRESS=${state.vault}`);
  console.log("Restart `npm run dev` in web/ and render new reels so they carry the token addresses.");
}

function setEnv(path, values) {
  if (!existsSync(path)) {
    const example = join(dirname(path), ".env.example");
    if (existsSync(example)) copyFileSync(example, path);
    else writeFileSync(path, "");
  }
  let text = readFileSync(path, "utf8");
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
  }
  writeFileSync(path, text);
}
