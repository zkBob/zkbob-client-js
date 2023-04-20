import { Chains, ProverMode, Pool, Pools } from "./config";
import { InternalError } from "./errors";
import { EvmNetwork } from "./networks/evm";
import { NetworkType } from "./network-type";
import { NetworkBackend } from "./networks/network";
import { ServiceVersion } from "./services/common";
import { ZkBobDelegatedProver } from "./services/prover";
import { LimitsFetch, ZkBobRelayer } from "./services/relayer";
import { ColdStorageConfig } from "./coldstorage";
import { bufToHex, HexStringReader, HexStringWriter, hexToBuf, truncateHexPrefix } from "./utils";

const LIB_VERSION = require('../package.json').version;

const DEFAULT_DENOMINATOR = BigInt(1000000000);
const RELAYER_FEE_LIFETIME = 3600;  // when to refetch the relayer fee (in seconds)
const DEFAULT_RELAYER_FEE = BigInt(100000000);
const MIN_TX_AMOUNT = BigInt(50000000);
const GIFT_CARD_CODE_VER = 1;

// relayer fee + fetching timestamp
interface RelayerFeeFetch {
    fee: bigint;
    timestamp: number;  // when the fee was fetched
}

export interface Limit { // all values are in Gwei
    total: bigint;
    available: bigint;
}

export interface PoolLimits { // all values are in Gwei
    deposit: {
        total: bigint;
        components: {
            singleOperation: bigint;
            dailyForAddress: Limit;
            dailyForAll: Limit;
            poolLimit: Limit;
        };
    }
    withdraw: {
        total: bigint;
        components: {
            dailyForAll: Limit;
        };
    }
    tier: number;
}

export interface TreeState {
    root: bigint;
    index: bigint;
}

export interface ChainConfig {
    backend: NetworkBackend;
    networkName: string;
}

export class GiftCardProperties {
    sk: Uint8Array;
    birthIndex: bigint;
    balance: bigint;
    poolAlias: string;
}

// Provides base functionality for the zkBob solution
// within the specified configuration and selected pool
// without attaching the user account
export class ZkBobProvider {
    private chains:         { [chainId: string]: ChainConfig } = {};
    private pools:          { [name: string]: Pool } = {};
    private relayers:       { [name: string]: ZkBobRelayer } = {};
    private provers:        { [name: string]: ZkBobDelegatedProver } = {};
    private proverModes:    { [name: string]: ProverMode } = {};
    private denominators:   { [name: string]: bigint } = {};
    private poolIds:        { [name: string]: number } = {};
    private relayerFee:     { [name: string]: RelayerFeeFetch } = {};
    private coldStorageCfg: { [name: string]: ColdStorageConfig } = {};
    protected supportId: string | undefined;

    // The current pool alias should always be set
    protected curPool: string;
    
    // public constructor
    constructor(pools: Pools, chains: Chains, currentPool: string, supportId: string | undefined) {
        this.supportId = supportId;

        for (const [chainId, chain] of Object.entries(chains)) {
            if (chain.rpcUrls.length == 0) {
                throw new InternalError(`Chain with id ${chainId} being initialized without RPC URL`);
            }
            // TODO: implement multi-RPC NetworkBackend 
            const backend = new EvmNetwork(chain.rpcUrls[0], false);    // initialize backend in the disabled state
            let networkName = NetworkType.networkName(Number(chainId));
            if (!networkName) {
                console.warn(`The chain with id ${chainId} currently isn't fully supported. Unsuspectable issues may occured`);
                networkName = 'unknown-chain';
            }

            this.chains[chainId] = {backend, networkName};
        }

        for (const [alias, pool] of Object.entries(pools)) {
            if (!this.chains[pool.chainId]) {
                throw new InternalError(`Pool ${alias} being initialized with unknown chain id (${pool.chainId})`);
            }

            this.pools[alias] = pool;
            const relayer = ZkBobRelayer.create(pool.relayerUrls, supportId);  // will throw error if relayerUrls is empty
            this.relayers[alias] = relayer;

            // create a delegated prover service if url presented
            if (pool.delegatedProverUrls.length > 0) {
                this.provers[alias] = ZkBobDelegatedProver.create(pool.delegatedProverUrls, supportId);
            }

            if (alias == currentPool) {
                this.chains[pool.chainId].backend.setEnabled(true);
            }

            this.proverModes[alias] = ProverMode.Local;
        }

        if (!this.pools[currentPool]) {
            throw new InternalError(`Cannot initialize with the unknown current pool (${currentPool})`);
        }
        this.curPool = currentPool;
    }

