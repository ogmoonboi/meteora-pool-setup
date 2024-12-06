import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  DEFAULT_COMMITMENT_LEVEL,
  MeteoraConfig,
  safeParseJsonFromFile,
  parseCliArguments,
  getAmountInLamports,
  getQuoteMint,
  getQuoteDecimals,
  safeParseKeypairFromFile,
  runSimulateTransaction,
  getDynamicAmmActivationType,
  getDlmmActivationType,
  FcfsAlphaVaultConfig,
  ProrataAlphaVaultConfig,
} from ".";
import { AmmImpl } from "@mercurial-finance/dynamic-amm-sdk";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  createProgram,
  deriveCustomizablePermissionlessConstantProductPoolAddress,
} from "@mercurial-finance/dynamic-amm-sdk/src/amm/utils";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { BN } from "bn.js";
import AlphaVault, {
  ActivationType,
  Permissionless,
  PoolType,
} from "@meteora-ag/alpha-vault";
import { CustomizableParams } from "@mercurial-finance/dynamic-amm-sdk/src/amm/types";
import DLMM, {
  LBCLMM_PROGRAM_IDS,
  deriveCustomizablePermissionlessLbPair,
} from "@meteora-ag/dlmm";
import { ActivationType as DlmmActivationType } from "@meteora-ag/dlmm";
import Decimal from "decimal.js";
import { simulateTransaction } from "@coral-xyz/anchor/dist/cjs/utils/rpc";

async function main() {
  const cliArguments = parseCliArguments();
  if (!cliArguments.config) {
    throw new Error("Please provide a config file path to --config flag");
  }
  const configFilePath = cliArguments.config!;
  console.log(`> Using config file: ${configFilePath}`);

  let config: MeteoraConfig = safeParseJsonFromFile(configFilePath);

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  let keypair = safeParseKeypairFromFile(config.keypairFilePath);

  console.log("\n> Initializing with general configuration...");
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: connection.commitment,
  });

  let baseMint = new PublicKey(config.baseMint);
  let quoteMint = getQuoteMint(config.quoteSymbol);

  if (config.createBaseToken && !config.dryRun) {
    console.log("\n> Minting base token...");
    if (!config.mintBaseTokenAmount) {
      throw new Error("Missing mintBaseTokenAmount in configuration");
    }
    const baseMintAmount = getAmountInLamports(
      config.mintBaseTokenAmount,
      config.baseDecimals,
    );

    baseMint = await createAndMintToken(
      connection,
      wallet,
      config.baseDecimals,
      baseMintAmount,
    );

    console.log(`>> Mint ${config.mintBaseTokenAmount} token to payer wallet`);
  }

  console.log(`- Using base token mint ${baseMint.toString()}`);
  console.log(`- Using quote token mint ${quoteMint.toString()}`);

  /// --------------------------------------------------------------------------
  if (config.dynamicAmm && !config.dlmm) {
    await createPermissionlessDynamicPool(
      config,
      connection,
      wallet,
      baseMint,
      quoteMint,
    );
  } else if (config.dlmm && !config.dynamicAmm) {
    await createPermissionlessDlmmPool(
      config,
      connection,
      wallet,
      baseMint,
      quoteMint,
    );
  } else if (config.dynamicAmm && config.dlmm) {
    throw new Error("Either provide only Dynamic AMM or DLMM configuration");
  } else {
    throw new Error("Must provide Dynamic AMM or DLMM configuration");
  }
}

