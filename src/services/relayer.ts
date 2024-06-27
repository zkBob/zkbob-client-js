import { PoolTxMinimal, RegularTxType, txStateFrom } from "../tx";
import { hexToNode } from "../utils";
import { InternalError, ServiceError } from "../errors";
import { IZkBobService, ServiceType,
         ServiceVersion, isServiceVersion, ServiceVersionFetch,
         defaultHeaders, fetchJson,
        } from "./common";
import { Proof, TreeNode } from 'libzkbob-rs-wasm-web';
import { CONSTANTS } from "../constants";
import { NetworkBackend } from "../networks";

const RELAYER_VERSION_REQUEST_THRESHOLD = 3600; // relayer's version expiration (in seconds)

export interface TxToRelayer {
  txType: RegularTxType;
  memo: string;
  proof: Proof;
  depositSignature?: string
}

export interface JobInfo {
  resolvedJobId: string;
  state: string;
  txHash: string | null;
  createdOn: number;
  finishedOn: number | null;
  failedReason: string | null;
}
const isJobInfo = (obj: any): obj is JobInfo => {
  return typeof obj === 'object' && obj !== null &&
    obj.hasOwnProperty('state') && typeof obj.state === 'string' &&
    obj.hasOwnProperty('txHash') && (!obj.txHash || typeof obj.state === 'string') &&
    obj.hasOwnProperty('resolvedJobId') && typeof obj.resolvedJobId === 'string' &&
    obj.hasOwnProperty('createdOn') && typeof obj.createdOn === 'number';
}

export interface SequencerJobInfo extends JobInfo {
  sequencerIndex: number;
}

export class SequencerJob { // sequencer job description
  constructor(public id: string, public seqIdx?: number) {}
  hash(): string { return `${this.id}_${this.seqIdx}`; }
  equals(other: SequencerJob): boolean { return this.id == other.id && this.seqIdx == other.seqIdx; }
  toString(): string { return `${this.id}@seq[${this.seqIdx}]`; }
}

export interface RelayerInfo {
  root: string;
  optimisticRoot: string;
  deltaIndex: bigint;
  optimisticDeltaIndex: bigint;
  pendingDeltaIndex?: bigint;
}

const isRelayerInfo = (obj: any): obj is RelayerInfo => {
  return typeof obj === 'object' && obj !== null &&
    obj.hasOwnProperty('root') && typeof obj.root === 'string' &&
    obj.hasOwnProperty('optimisticRoot') && typeof obj.optimisticRoot === 'string' &&
    obj.hasOwnProperty('deltaIndex') && typeof obj.deltaIndex === 'number' &&
    obj.hasOwnProperty('optimisticDeltaIndex') && typeof obj.optimisticDeltaIndex === 'number';
}

export interface RelayerFee {
  fee: {
    deposit: bigint;
    transfer: bigint;
    withdrawal: bigint;
    permittableDeposit: bigint;
  };
  oneByteFee: bigint;
  nativeConvertFee: bigint;
}

export function evaluateRelayerFeeValue(fee: RelayerFee): bigint {
  const avgTx = (fee.fee.deposit + fee.fee.transfer + fee.fee.withdrawal + fee.fee.permittableDeposit) / 4n;
  const typycalTxLength = 700n;

  return avgTx + fee.oneByteFee * typycalTxLength;
}

export function compareRelayerFee(fee1: RelayerFee, fee2: RelayerFee): boolean {
  return evaluateRelayerFeeValue(fee1) < evaluateRelayerFeeValue(fee2);
}

interface Limit { // all values are in pool dimension (denominated)
  total: bigint;
  available: bigint;
}

export interface LimitsFetch { 
  deposit: {
    singleOperation: bigint;
    dailyForAddress: Limit;
    dailyForAll: Limit;
    poolLimit: Limit;
  }
  withdraw: {
    dailyForAll: Limit;
  }
  dd: {
    singleOperation: bigint;
    dailyForAddress: Limit;
  }
  tier: number;
}