    // --------------=========< Configuration properties >=========----------------
    // | Chains and pools properties, switching between pools                     |
    // ----------------------------------------------------------------------------

    // get alias of the currently selected pool
    public currentPool(): string {
        return this.curPool;
    }

    // get all available pool aliases
    public availabePools(): string[] {
        return Object.keys(this.pools);
    }

    // swithing to the another pool
    public switchToPool(poolAlias: string) {
        if (!this.pools[poolAlias]) {
            throw new InternalError(`Cannot activate unknown pool ${poolAlias}`);
        }

        // disable current network backend and enable new one for the new pool
        const oldChainId = this.pools[this.curPool].chainId;
        const newChainId = this.pools[poolAlias].chainId;
        if (newChainId != oldChainId) {
            this.chains[oldChainId].backend.setEnabled(false);
            this.chains[newChainId].backend.setEnabled(true);
        }

        // try to set the prover mode for the new pool if it was not defined yet
        if (!this.proverModes[poolAlias]) {
            // apply current prover mode or use a local prover by default
            let proverMode = this.proverModes[this.curPool] ?? ProverMode.Local;
            if (this.pools[poolAlias].delegatedProverUrls.length == 0) {
                proverMode = ProverMode.Local;
            }

            this.proverModes[poolAlias] = proverMode;
        }

        this.curPool = poolAlias;
    }

    protected pool(): Pool {
        const pool = this.pools[this.curPool];
        if (!pool) {
            throw new InternalError(`Unknown pool: ${this.curPool}`);
        }

        return pool;
    }

    protected network(): NetworkBackend {
        const chainId = this.pool().chainId;
        const chain = this.chains[chainId];
        if (!chain) {
            throw new InternalError(`Unknown chain with id: ${chainId}`);
        }
        
        return chain.backend;
    }

    public networkName(): string {
        const chainId = this.pool().chainId;
        const chain = this.chains[chainId];
        if (!chain) {
            throw new InternalError(`Unknown chain with id: ${chainId}`);
        }
        
        return chain.networkName;
    }

    protected relayer(): ZkBobRelayer {
        const relayer = this.relayers[this.curPool];
        if (!relayer) {
            throw new InternalError(`No relayer for the pool ${this.curPool}`);
        }

        return relayer;
    }

    protected prover(): ZkBobDelegatedProver | undefined {
        return this.provers[this.curPool];
    }

    // Pool contract using default denominator 10^9
    // i.e. values less than 1 Gwei are supposed equals zero
    // But this is deployable parameter so this method needed to retrieve it
    protected async denominator(): Promise<bigint> {
        let denominator = this.denominators[this.curPool];
        if (!denominator) {
            try {
                const pool = this.pool();
                denominator = await this.network().getDenominator(pool.poolAddress);
                this.denominators[this.curPool] = denominator;
            } catch (err) {
                console.error(`Cannot fetch denominator value from the relayer, will using default 10^9: ${err}`);
                denominator = DEFAULT_DENOMINATOR;
            }
        }

        return denominator;
    }

    // Each zkBob pool should have a unique identifier
    public async poolId(): Promise<number> {
        let poolId = this.poolIds[this.curPool];
        if (!poolId) {
            try {
                const token = this.pool();
                poolId = await this.network().getPoolId(token.poolAddress);
                this.poolIds[this.curPool] = poolId;
            } catch (err) {
                console.error(`Cannot fetch pool ID, will using default (0): ${err}`);
                poolId = 0;
            }
        }

        return poolId;
    }

