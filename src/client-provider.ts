import { Chains, ProverMode, Pool, Pools, ZkAddressPrefix } from "./config";
import { InternalError } from "./errors";
import { NetworkBackendFactory } from "./networks";
import { NetworkType } from "./network-type";
import { NetworkBackend } from "./networks";
import { ServiceType, ServiceVersion } from "./services/common";
import { ZkBobDelegatedProver } from "./services/delegated-prover";
import { RelayerFee, LimitsFetch, ZkBobRelayer, SequencerEndpoint } from "./services/relayer";
import { ProxyFee, ZkBobProxy } from "./services/proxy";
import { ColdStorageConfig } from "./coldstorage";
import { bufToHex, HexStringReader, HexStringWriter, hexToBuf, truncateHexPrefix } from "./utils";
import { RegularTxType, TxCalldataVersion } from "./tx";
import { ZkBobSubgraph } from "./subgraph";
import { hardcodedPrefixes } from "./address-prefixes";

const bs58 = require('bs58')

const LIB_VERSION = require('../package.json').version;

const SEQUENCER_FEE_LIFETIME = 30;  // when to refetch the sequencer fee (in seconds)
const NATIVE_AMOUNT_LIFETIME = 3600;  // when to refetch the max supported swap amount (in seconds)
const MIN_TX_COIN_PART = 20;    // Min available tx amount is exactly this part of token (1/20)
const GIFT_CARD_CODE_VER = 1;

// We support both Relayer (centralized sequencer) and Proxy (decentralized one) interaction
export type Sequencer = ZkBobRelayer | ZkBobProxy;
export type SequencerFee = RelayerFee | ProxyFee;
// type guards
export function isProxy(seq: Sequencer): seq is ZkBobProxy {
    return seq.type() == ServiceType.Proxy;
}
export function isProxyFee(fee: SequencerFee): fee is ProxyFee {
    const proxyFee = fee as ProxyFee;
    return proxyFee.proxyAddress !== undefined && proxyFee.proverFee !== undefined;
}

// sequencer fee + fetching timestamp
interface SequencerFeeFetch {
    fee: SequencerFee;
    timestamp: number;  // when the fee was fetched
}

export interface TxFee { // all numeric values are in the pool dimension
    proxyAddress: string; // L1-address of the proxy
    proverAddress: string; // L1-address of the prover
    total: bigint;        // total fee estimation
    proxyPart: bigint;    // proxy fee of commiting tx to the pool contract
    proverPart: bigint;   // prover fee of including tx to the Merkle tree
}