function LimitsFromJson(json: any): LimitsFetch {
  return {
    deposit: {
      singleOperation: BigInt(json.deposit.singleOperation),
      dailyForAddress: {
        total:     BigInt(json.deposit.dailyForAddress.total),
        available: BigInt(json.deposit.dailyForAddress.available),
      },
      dailyForAll: {
        total:      BigInt(json.deposit.dailyForAll.total),
        available:  BigInt(json.deposit.dailyForAll.available),
      },
      poolLimit: {
        total:      BigInt(json.deposit.poolLimit.total),
        available:  BigInt(json.deposit.poolLimit.available),
      },
    },
    withdraw: {
      dailyForAll: {
        total:      BigInt(json.withdraw.dailyForAll.total),
        available:  BigInt(json.withdraw.dailyForAll.available),
      },
    },
    dd: {
      singleOperation: BigInt(json.dd.singleOperation),
      dailyForAddress: {
        total:     BigInt(json.dd.dailyForAddress.total),
        available: BigInt(json.dd.dailyForAddress.available),
      },
    },
    tier: json.tier === undefined ? 0 : Number(json.tier)
  };
}

export interface SequencerEndpoint {  // using for external purposes
  url: string;
  isActive: boolean;
  isPrioritize: boolean;
}

export class ZkBobRelayer implements IZkBobService {
  // The simplest support for multiple relayer configuration
  // TODO: implement proper relayer swiching / fallbacking
  protected relayerUrls: string[];
  protected curIdx: number;
  protected primaryIdx?: number;  // use to prioritize a concrete URL
  protected supportId: string | undefined;
  protected relayerVersions = new Map<string, ServiceVersionFetch>(); // relayer version: URL -> version

  public static create(relayerUrls: string[], supportId: string | undefined): ZkBobRelayer {
    if (relayerUrls.length == 0) {
      throw new InternalError('ZkBobRelayer: you should provide almost one relayer url');
    }

    const object = new ZkBobRelayer();

    object.relayerUrls = relayerUrls;
    object.supportId = supportId;
    object.curIdx = 0;

    return object;
  }

  // ------------------=========< IZkBobService Methods >=========------------------
  // | Mandatory universal service routines                                        |
  // -------------------------------------------------------------------------------

  public type(): ServiceType {
    return ServiceType.Relayer;
  }

  protected safeIndex(idx?: number): number {
    if (idx === undefined) {
      return this.primaryIdx !== undefined ? this.primaryIdx : this.curIdx;
    } else if (idx < 0) {
      return 0;
    } else if (idx >= this.relayerUrls.length && this.relayerUrls.length > 0) {
      return this.relayerUrls.length - 1;
    }

    return idx;
  }

  public url(idx?: number): string {

    return this.relayerUrls[this.safeIndex(idx)];
  }

  public async version(idx?: number): Promise<ServiceVersion> {
    const relayerUrl = this.url(idx);

    let cachedVer = this.relayerVersions.get(relayerUrl);
    if (cachedVer === undefined || cachedVer.timestamp + RELAYER_VERSION_REQUEST_THRESHOLD * 1000 < Date.now()) {
      const url = new URL(`/version`, relayerUrl);
      const headers = defaultHeaders();

      const version = await fetchJson(url.toString(), {headers}, this.type());
      if (isServiceVersion(version) == false) {
        throw new ServiceError(this.type(), 200, `Incorrect response (expected ServiceVersion, got \'${version}\')`)
      }

      cachedVer = {version, timestamp: Date.now()};  
      this.relayerVersions.set(relayerUrl, cachedVer);
    }

    return cachedVer.version;
  }

  public async healthcheck(idx?: number): Promise<boolean> {
    try {
      await this.info(idx);
    } catch {
      return false;
    }

    return true;
  }