    // get the cold storage configuration for the specified pool
    public async coldStorageConfig(): Promise<ColdStorageConfig | undefined> {
        if (!this.coldStorageCfg[this.curPool]) {
            const pool = this.pool();
            if (pool.coldStorageConfigPath) {
                try {
                    let response = await fetch(pool.coldStorageConfigPath);
                    let config: ColdStorageConfig = await response.json();
                    if (config.network.toLowerCase() != this.networkName().toLowerCase()) {
                        throw new InternalError('Incorrect cold storage configuration');
                    }
                    this.coldStorageCfg[this.curPool] = config;
                } catch (err) {
                    console.error(`Cannot initialize cold storage: ${err}`);
                }
            }
        }

        return this.coldStorageCfg[this.curPool];
    }

    // path to search cold storage bulk files for the specified pool
    public coldStorageBaseURL(): string | undefined {
        const pool = this.pool();
        if (pool.coldStorageConfigPath) {
            return pool.coldStorageConfigPath.substring(0, pool.coldStorageConfigPath.lastIndexOf('/'));
        }

        return undefined;
    }

    // -------------=========< Converting Amount Routines >=========---------------
    // | Between wei and pool resolution                                          |
    // ----------------------------------------------------------------------------

    // Convert native pool amount to the base units
    public async shieldedAmountToWei(amountShielded: bigint): Promise<bigint> {
        const denominator = await this.denominator();
        return amountShielded * denominator;
    }
    
    // Convert base units to the native pool amount
    public async weiToShieldedAmount(amountWei: bigint): Promise<bigint> {
        const denominator = await this.denominator();
        return amountWei / denominator;
    }

    // -------------=========< Transaction configuration >=========----------------
    // | Fees and limits, min tx amount (which are not depend on zkAccount)       |
    // ----------------------------------------------------------------------------

    // Min trensaction fee in Gwei (e.g. deposit or single transfer)
    // To estimate fee in the common case please use feeEstimate instead
    public async atomicTxFee(): Promise<bigint> {
        const relayer = await this.getRelayerFee();
        const l1 = BigInt(0);

        return relayer + l1;
    }

    // Base relayer fee per tx. Do not use it directly, use atomicTxFee instead
    protected async getRelayerFee(): Promise<bigint> {
        let cachedFee = this.relayerFee[this.curPool];
        if (!cachedFee || cachedFee.timestamp + RELAYER_FEE_LIFETIME * 1000 < Date.now()) {
            try {
                const fee = await this.relayer().fee()
                cachedFee = {fee, timestamp: Date.now()};
                this.relayerFee[this.curPool] = cachedFee;
            } catch (err) {
                console.error(`Cannot fetch relayer fee, will using default (${DEFAULT_RELAYER_FEE}): ${err}`);
                return this.relayerFee[this.curPool]?.fee ?? DEFAULT_RELAYER_FEE;
            }
        }

        return cachedFee.fee;
    }

    public async directDepositFee(): Promise<bigint> {
        return this.network().getDirectDepositFee(this.pool().poolAddress);
    }

    public async minTxAmount(): Promise<bigint> {
        return MIN_TX_AMOUNT;
    }