async function createPermissionlessDynamicPool(
  config: MeteoraConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey,
) {
  if (!config.dynamicAmm) {
    throw new Error("Missing dynamic amm configuration");
  }
  console.log("\n> Initializing Permissionless Dynamic AMM pool...");

  const quoteDecimals = getQuoteDecimals(config.quoteSymbol);
  const baseAmount = getAmountInLamports(
    config.dynamicAmm.baseAmount,
    config.baseDecimals,
  );
  const quoteAmount = getAmountInLamports(
    config.dynamicAmm.quoteAmount,
    quoteDecimals,
  );

  console.log(
    `- Using token A amount ${config.dynamicAmm.baseAmount}, in lamports = ${baseAmount}`,
  );
  console.log(
    `- Using token B amount ${config.dynamicAmm.quoteAmount}, in lamports = ${quoteAmount}`,
  );

  const activationType = getDynamicAmmActivationType(
    config.dynamicAmm.activationType,
  );

  const customizeParam: CustomizableParams = {
    tradeFeeNumerator: config.dynamicAmm.tradeFeeNumerator,
    activationType: activationType,
    activationPoint: config.dynamicAmm.activationPoint,
    hasAlphaVault: config.alphaVaultType != null,
    padding: Array(90).fill(0),
  };
  console.log(
    `- Using tradeFeeNumerator = ${customizeParam.tradeFeeNumerator}`,
  );
  console.log(`- Using activationType = ${config.dynamicAmm.activationType}`);
  console.log(`- Using activationPoint = ${customizeParam.activationPoint}`);
  console.log(`- Using hasAlphaVault = ${customizeParam.hasAlphaVault}`);

  const initPoolTx =
    await AmmImpl.createCustomizablePermissionlessConstantProductPool(
      connection,
      wallet.publicKey,
      baseMint,
      quoteMint,
      baseAmount,
      quoteAmount,
      customizeParam,
    );
  const poolKey = deriveCustomizablePermissionlessConstantProductPoolAddress(
    baseMint,
    quoteMint,
    createProgram(connection).ammProgram.programId,
  );

  console.log(`\n> Pool address: ${poolKey}`);

  let initAlphaVaultTx: Transaction;
  if (config.alphaVaultType == "fcfs") {
    if (!config.fcfsAlphaVault) {
      throw new Error("Missing FCFS alpha vault configuration");
    }
    initAlphaVaultTx = await createFcfsAlphaVault(
      connection,
      wallet,
      PoolType.DYNAMIC,
      poolKey,
      baseMint,
      quoteMint,
      config.fcfsAlphaVault,
    );
  } else if (config.alphaVaultType == "prorata") {
    if (!config.prorataAlphaVault) {
      throw new Error("Missing Prorata alpha vault configuration");
    }
    initAlphaVaultTx = await createProrataAlphaVault(
      connection,
      wallet,
      PoolType.DYNAMIC,
      poolKey,
      baseMint,
      quoteMint,
      config.prorataAlphaVault,
    );
  }

  if (!config.dryRun) {
    console.log(`>> Sending init pool transaction...`);
    const initPoolTxHash = await sendAndConfirmTransaction(
      connection,
      initPoolTx,
      [wallet.payer],
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(
      `>>> Pool initialized successfully with tx hash: ${initPoolTxHash}`,
    );

    console.log(`>> Sending init alpha vault transaction...`);
    const initAlphaVaulTxHash = await sendAndConfirmTransaction(
      connection,
      initAlphaVaultTx,
      [wallet.payer],
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(
      `>>> Alpha vault initialized successfully with tx hash: ${initAlphaVaulTxHash}`,
    );
  } else {
    console.log(`> Simulating init pool tx...`);
    await runSimulateTransaction(connection, wallet, [initPoolTx]);

    console.log(`> Simulating init alpha vault tx...`);
    await runSimulateTransaction(connection, wallet, [initAlphaVaultTx]);
  }
}

async function createPermissionlessDlmmPool(
  config: MeteoraConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey,
) {
  if (!config.dlmm) {
    throw new Error("Missing DLMM configuration");
  }
  console.log("\n> Initializing Permissionless DLMM pool...");

  const binStep = config.dlmm.binStep;
  const feeBps = config.dlmm.feeBps;
  const hasAlphaVault = config.alphaVaultType != null;
  const activationPoint = config.dlmm.activationPoint;

  const activationType = getDlmmActivationType(config.dlmm.activationType);

  console.log(`- Using binStep = ${binStep}`);
  console.log(`- Using feeBps = ${feeBps}`);
  console.log(`- Using minPrice = ${config.dlmm.minPrice}`);
  console.log(`- Using activationType = ${config.dlmm.activationType}`);
  console.log(`- Using activationPoint = ${config.dlmm.activationPoint}`);
  console.log(`- Using hasAlphaVault = ${hasAlphaVault}`);

  const quoteDecimals = getQuoteDecimals(config.quoteSymbol);
  const toLamportMultiplier = new Decimal(
    10 ** (config.baseDecimals - quoteDecimals),
  );

  const minBinId = DLMM.getBinIdFromPrice(
    new Decimal(config.dlmm.minPrice).mul(toLamportMultiplier),
    binStep,
    false,
  );

  const initPoolTx = await DLMM.createCustomizablePermissionlessLbPair(
    connection,
    new BN(binStep),
    baseMint,
    quoteMint,
    new BN(minBinId.toString()),
    new BN(feeBps),
    activationType,
    hasAlphaVault,
    wallet.publicKey,
    activationPoint,
    {
      cluster: "mainnet-beta",
    },
  );

  let poolKey: PublicKey;
  [poolKey] = deriveCustomizablePermissionlessLbPair(
    baseMint,
    quoteMint,
    new PublicKey(LBCLMM_PROGRAM_IDS["mainnet-beta"]),
  );

  console.log(`\n> Pool address: ${poolKey}`);

  let initAlphaVaultTx: Transaction;
  if (config.alphaVaultType == "fcfs") {
    if (!config.fcfsAlphaVault) {
      throw new Error("Missing FCFS alpha vault configuration");
    }
    initAlphaVaultTx = await createFcfsAlphaVault(
      connection,
      wallet,
      PoolType.DYNAMIC,
      poolKey,
      baseMint,
      quoteMint,
      config.fcfsAlphaVault,
    );
  } else if (config.alphaVaultType == "prorata") {
    if (!config.prorataAlphaVault) {
      throw new Error("Missing Prorata alpha vault configuration");
    }
    initAlphaVaultTx = await createProrataAlphaVault(
      connection,
      wallet,
      PoolType.DYNAMIC,
      poolKey,
      baseMint,
      quoteMint,
      config.prorataAlphaVault,
    );
  }

  if (!config.dryRun) {
    console.log(`>> Sending init pool transaction...`);
    let initPoolTxHash = await sendAndConfirmTransaction(
      connection,
      initPoolTx,
      [wallet.payer],
    ).catch((e) => {
      console.error(e);
      throw e;
    });
    console.log(
      `>>> Pool initialized successfully with tx hash: ${initPoolTxHash}`,
    );
  } else {
    console.log(`> Simulating init pool tx...`);
    await runSimulateTransaction(connection, wallet, [initPoolTx]);

    // console.log()
  }
}

async function createAndMintToken(
  connection: Connection,
  wallet: Wallet,
  mintDecimals: number,
  mintAmountLamport: BN,
): Promise<PublicKey> {
  const mint = await createMint(
    connection,
    wallet.payer,
    wallet.publicKey,
    null,
    mintDecimals,
  );

  const walletTokenATA = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet.payer,
    mint,
    wallet.publicKey,
    true,
  );
  await mintTo(
    connection,
    wallet.payer,
    mint,
    walletTokenATA.address,
    wallet.publicKey,
    mintAmountLamport,
    [],
    {
      commitment: DEFAULT_COMMITMENT_LEVEL,
    },
  );

  return mint;
}

async function createFcfsAlphaVault(
  connection: Connection,
  wallet: Wallet,
  poolType: PoolType,
  poolAddress: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  params: FcfsAlphaVaultConfig,
): Promise<Transaction> {
  console.log(`\n> Initializing FcfsAlphaVault...`);
  console.log(`- Using poolType: ${poolType}`);
  console.log(`- Using poolMint ${poolAddress}`);
  console.log(`- Using baseMint ${baseMint}`);
  console.log(`- Using quoteMint ${quoteMint}`);
  console.log(`- Using depositingPoint ${params.depositingPoint}`);
  console.log(`- Using startVestingPoint ${params.startVestingPoint}`);
  console.log(`- Using endVestingPoint ${params.endVestingPoint}`);
  console.log(`- Using maxDepositingCap ${params.maxDepositCap}`);
  console.log(
    `- Using individualDepositingCap ${params.individualDepositingCap}`,
  );
  console.log(`- Using escrowFee ${params.escrowFee}`);

  const tx = await AlphaVault.createCustomizableFcfsVault(
    connection,
    {
      quoteMint,
      baseMint,
      poolAddress,
      poolType,
      depositingPoint: new BN(params.depositingPoint),
      startVestingPoint: new BN(params.startVestingPoint),
      endVestingPoint: new BN(params.endVestingPoint),
      maxDepositingCap: new BN(params.maxDepositCap),
      individualDepositingCap: new BN(params.individualDepositingCap),
      escrowFee: new BN(params.escrowFee),
      whitelistMode: Permissionless,
    },
    wallet.publicKey,
    {
      cluster: "mainnet-beta",
    },
  );
  return tx;
}

async function createProrataAlphaVault(
  connection: Connection,
  wallet: Wallet,
  poolType: PoolType,
  poolAddress: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  params: ProrataAlphaVaultConfig,
): Promise<Transaction> {
  console.log(`\n> Initializing ProrataAlphaVault...`);
  console.log(`- Using poolType: ${poolType}`);
  console.log(`- Using poolMint ${poolAddress}`);
  console.log(`- Using baseMint ${baseMint}`);
  console.log(`- Using quoteMint ${quoteMint}`);
  console.log(`- Using depositingPoint ${params.depositingPoint}`);
  console.log(`- Using startVestingPoint ${params.startVestingPoint}`);
  console.log(`- Using endVestingPoint ${params.endVestingPoint}`);
  console.log(`- Using maxBuyingCap ${params.maxBuyingCap}`);
  console.log(`- Using escrowFee ${params.escrowFee}`);

  const tx = await AlphaVault.createCustomizableProrataVault(
    connection,
    {
      quoteMint,
      baseMint,
      poolAddress,
      poolType,
      depositingPoint: new BN(params.depositingPoint),
      startVestingPoint: new BN(params.startVestingPoint),
      endVestingPoint: new BN(params.endVestingPoint),
      maxBuyingCap: new BN(params.maxBuyingCap),
      escrowFee: new BN(params.escrowFee),
      whitelistMode: Permissionless,
    },
    wallet.publicKey,
    {
      cluster: "mainnet-beta",
    },
  );
  return tx;
}

main();