// max supported swap amount + fetching timestamp
interface MaxSwapAmountFetch {
    amount: bigint;
    timestamp: number;  // when amount was fetched
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
    dd: {
        total: bigint;
        components: {
            singleOperation: bigint;
            dailyForAddress: Limit;
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
    birthIndex: number;
    balance: bigint;
    poolAlias: string;
}

export enum SequencerType {
    CentralizedRelayer,
    DecentralizedProxy,
}

// Provides base functionality for the zkBob solution
// within the specified configuration and selected pool
// without attaching the user account
export class ZkBobProvider {
    private chains:           { [chainId: string]: ChainConfig } = {};
    private pools:            { [name: string]: Pool } = {};
    private sequencers:       { [name: string]: Sequencer } = {};
    private provers:          { [name: string]: ZkBobDelegatedProver } = {};
    private proverModes:      { [name: string]: ProverMode } = {};
    private subgraphs:        { [name: string]: ZkBobSubgraph } = {};
    private poolDenominators: { [name: string]: bigint } = {};
    private tokenDecimals:    { [name: string]: number } = {};
    private poolIds:          { [name: string]: number } = {};
    private sequencerFee:     { [name: string]: SequencerFeeFetch } = {};
    private minTxAmounts:     { [name: string]: bigint } = {};
    private maxSwapAmount:    { [name: string]: MaxSwapAmountFetch } = {};
    private coldStorageCfg:   { [name: string]: ColdStorageConfig } = {};
    protected addressPrefixes:  ZkAddressPrefix[] = [];
    protected supportId: string | undefined;

    // The current pool alias should always be set
    protected curPool: string;
    
    // public constructor
    constructor(
        pools: Pools,
        chains: Chains,
        currentPool: string,
        extraPrefixes: ZkAddressPrefix[],
        supportId: string | undefined
    ) {
        this.supportId = supportId;

        for (const [chainId, chain] of Object.entries(chains)) {
            if (chain.rpcUrls.length == 0) {
                throw new InternalError(`Chain with id ${chainId} being initialized without RPC URL`);
            }
            const backend = NetworkBackendFactory.createBackend(Number(chainId), chain.rpcUrls, false);    // initialize backend in the disabled state
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

            const hasRelayers = pool.relayerUrls && pool.relayerUrls.length > 0;
            const hasProxies = pool.proxyUrls && pool.proxyUrls.length > 0;
            if (hasRelayers == hasProxies) {
                throw new InternalError(`Pool ${alias} should define at least a relayer OR proxy (not both)`);
            }
            this.sequencers[alias] = hasRelayers ? 
                    ZkBobRelayer.create(pool.relayerUrls as string[], supportId) :
                    ZkBobProxy.create(pool.proxyUrls as string[], supportId);

            // create a delegated prover service if url presented
            if (pool.delegatedProverUrls && pool.delegatedProverUrls.length > 0) {
                this.provers[alias] = ZkBobDelegatedProver.create(pool.delegatedProverUrls, supportId);
            }

            const network = this.chains[pool.chainId].backend;
            if (alias == currentPool) {
                network.setEnabled(true);
            }

            this.proverModes[alias] = ProverMode.Local;

            // create subraph if presented
            if (pool.ddSubgraph) {
                try {
                    const subgraph = new ZkBobSubgraph(pool.ddSubgraph);
                    this.subgraphs[alias] = subgraph;
                } catch(err) {
                    console.warn(`The subgraph ${pool.ddSubgraph} cannot be created: ${err.message}`);
                }
            }
        }

        if (!this.pools[currentPool]) {
            throw new InternalError(`Cannot initialize with the unknown current pool (${currentPool})`);
        }
        this.curPool = currentPool;

        this.addressPrefixes.push(...hardcodedPrefixes);
        const existingPoolIds = this.addressPrefixes.map((val) => val.poolId);
        const existingAddrPrefs = this.addressPrefixes.map((val) => val.prefix.toLowerCase());
        for (const aPrefix of extraPrefixes) {
            if (existingPoolIds.includes(aPrefix.poolId)) {
                console.warn(`Address prefix for the pool id ${aPrefix.poolId} already exist. Ignoring ${aPrefix.poolId} -> ${aPrefix.prefix}`);
            } else if (existingAddrPrefs.includes(aPrefix.prefix.toLowerCase())) {
                console.warn(`Address prefix ${aPrefix.prefix} already exist. Ignoring ${aPrefix.poolId} -> ${aPrefix.prefix}`);
            } else {
                this.addressPrefixes.push(aPrefix, )
            }
        }
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

    // switching to the another pool
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
            const proverUrls = this.pools[poolAlias].delegatedProverUrls;
            if (!proverUrls || proverUrls.length == 0) {
                proverMode = ProverMode.Local;
            }

            this.proverModes[poolAlias] = proverMode;
        }

        this.curPool = poolAlias;
    }

    public async sequencerEndpoints(): Promise<SequencerEndpoint[]> {
        return this.sequencer().getEndpoints();
    }

    public async prioritizeSequencerEndpoint(index: number): Promise<number | undefined> {
        return this.sequencer().prioritizeEndpoint(index);
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

    protected sequencerType(): SequencerType {
        const seqType = this.sequencer().type();
        switch (seqType) {
            case ServiceType.Relayer: return SequencerType.CentralizedRelayer;
            case ServiceType.Proxy:   return SequencerType.DecentralizedProxy;
            default: throw new InternalError(`Bad sequencer service (${seqType}) for the pool ${this.curPool}`);
        }
    }

    protected sequencer(): Sequencer {
        const seq = this.sequencers[this.curPool];
        if (!seq) {
            throw new InternalError(`No sequencer exist for the pool ${this.curPool}`);
        }

        return seq;
    }

    protected prover(): ZkBobDelegatedProver | undefined {
        return this.provers[this.curPool];
    }

    protected subgraph(): ZkBobSubgraph | undefined {
        return this.subgraphs[this.curPool];
    }

    // Pool contract using denominator to calculate
    // absolute token amount (by multiplying)
    // E.g. for denomiator 10^9 values less than 1 Gwei
    // are supposed equals zero
    // This is a pool contract deployable parameter so this method needed to retrieve it
    protected async denominator(): Promise<bigint> {
        let denominator = this.poolDenominators[this.curPool];
        if (!denominator) {
            try {
                const pool = this.pool();
                denominator = await this.network().getDenominator(pool.poolAddress);
                const negFlag = 1n << 255n;
                if (denominator & negFlag) {
                    denominator = -(denominator ^ negFlag);
                }
                this.poolDenominators[this.curPool] = denominator;
            } catch (err) {
                console.error(`Cannot fetch denominator value from the pool contract: ${err}`);
                throw new InternalError(`Unable to retrieve pool denominator`);
            }
        }

        return denominator;
    }

    // Number of decimals used to get user representation of 1 token
    // Most of tokens have decimals = 18, but it isn't a rule
    // This is a token contract deployable parameter
    protected async decimals(): Promise<number> {
        let decimals = this.tokenDecimals[this.curPool];
        if (!decimals) {
            try {
                const pool = this.pool();
                decimals = await this.network().getTokenDecimals(pool.tokenAddress);
                this.tokenDecimals[this.curPool] = decimals;
            } catch (err) {
                console.error(`Cannot fetch decimals value from the token contract: ${err}`);
                throw new InternalError(`Unable to retrieve token decimals`);
            }
        }

        return decimals;
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
    protected async coldStorageConfig(): Promise<ColdStorageConfig | undefined> {
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
    protected coldStorageBaseURL(): string | undefined {
        const pool = this.pool();
        if (pool.coldStorageConfigPath) {
            return pool.coldStorageConfigPath.substring(0, pool.coldStorageConfigPath.lastIndexOf('/'));
        }

        return undefined;
    }

    protected async addressPrefix(): Promise<ZkAddressPrefix> {
        const poolId = await this.poolId();
        const pref = this.addressPrefixes.filter((val) => val.poolId == poolId);
        if (pref.length > 0) {
            // Polygon and Sepolia pools share the same pool id (0)
            // So we should select proper address prefix here
            if (poolId == 0 && pref.length > 1 && this.pool().chainId == 11155111) {
                return pref[1];
            }
            return pref[0];
        }

        throw new InternalError(`The current pool (id = 0x${poolId.toString(16)}) has no configured address prefix`);
    }

    protected calldataVersion(): TxCalldataVersion {
        return this.sequencerType() == SequencerType.CentralizedRelayer ? 
            TxCalldataVersion.V1 :
            TxCalldataVersion.V2;   // decentralized proxies do not support old calldata
    }

    // -------------=========< Converting Amount Routines >=========---------------
    // | Between wei and pool resolution                                          |
    // ----------------------------------------------------------------------------

    // Convert native pool amount to the base units
    public async shieldedAmountToWei(amountShielded: bigint): Promise<bigint> {
        const denominator = BigInt(await this.denominator());
        return denominator > 0 ? BigInt(amountShielded) * denominator : BigInt(amountShielded) / (-denominator);
    }
    
    // Convert base units to the native pool amount
    public async weiToShieldedAmount(amountWei: bigint): Promise<bigint> {
        const denominator = BigInt(await this.denominator());
        return denominator > 0 ? BigInt(amountWei) / denominator : BigInt(amountWei) * (-denominator);
    }

    // Round up the fee if needed with fixed fee decimal places (after point)
    protected async roundFee(fee: bigint): Promise<bigint> {
        const feeDecimals = this.pool().feeDecimals;
        if (feeDecimals !== undefined) {
            const denominator = await this.denominator();
            const denomLog = denominator > 0 ? 
                        denominator.toString().length - 1 :
                        -((-denominator).toString().length - 1);
            const poolResDigits = (await this.decimals()) - denomLog;
            if (poolResDigits > feeDecimals) {
                const rounder = 10n ** BigInt(poolResDigits - feeDecimals);
                return fee % rounder > 0n ? fee + rounder - fee % rounder : fee;
            }
        }

        return fee;
    }

    // -------------=========< Transaction configuration >=========----------------
    // | Fees and limits, min tx amount (which are not depend on zkAccount)       |
    // ----------------------------------------------------------------------------

    // Sequencer raw fee components used to calculate concrete tx cost
    // To estimate typical fee for transaction with desired type please use atomicTxFee
    public async getSequencerFee(): Promise<SequencerFee> {
        let cachedFee = this.sequencerFee[this.curPool];
        if (!cachedFee || cachedFee.timestamp + SEQUENCER_FEE_LIFETIME * 1000 < Date.now()) {
            const fee = await this.sequencer().fee();
            cachedFee = {fee, timestamp: Date.now()};
            this.sequencerFee[this.curPool] = cachedFee;
        }

        return cachedFee.fee;
    }

    protected async executionTxFee(txType: RegularTxType, sequencerFee?: SequencerFee): Promise<bigint> {
        const fee = sequencerFee ?? await this.getSequencerFee();
        switch (txType) {
            case RegularTxType.Deposit: return fee.fee.deposit;
            case RegularTxType.Transfer: return fee.fee.transfer;
            case RegularTxType.Withdraw: return fee.fee.withdrawal;
            case RegularTxType.BridgeDeposit: return fee.fee.permittableDeposit;
            default: throw new InternalError(`Unknown TxType: ${txType}`);
        }
    }

    // Min transaction fee in pool resolution (for regular transaction without any payload overhead)
    // To estimate fee for the concrete tx use account-based method (feeEstimate from client.ts)
    public async atomicTxFee(txType: RegularTxType, withdrawSwap: bigint = 0n): Promise<TxFee> {
        const sequencerFee = await this.getSequencerFee();
        
        return this.singleTxFeeInternal(sequencerFee, txType, txType == RegularTxType.Transfer ? 1 : 0, 0, withdrawSwap, true);
    }

    // dynamic fee calculation routine
    protected async singleTxFeeInternal(
        sequencerFee: SequencerFee,
        txType: RegularTxType,
        notesCnt: number,
        extraDataLen: number = 0,
        withdrawSwapAmount: bigint = 0n,
        roundFee?: boolean,
    ): Promise<TxFee> {
        const calldataBytesCnt = this.network().estimateCalldataLength(this.calldataVersion(), txType, notesCnt, extraDataLen);
        const baseFee = await this.executionTxFee(txType, sequencerFee);

        let proverPart = isProxyFee(sequencerFee) ? sequencerFee.proverFee : 0n;
        let proxyPart = baseFee + sequencerFee.oneByteFee * BigInt(calldataBytesCnt);
        if (txType == RegularTxType.Withdraw && withdrawSwapAmount > 0n) {
            // swapping tokens during withdrawal may require additional fee
            proxyPart += sequencerFee.nativeConvertFee;
        }

        if (roundFee === undefined || roundFee == true) {
            proxyPart = await this.roundFee(proxyPart);
            proverPart = await this.roundFee(proverPart);
        }
        
        return {
            proxyAddress: isProxyFee(sequencerFee) ? sequencerFee.proxyAddress : '',
            proverAddress: isProxyFee(sequencerFee) ? sequencerFee.proverAddress : '',
            total: proxyPart + proverPart,
            proxyPart,
            proverPart
        };
    }
    
    // Max supported token swap during withdrawal, in token resolution (Gwei)
    public async maxSupportedTokenSwap(): Promise<bigint> {
        let cachedAmount = this.maxSwapAmount[this.curPool];
        if (!cachedAmount || cachedAmount.timestamp + NATIVE_AMOUNT_LIFETIME * 1000 < Date.now()) {
            try {
                const amount = await this.sequencer().maxSupportedSwapAmount();
                cachedAmount = {amount, timestamp: Date.now()};
                this.maxSwapAmount[this.curPool] = cachedAmount;
            } catch (err) {
                const res = this.maxSwapAmount[this.curPool]?.amount ?? 0n;
                console.warn(`Cannot fetch max available swap amount, will using default (${res}): ${err}`);

                return res;
            }
        }

        return cachedAmount.amount;
    }

    public async minTxAmount(): Promise<bigint> {
        let cachedAmount = this.minTxAmounts[this.curPool];
        if (!cachedAmount) {
            const overridenMinTxAmout = this.pool().minTxAmount;
            if (overridenMinTxAmout !== undefined) {
                cachedAmount = BigInt(overridenMinTxAmout);
            } else {
                const [decimals, denominator] = await Promise.all([this.decimals(), this.denominator()]);
                const oneTokenNative = BigInt(10 ** decimals);
                const oneTokenShielded = denominator > 0 ? oneTokenNative / denominator : oneTokenNative * denominator;
                cachedAmount = oneTokenShielded / BigInt(MIN_TX_COIN_PART);
            }

            this.minTxAmounts[this.curPool] = cachedAmount;
        }

        return cachedAmount;
    }

    // The deposit and withdraw amount is limited by few factors:
    // https://docs.zkbob.com/bob-protocol/deposit-and-withdrawal-limits
    // Global limits are fetched from the sequencer (except personal deposit limit from the specified address)
    public async getLimits(address: string | undefined, directRequest: boolean = false): Promise<PoolLimits> {
        const pool = this.pool();
        const network = this.network();
        const sequencer = this.sequencer();

        async function fetchLimitsFromContract(network: NetworkBackend): Promise<LimitsFetch> {
            const poolLimits = await network.poolLimits(pool.poolAddress, address);
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
                dd: {
                    singleOperation: BigInt(poolLimits.directDepositCap),
                    dailyForAddress: {
                        total: BigInt(poolLimits.dailyUserDirectDepositCap),
                        available: BigInt(poolLimits.dailyUserDirectDepositCap) - BigInt(poolLimits.dailyUserDirectDepositCapUsage),
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
                dd: {
                    singleOperation: BigInt(10000000000000),  // 10k tokens
                    dailyForAddress: {
                        total: BigInt(10000000000000),  // 10k tokens
                        available: BigInt(10000000000000),  // 10k tokens
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
                console.warn(`Cannot fetch limits from the contract (${e}). Try to get them from sequencer`);
                try {
                    currentLimits = await sequencer.limits(address);
                } catch (err) {
                    console.warn(`Cannot fetch limits from the sequencer (${err}). Getting hardcoded values. Please note your transactions can be reverted with incorrect limits!`);
                    currentLimits = defaultLimits();
                }
            }
        } else {
            try {
                currentLimits = await sequencer.limits(address);
            } catch (e) {
                console.warn(`Cannot fetch deposit limits from the sequencer (${e}). Try to get them from contract directly`);
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

        // Calculate direct deposit limits
        const allDdLimits = [
            currentLimits.dd.singleOperation,
            currentLimits.dd.dailyForAddress.available,
        ];
        const totalDdLimit = bigIntMin(...allDdLimits);

        return {
            deposit: {
                total: totalDepositLimit >= 0 ? totalDepositLimit : 0n,
                components: currentLimits.deposit,
            },
            withdraw: {
                total: totalWithdrawLimit >= 0 ? totalWithdrawLimit : 0n,
                components: currentLimits.withdraw,
            },
            dd: {
                total: totalDdLimit >=0 ? totalDdLimit : 0n,
                components: currentLimits.dd,
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
    // | Getting the remote state (from the sequencer and pool)                   |
    // ----------------------------------------------------------------------------

    // Get sequencer regular root & index
    public async getSequencerState(): Promise<TreeState> {
        const sequencer = this.sequencer();
        const info = await sequencer.info();

        return {root: BigInt(info.root), index: info.deltaIndex};
    }

    // Get sequencer optimistic root & index
    public async getSequencerOptimisticState(): Promise<TreeState> {
        const info = await this.sequencer().info();

        return {root: BigInt(info.optimisticRoot), index: info.optimisticDeltaIndex};
    }

    // Get sequencer pending (super-optimistic) index
    public async getSequencerPendingIndex(): Promise<bigint> {
        const info = await this.sequencer().info();

        return BigInt(info.pendingDeltaIndex ?? info.optimisticDeltaIndex);
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

    public async getSequencerVersion(): Promise<ServiceVersion> {
        return this.sequencer().version();
    }

    public async getDelegatedProverVersion(): Promise<ServiceVersion> {
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
        writer.writeNumber(giftCard.birthIndex, 6);
        const poolAddrHex = bufToHex(this.network().addressToBytes(pool.poolAddress));
        writer.writeHex(poolAddrHex.slice(-8));
        writer.writeNumber(pool.chainId, 4);
        writer.writeBigInt(giftCard.balance, 8);

        return bs58.encode(hexToBuf(writer.toString()));
    }

    public async giftCardFromCode(code: string): Promise<GiftCardProperties> {
        const hexBuf = bufToHex(bs58.decode(code));
        const reader = new HexStringReader(hexBuf);
        
        const codeVer = reader.readNumber(1);
        if (codeVer == null) {
            throw new InternalError('Incorrect code for the gift-card');
        }
        if (codeVer > GIFT_CARD_CODE_VER) {
            throw new InternalError(`The gift-card code version ${codeVer} isn't supported`);
        }

        const sk = reader.readHex(32);
        const birthIndex = reader.readNumber(6);
        const poolAddrSlice = reader.readHex(4);
        const chainId = reader.readNumber(4);
        const balance = reader.readBigInt(8);
        if (sk == null || birthIndex == null || poolAddrSlice == null || chainId == null || balance == null) {
            throw new InternalError('Incorrect code for the gift-card');
        }
        
        let poolAlias: string | undefined = undefined;
        for (const [alias, pool] of Object.entries(this.pools)) {
            const poolAddrHex = bufToHex(this.network().addressToBytes(pool.poolAddress));
            if (pool.chainId == chainId && poolAddrHex.slice(-8).toLowerCase() == poolAddrSlice.toLowerCase()) {
                poolAlias = alias;
                break;
            }
        }

        if (!poolAlias) {
            throw new InternalError(`Unknown pool in the gift-card code (chainId = ${chainId}, endOfPoolAddr = ${poolAddrSlice})`);
        }

        return { sk: hexToBuf(sk), birthIndex, balance, poolAlias };
    }

    public async tokenSellerContract(): Promise<string> {
        return this.network().getTokenSellerContract(this.pool().poolAddress);
    }
}