    // The deposit and withdraw amount is limited by few factors:
    // https://docs.zkbob.com/bob-protocol/deposit-and-withdrawal-limits
    // Global limits are fetched from the relayer (except personal deposit limit from the specified address)
    public async getLimits(address: string | undefined, directRequest: boolean = false): Promise<PoolLimits> {
        const token = this.pool();
        const network = this.network();
        const relayer = this.relayer();

        async function fetchLimitsFromContract(network: NetworkBackend): Promise<LimitsFetch> {
            const poolLimits = await network.poolLimits(token.poolAddress, address);
            return {
                deposit: {
                    singleOperation: BigInt(poolLimits.depositCap),
                    dailyForAddress: {
                        total: BigInt(poolLimits.dailyUserDepositCap),
                        available: BigInt(poolLimits.dailyUserDepositCap) - BigInt(poolLimits.dailyUserDepositCapUsage),
                    },
                    dailyForAll: {
                        total:      BigInt(poolLimits.dailyDepositCap),
                        available:  BigInt(poolLimits.dailyDepositCap) - BigInt(poolLimits.dailyDepositCapUsage),
                    },
                    poolLimit: {
                        total:      BigInt(poolLimits.tvlCap),
                        available:  BigInt(poolLimits.tvlCap) - BigInt(poolLimits.tvl),
                    },
                },
                withdraw: {
                    dailyForAll: {
                        total:      BigInt(poolLimits.dailyWithdrawalCap),
                        available:  BigInt(poolLimits.dailyWithdrawalCap) - BigInt(poolLimits.dailyWithdrawalCapUsage),
                    },
                },
                tier: poolLimits.tier === undefined ? 0 : Number(poolLimits.tier)
            };
        }

        function defaultLimits(): LimitsFetch {
            // hardcoded values
            return {
                deposit: {
                    singleOperation: BigInt(10000000000000),  // 10k tokens
                    dailyForAddress: {
                        total: BigInt(10000000000000),  // 10k tokens
                        available: BigInt(10000000000000),  // 10k tokens
                    },
                    dailyForAll: {
                        total:      BigInt(100000000000000),  // 100k tokens
                        available:  BigInt(100000000000000),  // 100k tokens
                    },
                    poolLimit: {
                        total:      BigInt(1000000000000000), // 1kk tokens
                        available:  BigInt(1000000000000000), // 1kk tokens
                    },
                },
                withdraw: {
                    dailyForAll: {
                        total:      BigInt(100000000000000),  // 100k tokens
                        available:  BigInt(100000000000000),  // 100k tokens
                    },
                },
                tier: 0
            };
        }

        // Fetch limits in the requested order
        let currentLimits: LimitsFetch;
        if (directRequest) {
            try {
                currentLimits = await fetchLimitsFromContract(network);
            } catch (e) {
                console.warn(`Cannot fetch limits from the contract (${e}). Try to get them from relayer`);
                try {
                    currentLimits = await relayer.limits(address);
                } catch (err) {
                    console.warn(`Cannot fetch limits from the relayer (${err}). Getting hardcoded values. Please note your transactions can be reverted with incorrect limits!`);
                    currentLimits = defaultLimits();
                }
            }
        } else {
            try {
                currentLimits = await relayer.limits(address);
            } catch (e) {
                console.warn(`Cannot fetch deposit limits from the relayer (${e}). Try to get them from contract directly`);
                try {
                    currentLimits = await fetchLimitsFromContract(network);
                } catch (err) {
                    console.warn(`Cannot fetch deposit limits from contract (${err}). Getting hardcoded values. Please note your transactions can be reverted with incorrect limits!`);
                    currentLimits = defaultLimits();
                }
            }
        }

        // helper
        const bigIntMin = (...args: bigint[]) => args.reduce((m, e) => e < m ? e : m);

        // Calculate deposit limits
        const allDepositLimits = [
            currentLimits.deposit.singleOperation,
            currentLimits.deposit.dailyForAddress.available,
            currentLimits.deposit.dailyForAll.available,
            currentLimits.deposit.poolLimit.available,
        ];
        const totalDepositLimit = bigIntMin(...allDepositLimits);

        // Calculate withdraw limits
        const allWithdrawLimits = [ currentLimits.withdraw.dailyForAll.available ];
        const totalWithdrawLimit = bigIntMin(...allWithdrawLimits);

        return {
            deposit: {
                total: totalDepositLimit >= 0 ? totalDepositLimit : BigInt(0),
                components: currentLimits.deposit,
            },
            withdraw: {
                total: totalWithdrawLimit >= 0 ? totalWithdrawLimit : BigInt(0),
                components: currentLimits.withdraw,
            },
            tier: currentLimits.tier
        }
    }

    // --------------=========< Common Prover Routines >=========------------------
    // | Support fo switching between different proving modes                     |
    // ----------------------------------------------------------------------------
    public async setProverMode(mode: ProverMode) {
        if (!Object.values(ProverMode).includes(mode)) {
            throw new InternalError("Provided mode isn't correct. Possible modes: Local, Delegated, and DelegatedWithFallback");
        }

        const prover = this.prover();

        if (mode == ProverMode.Delegated || mode == ProverMode.DelegatedWithFallback) {
            if (!prover) {
                this.proverModes[this.curPool] = ProverMode.Local;
                throw new InternalError(`Delegated prover can't be enabled because delegated prover url wasn't provided`)
            }

            if ((await prover.healthcheck()) == false) {
                this.proverModes[this.curPool] = ProverMode.Local;
                throw new InternalError(`Delegated prover can't be enabled because delegated prover isn't healthy`)
            }
        }

        this.proverModes[this.curPool] = mode;
    }
    