  public getEndpoints(): SequencerEndpoint[] {
    return this.relayerUrls.map((url, idx) => { 
      return {
        url,
        isActive: idx == this.curIdx,
        isPrioritize: idx == this.primaryIdx,
      }
    });
  }

  public async prioritizeEndpoint(index: number | undefined): Promise<number | undefined> {
    if (index === undefined || index < 0 || index >= this.relayerUrls.length) {
      this.primaryIdx = undefined;
    } else {
      if ((await this.healthcheck(index)) == true) {
        this.primaryIdx = index;
        this.curIdx = index;
      } else {
        throw new InternalError(`ZkBobRelayer: cannot prioritize URL ${this.relayerUrls[index]} because it isn't healthy`);
      }
    }

    console.info(`ZkBobRelayer: prioritized sequencer is ${this.primaryIdx !== undefined ? this.relayerUrls[this.primaryIdx] : 'not set'}`);

    return this.primaryIdx;
  }

  // ----------------=========< Relayer Specific Routines >=========----------------
  // |                                                                             |
  // -------------------------------------------------------------------------------

  public async fetchTransactionsOptimistic(network: NetworkBackend, offset: number, limit: number = 100): Promise<PoolTxMinimal[]> {
    const url = new URL(`/transactions/v2`, this.url());
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('offset', offset.toString());
    const headers = defaultHeaders(this.supportId);

    const txs = await fetchJson(url.toString(), {headers}, this.type());
    if (!Array.isArray(txs)) {
      throw new ServiceError(this.type(), 200, `Response should be an array`);
    }
  
    const OUTPLUSONE = CONSTANTS.OUT + 1; // number of leaves (account + notes) in a transaction
    
    return txs.map((tx, txIdx) => {
      // tx structure from relayer: state + txHash(32 bytes, 64 chars) + commitment(32 bytes, 64 chars) + memo
      return {
        index: offset + txIdx * OUTPLUSONE,
        commitment: tx.slice(65, 129),
        txHash: network.txHashFromHexString(tx.slice(1, 65)),
        memo: tx.slice(129),
        state: txStateFrom(Number(tx.slice(0, 1))),
      }
    });
  }
  
  // returns transaction job ID
  public async sendTransactions(txs: TxToRelayer[]): Promise<SequencerJob> {
    const idx = this.safeIndex();
    const url = new URL('/sendTransactions', this.url(idx));
    const headers = defaultHeaders(this.supportId);

    const res = await fetchJson(url.toString(), { method: 'POST', headers, body: JSON.stringify(txs) }, this.type());
    if (typeof res.jobId !== 'string') {
      throw new ServiceError(this.type(), 200, `Cannot get jobId for transaction (response: ${res})`);
    }

    return new SequencerJob(res.jobId, idx);
  }
  
  public async getJob(job: SequencerJob): Promise<SequencerJobInfo | null> {
    const sequencerIndex = this.safeIndex(job.seqIdx);
    const url = new URL(`/job/${job.id}`, this.url(sequencerIndex));
    const headers = defaultHeaders(this.supportId);
    const res = await fetchJson(url.toString(), {headers}, this.type());
  
    if (isJobInfo(res)) {
      return {sequencerIndex, ...res};
    }

    return null;
  }
  
  public async info(idx?: number): Promise<RelayerInfo> {
    const url = new URL('/info', this.url(idx));
    const headers = defaultHeaders();
    const res = await fetchJson(url.toString(), {headers}, this.type());

    if (isRelayerInfo(res)) {
      return res;
    }

    throw new ServiceError(this.type(), 200, `Incorrect response (expected RelayerInfo, got \'${res}\')`)
  }
  
