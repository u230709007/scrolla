import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ganache from "ganache";
import { createPublicClient, createWalletClient, http, maxUint256, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const run = promisify(execFile);
const artifact = (name) => JSON.parse(readFileSync(new URL(`../out/${name}.json`, import.meta.url)));
const Vault = artifact("AlphaScrollSessionVault");
const Router = artifact("AlphaTestRouter");
const Token = artifact("TestToken");
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;

let server, pub, deployerKey, owner, dir, deployment;

const wallet = (account) => createWalletClient({ account, transport: http(RPC) });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
async function send(from, address, abi, functionName, args = [], value = 0n) {
  const hash = await wallet(from).writeContract({ address, abi, functionName, args, value, chain: null });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt;
}
const now = async () => (await pub.getBlock()).timestamp;

const setup = () =>
  run(process.execPath, [fileURLToPath(new URL("../scripts/setup-testnet.mjs", import.meta.url))], {
    env: {
      ...process.env,
      DEPLOYER_PRIVATE_KEY: deployerKey,
      RPC_URL: RPC,
      LIQUIDITY_MON: "2",
      DEPLOYMENTS_DIR: dir,
      WEB_ENV_PATH: join(dir, ".env.local"),
    },
  });

describe("setup-testnet + AlphaTestRouter", () => {
  before(async () => {
    deployerKey = generatePrivateKey();
    const ownerKey = generatePrivateKey();
    server = ganache.server({
      logging: { quiet: true },
      chain: { hardfork: "shanghai", chainId: 31337 },
      wallet: { accounts: [deployerKey, ownerKey].map((secretKey) => ({ secretKey, balance: parseEther("1000") })) },
    });
    await server.listen(PORT);
    pub = createPublicClient({ transport: http(RPC) });
    owner = privateKeyToAccount(ownerKey);

    dir = mkdtempSync(join(tmpdir(), "alphascroll-"));
    writeFileSync(join(dir, ".env.local"), "AUTH_SECRET=keep-me\nNEXT_PUBLIC_VAULT_ADDRESS=\n");
    await setup();
    deployment = JSON.parse(readFileSync(join(dir, "31337.json"), "utf8"));
  });

  after(() => server.close());

  it("deploys every contract, seeds 6 pools and updates web/.env.local", async () => {
    assert.equal(deployment.tokens.length, 6);
    assert.ok(deployment.tokens.every((t) => t.seeded));
    assert.equal(await read(deployment.vault, Vault.abi, "router"), deployment.router);
    assert.equal(await read(deployment.router, Router.abi, "tokenCount"), 6n);
    const [reserveNative] = await read(deployment.router, Router.abi, "pools", [deployment.tokens[0].address]);
    assert.equal(reserveNative, parseEther("2"));

    const env = readFileSync(join(dir, ".env.local"), "utf8");
    assert.match(env, /^AUTH_SECRET=keep-me$/m);
    assert.match(env, /^NEXT_PUBLIC_CHAIN_ID=31337$/m);
    assert.match(env, new RegExp(`^NEXT_PUBLIC_VAULT_ADDRESS=${deployment.vault}$`, "m"));
  });

  it("re-running reuses the existing deployment", async () => {
    await setup();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "31337.json"), "utf8")), deployment);
  });

  it("session key buys through the real pool; the owner can sell back", async () => {
    const token = deployment.tokens.find((t) => t.symbol === "CHOG").address;
    const session = privateKeyToAccount(generatePrivateKey());
    const expiry = (await now()) + 3600n;
    await send(owner, deployment.vault, Vault.abi, "authorizeSession",
      [session.address, expiry, parseEther("0.1"), parseEther("1"), parseEther("0.05")], parseEther("1.05"));

    // Same flow as web/src/lib/web3/trading.ts quickBuy: quote, 8% slippage, buy.
    const quote = await read(deployment.vault, Vault.abi, "quote", [token, parseEther("0.1")]);
    assert.ok(quote > 0n);
    const minOut = (quote * 9200n) / 10000n;
    await send(session, deployment.vault, Vault.abi, "buy", [token, parseEther("0.1"), minOut, expiry]);

    const bought = await read(token, Token.abi, "balanceOf", [owner.address]);
    assert.equal(bought, quote);
    assert.equal(await read(token, Token.abi, "balanceOf", [session.address]), 0n);

    // Price impact: the second quote for the same amount is lower.
    assert.ok((await read(deployment.vault, Vault.abi, "quote", [token, parseEther("0.1")])) < quote);

    const path = [token, deployment.wrappedNative];
    const [, monOut] = await read(deployment.router, Router.abi, "getAmountsOut", [bought, path]);
    await send(owner, token, Token.abi, "approve", [deployment.router, maxUint256]);
    const before = await pub.getBalance({ address: owner.address });
    const receipt = await send(owner, deployment.router, Router.abi, "swapExactTokensForETHSupportingFeeOnTransferTokens",
      [bought, monOut, path, owner.address, expiry]);
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    assert.equal((await pub.getBalance({ address: owner.address })) - before + gas, monOut);
    assert.ok(monOut < parseEther("0.1")); // round trip pays 2x 0.3% fee
  });

  it("only the deployer can manage liquidity", async () => {
    const token = deployment.tokens[0].address;
    await assert.rejects(send(owner, deployment.router, Router.abi, "removeLiquidity", [token]));
  });
});