    public getProverMode(): ProverMode {
        const mode = this.proverModes[this.curPool];
        if (!mode) {
            throw new InternalError(`No prover mode set for the pool ${this.curPool}`);
        }

        return mode;
    }

    // ------------------=========< State Processing >=========--------------------
    // | Getting the remote state (from the relayer and pool)                     |
    // ----------------------------------------------------------------------------

    // Get relayer regular root & index
    public async getRelayerState(): Promise<TreeState> {
        const relayer = this.relayer();
        const info = await relayer.info();

        return {root: BigInt(info.root), index: info.deltaIndex};
    }

    // Get relayer optimistic root & index
    public async getRelayerOptimisticState(): Promise<TreeState> {
        const info = await this.relayer().info();

        return {root: BigInt(info.optimisticRoot), index: info.optimisticDeltaIndex};
    }

    // Get pool info (direct web3 request)
    public async getPoolState(index?: bigint): Promise<TreeState> {
        const token = this.pool();
        const res = await this.network().poolState(token.poolAddress, index);

        return {index: res.index, root: res.root};
    }

    // --------------------=========< Versioning >=========------------------------
    // | Miscellaneous version information                                        |
    // ----------------------------------------------------------------------------

    public getLibraryVersion(): string {
        return LIB_VERSION;
    }

    public async getRelayerVersion(): Promise<ServiceVersion> {
        return this.relayer().version();
    }

    public async getProverVersion(): Promise<ServiceVersion> {
        const prover = this.prover()
        if (!prover) {
            throw new InternalError(`Cannot fetch prover version because delegated prover wasn't initialized for the pool ${this.curPool}`);
        }
        
        return prover.version();
    }

    // ------------------=========< Other Routines >=========----------------------
    // | Helpers                                                                  |
    // ----------------------------------------------------------------------------

    public async codeForGiftCard(giftCard: GiftCardProperties): Promise<string> {
        const pool = this.pools[giftCard.poolAlias];
        if (!pool) {
            throw new InternalError(`Unknown pool in gift-card properties: ${giftCard.poolAlias}`);
        }

        if (giftCard.sk.length != 32) {
            throw new InternalError('The gift-card spending key should be 32 bytes length');
        }


        const writer = new HexStringWriter();
        writer.writeNumber(GIFT_CARD_CODE_VER, 1);
        writer.writeHex(bufToHex(giftCard.sk));
        writer.writeBigInt(giftCard.birthIndex, 6);
        writer.writeHex(pool.poolAddress.slice(-8));
        writer.writeNumber(pool.chainId, 4);
        writer.writeBigInt(giftCard.balance, 8);

        return truncateHexPrefix(writer.toString());
    }

    public async giftCardFromCode(code: string): Promise<GiftCardProperties> {
        const reader = new HexStringReader(code);
        
        const codeVer = reader.readNumber(1);
        if (codeVer == null) {
            throw new InternalError('Incorrect code for the gift-card');
        }
        if (codeVer > GIFT_CARD_CODE_VER) {
            throw new InternalError(`The gift-card code version ${codeVer} isn't supported`);
        }

        const sk = reader.readHex(32);
        const birthIndex = reader.readBigInt(6);
        const poolAddrSlice = reader.readHex(4);
        const chainId = reader.readNumber(4);
        const balance = reader.readBigInt(8);
        if (sk == null || birthIndex == null || poolAddrSlice == null || chainId == null || balance == null) {
            throw new InternalError('Incorrect code for the gift-card');
        }
        
        let poolAlias: string | undefined = undefined;
        for (const [alias, pool] of Object.entries(this.pools)) {
            if (pool.chainId == chainId && pool.poolAddress.slice(-8) == poolAddrSlice) {
                poolAlias = alias;
                break;
            }
        }

        if (!poolAlias) {
            throw new InternalError(`Uncnown pool in the gift-carg code (chainId = ${chainId}, endOfPoolAddr = ${poolAddrSlice})`);
        }

        return { sk: hexToBuf(sk), birthIndex, balance, poolAlias };
    }
}