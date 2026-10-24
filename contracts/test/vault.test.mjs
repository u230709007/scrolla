import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, describe, it } from "node:test";
import ganache from "ganache";
import { createPublicClient, createWalletClient, custom, decodeErrorResult, encodeFunctionData, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const artifact = (name) => JSON.parse(readFileSync(new URL(`../out/${name}.json`, import.meta.url)));
const Vault = artifact("AlphaScrollSessionVault");
const Router = artifact("MockRouter");
const Token = artifact("MockToken");
const RATE = 1000n;

let provider, pub, owner, stranger, vault, router, token;

const wallet = (account) => createWalletClient({ account, transport: custom(provider) });

async function deploy(art, args, from = owner) {
  const hash = await wallet(from).deployContract({ abi: art.abi, bytecode: art.bytecode, args, chain: null });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}

async function send(from, address, abi, functionName, args = [], value = 0n) {
  const hash = await wallet(from).writeContract({ address, abi, functionName, args, value, chain: null });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt;
}

// eth_call the function and assert it reverts with the given custom error.
// (Ganache returns revert data in err.data, which viem's simulate doesn't decode.)
async function reverts(from, functionName, args, errorName, value = 0n) {
  const data = encodeFunctionData({ abi: Vault.abi, functionName, args });
  const call = { from: from.address, to: vault, data, value: toHex(value) };
  const revertData = await provider.request({ method: "eth_call", params: [call, "latest"] }).then(
    () => assert.fail(`${functionName} did not revert`),
    (err) => err.data,
  );
  assert.equal(decodeErrorResult({ abi: Vault.abi, data: revertData }).errorName, errorName);
}

const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const now = async () => (await pub.getBlock()).timestamp;

describe("AlphaScrollSessionVault", () => {
  before(async () => {
    // Local accounts: viem signs and sends raw txs (Ganache lacks wallet_sendTransaction).
    const keys = [generatePrivateKey(), generatePrivateKey()];
    provider = ganache.provider({
      logging: { quiet: true },
      chain: { hardfork: "shanghai" },
      wallet: { accounts: keys.map((secretKey) => ({ secretKey, balance: parseEther("1000") })) },
    });
    pub = createPublicClient({ transport: custom(provider) });
    [owner, stranger] = keys.map((k) => privateKeyToAccount(k));
  });

  beforeEach(async () => {
    router = await deploy(Router, [RATE]);
    token = await read(router, Router.abi, "token");
    vault = await deploy(Vault, [router]);
  });

  it("reads WETH from the router", async () => {
    assert.equal((await read(vault, Vault.abi, "wrappedNative")).toLowerCase(), "0x000000000000000000000000000000000000beef");
  });

  it("deposit and withdraw", async () => {
    await send(owner, vault, Vault.abi, "deposit", [], parseEther("2"));
    assert.equal(await read(vault, Vault.abi, "balanceOf", [owner.address]), parseEther("2"));
    await send(owner, vault, Vault.abi, "withdraw", [parseEther("1.5")]);
    assert.equal(await read(vault, Vault.abi, "balanceOf", [owner.address]), parseEther("0.5"));
    await reverts(owner, "withdraw", [parseEther("1")], "InsufficientBalance");
  });

  it("session key buys without the owner, tokens go to the owner", async () => {
    const sessionPk = generatePrivateKey();
    const session = privateKeyToAccount(sessionPk);
    const expiry = (await now()) + 3600n;

    const value = parseEther("1.05"); // 1 MON budget + 0.05 gas stipend
    await send(owner, vault, Vault.abi, "authorizeSession",
      [session.address, expiry, parseEther("0.2"), parseEther("1"), parseEther("0.05")], value);

    assert.equal(await pub.getBalance({ address: session.address }), parseEther("0.05"));
    assert.equal(await read(vault, Vault.abi, "balanceOf", [owner.address]), parseEther("1"));
    assert.equal((await read(vault, Vault.abi, "ownerOfKey", [session.address])).toLowerCase(), owner.address.toLowerCase());

    const quote = await read(vault, Vault.abi, "quote", [token, parseEther("0.1")]);
    assert.equal(quote, parseEther("0.1") * RATE);

    // Session key signs locally — no owner interaction.
    const hash = await wallet(session).writeContract({
      address: vault, abi: Vault.abi, functionName: "buy",
      args: [token, parseEther("0.1"), quote, expiry], chain: null,
    });
    assert.equal((await pub.waitForTransactionReceipt({ hash })).status, "success");

    assert.equal(await read(token, Token.abi, "balanceOf", [owner.address]), parseEther("100"));
    assert.equal(await read(token, Token.abi, "balanceOf", [session.address]), 0n);
    assert.equal(await read(vault, Vault.abi, "balanceOf", [owner.address]), parseEther("0.9"));
    const [, , , remaining] = await read(vault, Vault.abi, "sessions", [owner.address]);
    assert.equal(remaining, parseEther("0.9"));
  });

  it("enforces per-trade cap, budget, expiry and revocation", async () => {
    const session = privateKeyToAccount(generatePrivateKey());
    const expiry = (await now()) + 600n;
    await send(owner, vault, Vault.abi, "authorizeSession",
      [session.address, expiry, parseEther("0.3"), parseEther("0.5"), parseEther("0.05")], parseEther("2"));

    const buyArgs = (amount) => [token, amount, 0n, expiry + 10_000n];
    const buy = async (amount) => pub.waitForTransactionReceipt({
      hash: await wallet(session).writeContract({
        address: vault, abi: Vault.abi, functionName: "buy", args: buyArgs(amount), chain: null,
      }),
    });

    await reverts(session, "buy", buyArgs(parseEther("0.31")), "TradeTooLarge");
    await buy(parseEther("0.3"));
    await reverts(session, "buy", buyArgs(parseEther("0.3")), "BudgetExceeded");

    await provider.request({ method: "evm_increaseTime", params: [601] });
    await provider.request({ method: "evm_mine", params: [] });
    await reverts(session, "buy", buyArgs(parseEther("0.1")), "SessionExpired");

    await send(owner, vault, Vault.abi, "revokeSession");
    assert.equal(await read(vault, Vault.abi, "ownerOfKey", [session.address]), "0x0000000000000000000000000000000000000000");
  });

  it("session key cannot withdraw the owner's funds", async () => {
    const session = privateKeyToAccount(generatePrivateKey());
    await send(owner, vault, Vault.abi, "authorizeSession",
      [session.address, (await now()) + 600n, parseEther("0.1"), parseEther("0.1"), parseEther("0.05")], parseEther("1"));
    // withdraw() only touches msg.sender's own balance, which is zero for the key.
    await reverts(session, "withdraw", [parseEther("0.5")], "InsufficientBalance");
    assert.equal(await read(vault, Vault.abi, "balanceOf", [owner.address]), parseEther("0.95"));
  });

  it("rejects a key already bound to another owner", async () => {
    const session = privateKeyToAccount(generatePrivateKey());
    const expiry = (await now()) + 600n;
    await send(owner, vault, Vault.abi, "authorizeSession", [session.address, expiry, 1n, 1n, 0n], 1n);
    await reverts(stranger, "authorizeSession", [session.address, expiry, 1n, 1n, 0n], "KeyInUse", 1n);
  });

  it("owner can buy directly without a session", async () => {
    await send(owner, vault, Vault.abi, "deposit", [], parseEther("1"));
    await send(owner, vault, Vault.abi, "buy", [token, parseEther("1"), 0n, (await now()) + 60n]);
    assert.equal(await read(token, Token.abi, "balanceOf", [owner.address]), parseEther("1000"));
  });
});
