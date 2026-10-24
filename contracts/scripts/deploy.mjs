// Deploys AlphaScrollSessionVault to Monad (testnet by default).
//
//   DEPLOYER_PRIVATE_KEY=0x...  ROUTER_ADDRESS=0x...  npm run deploy
//   RPC_URL=https://rpc.monad.xyz ...                  # mainnet
//
// ROUTER_ADDRESS must be a Uniswap V2-compatible router on the target chain.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad, monadTestnet } from "viem/chains";

const { DEPLOYER_PRIVATE_KEY, ROUTER_ADDRESS } = process.env;
const RPC_URL = process.env.RPC_URL ?? monadTestnet.rpcUrls.default.http[0];
if (!DEPLOYER_PRIVATE_KEY || !ROUTER_ADDRESS) {
  console.error("Set DEPLOYER_PRIVATE_KEY and ROUTER_ADDRESS (a V2-compatible router on the target chain).");
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(new URL("../out/AlphaScrollSessionVault.json", import.meta.url)));
const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
const transport = http(RPC_URL);
const chainId = await createPublicClient({ transport }).getChainId();
const chain = [monad, monadTestnet].find((c) => c.id === chainId);
if (!chain) throw new Error(`Unsupported chain id ${chainId}`);

const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

console.log(`Deploying from ${account.address} to ${chain.name} (${chainId})`);
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [getAddress(ROUTER_ADDRESS)],
});
const { contractAddress } = await pub.waitForTransactionReceipt({ hash });

mkdirSync(new URL("../deployments/", import.meta.url), { recursive: true });
writeFileSync(
  new URL(`../deployments/${chainId}.json`, import.meta.url),
  JSON.stringify({ chainId, vault: contractAddress, router: getAddress(ROUTER_ADDRESS), tx: hash }, null, 2),
);

console.log(`\nVault deployed: ${contractAddress}\nAdd to web/.env.local:\n`);
console.log(`NEXT_PUBLIC_CHAIN_ID=${chainId}`);
console.log(`NEXT_PUBLIC_VAULT_ADDRESS=${contractAddress}`);