  public async fee(idx?: number): Promise<RelayerFee> {
    const headers = defaultHeaders(this.supportId);
    const url = new URL('/fee', this.url(idx));

    const proxyFee = await fetchJson(url.toString(), {headers}, this.type());


    if (typeof proxyFee !== 'object' || proxyFee === null || 
        (!proxyFee.hasOwnProperty('fee') && !proxyFee.hasOwnProperty('baseFee')))
    {
      throw new ServiceError(this.type(), 200, 'Incorrect response for dynamic fees');
    }

    const feeResp = proxyFee.fee ?? proxyFee.baseFee;
    if (typeof feeResp === 'object' &&
        feeResp.hasOwnProperty('deposit') &&
        feeResp.hasOwnProperty('transfer') &&
        feeResp.hasOwnProperty('withdrawal') &&
        feeResp.hasOwnProperty('permittableDeposit')
    ){
      return {
        fee: {
          deposit: BigInt(feeResp.deposit),
          transfer: BigInt(feeResp.transfer),
          withdrawal: BigInt(feeResp.withdrawal),
          permittableDeposit: BigInt(feeResp.permittableDeposit),
        },
        oneByteFee: BigInt(proxyFee.oneByteFee ?? '0'),
        nativeConvertFee: BigInt(proxyFee.nativeConvertFee ?? '0'),
      };
    } else if (typeof feeResp === 'string' || 
                typeof feeResp === 'number' ||
                typeof feeResp === 'bigint'
    ) {
      return {
        fee: {
          deposit: BigInt(feeResp),
          transfer: BigInt(feeResp),
          withdrawal: BigInt(feeResp),
          permittableDeposit: BigInt(feeResp),
        },
        oneByteFee: BigInt(proxyFee.oneByteFee ?? '0'),
        nativeConvertFee: BigInt(proxyFee.nativeConvertFee ?? '0'),
      };
    } else {
      throw new ServiceError(this.type(), 200, 'Incorrect fee field');
    }
  }
  
  public async limits(address: string | undefined): Promise<LimitsFetch> {
    const url = new URL('/limits', this.url());
    if (address) {
      url.searchParams.set('address', address);
    }
    const headers = defaultHeaders(this.supportId);
    const res = await fetchJson(url.toString(), {headers}, this.type());

    return LimitsFromJson(res);
  }

  public async siblings(index: number): Promise<TreeNode[]> {
    const url = new URL(`/siblings`, this.url());
    url.searchParams.set('index', index.toString());
    const headers = defaultHeaders(this.supportId);

    const siblings = await fetchJson(url.toString(), {headers}, this.type());
    if (!Array.isArray(siblings)) {
      throw new ServiceError(this.type(), 200, `Response should be an array`);
    }
  
    return siblings.map((aNode) => {
      let node = hexToNode(aNode)
      if (!node) {
        throw new ServiceError(this.type(), 200, `Cannot convert \'${aNode}\' to a TreeNode`);
      }
      return node;
    });
  }

  public async txParamsHash(): Promise<string> {
    const url = new URL('/params/hash/tx', this.url());
    const headers = defaultHeaders();
    const res = await fetchJson(url.toString(), {headers}, this.type());

    if (typeof res !== 'object' || res === null ||
        !res.hasOwnProperty('hash') || typeof res.hash !== 'string')
    {
      throw new ServiceError(this.type(), 200, 'Incorrect response for tx params hash');
    }
  
    return res.hash;
  }

  // Amount of the pool tokens which could be swapped to the native ones
  // in a single withdrawal transaction (aka native_amount)
  public async maxSupportedSwapAmount(): Promise<bigint> {
    const url = new URL('/maxNativeAmount', this.url());
    const headers = defaultHeaders(this.supportId);
    const res = await fetchJson(url.toString(), {headers}, this.type());

    if (typeof res !== 'object' || res === null ||
        !res.hasOwnProperty('maxNativeAmount') || typeof res.maxNativeAmount !== 'string')
    {
      throw new ServiceError(this.type(), 200, 'Incorrect respons for /maxNativeAmount');
    }
  
    return BigInt(res.maxNativeAmount);
  }
}